//! `clover-link`: clover-core's link sidecar (spec §8.2; spike S1 chose iroh over a sidecar). One iroh endpoint per
//! device, keyed by the device's link key, which clover-core hands over on stdin, never in arguments, the environment
//! or a file. The core drives it over stdin and stdout; the link protocol itself (hello, lanes, requests, streams)
//! lives in the core (`packages/core/src/links/transport.ts`), and this process only carries connections and streams.
//! If it exits, the core starts it again with the same `init` and re-dials (§8.3; `sidecar-wire.ts`).
//!
//! Frames, both ways: a big-endian u32 length, then that many bytes. The first byte says what follows:
//! * `0`: a JSON control message (`{"op": …}` from the core, `{"ev": …}` to it);
//! * `1`: stream bytes, a big-endian u64 stream id and the data;
//! * `2`: credit, a big-endian u64 stream id and a big-endian u32 byte count.
//!
//! Backpressure (S6.2 of H-M1's review): every stream has a window (`init`'s `window`, 2 MiB by default) each way
//! across the pipe, so neither process buffers without bound.
//! * Writes: the core keeps at most a window of a stream's bytes sent here and not yet taken by QUIC. Each data frame's
//!   bytes are credited back (`2`) once `write_all` has handed them to QUIC, which waits while the peer's flow control
//!   or the connection's send window is full; so a blocked QUIC send side stops the core's writes.
//! * Reads: this side reads a stream from QUIC only while the core has credit for it (the window, then what the core
//!   credits back as its reader takes the bytes). Bytes not read stay in QUIC's receive buffer, whose flow control then
//!   holds the peer back.
//! * The `out` channel to stdout is unbounded in type, but every byte on it is a stream's data under its credit, or a
//!   small event.
//!
//! Congestion control and windows (§8.3): quinn's BBR (`bbr.rs`) by default, its window sized to 1.25 times each
//! path's bandwidth-delay product. QUIC's flow-control windows can't do that sizing: they are set per connection
//! before any path is measured, can't be changed per stream after, and noq caps how big a stream's may safely be
//! (`QUIC_STREAM_WINDOW`). `init`'s `congestion: "cubic"` keeps noq's default instead, for live gate 1's comparison.
//!
//! What the owner decided for edit 6 (items 79-81): presence on n0's relays is accepted and QUIC address discovery is
//! on (iroh's default relays carry it); only a device without an account publishes to n0's address lookup, and then the
//! relay URL only (`PkarrPublisher`'s default filter); UPnP, NAT-PMP and PCP stay off (no firewall prompt, S1). The
//! lookup switches on and off while running (`n0Lookup`), so signing in or out needs no restart. Connections on the
//! link ALPN from keys the core hasn't allowed are closed at once (`allow`, also in `init`; the list starts empty), and
//! a revoked device's with "revoked", so it stops re-dialling; the core checks again.
//!
//! Hooks the other lanes fill (the sidecar holds the device key): lane C's fence wraps how the core spawns it (it needs
//! only UDP, its stdin and stdout); lane M signs the binary and ships it beside the core.

mod bbr;

use std::{
    collections::{HashMap, HashSet},
    io::Write,
    net::SocketAddr,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use iroh::{
    address_lookup::AddressLookupBuilder,
    endpoint::{Connection, ConnectionError, ReadError, RecvStream, SendStream, VarInt, WriteError},
};
use n0_future::StreamExt;
use serde_json::{json, Value};
use tokio::{
    io::AsyncReadExt,
    sync::{mpsc, oneshot, Mutex, Semaphore},
};

const T_JSON: u8 = 0;
const T_DATA: u8 = 1;
const T_CREDIT: u8 = 2;
const MAX_FRAME: usize = 16 * 1024 * 1024 + 16;
const LINK_ALPN: &str = "clover/link/1";
const CLOSE_UNPAIRED: u32 = 2;
const CLOSE_REVOKED: u32 = 3;
const RESET_ABORTED: u32 = 1;
const RESET_CONN_LOST: u32 = 3;
/// A stream's window across the pipe when `init` names none (the core's `STREAM_WINDOW`).
const DEFAULT_WINDOW: usize = 2 * 1024 * 1024;
/// The most read from QUIC at once for the core.
const READ_CHUNK: usize = 64 * 1024;
/// QUIC's per-stream receive window: noq's own 1.25 MB, and no more. noq 1.4.0's receive assembler keeps each
/// full-packet chunk apart, compacts a stream holding over 2048 of them, and closes the whole connection
/// (INTERNAL_ERROR "too many gaps in stream buffer") if over 1024 remain; a bigger window lets a reader that pauses,
/// or one lost packet on a long fat path, cross that. So one stream stays capped at about 1.25 MB per round trip (S1's
/// 8 MB/s at 150 ms) until noq lifts the limit; what a path has in flight is the congestion window's to size.
const QUIC_STREAM_WINDOW: u32 = 1_250_000;
/// QUIC's per-connection receive window: room for many streams whose readers are slow, so they can't hold up the
/// control lanes, and a bound on what one peer can make this side buffer.
const QUIC_CONN_WINDOW: u32 = 32 * 1024 * 1024;
/// What one connection keeps sent and unacknowledged: the congestion window's ceiling.
const QUIC_SEND_WINDOW: u64 = bbr::WINDOW_CEILING;

enum Out {
    Json(Value),
    Data(u64, Vec<u8>),
    Credit(u64, u32),
}

enum StreamCmd {
    Write(Vec<u8>),
    Finish,
}

/// One stream: what the main loop and the control ops reach of its two tasks (one owns the send half, one the
/// receive half).
struct StreamEntry {
    conn: u64,
    cmds: mpsc::UnboundedSender<StreamCmd>,
    /// The core's writes queued here, not yet taken by QUIC; the core keeps them under the window.
    queued: Arc<AtomicUsize>,
    /// Bytes the core will still take of this stream's incoming data.
    credit: Arc<Semaphore>,
    /// The core's reset (with its code), to each task: it doesn't wait behind queued writes. Dropping them, as a
    /// closed connection does, ends both tasks too.
    stop: Option<oneshot::Sender<u32>>,
    reset: Option<oneshot::Sender<u32>>,
}

impl StreamEntry {
    fn reset(&mut self, code: u32) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(code);
        }
        if let Some(reset) = self.reset.take() {
            let _ = reset.send(code);
        }
    }
}

/// The receiving halves a stream's tasks take.
struct StreamHalves {
    rx: mpsc::UnboundedReceiver<StreamCmd>,
    stop: oneshot::Receiver<u32>,
    reset: oneshot::Receiver<u32>,
    queued: Arc<AtomicUsize>,
    credit: Arc<Semaphore>,
    /// The tasks still running; the last one out removes the entry, so a stream stays writable after the peer's FIN.
    live: Arc<AtomicU8>,
}

struct Sidecar {
    ep: iroh::Endpoint,
    out: mpsc::UnboundedSender<Out>,
    /// Stream bytes on `out` not yet written to stdout.
    out_bytes: Arc<AtomicUsize>,
    window: usize,
    congestion: &'static str,
    n0_lookup: AtomicBool,
    conns: Mutex<HashMap<u64, Connection>>,
    /// Codes this side closed a connection with, for its `closed` event.
    local_close: Mutex<HashMap<u64, (u32, String)>>,
    streams: Mutex<HashMap<u64, StreamEntry>>,
    /// The paired devices' keys; it starts as `init` says (empty at first), so nothing gets in before the core says
    /// who may.
    allow: Mutex<HashSet<[u8; 32]>>,
    /// Revoked devices' keys: closed with "revoked", so the other side stops re-dialling.
    revoked: Mutex<HashSet<[u8; 32]>>,
    next_conn: AtomicU64,
    /// Streams this side accepts get odd ids; the core picks even ones for those it opens.
    next_stream: AtomicU64,
}

fn emit(out: &mpsc::UnboundedSender<Out>, v: Value) {
    let _ = out.send(Out::Json(v));
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex32(s: &str) -> Result<[u8; 32]> {
    if s.len() != 64 {
        bail!("a key is 32 bytes of hex");
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).context("a key is hex")?;
    }
    Ok(out)
}

fn keys(v: &Value) -> Result<HashSet<[u8; 32]>> {
    let mut set = HashSet::new();
    for k in v.as_array().into_iter().flatten().filter_map(|v| v.as_str()) {
        set.insert(unhex32(k)?);
    }
    Ok(set)
}

fn is_lan(addr: &SocketAddr) -> bool {
    match addr {
        SocketAddr::V4(a) => {
            let ip = a.ip();
            ip.is_private() || ip.is_loopback() || ip.is_link_local()
        }
        SocketAddr::V6(a) => {
            let ip = a.ip();
            ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

fn kind_of(addr: &iroh::TransportAddr) -> &'static str {
    match addr {
        iroh::TransportAddr::Ip(addr) => {
            if is_lan(addr) {
                "lan"
            } else {
                "direct"
            }
        }
        iroh::TransportAddr::Relay(_) => "relay",
        _ => "direct",
    }
}

/// The path a connection's traffic takes now: `lan`, `direct` or `relay`, its round trip and its relay.
fn path_of(conn: &Connection) -> Value {
    let paths = conn.paths();
    let Some(p) = paths.iter().find(|p| p.is_selected()) else { return json!({ "kind": "relay" }) };
    let rtt = (p.rtt().as_secs_f64() * 10_000.0).round() / 10.0;
    match p.remote_addr() {
        iroh::TransportAddr::Relay(url) => json!({ "kind": "relay", "rttMs": rtt, "relay": url.to_string() }),
        other => json!({ "kind": kind_of(other), "rttMs": rtt }),
    }
}

/// Every open path of a connection, with what its congestion controller makes of it (`stats`).
fn paths_detail(conn: &Connection) -> Vec<Value> {
    let paths = conn.paths();
    paths
        .iter()
        .map(|p| {
            let s = p.stats();
            let cc = conn
                .congestion_state(p.id())
                .and_then(|c| c.into_any().downcast::<bbr::Bbr>().ok())
                .map(|b| b.snapshot())
                .unwrap_or(Value::Null);
            json!({
                "selected": p.is_selected(),
                "kind": kind_of(p.remote_addr()),
                "rttUs": s.rtt.as_micros() as u64,
                "cwnd": s.cwnd,
                "bandwidth": s.bandwidth_estimate.map(|b| b / 8),
                "lostPackets": s.lost_packets,
                "bbr": cc,
            })
        })
        .collect()
}

impl Sidecar {
    async fn bind(init: &Value, out: mpsc::UnboundedSender<Out>, out_bytes: Arc<AtomicUsize>) -> Result<Arc<Self>> {
        let seed = unhex32(init["seed"].as_str().ok_or_else(|| anyhow!("init needs the seed"))?)?;
        let secret = iroh::SecretKey::from_bytes(&seed);
        let alpns: Vec<Vec<u8>> = init["alpns"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.as_bytes().to_vec())).collect())
            .unwrap_or_else(|| vec![LINK_ALPN.as_bytes().to_vec()]);
        let window = init["window"].as_u64().map(|w| w.clamp(64 * 1024, 64 * 1024 * 1024) as usize).unwrap_or(DEFAULT_WINDOW);
        let congestion = match init["congestion"].as_str() {
            None | Some("bbr") => "bbr",
            Some("cubic") => "cubic",
            Some(other) => bail!("unknown congestion controller {other}"),
        };
        let mut tc = iroh::endpoint::QuicTransportConfig::builder()
            .stream_receive_window(VarInt::from_u32(QUIC_STREAM_WINDOW))
            .receive_window(VarInt::from_u32(QUIC_CONN_WINDOW))
            .send_window(QUIC_SEND_WINDOW);
        if congestion == "bbr" {
            tc = tc.congestion_controller_factory(Arc::new(bbr::BbrConfig::default()));
        }
        let mut builder = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
            .secret_key(secret)
            .alpns(alpns)
            .transport_config(tc.build())
            .portmapper_config(iroh::endpoint::PortmapperConfig::Disabled);
        builder = match &init["relay"] {
            Value::String(s) if s == "disabled" => builder.relay_mode(iroh::RelayMode::Disabled),
            Value::String(s) if s == "default" || s.is_empty() => builder.relay_mode(iroh::RelayMode::Default),
            Value::String(url) => {
                let url: iroh::RelayUrl = url.parse().context("relay url")?;
                builder.relay_mode(iroh::RelayMode::Custom(iroh::RelayMap::from(iroh::RelayConfig::new(url, None))))
            }
            _ => builder.relay_mode(iroh::RelayMode::Default),
        };
        if let Some(bind) = init["bind"].as_str() {
            let addr: SocketAddr = bind.parse().context("bind address")?;
            builder = builder.clear_ip_transports().bind_addr(addr)?;
        }
        let ep = builder.bind().await.context("bind the iroh endpoint")?;
        let sidecar = Arc::new(Sidecar {
            ep,
            out,
            out_bytes,
            window,
            congestion,
            n0_lookup: AtomicBool::new(false),
            conns: Mutex::new(HashMap::new()),
            local_close: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
            // A restart's `init` carries the last lists, so a paired device that dials in at once isn't refused.
            allow: Mutex::new(keys(&init["allow"])?),
            revoked: Mutex::new(keys(&init["revoked"])?),
            next_conn: AtomicU64::new(1),
            next_stream: AtomicU64::new(1),
        });
        sidecar.set_n0_lookup(init["n0Lookup"].as_bool() == Some(true))?;
        Ok(sidecar)
    }

    /// Publishes to n0's address lookup, and resolves through it, or stops (items 79-81: only a device without an
    /// account). iroh takes and drops lookup services on a running endpoint, so this needs no restart.
    fn set_n0_lookup(&self, on: bool) -> Result<()> {
        if self.n0_lookup.swap(on, Ordering::AcqRel) == on {
            return Ok(());
        }
        let lookup = self.ep.address_lookup().map_err(|e| anyhow!("{e}"))?;
        if on {
            // The relay URL only, the publisher's default filter.
            let err = |e: iroh::address_lookup::AddressLookupBuilderError| anyhow!("{e}");
            lookup.add(iroh::address_lookup::PkarrPublisher::n0_dns().into_address_lookup(&self.ep).map_err(err)?);
            lookup.add(iroh::address_lookup::PkarrResolver::n0_dns().into_address_lookup(&self.ep).map_err(err)?);
            lookup.add(iroh::address_lookup::DnsAddressLookup::n0_dns().into_address_lookup(&self.ep).map_err(err)?);
        } else {
            // These three are the only services (the Minimal preset adds none); dropping the publisher ends its task.
            lookup.clear();
        }
        Ok(())
    }

    fn ready(&self) -> Value {
        let addr = self.ep.addr();
        json!({
            "ev": "ready",
            "publicKey": hex(self.ep.id().as_bytes()),
            "relay": addr.relay_urls().next().map(|u| u.to_string()),
            "bound": self.ep.bound_sockets().iter().map(|a| a.to_string()).collect::<Vec<_>>(),
            "congestion": self.congestion,
            "window": self.window,
        })
    }

    /// Registers a connection, tells the core (`first`, given the id), and only then starts its watchers, so the core
    /// knows the connection before any of its streams.
    async fn adopt(self: &Arc<Self>, conn: Connection, first: impl FnOnce(u64) -> Value) -> u64 {
        let id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        self.conns.lock().await.insert(id, conn.clone());
        emit(&self.out, first(id));
        let me = self.clone();
        let c = conn.clone();
        tokio::spawn(async move {
            while let Ok((send, recv)) = c.accept_bi().await {
                let sid = me.next_stream.fetch_add(2, Ordering::Relaxed);
                let halves = me.register(sid, id).await;
                // The core hears of the stream before its first bytes.
                emit(&me.out, json!({ "ev": "stream", "conn": id, "stream": sid }));
                me.run_stream(sid, send, recv, halves);
            }
        });
        let me = self.clone();
        let c = conn.clone();
        tokio::spawn(async move {
            let mut last = Value::Null;
            let mut paths = c.paths_stream();
            while paths.next().await.is_some() {
                let now = path_of(&c);
                if now["kind"] != last["kind"] || now["relay"] != last["relay"] {
                    emit(&me.out, json!({ "ev": "path", "conn": id, "path": now }));
                    last = now;
                }
            }
        });
        let me = self.clone();
        tokio::spawn(async move {
            let why = conn.closed().await;
            me.conns.lock().await.remove(&id);
            // Its streams go with it: their tasks may be waiting on the core, not on QUIC, and wouldn't see the close.
            me.streams.lock().await.retain(|_, s| s.conn != id);
            let mine = me.local_close.lock().await.remove(&id);
            let (code, reason, local) = match (mine, why) {
                (Some((code, reason)), _) => (code, reason, true),
                (None, ConnectionError::ApplicationClosed(c)) => {
                    (u32::try_from(c.error_code.into_inner()).unwrap_or(5), String::from_utf8_lossy(&c.reason).into_owned(), false)
                }
                (None, ConnectionError::LocallyClosed) => (0, "closed".into(), true),
                (None, other) => (5, other.to_string(), false),
            };
            emit(&me.out, json!({ "ev": "closed", "conn": id, "code": code, "reason": reason, "local": local }));
        });
        id
    }

    /// A stream's entry, registered before its QUIC stream is open so the core's writes queue in order.
    async fn register(&self, sid: u64, conn: u64) -> StreamHalves {
        let (cmds, rx) = mpsc::unbounded_channel::<StreamCmd>();
        let (stop_tx, stop) = oneshot::channel();
        let (reset_tx, reset) = oneshot::channel();
        let queued = Arc::new(AtomicUsize::new(0));
        let credit = Arc::new(Semaphore::new(self.window));
        let live = Arc::new(AtomicU8::new(2));
        self.streams.lock().await.insert(
            sid,
            StreamEntry { conn, cmds, queued: queued.clone(), credit: credit.clone(), stop: Some(stop_tx), reset: Some(reset_tx) },
        );
        StreamHalves { rx, stop, reset, queued, credit, live }
    }

    /// One of a stream's two tasks is done; the second removes its entry.
    async fn task_done(&self, sid: u64, live: &AtomicU8) {
        if live.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.streams.lock().await.remove(&sid);
        }
    }

    async fn accept_loop(self: Arc<Self>) {
        while let Some(incoming) = self.ep.accept().await {
            let me = self.clone();
            tokio::spawn(async move {
                let Ok(accepting) = incoming.accept() else { return };
                let Ok(conn) = accepting.await else { return };
                let alpn = String::from_utf8_lossy(conn.alpn()).into_owned();
                let peer = *conn.remote_id().as_bytes();
                if alpn == LINK_ALPN {
                    if me.revoked.lock().await.contains(&peer) {
                        conn.close(VarInt::from_u32(CLOSE_REVOKED), b"the device was revoked");
                        return;
                    }
                    if !me.allow.lock().await.contains(&peer) {
                        conn.close(VarInt::from_u32(CLOSE_UNPAIRED), b"not a paired device");
                        return;
                    }
                }
                let path = path_of(&conn);
                me.adopt(conn, |id| json!({ "ev": "incoming", "conn": id, "peerKey": hex(&peer), "alpn": alpn, "path": path })).await;
            });
        }
    }

    async fn dial(self: Arc<Self>, m: Value) {
        let req = m["id"].clone();
        let result: Result<Connection> = async {
            let key = iroh::PublicKey::from_bytes(&unhex32(m["key"].as_str().unwrap_or_default())?)?;
            let alpn = m["alpn"].as_str().unwrap_or(LINK_ALPN).to_string();
            let direct_only = m["directOnly"].as_bool() == Some(true);
            let mut addrs: Vec<iroh::TransportAddr> = Vec::new();
            for list in ["lan", "direct"] {
                for a in m[list].as_array().into_iter().flatten().filter_map(|v| v.as_str()) {
                    if let Ok(sa) = SocketAddr::from_str(a) {
                        addrs.push(iroh::TransportAddr::Ip(sa));
                    }
                }
            }
            if !direct_only {
                if let Some(url) = m["relay"].as_str() {
                    addrs.push(iroh::TransportAddr::Relay(url.parse().context("relay url")?));
                }
            }
            let timeout = Duration::from_millis(m["timeoutMs"].as_u64().unwrap_or(10_000));
            Ok(tokio::time::timeout(timeout, self.ep.connect(iroh::EndpointAddr::from_parts(key, addrs), alpn.as_bytes()))
                .await
                .map_err(|_| anyhow!("no path answered in time"))??)
        }
        .await;
        match result {
            Ok(conn) => {
                let path = path_of(&conn);
                self.adopt(conn, |id| json!({ "ev": "dialed", "id": req, "conn": id, "path": path })).await;
            }
            Err(e) => emit(&self.out, json!({ "ev": "dialFailed", "id": req, "error": e.to_string() })),
        }
    }

    async fn control(self: &Arc<Self>, m: Value) -> Result<bool> {
        match m["op"].as_str().unwrap_or_default() {
            "dial" => {
                tokio::spawn(self.clone().dial(m));
            }
            "open" => {
                let cid = m["conn"].as_u64().unwrap_or(0);
                let conn = self.conns.lock().await.get(&cid).cloned();
                let sid = m["stream"].as_u64().unwrap_or(0);
                let priority = m["priority"].as_i64().unwrap_or(0) as i32;
                match conn {
                    Some(c) => {
                        let halves = self.register(sid, cid).await;
                        let me = self.clone();
                        tokio::spawn(async move {
                            match c.open_bi().await {
                                Ok((send, recv)) => {
                                    let _ = send.set_priority(priority);
                                    me.run_stream(sid, send, recv, halves);
                                }
                                Err(_) => {
                                    me.streams.lock().await.remove(&sid);
                                    emit(&me.out, json!({ "ev": "reset", "stream": sid, "code": RESET_CONN_LOST }));
                                }
                            }
                        });
                    }
                    None => emit(&self.out, json!({ "ev": "reset", "stream": sid, "code": RESET_CONN_LOST })),
                }
            }
            "finish" => {
                let sid = m["stream"].as_u64().unwrap_or(0);
                if let Some(s) = self.streams.lock().await.get(&sid) {
                    let _ = s.cmds.send(StreamCmd::Finish);
                }
            }
            "reset" => {
                // Both ways at once: the send half is reset, and the reader stops the receive half.
                let sid = m["stream"].as_u64().unwrap_or(0);
                let code = m["code"].as_u64().unwrap_or(RESET_ABORTED as u64) as u32;
                if let Some(s) = self.streams.lock().await.get_mut(&sid) {
                    s.reset(code);
                }
            }
            "close" => {
                let id = m["conn"].as_u64().unwrap_or(0);
                if let Some(c) = self.conns.lock().await.get(&id).cloned() {
                    let code = m["code"].as_u64().unwrap_or(0) as u32;
                    let reason = m["reason"].as_str().unwrap_or_default().to_string();
                    self.local_close.lock().await.insert(id, (code, reason.clone()));
                    c.close(VarInt::from_u32(code), reason.as_bytes());
                }
            }
            "allow" => {
                let set = keys(&m["keys"])?;
                let gone = keys(&m["revoked"])?;
                *self.allow.lock().await = set;
                *self.revoked.lock().await = gone;
            }
            "n0Lookup" => self.set_n0_lookup(m["on"].as_bool() == Some(true))?,
            "networkChanged" => {
                let me = self.clone();
                tokio::spawn(async move { me.ep.network_change().await });
            }
            "netReport" => {
                use iroh::Watcher;
                let report = self.ep.net_report().get();
                let mapping = match report.as_ref().and_then(|r| r.mapping_varies_by_dest_ipv4) {
                    Some(false) => "same",
                    Some(true) => "varies",
                    None => "unknown",
                };
                let addr = self.ep.addr();
                emit(&self.out, json!({
                    "ev": "netReport", "id": m["id"].clone(), "mapping": mapping,
                    "globalV4": report.as_ref().and_then(|r| r.global_v4).map(|a| a.to_string()),
                    "relay": addr.relay_urls().next().map(|u| u.to_string()),
                    "direct": addr.ip_addrs().map(|a| a.to_string()).collect::<Vec<_>>(),
                }));
            }
            "stats" => {
                // What this side holds for the core and for QUIC, and each path's congestion state (diagnostics and
                // the backpressure tests).
                let (streams, queued, unconsumed) = {
                    let s = self.streams.lock().await;
                    let queued: usize = s.values().map(|e| e.queued.load(Ordering::Relaxed)).sum();
                    let unconsumed: usize = s.values().map(|e| self.window.saturating_sub(e.credit.available_permits())).sum();
                    (s.len(), queued, unconsumed)
                };
                let conns: Vec<Value> = {
                    let c = self.conns.lock().await;
                    c.iter().map(|(id, conn)| json!({ "conn": id, "paths": paths_detail(conn) })).collect()
                };
                emit(&self.out, json!({
                    "ev": "stats", "id": m["id"].clone(), "congestion": self.congestion, "window": self.window,
                    "quic": { "streamWindow": QUIC_STREAM_WINDOW, "connWindow": QUIC_CONN_WINDOW, "sendWindow": QUIC_SEND_WINDOW,
                              "windowFloor": bbr::WINDOW_FLOOR, "windowCeiling": bbr::WINDOW_CEILING, "windowGain": bbr::WINDOW_GAIN },
                    "streams": streams, "queuedWrites": queued, "unconsumed": unconsumed,
                    "outBytes": self.out_bytes.load(Ordering::Relaxed), "conns": conns,
                }));
            }
            "shutdown" => return Ok(false),
            other => emit(&self.out, json!({ "ev": "error", "message": format!("unknown op {other}") })),
        }
        Ok(true)
    }

    /// The core's bytes for a stream, under its window.
    async fn data(&self, sid: u64, bytes: &[u8]) {
        let mut streams = self.streams.lock().await;
        let Some(s) = streams.get_mut(&sid) else { return };
        let queued = s.queued.fetch_add(bytes.len(), Ordering::AcqRel) + bytes.len();
        if queued > self.window + MAX_FRAME {
            // The core wrote past the window: end the stream rather than buffer without bound.
            s.queued.fetch_sub(bytes.len(), Ordering::AcqRel);
            s.reset(RESET_ABORTED);
            emit(&self.out, json!({ "ev": "error", "message": format!("stream {sid} was written past its window") }));
            emit(&self.out, json!({ "ev": "reset", "stream": sid, "code": RESET_ABORTED }));
            return;
        }
        let _ = s.cmds.send(StreamCmd::Write(bytes.to_vec()));
    }

    /// The core took `n` more bytes of a stream: this side may read that many more from QUIC.
    async fn credit(&self, sid: u64, n: usize) {
        if let Some(s) = self.streams.lock().await.get(&sid) {
            s.credit.add_permits(n.min(self.window));
        }
    }

    fn run_stream(self: &Arc<Self>, sid: u64, mut send: SendStream, mut recv: RecvStream, h: StreamHalves) {
        let StreamHalves { mut rx, mut stop, mut reset, queued, credit, live } = h;
        let me = self.clone();
        let live_w = live.clone();
        // The writer: the core's writes in order, each credited back once QUIC has taken it. A reset cuts in, even
        // while a write waits on a peer that doesn't read.
        tokio::spawn(async move {
            loop {
                let cmd = tokio::select! {
                    biased;
                    code = &mut reset => {
                        if let Ok(code) = code {
                            let _ = send.reset(VarInt::from_u32(code));
                        }
                        break;
                    }
                    cmd = rx.recv() => match cmd {
                        Some(cmd) => cmd,
                        None => break,
                    },
                };
                match cmd {
                    StreamCmd::Write(data) => {
                        let n = data.len();
                        let r = tokio::select! {
                            biased;
                            code = &mut reset => {
                                queued.fetch_sub(n, Ordering::AcqRel);
                                if let Ok(code) = code {
                                    let _ = send.reset(VarInt::from_u32(code));
                                }
                                break;
                            }
                            r = send.write_all(&data) => r,
                        };
                        queued.fetch_sub(n, Ordering::AcqRel);
                        match r {
                            Ok(()) => {
                                let _ = me.out.send(Out::Credit(sid, n as u32));
                            }
                            Err(e) => {
                                let code = match e {
                                    WriteError::Stopped(code) => u32::try_from(code.into_inner()).unwrap_or(RESET_CONN_LOST),
                                    _ => RESET_CONN_LOST,
                                };
                                emit(&me.out, json!({ "ev": "reset", "stream": sid, "code": code }));
                                break;
                            }
                        }
                    }
                    StreamCmd::Finish => {
                        let _ = send.finish();
                        break;
                    }
                }
            }
            // Writes still queued are dropped with the stream; they no longer count as held.
            while let Ok(cmd) = rx.try_recv() {
                if let StreamCmd::Write(data) = cmd {
                    queued.fetch_sub(data.len(), Ordering::AcqRel);
                }
            }
            me.task_done(sid, &live_w).await;
        });
        let me = self.clone();
        // The reader: from QUIC only as far as the core's credit goes. While it waits for credit it still hears the
        // peer's reset, which QUIC would otherwise report only at the next read.
        tokio::spawn(async move {
            let mut may_reset = true;
            loop {
                let want = tokio::select! {
                    code = &mut stop => {
                        if let Ok(code) = code {
                            let _ = recv.stop(VarInt::from_u32(code));
                        }
                        break;
                    }
                    r = recv.received_reset(), if may_reset => match r {
                        Ok(Some(code)) => {
                            emit(&me.out, json!({ "ev": "reset", "stream": sid, "code": u32::try_from(code.into_inner()).unwrap_or(RESET_CONN_LOST) }));
                            break;
                        }
                        // Everything has arrived: no reset can come now, only the core's credit matters.
                        Ok(None) => {
                            may_reset = false;
                            continue;
                        }
                        Err(_) => {
                            emit(&me.out, json!({ "ev": "reset", "stream": sid, "code": RESET_CONN_LOST }));
                            break;
                        }
                    },
                    p = credit.acquire() => match p {
                        Ok(p) => {
                            p.forget();
                            let more = credit.available_permits().min(READ_CHUNK - 1);
                            if more > 0 {
                                if let Ok(p) = credit.try_acquire_many(more as u32) {
                                    p.forget();
                                }
                            }
                            1 + more
                        }
                        Err(_) => break,
                    },
                };
                let read = tokio::select! {
                    code = &mut stop => {
                        if let Ok(code) = code {
                            let _ = recv.stop(VarInt::from_u32(code));
                        }
                        break;
                    }
                    r = recv.read_chunk(want) => r,
                };
                match read {
                    Ok(Some(chunk)) => {
                        if chunk.len() < want {
                            credit.add_permits(want - chunk.len());
                        }
                        me.out_bytes.fetch_add(chunk.len(), Ordering::AcqRel);
                        // `Bytes` into a `Vec` keeps the buffer when it is the only owner.
                        let _ = me.out.send(Out::Data(sid, chunk.into()));
                    }
                    Ok(None) => {
                        emit(&me.out, json!({ "ev": "fin", "stream": sid }));
                        break;
                    }
                    Err(ReadError::Reset(code)) => {
                        emit(&me.out, json!({ "ev": "reset", "stream": sid, "code": u32::try_from(code.into_inner()).unwrap_or(RESET_CONN_LOST) }));
                        break;
                    }
                    Err(_) => {
                        emit(&me.out, json!({ "ev": "reset", "stream": sid, "code": RESET_CONN_LOST }));
                        break;
                    }
                }
            }
            me.task_done(sid, &live).await;
        });
    }
}

async fn read_frame(input: &mut tokio::io::Stdin, buf: &mut Vec<u8>) -> Result<bool> {
    let mut len = [0u8; 4];
    if input.read_exact(&mut len).await.is_err() {
        return Ok(false);
    }
    let n = u32::from_be_bytes(len) as usize;
    if n == 0 || n > MAX_FRAME {
        bail!("a frame of {n} bytes");
    }
    buf.resize(n, 0);
    input.read_exact(buf).await?;
    Ok(true)
}

fn writer(mut rx: mpsc::UnboundedReceiver<Out>, out_bytes: Arc<AtomicUsize>) {
    let stdout = std::io::stdout();
    let mut w = std::io::BufWriter::with_capacity(1 << 20, stdout.lock());
    while let Some(first) = rx.blocking_recv() {
        let mut next = Some(first);
        while let Some(o) = next {
            let ok = match o {
                Out::Json(v) => {
                    let body = v.to_string();
                    w.write_all(&(body.len() as u32 + 1).to_be_bytes())
                        .and_then(|_| w.write_all(&[T_JSON]))
                        .and_then(|_| w.write_all(body.as_bytes()))
                }
                Out::Data(sid, data) => {
                    let r = w
                        .write_all(&(data.len() as u32 + 9).to_be_bytes())
                        .and_then(|_| w.write_all(&[T_DATA]))
                        .and_then(|_| w.write_all(&sid.to_be_bytes()))
                        .and_then(|_| w.write_all(&data));
                    out_bytes.fetch_sub(data.len(), Ordering::AcqRel);
                    r
                }
                Out::Credit(sid, n) => w
                    .write_all(&13u32.to_be_bytes())
                    .and_then(|_| w.write_all(&[T_CREDIT]))
                    .and_then(|_| w.write_all(&sid.to_be_bytes()))
                    .and_then(|_| w.write_all(&n.to_be_bytes())),
            };
            if ok.is_err() {
                return;
            }
            next = rx.try_recv().ok();
        }
        if w.flush().is_err() {
            return;
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let (tx, rx) = mpsc::unbounded_channel::<Out>();
    let out_bytes = Arc::new(AtomicUsize::new(0));
    let writer_bytes = out_bytes.clone();
    let writer = std::thread::spawn(move || writer(rx, writer_bytes));
    let mut input = tokio::io::stdin();
    let mut buf = Vec::new();
    // The first frame is `init`, with the seed: nothing binds before the key is here.
    if !read_frame(&mut input, &mut buf).await? || buf[0] != T_JSON {
        bail!("expected init on stdin");
    }
    let init: Value = serde_json::from_slice(&buf[1..])?;
    buf.iter_mut().for_each(|b| *b = 0);
    if init["op"] != "init" {
        bail!("expected init on stdin");
    }
    let sidecar = match Sidecar::bind(&init, tx.clone(), out_bytes).await {
        Ok(s) => s,
        Err(e) => {
            emit(&tx, json!({ "ev": "error", "message": e.to_string(), "fatal": true }));
            drop(tx);
            let _ = writer.join();
            std::process::exit(1);
        }
    };
    drop(init);
    emit(&tx, sidecar.ready());
    tokio::spawn(sidecar.clone().accept_loop());
    loop {
        match read_frame(&mut input, &mut buf).await {
            Ok(true) => {}
            _ => break,
        }
        match buf[0] {
            T_JSON => {
                let Ok(m) = serde_json::from_slice::<Value>(&buf[1..]) else { continue };
                match sidecar.control(m).await {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(e) => emit(&tx, json!({ "ev": "error", "message": e.to_string() })),
                }
            }
            T_DATA if buf.len() >= 9 => {
                let sid = u64::from_be_bytes(buf[1..9].try_into().unwrap());
                sidecar.data(sid, &buf[9..]).await;
            }
            T_CREDIT if buf.len() >= 13 => {
                let sid = u64::from_be_bytes(buf[1..9].try_into().unwrap());
                let n = u32::from_be_bytes(buf[9..13].try_into().unwrap()) as usize;
                sidecar.credit(sid, n).await;
            }
            _ => {}
        }
    }
    // The core went away or asked to stop: close every connection, tell the relays, and exit.
    let _ = tokio::time::timeout(Duration::from_secs(3), sidecar.ep.close()).await;
    emit(&tx, json!({ "ev": "stopped" }));
    drop(tx);
    // Tasks still hold senders; give the writer a moment to flush the last events, then go.
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(writer);
    std::process::exit(0);
}
