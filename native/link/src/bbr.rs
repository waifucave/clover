//! The link's congestion controller (spec §8.3, "Congestion control is chosen for lossy paths", and the per-path
//! stream windows): quinn's BBR, ported to the controller trait iroh 1.4.1 takes (noq's, re-exported as
//! `iroh::endpoint::Controller`), with the data in flight sized to the path.
//!
//! Why this one: in S1's lab (docs/research/2026-11-05-s1-transport.md, Q4), with loss on single datagrams, Cubic
//! moved 0.2-0.3 MB/s at 1 % loss and 80 ms, noq's BBRv3 mostly under 1.3 MB/s, and quinn's BBR 3.4-4.9 MB/s, the only
//! controller steady in every run. noq ships BBRv3, Cubic and NewReno, not quinn's BBR, so it lives here.
//!
//! What changed from quinn-proto 0.11.19's `congestion/bbr` (MIT OR Apache-2.0, quinn-rs/quinn, itself after
//! Chromium's QUIC `bbr_sender.cc`):
//! * the controller trait's new arguments (packet numbers, ECN) are taken and, as quinn did, not used;
//! * once the path's rate is known (past startup), the window is 1.25 times the path's bandwidth-delay product, plus
//!   the ACK aggregation BBR measures, within a floor and a ceiling (`WINDOW_GAIN`, `WINDOW_FLOOR`,
//!   `WINDOW_CEILING`), instead of quinn's twice. That is S1's sized window: during a transfer the data already in
//!   flight sets how long a control message waits, whatever its priority, and 1.25 times the BDP cut the added delay
//!   from about 8 ms to about 0.3 ms on a clean LAN at 0-4 % of the throughput. Each path has its own controller
//!   (noq builds one per path), so the window follows each path's measured round trip and rate as they change;
//! * the pacing rate isn't handed to noq's pacer, which then paces from the window as quinn's did when the lab
//!   measured it; the bandwidth estimate is reported (in bits per second, as noq's `PathStats` expects);
//! * the bandwidth-delay product is taken from the minimum round trip in nanoseconds, not whole microseconds (on a LAN
//!   or loopback it can be under one, and quinn's product then fell back to the initial window);
//! * a small xorshift replaces the `rand` crate for the gain cycle's starting phase.
//!
//! quinn-proto's licence (MIT; it is also offered under Apache-2.0), whose notice the port keeps:
//!
//! Copyright (c) 2018 The quinn Developers
//!
//! Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
//!
//! The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
//!
//! THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

use std::{
    any::Any,
    collections::hash_map::RandomState,
    hash::{BuildHasher, Hasher},
    sync::Arc,
    time::{Duration, Instant},
};

use iroh::endpoint::{Controller, ControllerFactory, ControllerMetrics, RttEstimator};
use serde_json::{json, Value};

/// In flight once the path's rate is known: this times its bandwidth-delay product (S1's sized window).
pub const WINDOW_GAIN: f32 = 1.25;
/// The least the sized window allows: on a fast path with a sub-millisecond round trip the product is tiny, and a
/// window below a few dozen packets stalls on any hiccup in the ACKs.
pub const WINDOW_FLOOR: u64 = 64 * 1024;
/// The most data in flight on one path, whatever the estimate (also the most the send side keeps unacknowledged).
pub const WINDOW_CEILING: u64 = 16 * 1024 * 1024;

/// One path's BBR state.
#[derive(Debug, Clone)]
pub struct Bbr {
    config: Arc<BbrConfig>,
    current_mtu: u64,
    max_bandwidth: BandwidthEstimation,
    acked_bytes: u64,
    mode: Mode,
    loss_state: LossState,
    recovery_state: RecoveryState,
    recovery_window: u64,
    is_at_full_bandwidth: bool,
    pacing_gain: f32,
    high_gain: f32,
    drain_gain: f32,
    cwnd_gain: f32,
    high_cwnd_gain: f32,
    last_cycle_start: Option<Instant>,
    current_cycle_offset: u8,
    init_cwnd: u64,
    min_cwnd: u64,
    prev_in_flight_count: u64,
    exit_probe_rtt_at: Option<Instant>,
    probe_rtt_last_started_at: Option<Instant>,
    min_rtt: Duration,
    exiting_quiescence: bool,
    pacing_rate: u64,
    max_acked_packet_number: u64,
    max_sent_packet_number: u64,
    end_recovery_at_packet_number: u64,
    cwnd: u64,
    current_round_trip_end_packet_number: u64,
    round_count: u64,
    bw_at_last_round: u64,
    round_wo_bw_gain: u64,
    ack_aggregation: AckAggregationState,
    rng: u64,
}

impl Bbr {
    pub fn new(config: Arc<BbrConfig>, current_mtu: u16) -> Self {
        let initial_window = config.initial_window;
        let mut seed = RandomState::new().build_hasher();
        seed.write_u64(initial_window);
        Self {
            config,
            current_mtu: current_mtu as u64,
            max_bandwidth: BandwidthEstimation::default(),
            acked_bytes: 0,
            mode: Mode::Startup,
            loss_state: Default::default(),
            recovery_state: RecoveryState::NotInRecovery,
            recovery_window: 0,
            is_at_full_bandwidth: false,
            pacing_gain: K_DEFAULT_HIGH_GAIN,
            high_gain: K_DEFAULT_HIGH_GAIN,
            drain_gain: 1.0 / K_DEFAULT_HIGH_GAIN,
            cwnd_gain: K_DEFAULT_HIGH_GAIN,
            high_cwnd_gain: K_DEFAULT_HIGH_GAIN,
            last_cycle_start: None,
            current_cycle_offset: 0,
            init_cwnd: initial_window,
            min_cwnd: calculate_min_window(current_mtu as u64),
            prev_in_flight_count: 0,
            exit_probe_rtt_at: None,
            probe_rtt_last_started_at: None,
            min_rtt: Default::default(),
            exiting_quiescence: false,
            pacing_rate: 0,
            max_acked_packet_number: 0,
            max_sent_packet_number: 0,
            end_recovery_at_packet_number: 0,
            cwnd: initial_window,
            current_round_trip_end_packet_number: 0,
            round_count: 0,
            bw_at_last_round: 0,
            round_wo_bw_gain: 0,
            ack_aggregation: AckAggregationState::default(),
            rng: seed.finish() | 1,
        }
    }

    /// What the sidecar's `stats` shows of this path's controller: its mode, its model of the path and the window
    /// that model gives.
    pub fn snapshot(&self) -> Value {
        let bw = self.max_bandwidth.get_estimate();
        json!({
            "mode": match self.mode { Mode::Startup => "startup", Mode::Drain => "drain", Mode::ProbeBw => "probeBw", Mode::ProbeRtt => "probeRtt" },
            "bandwidth": bw,
            "minRttNs": self.min_rtt.as_nanos() as u64,
            "bdp": self.bdp(1.0),
            "ackHeight": self.ack_aggregation.max_ack_height.get(),
            "window": self.window(),
            "sized": self.sized_window(),
            "recovery": self.recovery_state.in_recovery(),
        })
    }

    /// `gain` times the bandwidth-delay product: the estimated rate (bytes per second) over the minimum round trip.
    fn bdp(&self, gain: f32) -> u64 {
        let bytes = self.max_bandwidth.get_estimate() as u128 * self.min_rtt.as_nanos() / 1_000_000_000;
        (gain as f64 * bytes as f64) as u64
    }

    /// The window once the path's rate is known: `WINDOW_GAIN` times the BDP, plus the ACK aggregation seen, kept
    /// between the floor and the ceiling.
    fn sized_window(&self) -> u64 {
        (self.bdp(WINDOW_GAIN) + self.ack_aggregation.max_ack_height.get()).clamp(WINDOW_FLOOR.max(self.min_cwnd), WINDOW_CEILING)
    }

    fn next_random(&mut self) -> u64 {
        // xorshift64: only the gain cycle's starting phase needs it.
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.rng = x;
        x
    }

    fn enter_startup_mode(&mut self) {
        self.mode = Mode::Startup;
        self.pacing_gain = self.high_gain;
        self.cwnd_gain = self.high_cwnd_gain;
    }

    fn enter_probe_bandwidth_mode(&mut self, now: Instant) {
        self.mode = Mode::ProbeBw;
        self.cwnd_gain = WINDOW_GAIN;
        self.last_cycle_start = Some(now);
        // A random offset for the gain cycle out of {0, 2..7}. 1 is excluded because then increased gain and decreased
        // gain would not follow each other.
        let mut rand_index = (self.next_random() % (K_PACING_GAIN.len() as u64 - 1)) as u8;
        if rand_index >= 1 {
            rand_index += 1;
        }
        self.current_cycle_offset = rand_index;
        self.pacing_gain = K_PACING_GAIN[rand_index as usize];
    }

    fn update_recovery_state(&mut self, is_round_start: bool) {
        // Exit recovery when there are no losses for a round.
        if self.loss_state.has_losses() {
            self.end_recovery_at_packet_number = self.max_sent_packet_number;
        }
        match self.recovery_state {
            // Enter conservation on the first loss.
            RecoveryState::NotInRecovery if self.loss_state.has_losses() => {
                self.recovery_state = RecoveryState::Conservation;
                // This will cause the |recovery_window| to be set to the correct value in calculate_recovery_window().
                self.recovery_window = 0;
                // Since the conservation phase is meant to last a whole round, extend the current round as if it
                // were started right now.
                self.current_round_trip_end_packet_number = self.max_sent_packet_number;
            }
            RecoveryState::Growth | RecoveryState::Conservation => {
                if self.recovery_state == RecoveryState::Conservation && is_round_start {
                    self.recovery_state = RecoveryState::Growth;
                }
                // Exit recovery if appropriate.
                if !self.loss_state.has_losses() && self.max_acked_packet_number > self.end_recovery_at_packet_number {
                    self.recovery_state = RecoveryState::NotInRecovery;
                }
            }
            _ => {}
        }
    }

    fn update_gain_cycle_phase(&mut self, now: Instant, in_flight: u64) {
        // In most cases, the cycle is advanced after an RTT passes.
        let mut should_advance_gain_cycling =
            self.last_cycle_start.map(|last_cycle_start| now.duration_since(last_cycle_start) > self.min_rtt).unwrap_or(false);
        // If the pacing gain is above 1.0, the connection is trying to probe the bandwidth by increasing the number
        // of bytes in flight to at least pacing_gain * BDP. Make sure that it actually reaches the target, as long as
        // there are no losses suggesting that the buffers are not able to hold that much.
        if self.pacing_gain > 1.0 && !self.loss_state.has_losses() && self.prev_in_flight_count < self.get_target_cwnd(self.pacing_gain) {
            should_advance_gain_cycling = false;
        }

        // If pacing gain is below 1.0, the connection is trying to drain the extra queue which could have been
        // incurred by probing prior to it. If the number of bytes in flight falls down to the estimated BDP value
        // earlier, conclude that the queue has been successfully drained and exit this cycle early.
        if self.pacing_gain < 1.0 && in_flight <= self.get_target_cwnd(1.0) {
            should_advance_gain_cycling = true;
        }

        if should_advance_gain_cycling {
            self.current_cycle_offset = (self.current_cycle_offset + 1) % K_PACING_GAIN.len() as u8;
            self.last_cycle_start = Some(now);
            // Stay in low gain mode until the target BDP is hit. Low gain mode will be exited immediately when the
            // target BDP is achieved.
            if DRAIN_TO_TARGET
                && self.pacing_gain < 1.0
                && (K_PACING_GAIN[self.current_cycle_offset as usize] - 1.0).abs() < f32::EPSILON
                && in_flight > self.get_target_cwnd(1.0)
            {
                return;
            }
            self.pacing_gain = K_PACING_GAIN[self.current_cycle_offset as usize];
        }
    }

    fn maybe_exit_startup_or_drain(&mut self, now: Instant, in_flight: u64) {
        if self.mode == Mode::Startup && self.is_at_full_bandwidth {
            self.mode = Mode::Drain;
            self.pacing_gain = self.drain_gain;
            self.cwnd_gain = self.high_cwnd_gain;
        }
        if self.mode == Mode::Drain && in_flight <= self.get_target_cwnd(1.0) {
            self.enter_probe_bandwidth_mode(now);
        }
    }

    fn is_min_rtt_expired(&self, now: Instant, app_limited: bool) -> bool {
        !app_limited
            && self.probe_rtt_last_started_at.map(|last| now.saturating_duration_since(last) > Duration::from_secs(10)).unwrap_or(true)
    }

    fn maybe_enter_or_exit_probe_rtt(&mut self, now: Instant, is_round_start: bool, bytes_in_flight: u64, app_limited: bool) {
        let min_rtt_expired = self.is_min_rtt_expired(now, app_limited);
        if min_rtt_expired && !self.exiting_quiescence && self.mode != Mode::ProbeRtt {
            self.mode = Mode::ProbeRtt;
            self.pacing_gain = 1.0;
            // Do not decide on the time to exit ProbeRtt until the |bytes_in_flight| is at the target small value.
            self.exit_probe_rtt_at = None;
            self.probe_rtt_last_started_at = Some(now);
        }

        if self.mode == Mode::ProbeRtt {
            match self.exit_probe_rtt_at {
                None => {
                    // If the window has reached the appropriate size, schedule exiting ProbeRtt. The CWND during
                    // ProbeRtt is kMinimumCongestionWindow, but we allow an extra packet since QUIC checks CWND before
                    // sending a packet.
                    if bytes_in_flight < self.get_probe_rtt_cwnd() + self.current_mtu {
                        const K_PROBE_RTT_TIME: Duration = Duration::from_millis(200);
                        self.exit_probe_rtt_at = Some(now + K_PROBE_RTT_TIME);
                    }
                }
                Some(exit_time) if is_round_start && now >= exit_time => {
                    if !self.is_at_full_bandwidth {
                        self.enter_startup_mode();
                    } else {
                        self.enter_probe_bandwidth_mode(now);
                    }
                }
                Some(_) => {}
            }
        }

        self.exiting_quiescence = false;
    }

    fn get_target_cwnd(&self, gain: f32) -> u64 {
        let cwnd = self.bdp(gain);
        // BDP estimate will be zero if no bandwidth samples are available yet.
        if cwnd == 0 {
            return self.init_cwnd;
        }
        cwnd.max(self.min_cwnd)
    }

    fn get_probe_rtt_cwnd(&self) -> u64 {
        const K_MODERATE_PROBE_RTT_MULTIPLIER: f32 = 0.75;
        if PROBE_RTT_BASED_ON_BDP {
            return self.get_target_cwnd(K_MODERATE_PROBE_RTT_MULTIPLIER);
        }
        self.min_cwnd
    }

    fn calculate_pacing_rate(&mut self) {
        let bw = self.max_bandwidth.get_estimate();
        if bw == 0 {
            return;
        }
        let target_rate = (bw as f64 * self.pacing_gain as f64) as u64;
        if self.is_at_full_bandwidth {
            self.pacing_rate = target_rate;
            return;
        }

        // Pace at the rate of initial_window / RTT as soon as RTT measurements are available.
        if self.pacing_rate == 0 && self.min_rtt.as_nanos() != 0 {
            self.pacing_rate = BandwidthEstimation::bw_from_delta(self.init_cwnd, self.min_rtt).unwrap_or(0);
            return;
        }

        // Do not decrease the pacing rate during startup.
        if self.pacing_rate < target_rate {
            self.pacing_rate = target_rate;
        }
    }

    fn calculate_cwnd(&mut self, bytes_acked: u64, excess_acked: u64) {
        if self.mode == Mode::ProbeRtt {
            return;
        }
        if self.is_at_full_bandwidth {
            // The sized window (S1): 1.25 times the BDP plus the recent ACK aggregation, within the floor and the
            // ceiling. BBR grows the CWND towards it by only |bytes_acked| at a time, and drops to it at once.
            let target_window = self.sized_window();
            self.cwnd = target_window.min(self.cwnd + bytes_acked);
        } else {
            // Add the most recent excess acked. Because CWND never decreases in STARTUP, this will automatically
            // create a very localized max filter.
            let target_window = self.get_target_cwnd(self.cwnd_gain) + excess_acked;
            // If the connection is not yet out of startup phase, do not decrease the window.
            if (self.cwnd_gain < target_window as f32) || (self.acked_bytes < self.init_cwnd) {
                self.cwnd += bytes_acked;
            }
        }

        // Enforce the limits on the congestion window.
        self.cwnd = self.cwnd.clamp(self.min_cwnd, WINDOW_CEILING.max(self.min_cwnd));
    }

    fn calculate_recovery_window(&mut self, bytes_acked: u64, bytes_lost: u64, in_flight: u64) {
        if !self.recovery_state.in_recovery() {
            return;
        }
        // Set up the initial recovery window.
        if self.recovery_window == 0 {
            self.recovery_window = self.min_cwnd.max(in_flight + bytes_acked);
            return;
        }

        // Remove losses from the recovery window, while accounting for a potential integer underflow.
        if self.recovery_window >= bytes_lost {
            self.recovery_window -= bytes_lost;
        } else {
            // k_max_segment_size = current_mtu
            self.recovery_window = self.current_mtu;
        }
        // In CONSERVATION mode, just subtracting losses is sufficient. In GROWTH, release additional |bytes_acked| to
        // achieve a slow-start-like behavior.
        if self.recovery_state == RecoveryState::Growth {
            self.recovery_window += bytes_acked;
        }

        // Sanity checks. Ensure that we always allow to send at least an MSS or |bytes_acked| in response, whichever
        // is larger.
        self.recovery_window = self.recovery_window.max(in_flight + bytes_acked).max(self.min_cwnd);
    }

    /// <https://datatracker.ietf.org/doc/html/draft-cardwell-iccrg-bbr-congestion-control#section-4.3.2.2>
    fn check_if_full_bw_reached(&mut self, app_limited: bool) {
        if app_limited {
            return;
        }
        let target = (self.bw_at_last_round as f64 * K_STARTUP_GROWTH_TARGET as f64) as u64;
        let bw = self.max_bandwidth.get_estimate();
        if bw >= target {
            self.bw_at_last_round = bw;
            self.round_wo_bw_gain = 0;
            self.ack_aggregation.max_ack_height.reset();
            return;
        }

        self.round_wo_bw_gain += 1;
        if self.round_wo_bw_gain >= K_ROUND_TRIPS_WITHOUT_GROWTH_BEFORE_EXITING_STARTUP as u64 || (self.recovery_state.in_recovery()) {
            self.is_at_full_bandwidth = true;
        }
    }
}

impl Controller for Bbr {
    fn on_sent(&mut self, now: Instant, bytes: u64, last_packet_number: u64) {
        self.max_sent_packet_number = last_packet_number;
        self.max_bandwidth.on_sent(now, bytes);
    }

    fn on_ack(&mut self, now: Instant, sent: Instant, bytes: u64, _pn: u64, app_limited: bool, rtt: &RttEstimator) {
        self.max_bandwidth.on_ack(now, sent, bytes, self.round_count, app_limited);
        self.acked_bytes += bytes;
        if self.is_min_rtt_expired(now, app_limited) || self.min_rtt > rtt.min() {
            self.min_rtt = rtt.min();
        }
    }

    fn on_end_acks(&mut self, now: Instant, in_flight: u64, app_limited: bool, largest_packet_num_acked: Option<u64>) {
        let bytes_acked = self.max_bandwidth.bytes_acked_this_window();
        let excess_acked =
            self.ack_aggregation.update_ack_aggregation_bytes(bytes_acked, now, self.round_count, self.max_bandwidth.get_estimate());
        self.max_bandwidth.end_acks(self.round_count, app_limited);
        if let Some(largest_acked_packet) = largest_packet_num_acked {
            self.max_acked_packet_number = largest_acked_packet;
        }

        let mut is_round_start = false;
        if bytes_acked > 0 {
            is_round_start = self.max_acked_packet_number > self.current_round_trip_end_packet_number;
            if is_round_start {
                self.current_round_trip_end_packet_number = self.max_sent_packet_number;
                self.round_count += 1;
            }
        }

        self.update_recovery_state(is_round_start);

        if self.mode == Mode::ProbeBw {
            self.update_gain_cycle_phase(now, in_flight);
        }

        if is_round_start && !self.is_at_full_bandwidth {
            self.check_if_full_bw_reached(app_limited);
        }

        self.maybe_exit_startup_or_drain(now, in_flight);

        self.maybe_enter_or_exit_probe_rtt(now, is_round_start, in_flight, app_limited);

        // After the model is updated, recalculate the pacing rate and congestion window.
        self.calculate_pacing_rate();
        self.calculate_cwnd(bytes_acked, excess_acked);
        self.calculate_recovery_window(bytes_acked, self.loss_state.lost_bytes, in_flight);

        self.prev_in_flight_count = in_flight;
        self.loss_state.reset();
    }

    fn on_congestion_event(
        &mut self,
        _now: Instant,
        _sent: Instant,
        _is_persistent_congestion: bool,
        _is_ecn: bool,
        lost_bytes: u64,
        _largest_lost_pn: u64,
    ) {
        self.loss_state.lost_bytes += lost_bytes;
    }

    fn on_mtu_update(&mut self, new_mtu: u16) {
        self.current_mtu = new_mtu as u64;
        self.min_cwnd = calculate_min_window(self.current_mtu);
        self.init_cwnd = self.config.initial_window.max(self.min_cwnd);
        self.cwnd = self.cwnd.max(self.min_cwnd);
    }

    fn window(&self) -> u64 {
        if self.mode == Mode::ProbeRtt {
            return self.get_probe_rtt_cwnd();
        } else if self.recovery_state.in_recovery() && self.mode != Mode::Startup {
            return self.cwnd.min(self.recovery_window);
        }
        self.cwnd
    }

    fn metrics(&self) -> ControllerMetrics {
        // No pacing rate: noq's pacer then paces from the window, as quinn's did when S1 measured this controller.
        let mut m = ControllerMetrics::default();
        m.congestion_window = self.window();
        let bw = self.max_bandwidth.get_estimate();
        if bw > 0 {
            m.bandwidth_estimate = Some(bw.saturating_mul(8));
        }
        m
    }

    fn clone_box(&self) -> Box<dyn Controller> {
        Box::new(self.clone())
    }

    fn initial_window(&self) -> u64 {
        self.config.initial_window
    }

    fn into_any(self: Box<Self>) -> Box<dyn Any> {
        self
    }
}

/// Configuration for [`Bbr`]: what the endpoint's transport config hands noq, which builds one per path.
#[derive(Debug, Clone)]
pub struct BbrConfig {
    initial_window: u64,
}

impl Default for BbrConfig {
    fn default() -> Self {
        Self { initial_window: K_MAX_INITIAL_CONGESTION_WINDOW * BASE_DATAGRAM_SIZE }
    }
}

impl ControllerFactory for BbrConfig {
    fn build(self: Arc<Self>, _now: Instant, current_mtu: u16) -> Box<dyn Controller> {
        Box::new(Bbr::new(self, current_mtu))
    }
}

#[derive(Debug, Default, Copy, Clone)]
struct AckAggregationState {
    max_ack_height: MinMax,
    aggregation_epoch_start_time: Option<Instant>,
    aggregation_epoch_bytes: u64,
}

impl AckAggregationState {
    fn update_ack_aggregation_bytes(&mut self, newly_acked_bytes: u64, now: Instant, round: u64, max_bandwidth: u64) -> u64 {
        // Compute how many bytes are expected to be delivered, assuming max bandwidth is correct.
        let expected_bytes_acked =
            max_bandwidth * now.saturating_duration_since(self.aggregation_epoch_start_time.unwrap_or(now)).as_micros() as u64 / 1_000_000;

        // Reset the current aggregation epoch as soon as the ack arrival rate is less than or equal to the max
        // bandwidth.
        if self.aggregation_epoch_bytes <= expected_bytes_acked {
            // Reset to start measuring a new aggregation epoch.
            self.aggregation_epoch_bytes = newly_acked_bytes;
            self.aggregation_epoch_start_time = Some(now);
            return 0;
        }

        // Compute how many extra bytes were delivered vs max bandwidth. Include the bytes most recently acknowledged
        // to account for stretch acks.
        self.aggregation_epoch_bytes += newly_acked_bytes;
        let diff = self.aggregation_epoch_bytes - expected_bytes_acked;
        self.max_ack_height.update_max(round, diff);
        diff
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum Mode {
    // Startup phase of the connection.
    Startup,
    // After achieving the highest possible bandwidth during the startup, lower the pacing rate in order to drain the
    // queue.
    Drain,
    // Cruising mode.
    ProbeBw,
    // Temporarily slow down sending in order to empty the buffer and measure the real minimum RTT.
    ProbeRtt,
}

// Indicates how the congestion control limits the amount of bytes in flight.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum RecoveryState {
    // Do not limit.
    NotInRecovery,
    // Allow an extra outstanding byte for each byte acknowledged.
    Conservation,
    // Allow two extra outstanding bytes for each byte acknowledged (slow start).
    Growth,
}

impl RecoveryState {
    fn in_recovery(&self) -> bool {
        !matches!(self, Self::NotInRecovery)
    }
}

#[derive(Debug, Clone, Default)]
struct LossState {
    lost_bytes: u64,
}

impl LossState {
    fn reset(&mut self) {
        self.lost_bytes = 0;
    }

    fn has_losses(&self) -> bool {
        self.lost_bytes != 0
    }
}

fn calculate_min_window(current_mtu: u64) -> u64 {
    4 * current_mtu
}

const BASE_DATAGRAM_SIZE: u64 = 1200;
// The gain used for the STARTUP, equal to 2/ln(2).
const K_DEFAULT_HIGH_GAIN: f32 = 2.885;
// The cycle of gains used during the ProbeBw stage.
const K_PACING_GAIN: [f32; 8] = [1.25, 0.75, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];

const K_STARTUP_GROWTH_TARGET: f32 = 1.25;
const K_ROUND_TRIPS_WITHOUT_GROWTH_BEFORE_EXITING_STARTUP: u8 = 3;

// Do not allow initial congestion window to be greater than 200 packets.
const K_MAX_INITIAL_CONGESTION_WINDOW: u64 = 200;

const PROBE_RTT_BASED_ON_BDP: bool = true;
const DRAIN_TO_TARGET: bool = true;

/// The delivery rate, as the max over the last rounds of the lesser of the send and ACK rates (quinn's
/// `bw_estimation.rs`).
#[derive(Clone, Debug, Default)]
struct BandwidthEstimation {
    total_acked: u64,
    prev_total_acked: u64,
    acked_time: Option<Instant>,
    prev_acked_time: Option<Instant>,
    total_sent: u64,
    prev_total_sent: u64,
    sent_time: Option<Instant>,
    prev_sent_time: Option<Instant>,
    max_filter: MinMax,
    acked_at_last_window: u64,
}

impl BandwidthEstimation {
    fn on_sent(&mut self, now: Instant, bytes: u64) {
        self.prev_total_sent = self.total_sent;
        self.total_sent += bytes;
        self.prev_sent_time = self.sent_time;
        self.sent_time = Some(now);
    }

    fn on_ack(&mut self, now: Instant, _sent: Instant, bytes: u64, round: u64, app_limited: bool) {
        self.prev_total_acked = self.total_acked;
        self.total_acked += bytes;
        self.prev_acked_time = self.acked_time;
        self.acked_time = Some(now);

        let prev_sent_time = match self.prev_sent_time {
            Some(prev_sent_time) => prev_sent_time,
            None => return,
        };

        let send_rate = match self.sent_time {
            Some(sent_time) if sent_time > prev_sent_time => {
                Self::bw_from_delta(self.total_sent - self.prev_total_sent, sent_time - prev_sent_time).unwrap_or(0)
            }
            _ => u64::MAX, // will take the min of send and ack, so this is just a skip
        };

        let ack_rate = match self.prev_acked_time {
            Some(prev_acked_time) => Self::bw_from_delta(self.total_acked - self.prev_total_acked, now - prev_acked_time).unwrap_or(0),
            None => 0,
        };

        let bandwidth = send_rate.min(ack_rate);
        if !app_limited && self.max_filter.get() < bandwidth {
            self.max_filter.update_max(round, bandwidth);
        }
    }

    fn bytes_acked_this_window(&self) -> u64 {
        self.total_acked - self.acked_at_last_window
    }

    fn end_acks(&mut self, _current_round: u64, _app_limited: bool) {
        self.acked_at_last_window = self.total_acked;
    }

    fn get_estimate(&self) -> u64 {
        self.max_filter.get()
    }

    const fn bw_from_delta(bytes: u64, delta: Duration) -> Option<u64> {
        let window_duration_ns = delta.as_nanos();
        if window_duration_ns == 0 {
            return None;
        }
        let b_ns = bytes * 1_000_000_000;
        let bytes_per_second = b_ns / (window_duration_ns as u64);
        Some(bytes_per_second)
    }
}

/// Kathleen Nichols' windowed max filter, over round counts (quinn's `min_max.rs`, after Google's code released under
/// the BSD license, https://groups.google.com/forum/#!topic/bbr-dev/3RTgkzi5ZD8). It keeps the best, second and third
/// best samples, widely separated in the window, so it costs constant space and time per update.
#[derive(Copy, Clone, Debug)]
struct MinMax {
    /// round count, not a timestamp
    window: u64,
    samples: [MinMaxSample; 3],
}

impl MinMax {
    fn get(&self) -> u64 {
        self.samples[0].value
    }

    fn fill(&mut self, sample: MinMaxSample) {
        self.samples.fill(sample);
    }

    fn reset(&mut self) {
        self.fill(Default::default())
    }

    fn update_max(&mut self, current_round: u64, measurement: u64) {
        let sample = MinMaxSample { time: current_round, value: measurement };

        if self.samples[0].value == 0 /* uninitialised */
            || /* found new max? */ sample.value >= self.samples[0].value
            || /* nothing left in window? */ sample.time - self.samples[2].time > self.window
        {
            self.fill(sample); /* forget earlier samples */
            return;
        }

        if sample.value >= self.samples[1].value {
            self.samples[2] = sample;
            self.samples[1] = sample;
        } else if sample.value >= self.samples[2].value {
            self.samples[2] = sample;
        }

        self.subwin_update(sample);
    }

    /* As time advances, update the 1st, 2nd, and 3rd choices. */
    fn subwin_update(&mut self, sample: MinMaxSample) {
        let dt = sample.time - self.samples[0].time;
        if dt > self.window {
            // Passed the entire window without a new sample, so make the 2nd choice the new sample and the 3rd choice
            // the new 2nd. This may have to iterate, since the 2nd choice may also be outside the window (the 3rd was
            // checked to be inside it on entry).
            self.samples[0] = self.samples[1];
            self.samples[1] = self.samples[2];
            self.samples[2] = sample;
            if sample.time - self.samples[0].time > self.window {
                self.samples[0] = self.samples[1];
                self.samples[1] = self.samples[2];
                self.samples[2] = sample;
            }
        } else if self.samples[1].time == self.samples[0].time && dt > self.window / 4 {
            // A quarter of the window passed without a new sample, so take a 2nd choice from the 2nd quarter.
            self.samples[2] = sample;
            self.samples[1] = sample;
        } else if self.samples[2].time == self.samples[1].time && dt > self.window / 2 {
            // Half the window passed without a new sample, so take a 3rd choice from the last half.
            self.samples[2] = sample;
        }
    }
}

impl Default for MinMax {
    fn default() -> Self {
        Self { window: 10, samples: [Default::default(); 3] }
    }
}

#[derive(Debug, Copy, Clone, Default)]
struct MinMaxSample {
    /// round number, not a timestamp
    time: u64,
    value: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn min_max_keeps_the_windowed_max() {
        let round = 25;
        let mut min_max = MinMax::default();
        min_max.update_max(round + 1, 100);
        assert_eq!(100, min_max.get());
        min_max.update_max(round + 3, 120);
        assert_eq!(120, min_max.get());
        min_max.update_max(round + 5, 160);
        assert_eq!(160, min_max.get());
        min_max.update_max(round + 7, 100);
        assert_eq!(160, min_max.get());
        min_max.update_max(round + 10, 100);
        assert_eq!(160, min_max.get());
        min_max.update_max(round + 14, 100);
        assert_eq!(160, min_max.get());
        min_max.update_max(round + 16, 100);
        assert_eq!(100, min_max.get());
        min_max.update_max(round + 18, 130);
        assert_eq!(130, min_max.get());
    }

    #[test]
    fn the_sized_window_follows_the_path_within_its_bounds() {
        let mut b = Bbr::new(Arc::new(BbrConfig::default()), 1200);
        // 10 MB/s at 40 ms: a BDP of 400 kB, so 500 kB sized.
        b.max_bandwidth.max_filter.update_max(1, 10_000_000);
        b.min_rtt = Duration::from_millis(40);
        assert_eq!(b.sized_window(), 500_000);
        // A 0.4 µs round trip (loopback): still the product (4 bytes), not the initial window, so the floor.
        b.min_rtt = Duration::from_nanos(400);
        assert_eq!(b.sized_window(), WINDOW_FLOOR);
        b.min_rtt = Duration::from_millis(40);
        // A sub-millisecond LAN at 100 MB/s: a 20 kB BDP, so the floor.
        b.min_rtt = Duration::from_micros(200);
        b.max_bandwidth.max_filter.update_max(2, 100_000_000);
        assert_eq!(b.sized_window(), WINDOW_FLOOR);
        // 1 GB/s at 150 ms: past the ceiling.
        b.min_rtt = Duration::from_millis(150);
        b.max_bandwidth.max_filter.update_max(3, 1_000_000_000);
        assert_eq!(b.sized_window(), WINDOW_CEILING);
    }
}
