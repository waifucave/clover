# S1, the transport: lab results

Lane H, milestone M0: the lab half of spike S1 (spec §8.2, §8.3 and §14.1 item 1; plan §4 lane H). November 5, 2026.

Code: [`spikes/s1-transport/`](../../spikes/s1-transport/README.md) (the Bun side, the network labs, the CI glue) and [`native/link-sidecar/`](../../native/link-sidecar/) (the native half: quinn and iroh peers, a STUN responder, a stdio sidecar). CI: `.github/workflows/spike-s1.yml` on `lane/h-m0`, runs [1](https://github.com/waifucave/clover/actions/runs/41942502147), [2](https://github.com/waifucave/clover/actions/runs/41943850278), [3](https://github.com/waifucave/clover/actions/runs/41945403885) and [4](https://github.com/waifucave/clover/actions/runs/41948554183); each run's artifacts hold its result files, and [`spikes/s1-transport/results/2026-11-05/`](../../spikes/s1-transport/results/2026-11-05/) keeps the ones the tables below cite (runs 3 and 4). The runs on real networks, and how often traffic falls back to n0's relays, wait for live gate 1.

## Verdicts

| # | Question | Verdict | Key numbers |
| :- | :- | :- | :- |
| 1 | iroh or plain QUIC (quinn) between a user's computers | **iroh.** The two are equally fast and punch the same NATs. quinn would mean rebuilding iroh's identity, relay fallback and discovery, could not use n0's relays, and has no iOS or Bun binding. quinn did follow a new address faster (0.1 s against 6 s), which re-dialling on network changes covers | Native loopback bulk: iroh 130–608 MB/s, quinn 116–559 MB/s, neither ahead on every OS; RPC p50 0.05–0.19 ms against 0.04–0.15 ms; identical NAT matrix |
| 2 | iroh, quinn and WebRTC under Bun and inside `bun build --compile`, on all three OSes | **Works, with limits.** Everything loads and compiles on all four targets. n0's napi binding is too slow for bulk data and makes Bun stop firing timers; a binding that passes buffers fixes both. quinn has no binding: it needs a sidecar or our own addon | iroh napi bulk 18–64 MB/s against native 130–608; a 10 ms timer fired once in 1–3.5 s of transfer; an async buffer-typed napi call costs 22–61 µs and moves 1.1–3.3 GB/s; the sidecar's stdio hop is 0.02–0.06 ms |
| 3 | Punching through routers with no relay | **Works, with limits.** Relay-free iroh connects every NAT pair that can connect without a relay, if each device asks STUN from iroh's own port first and both devices dial at once; a symmetric NAT against a filtering one needs a relay | 13 of 15 NAT pairs direct, the same for quinn; same LAN direct in 1 ms; with only one side dialling, 10 of 25 |
| 4 | Delay and throughput under `tc netem`, prioritised streams | **Works, with limits.** Connecting costs one round trip and a small RPC the network's delay plus well under a millisecond, on both stacks. But stream priorities alone don't keep small messages fast during a transfer, and neither stack's default congestion control copes with a lossy path | Connect 1 RTT + 1–5 ms; RPC p50 1 RTT + < 0.6 ms; during a transfer, prioritised and equal streams measured the same, +1–15 ms at p50 under Cubic and +35–50 ms under quinn's BBR; at 1 % loss and 80 ms, Cubic 0.2–0.5 MB/s and quinn's BBR 4.7 MB/s |
| 5 | WebRTC from a browser to the Bun side | **Works.** Headless Chrome 156 and Firefox 158–159 open data channels to `node-datachannel` under Bun on macOS, Windows and Linux; Lane I can build on [`webrtc-browser.ts`](../../spikes/s1-transport/bun/src/webrtc-browser.ts) | Open 0.15–1.5 s; RTT p50 0.14–0.48 ms; 8–80 MB/s each way; RTT during a parallel upload 6–62 ms (p50) |

Beyond choosing iroh, these results change the spec, and one touches decisions:

* **How clover-core holds iroh** [P]: through a thin napi addon of Clover's own, not n0's binding as it is (Q2).
* **Relay-free iroh needs two things from the handshake** [P]: each device learns its public address with STUN on the port iroh then binds, because iroh has no STUN and learns nothing without a relay, and both devices dial each other at the same moment (Q3).
* **Priorities aren't enough** [P]: the congestion controller and pacing decide how fast control messages stay during a transfer, and how much a lossy path delivers (Q4).
* **Re-dial on every network change and wake** [P]: no existing connection came back quickly from a long outage, and relay-free iroh took 6 s to follow a new address (network changes).
* **Relays on, coordination off them** touches three [D]s (edit 6): iroh sends a dial's first packets over every path it knows, the relay included, so coordination stays off n0's relays only if Clover dials direct first and adds the relay after a head start, which the owner weighs against the fastest connection.

## Where it ran

* **This session ran on the owner's Mac** (M4 Pro, 14 cores, macOS 26.6.1), not in a cloud session as the brief assumed. So local runs were limited to what needs no root and no window: no browser was started here, and nothing touched Winter. Everything that needs Linux networking, root or another OS ran on GitHub Actions: `macos-latest` (arm64), `windows-latest` (x64), `ubuntu-24.04` (x64) and `ubuntu-24.04-arm` (arm64), all four of the daemon's targets (spec §3.1).
* Versions: Bun 1.3.14; Node 24 on CI and 26.7 here, for comparison; iroh 1.4.1 with noq 1.4.0 (n0's quinn fork), both natively and through `@number0/iroh` 1.2.0, which iroh-ffi v1.2.0's lockfile pins to the same iroh; quinn 0.11.12 with rustls 0.23 and ring; `node-datachannel` 0.33.6 (libdatachannel); headless Chrome 156 and Firefox 158–159 as the runners ship them.
* CI numbers come from shared runners and vary between runs by tens of percent; compare within a table, not across runners. The owner's Mac is faster than every runner.

## The bench

One protocol, written twice: in TypeScript for the napi binding ([`iroh-napi.ts`](../../spikes/s1-transport/bun/src/iroh-napi.ts)) and in Rust for native quinn and iroh ([`bench.rs`](../../native/link-sidecar/src/bench.rs)). The first byte of each bidirectional stream picks the server's handler: `E` echoes 64-byte frames, `R` answers one RPC per stream, `S` sinks a bulk transfer and acks its size. The client measures 64-byte round trips on one stream (`rpc`), one stream per RPC (`rpcPerStream`), one large transfer (`bulk`, MB/s, 10^6 bytes), 1 MB transfers one stream each (`screenshot1MB`), and round trips every 5 ms while a bulk transfer runs on the same connection, with the RPC stream at priority 10 or at the bulk's priority 0 (`rpcUnderLoad`). Every check prints one `S1RESULT` JSON line; the per-run files are in each CI run's artifacts.

## Question 2: under Bun and compiled

**Method.** Each check ran under Bun from source, then as a `bun build --compile` binary copied outside the source tree, on all four targets ([`platform-checks.sh`](../../spikes/s1-transport/ci/platform-checks.sh)). The iroh check also ran under Node, and a small napi probe ([`napi-probe/`](../../spikes/s1-transport/napi-probe/)) measured byte passing on its own.

**iroh through `@number0/iroh` 1.2.0**, two endpoints in one process over loopback, relays off:

Ranges cover three CI runs on each target:

| | macOS arm64 | Windows x64 | Linux x64 | Linux arm64 |
| :- | -: | -: | -: | -: |
| loads under Bun / compiled | yes / yes | yes / yes | yes / yes | yes / yes |
| load time, source / compiled (ms) | 10–24 / 25–39 | 8–19 / 147–233 | 5–7 / 11–13 | 5–6 / 11 |
| connect, warm (ms) | 0.60–1.88 | 0.73–1.50 | 0.58–0.90 | 0.80–0.88 |
| RPC p50 / p99 (ms) | 0.14–0.18 / 0.28–1.0 | 0.14–0.39 / 0.38–1.74 | 0.10–0.16 / 0.34–0.52 | 0.22–0.26 / 0.56–0.65 |
| bulk (MB/s), napi | 30–46 | 18–34 | 23–38 | 28–29 |
| bulk (MB/s), native iroh, same runners | 130–181 | 155–363 | 429–608 | 388–423 |
| 1 MB transfer p50 (ms), napi | 22–37 | 29–54 | 26–44 | 35–36 |
| 10 ms timer during bulk: fired / expected | 1–20 / 140–212 | 1 / 188–353 | 1–3 / 167–278 | 1–4 / 224–226 |
| the same, yielding once per write (run 1) | 129 / 139 | 246 / 278 | 164 / 174 | 202 / 231 |
| bulk under Node 24 (MB/s, run 1) | 12.8 | 5.5 | 8.5 | 6.8 |

On the owner's Mac the same check moves 62–64 MB/s, against 263–269 MB/s for native iroh and 290–318 for quinn.

What this shows:

1. **It loads and compiles everywhere.** napi-rs's loader names each platform package literally, so `bun build --compile` embeds the right `.node` by itself. A compiled binary writes that file to a new temporary file on every start: 11–39 ms on the runners, 147–233 ms on Windows, 290–450 ms on the owner's Mac. The same file kept beside the binary and loaded from disk (`NAPI_RS_NATIVE_LIBRARY_PATH`) loads in 4 ms once the OS has seen it.
2. **Its byte API is the bottleneck.** Every `read` and `write` takes or returns `Vec<u8>`, which napi-rs turns into a JS `Array<number>`, one element at a time. The probe puts the cost at 0.5–2.3 ms of JS-thread time per 64 KB under Bun (28–135 MB/s) and 2–10 ms under Node. A `Uint8Array` in costs 1–2 µs, a `Buffer` out 20–27 µs, and either one as an async call 22–61 µs (1.1–3.0 GB/s). So the binding, not iroh or Bun, makes transfers 4–16 times slower than native and holds the daemon's thread while they run.
3. **Bun stops firing timers while napi completions keep arriving.** With a transfer running, a 10 ms interval that should have fired 140–350 times fired 1–20 times, on every OS; under Node it fired on time. The probe reproduces it without iroh: two independent loops of async napi calls whose results each take about a millisecond to convert left a 10 ms timer firing once in 44–90 periods, while lock-step pairs, typed buffers and Node all kept it on time. Bun appears to run every queued native completion before its timers, and two loops keep that queue from emptying. For a daemon whose keep-alives, lease renewals and clock sync are timers (spec §6.4), this matters more than speed. Yielding once per write (`setImmediate`) fixes it at no cost to throughput; a buffer-typed binding avoids it, since each completion is cheap. It is worth reporting to Bun; the controller decides.
4. **node-datachannel loads under Bun on all four targets, and compiles with a 10-line plugin.** Its loader computes the package name, so the bundler can't follow it; [`compile.ts`](../../spikes/s1-transport/bun/scripts/compile.ts) swaps the loader for a literal `require` of this platform's `.node`. Bun to Bun in one process: open 3–55 ms, RTT p50 0.08–0.30 ms, 15–115 MB/s.
5. **quinn has no maintained napi binding.** Under Bun it is reachable only through our own addon or a sidecar. The sidecar prototype (`clover-link-sidecar ipc`, framed echo over stdio) measured, from Bun and from compiled binaries: spawn and first round trip 4–21 ms; 64-byte round trip p50 0.02–0.06 ms (p99 0.4–1.5 ms); 0.5–1.6 GB/s each way; timers unaffected. That confirms the spec's "adds microseconds" for the fallback.
6. **Compiled sizes**: 63–76 MB on macOS, 99–115 MB on Windows, 94–131 MB on Linux, for a binary carrying Bun plus one of these addons (iroh's `.node` alone is 12 MB).

**Verdict: works, with limits.** The limits are the binding's, and a binding of Clover's own removes them: the probe shows buffer-typed calls at 1.1–3.3 GB/s with timers unaffected. M1 starts there (below).

## Question 1: iroh or plain quinn

**Method.** Both stacks run the same Rust bench (release builds), relays off, in one process over loopback on all four targets, then under netem (Q4), through the NAT lab (Q3) and through path changes (below). quinn gets the pieces iroh has built in, written for the spike: a self-signed Ed25519 certificate pinned by its hash on the dialling side ([`link.rs`](../../native/link-sidecar/src/link.rs)), STUN on its own socket, and punch packets from that socket ([`punch.rs`](../../native/link-sidecar/src/punch.rs)).

Native, loopback, relays off, ranges over three CI runs:

| | macOS arm64 | Windows x64 | Linux x64 | Linux arm64 | owner's Mac |
| :- | -: | -: | -: | -: | -: |
| bulk MB/s, quinn / iroh | 116–203 / 130–181 | 175–378 / 155–363 | 401–559 / 429–608 | 456–467 / 388–423 | 290–318 / 263–269 |
| RPC p50 ms, quinn / iroh | 0.06–0.13 / 0.10–0.11 | 0.06–0.15 / 0.06–0.19 | 0.04–0.07 / 0.05–0.08 | 0.09–0.10 / 0.13 | 0.03–0.04 / 0.04 |
| first connect ms, quinn / iroh | 3.7–8.7 / 3.6–9.0 | 1.9–2.8 / 2.5–4.0 | 0.75–0.84 / 1.0–1.6 | 0.88–0.97 / 1.3 | 1.0 / 1.0 |
| warm connect ms, quinn / iroh | 0.41–0.67 / 0.67–0.90 | 0.54–1.14 / 0.72–1.68 | 0.45–0.68 / 0.64–0.92 | 0.61–0.65 / 0.93–1.08 | 0.30 / 0.34 |
| 1 MB transfer p50 ms, quinn / iroh | 4.4–5.2 / 4.6–5.5 | 2.6–5.7 / 2.7–6.5 | 1.9–2.5 / 1.7–2.4 | 2.3–2.4 / 2.4–2.6 | 3.0–3.4 / 3.4 |

The harness handed quinn a socket still in blocking mode in the first two runs; tokio needs it non-blocking. That stalled quinn whenever no packet was arriving, so it slowed quinn's idle wake-ups (connects behind NATs, recovery after blackouts) but hardly its loopback numbers. The third run and every NAT, netem and network-change result below have the fix.

Across a real-looking link the two tie (Q4): the same connect time (one round trip plus 1–5 ms) and the same RPC delay (the round trip plus well under a millisecond) in every netem profile. Where throughput differs, the congestion controller makes the difference, and either stack accepts a different one. Through blackouts iroh came back sooner (below).

Beyond speed:

| | iroh 1.4.1 | quinn 0.11, plus what Clover would build |
| :- | :- | :- |
| Identity | Dials an Ed25519 public key (TLS with raw public keys), which is the device key of spec §8.1 | Certificates pinned by hash; built in the spike, mutual authentication still to write |
| Public address with relays off | None: iroh has no STUN, and its QUIC address discovery (QAD) only runs against relays. STUN on the port before iroh binds it, then `add_external_addr` | STUN on its own socket |
| Punching | NAT traversal rounds inside a connection, so the first path must work on its own; both sides dial at once (Q3) | Punch packets from its own socket, and both sides dial (Q3) |
| Relay fallback | Built in; n0's relays, which spec §8.3 turns on by default [D] | None. n0's relays speak iroh's relay protocol, so quinn could not use them |
| Path changes | Multipath, with paths kept alive every 5 s and dropped after 15 s idle. With relays off it took 6 s to follow a new local address, but came back sooner after long outages (below) | QUIC migration: followed a new client address in 0.1 s |
| iOS | Official Swift bindings; Winter's phone already uses iroh-ffi 1.1.0 | None |
| Bun | n0's napi binding (with Q2's limits); or our own addon | Our own addon, or a sidecar |
| Churn | iroh 1.0 shipped in June 2026 and is at 1.4.1 now; the napi binding is at 1.2.0 | quinn's 0.11 line is stable |

**Verdict: iroh.** Speed doesn't separate them: quinn is ahead on some runners and behind on others, and both are far above what the network delivers once the link leaves the machine (Q4). quinn did better at following a new address (below), and its punch packets saved one retransmission in one NAT pair (Q3), but re-dialling on network changes covers the first and an earlier second dial would cover the other. Everything else favours iroh, and quinn would also break a decision: n0's relays, on by default [D], are iroh relays.

## Question 3: punching with no relay

**Method.** [`nat/matrix.sh`](../../spikes/s1-transport/nat/matrix.sh) builds a small internet from Linux network namespaces on a CI runner: one bridge for the public internet (203.0.113.0/24), a STUN responder on it (RFC 5389, standing in for Cloudflare's and Google's), and two peers, each behind a router namespace whose iptables rules make one NAT type (RFC 4787 terms):

| Type | Mapping | Filtering | How |
| :- | :- | :- | :- |
| public | none | none | the peer sits on the bridge |
| full | endpoint-independent | endpoint-independent | SNAT keeping the port, and DNAT of the peers' ports (full cone) |
| restricted | endpoint-independent | address-dependent | SNAT, plus DNAT only from addresses the inside host has sent to (`xt_recent`) |
| port-restricted | endpoint-independent | address-and-port-dependent | Linux's ordinary SNAT and conntrack, as most home routers behave |
| symmetric | address-and-port-dependent | address-and-port-dependent | SNAT `--random`: a new port for every destination |
| lan | | | both peers on one LAN behind one port-restricted router (the same-Wi-Fi case) |

The routers drop unsolicited UDP silently, every pair starts from fresh namespaces, and nothing relays. The two peers ([`punch.rs`](../../native/link-sidecar/src/punch.rs)) exchange `{identity, candidates}` through a shared folder, the waifucave handshake's job (spec §8.3), where the candidates are the LAN address and the address STUN reported. Then:

* **iroh** (Minimal preset, relays off, no address lookup): the peer binds UDP port P, asks STUN from P, closes the socket, and binds iroh on P, because iroh has no STUN of its own (below). The mapping the query made outlives the socket on any NAT with endpoint-independent mapping.
* **quinn** asks STUN from the socket it then gives quinn, and sends 1-byte punch packets from it every 100 ms to the peer's candidates.
* **Strategy "both"**: each peer dials the other at once and also accepts; the first connection wins. **Strategy "one"**: only peer `a` dials.

Peer `a` then runs 20 RPCs on the connection to prove data flows. The time is from the moment a peer had the other's record to its first connection; the lab's rendezvous polls every 20 ms, which is most of the 22 ms values.

Direct connections, iroh, both peers dialling (time to connect, CI run 2; runs 3 and 4 connected the same pairs, within the 20 ms poll of these times):

| a \ b | public | full | restricted | port-restricted | symmetric |
| :- | :-: | :-: | :-: | :-: | :-: |
| public | 22 ms | 22 ms | 22 ms | 23 ms | 23 ms |
| full | | 22 ms | 1 ms | 23 ms | 23 ms |
| restricted | | | 23 ms | 1 ms | 981 ms |
| port-restricted | | | | 23 ms | **no** |
| symmetric | | | | | **no** |

Same LAN behind one router: direct over the LAN addresses, 1 ms.

quinn with its own STUN and punch packets, both peers dialling, connects exactly the same 13 of 15 pairs and the same LAN case, in 1–22 ms (CI run 4). That includes restricted × symmetric in 22 ms, which took iroh one retransmission: quinn's punch packets had already opened the way. With only one peer dialling, iroh reaches peer `b` only when `b` is public or behind a full cone, 10 of 25 ordered pairs: every other router drops the dial because `b` never sent anything toward `a`.

What this shows:

1. **Relay-free iroh punches everything that can be punched without a relay**, 13 of 15 pairs, the textbook result: only a symmetric NAT against a port-restricted or symmetric one fails, since the symmetric side's port for the peer is one nobody has seen (Linux picks it at random, so no prediction helps).
2. **iroh learns no public address with relays off.** In iroh 1.4.1 an endpoint finds its public address only through QUIC address discovery against its relays (`net_report` builds its probes from the relay map); there is no STUN. So the handshake's STUN has to run from the port iroh will use, before iroh binds it, and Clover should hand the result to iroh with `add_external_addr` so iroh's later NAT-traversal rounds advertise it. On NATs whose mapping depends on the destination (symmetric), no such address exists at all.
3. **Both peers must dial at the same moment.** Before a connection exists, iroh sends its Initial to every address it was given, which opens the dialler's own NAT toward the peer; the peer's NAT lets it in only once the peer has sent something back the other way. So the handshake has to tell both devices to dial each other at once. A pair that took one retransmission (restricted × symmetric, 981 ms) shows why at once matters: the first Initial arrived before the other side's.
4. **The two stacks reach the same pairs.** Punching is a property of the NATs, not of the QUIC library, once both sides have their address and dial together. quinn's punch packets only saved one retransmission; iroh could get the same by dialling a second time a few milliseconds after the first.

**Verdict: works, with limits.** Every pair that can connect without a relay did, given STUN on iroh's port and a simultaneous dial; pairs with a symmetric NAT against a filtering one need a relay. How common those are on real networks is live gate 1's question.

## Question 4: delay and throughput

**Method.** [`nat/netem.sh`](../../spikes/s1-transport/nat/netem.sh) joins two namespaces with one veth pair and puts `tc netem` on both egresses, with its default queue of 1,000 packets. Profiles, each way: **lan** 1 ms, no loss, 1 Gbit/s; **wan** 20 ms, 0.1 % loss, 100 Mbit/s; **lossy** 40 ms, 1 % loss, 50 Mbit/s; **far** 75 ms, 0.5 % loss, 50 Mbit/s. Each runs the bench across the link for quinn and iroh natively, each with Cubic (the default) and with BBR (quinn's BBR, noq's BBRv3), and for iroh through the napi binding in Bun. One run per cell (CI run 3), so read the loss profiles' throughput as an order of magnitude: random loss on a single transfer varies a lot.

| profile | impl | connect ms | RPC p50 / p99 ms | bulk MB/s | 1 MB p50 ms | RPC under load, prioritised p50 / p99 | equal p50 / p99 |
| :- | :- | -: | -: | -: | -: | -: | -: |
| lan | quinn, Cubic | 5.1 | 2.12 / 2.5 | 116 | 10.6 | 9.9 / 10.4 | 10.1 / 10.5 |
| | quinn, BBR | 2.9 | 2.11 / 2.16 | 94 | 10.6 | 10.1 / 10.4 | 9.9 / 10.4 |
| | iroh, Cubic | 3.1 | 2.13 / 2.16 | 116 | 10.6 | 10.0 / 10.5 | 10.0 / 10.5 |
| | iroh, BBRv3 | 3.2 | 2.13 / 2.17 | 99 | 10.6 | 3.4 / 5.0 | 3.9 / 6.3 |
| | iroh napi | 3.8 | 2.20 / 2.4 | 49 | 21.5 | 5.5 / 14 | 4.2 / 12 |
| wan | quinn, Cubic | 41.4 | 40.44 / 40.63 | 6.5 | 406 | 42.2 / 50.1 | 43.3 / 46.7 |
| | quinn, BBR | 41.3 | 40.45 / 40.97 | 10.5 | 125 | 93.6 / 124.6 | 93.6 / 126.2 |
| | iroh, Cubic | 41.5 | 40.42 / 40.59 | 10.2 | 133 | 41.7 / 43.6 | 42.1 / 45.0 |
| | iroh, BBRv3 | 41.6 | 40.42 / 40.64 | 6.7 | 144 | 41.2 / 42.3 | 41.8 / 46.0 |
| | iroh napi | 42.1 | 40.54 / 40.89 | 2.5 | 358 | 43.5 / 54.5 | 43.2 / 52.7 |
| lossy | quinn, Cubic | 81.7 | 80.53 / 268 | 0.5 | 2,375 | 90.7 / 212.8 | 95.0 / 188.4 |
| | quinn, BBR | 81.7 | 80.52 / 268 | 4.7 | 288 | 107.5 / 180.6 | 90.0 / 181.3 |
| | iroh, Cubic | 81.9 | 80.43 / 95.6 | 0.2 | 4,384 | 82.4 / 165.3 | 89.3 / 203.1 |
| | iroh, BBRv3 | 81.9 | 80.39 / 80.61 | 0.5 | 906 | 81.5 / 192.9 | 82.5 / 188.2 |
| | iroh napi | 82.4 | 80.55 / 270 | 0.3 | 4,517 | 83.7 / 196.6 | 86.4 / 232.6 |
| far | quinn, Cubic | 151.7 | 150.52 / 150.78 | 0.7 | 2,535 | 158.4 / 202.0 | 164.8 / 360.7 |
| | quinn, BBR | 151.9 | 150.55 / 151.06 | 4.2 | 319 | 185.9 / 340.9 | 190.7 / 340.7 |
| | iroh, Cubic | 152.0 | 150.60 / 152.65 | 3.4 | 350 | 152.6 / 171.0 | 152.6 / 177.1 |
| | iroh, BBRv3 | 152.1 | 150.60 / 478.6 | 0.6 | 1,421 | 155.7 / 216.1 | 155.8 / 158.9 |
| | iroh napi | 152.5 | 150.71 / 478.0 | 0.2 | 3,677 | 153.3 / 185.3 | 162.1 / 397.1 |

What this shows:

1. **Connecting takes one round trip plus 1–5 ms, and a small RPC one round trip plus under 0.6 ms**, on both stacks and in every profile (QUIC's one-round-trip handshake, as spec §8.3 expects). The napi binding adds about 0.1 ms.
2. **Stream priorities made no measurable difference** to small RPCs during a transfer, in any profile. The delay is in queues below QUIC: on the LAN profile Cubic filled netem's queue and added about 8 ms to every RPC; on the others the added delay was 1–15 ms at p50 under Cubic. iroh's BBRv3 kept the LAN queue to 1–2 ms. quinn's BBR built a standing queue: 50 ms more on the WAN profile and 35–40 ms more on the far one.
3. **Loss, not distance, is what hurts throughput.** At 0.1 % loss and 40 ms, the stacks moved 6.5–10.5 MB/s of the link's 12.5. At 1 % loss and 80 ms, Cubic collapsed to 0.2–0.5 MB/s, so a 1 MB screenshot took 2.4–4.4 s. quinn's BBR held 4.7 MB/s (1 MB in 0.29 s), but noq's BBRv3 managed only 0.5 MB/s. At 0.5 % loss and 150 ms, quinn's BBR (4.2 MB/s) and iroh's Cubic (3.4 MB/s, a good draw) did well and the rest moved under 1 MB/s. So on a lossy Wi-Fi or mobile path the congestion controller matters more than which QUIC library is underneath. iroh lets Clover plug its own in (`congestion_controller_factory`).
4. **n0's napi binding falls behind on every link**: 49 against 116 MB/s on the LAN profile, and 2.5 against 10 MB/s on the WAN one. On the WAN profile data arrives a packet at a time, so its per-read cost is paid per packet; the cause wasn't isolated further, since M1 replaces the binding anyway.

**Verdict: works, with limits.** Delay is the network's plus well under a millisecond, and connecting costs one round trip. But prioritised streams alone don't keep control messages fast during a transfer, and neither default congestion controller copes with a lossy path. M1 has to choose the controller and pace bulk streams (edit 7).

## Network changes

Spec §8.3 asks for the time to first byte after sleep and after a Wi-Fi-to-mobile switch on real networks. The lab can't sleep a laptop, but it can do the network side of both to one live connection and watch whether it lives through it.

**Method.** [`nat/migrate.sh`](../../spikes/s1-transport/nat/migrate.sh) puts a client and a server namespace on one veth pair with 10 ms of delay each way. The client ([`bench.rs`](../../native/link-sidecar/src/bench.rs), `ping`) sends a 64-byte echo every 50 ms without waiting for replies. The script then breaks the path at a known time: the client's address changes, or every packet is dropped for a while, or both. In some scenarios it also tells the client the network changed, as clover-core would on the OS's event: quinn then moves to a new socket (`rebind`, its active migration) and iroh re-checks its paths (`network_change()`). Nothing reconnects; the question is whether this one connection carries on.

Echoes sent every 50 ms; "longest gap" is the longest wait between replies (CI run 4; the blackout rows match run 3 within 0.1 s):

| Scenario | quinn: all back? | quinn: longest gap | iroh: all back? | iroh: longest gap |
| :- | :- | -: | :- | -: |
| address change, no call | yes | 0.14 s | yes | 6.0 s |
| address change, with the network-change call | yes | 0.12 s | yes | 6.0 s |
| Wi-Fi to mobile: 2 s outage, new address, call | yes | 2.1 s | **no**: 181 of 201, 8 s after the end | 8.0 s |
| 5 s blackout | yes | 5.1 s | yes | 5.1 s |
| 20 s blackout | yes | 28.4 s | yes | 24.6 s |
| 20 s blackout, with the call at wake | yes | 28.4 s | yes | 24.5 s |
| 40 s blackout | **no**: closed at 33 s | | **no**: closed at 33 s | |

What this shows:

1. **Short outages heal by themselves.** After 5 s without a network, both stacks delivered every queued echo within about 150 ms of the link coming back.
2. **quinn follows a new address at once; relay-free iroh takes seconds.** When the client's address changed, quinn carried on within about 0.1 s: QUIC's own migration, where the client just sends from its new address and the server follows. iroh, with relays off, went 6 s without replies before it opened a second path from the new address, and the network-change call didn't shorten that. In the Wi-Fi-to-mobile case iroh went 8 s without replies, and a tenth of the echoes still hadn't arrived 8 s after the test ended. With relays on, iroh would have had the relay path meanwhile; that is live gate 1's to measure. It is worth raising with n0 (the controller decides).
3. **Long outages heal slowly, and the wake call doesn't speed them up.** After 20 s, iroh resumed 4.5 s after the link returned and quinn 8.4 s, with or without the call. Both had backed off their retransmission timers, and after a loss that long congestion control holds them back too, so quinn's rebind ping waits as well. A fresh connection takes one round trip.
4. **Past 30 s the connection is gone.** Both close it after 30 s with nothing received (quinn as configured here, iroh by default), so a sleep longer than that always needs a new connection.

The first two runs of this test were wrong and are not used: deleting the client's old address also deleted the new one, because Linux drops secondary addresses with the primary unless `promote_secondaries` is on.

**Verdict.** Neither stack makes a sleep or a network switch invisible, and relay-free iroh handles a new address worse than plain QUIC. clover-core should dial a new connection at once on every wake and network-change event, keep whichever connection answers first, and let the old one go, as spec §8.3's "re-dial at once" already says (edit 8). That costs one round trip on either stack and takes the difference between them off the table.

## Question 5: WebRTC from browsers

**Method.** [`webrtc-browser.ts`](../../spikes/s1-transport/bun/src/webrtc-browser.ts) serves one page on 127.0.0.1 and answers its offer over HTTP, the lab's stand-in for waifucave's signalling (spec §8.4). The page, in headless Chrome or Firefox, opens a `ctrl` and a `bulk` channel to `node-datachannel` under Bun and measures: time to open (from the offer to both channels open, gathering included, no trickle), 64-byte round trips on `ctrl`, uploads and downloads on `bulk` with 4 MB of backpressure, and round trips on `ctrl` while an upload runs. The Bun side ran from source and compiled.

Ranges cover three CI runs, with the Bun side from source and compiled:

| | macOS arm64 | Windows x64 | Linux x64 |
| :- | -: | -: | -: |
| Chrome 156: open (ms) | 244–569 | 150–1,246 | 204–933 |
| Chrome: RTT p50 / p99 (ms) | 0.24–0.37 / 0.4–1.9 | 0.19–0.40 / 0.6–1.5 | 0.14–0.30 / 0.4–1.7 |
| Chrome: up / down (MB/s) | 16–23 / 18–36 | 14–34 / 12–32 | 32–47 / 44–63 |
| Chrome: RTT during an upload, p50 (ms) | 13–23 | 16–39 | 6–15 |
| Firefox 158–159: open (ms) | 1,103–1,173 | 1,221–1,341 | 1,368–1,454 |
| Firefox: RTT p50 (ms) | 0.22–0.24 | 0.26–0.48 | 0.30–0.34 |
| Firefox: up / down (MB/s) | 22–34 / 22–32 | 13–29 / 8–23 | 28–62 / 33–80 |
| Firefox: RTT during an upload, p50 (ms) | 18–34 | 22–62 | 11–22 |

Linux arm64 has no Chrome build, so it ran no browser check. Firefox's first run had no cross-origin isolation, so its RTTs come from the later two.

Notes for lane I:

* **Both browsers hide host candidates behind mDNS names** by default, and libdatachannel does not resolve `.local` names. The lab turns that off (`--disable-features=WebRtcHideLocalIpsWithMdns`, Firefox's `media.peerconnection.ice.obfuscate_host_addresses`). A real page can't, so the web companion's direct path depends on server-reflexive candidates from STUN, or on the daemon resolving mDNS names. Live gate 8 tests it from Chrome, Firefox and Safari on another device.
* **Delay under load is the SCTP send buffer.** libdatachannel has no stream priorities, so a `ctrl` message waits behind whatever `bulk` has queued: with 4 MB allowed, 6–62 ms in a browser and 3–190 ms Bun to Bun. A smaller `bufferedAmount` limit trades throughput for delay; spec §8.4 already sends screenshots to the browser at reduced size.
* **Firefox clamps `performance.now()`** to 1 ms unless the page is cross-origin isolated; the page sends COOP and COEP headers so its round trips are real.
* Opening takes 0.15–1.5 s, most of it ICE gathering and Firefox's start; QUIC between devices connects in one round trip (Q1).

**Verdict: works.**

## Proposed spec edits

Each is marked [P] (the controller applies it) or [D] (it touches an owner decision).

1. **[P] §8.2, "Not a WebSocket":** the transport is chosen.
   * Old: `Between devices the link uses QUIC, whose independent streams run over UDP — through iroh or plain quinn, chosen in spike S1 (§8.3).`
   * New: `Between devices the link uses QUIC, whose independent streams run over UDP, through iroh (chosen in spike S1, §8.3).`
2. **[P] §8.3, the transport table's Bun row:**
   * Old: `| Bun | Official napi binding `@number0/iroh` (iroh-ffi 1.2.0); Bun support unconfirmed | `node-datachannel` napi; Bun support unconfirmed | Go helper process |`
   * New: `| Bun | `@number0/iroh` 1.2.0 loads under Bun and compiled on all four targets, but passes bytes as JS arrays (18–64 MB/s, and Bun stops firing timers meanwhile); Clover binds iroh with a thin addon of its own | `node-datachannel` 0.33.6 loads under Bun and compiled on all four targets; compiling needs a small build plugin | Go helper process |`
3. **[P] §8.3, "S1 compares two ways to get QUIC speed"** and its two sub-bullets, replaced by the result:
   * New: `**[P] The transport (S1's lab half, November 5, 2026): iroh.** Plain quinn matched iroh's speed and punched the same NATs, and followed a new address faster (0.1 s against 6 s, which re-dialling covers), but needs its own identity, discovery and relay fallback, has no iOS or Bun binding, and cannot use n0's relays. With relays off, iroh connects directly through every NAT pair that allows it (13 of 15 in the lab) given two things from the handshake: each device asks a public STUN server for its address from the port iroh then binds, since iroh has no STUN and learns no address without a relay, and both devices dial each other at once ([lab report](research/2026-11-05-s1-transport.md)).`
4. **[P] §8.3, "Fallback if the Bun bindings don't load":**
   * New: `**[P] How clover-core holds iroh:** through a thin napi addon of Clover's own, which passes byte buffers and keeps the link's framing in Rust. n0's binding passes every byte as a JS number and, under Bun, keeps timers from firing while a transfer runs; a buffer-typed call measured 22–61 µs and 1.1–3.3 GB/s under Bun on all four targets. The addon ships beside clover-core, not inside it. The fallback stays a sidecar process, whose stdio hop measured 0.02–0.06 ms per round trip and 0.5–1.6 GB/s.`
5. **[P] §8.3, inside the [D] "Discovery works like waifucave's pairing service today"** (it adds how, and doesn't change the decision):
   * Old: `Public STUN servers (Cloudflare, Google) find each device's internet address reliably.`
   * New: `Public STUN servers (Cloudflare, Google) find each device's internet address reliably, asked from the port the link then binds, since iroh has none of its own. The handshake also tells both devices when to dial, so they dial each other at once.`
6. **[D] Coordination off n0's relays, against the fastest connection.** This touches three decisions in §8.3: "[D] n0's public relays are on by default", "[D] Settled: no relay for coordination either" and "[D] The connection must be the absolute fastest", and the [P] "LAN first: … racing the LAN, direct and relay paths and keeping the fastest". iroh 1.4.1, read in its source, sends a dial's first packets to every path it knows, relay included, and runs its NAT-traversal rounds inside that connection over whichever path is up; with relays on it also keeps a connection to its home relay and probes its relays to learn its own address. So with n0's relays on, no relay for coordination holds only if Clover dials with direct addresses alone and adds the relay after a head start; that costs the head start every time direct fails. Racing every path from the start gives the fastest first byte but puts coordination on the relay whenever one is configured. Options:
   * **(a) direct first, then the relay after a head start of about 0.5–1 s (rec).** It keeps "no relay for coordination". In the lab, direct connections that worked took 1–23 ms, or about 1 s when the first packet needed a retransmission. On real paths add one or two round trips.
   * **(b) race every path from the start.** The fastest first byte, but the relay sees every connection's set-up.

   Either way, the LAN-first bullet should say the same as the choice.
7. **[P] §8.3, "Priorities"**, and a new bullet after it:
   * Old: `* **Priorities:** binary frames on separate streams for bulk data, with token streams and control messages ahead of screenshots and files.`
   * New: `* **Priorities:** binary frames on separate streams for bulk data, with token streams and control messages ahead of screenshots and files. Priorities only order what QUIC sends next; during a transfer a control message still waits in the queues below QUIC, which the congestion controller fills or keeps short (S1: prioritised and equal streams measured the same). So bulk streams are paced below the path's rate.`
   * Added: `* **[P] Congestion control is chosen for lossy paths.** At 1 % loss and 80 ms, Cubic moved 0.2–0.5 MB/s in S1's lab and quinn's BBR 4.7 MB/s, while noq's BBRv3 managed 0.5 MB/s and quinn's BBR added 35–50 ms of queueing. M1 picks and tunes the controller (iroh accepts one from Clover); live gate 1 checks it on real Wi-Fi and mobile.`
8. **[P] §8.3, "Connect early, stay connected"**, and the transport table's "Network change or sleep" row:
   * Old: `* **Connect early, stay connected:** connect at login and wake, send keep-alives, and re-dial at once on network-change and wake events.`
   * New: `* **Connect early, stay connected:** connect at login and wake, send keep-alives, and re-dial at once on network-change and wake events, keeping whichever connection answers first. In S1's lab an existing connection came back 4.5–8.4 s after a 20 s outage ended, telling the stack about the change didn't shorten that, relay-free iroh took 6 s to follow a new local address, and a connection is gone after 30 s of silence; a new one takes one round trip.`
   * Old (iroh's cell): `Best: the connection survives a switch of path`
   * New: `The connection survives a switch of path, but with relays off it took 6 s to follow a new address in S1's lab (plain QUIC migration: 0.1 s); Clover re-dials on network changes either way`
9. **[P] §8.3, the S1 list**, a line after item 8: `S1's lab half (November 5, 2026) answered item 1 and the lab part of items 2–6 ([lab report](research/2026-11-05-s1-transport.md)); the runs on real networks, item 8 and, if still wanted, item 7 wait for live gate 1.`
10. **[P] §14.1 item 1**, appended: `Lab half done November 5, 2026: iroh, held through Clover's own addon; real networks and the relay share remain for live gate 1 ([lab report](research/2026-11-05-s1-transport.md)).`
11. **[P] §8.4, the web companion's first bullet**, appended: `Browsers name their LAN candidates with mDNS, which the daemon's WebRTC library does not resolve, so the page's direct path rests on STUN's reflexive candidates unless the daemon resolves mDNS names (S1).`

## Risks

1. **Our own addon is code to keep up with iroh.** iroh went from 1.0 to 1.4.1 in five months, and the addon has to follow. Keep it thin (endpoint, streams, paths, network change), pin iroh exactly, and put `LinkTransport` in front of it so nothing else sees iroh.
2. **Bun's event loop can starve timers.** Any native addon that delivers a steady stream of costly completions (n0's binding, a plugin's) can stop keep-alives, lease renewals and clock sync, on every OS. Buffer-typed APIs and a yield in hot loops avoid it; a timer-lag watchdog in clover-core would catch the next case. Native plugins already get their own process (spec §3.1), which keeps them off the daemon's loop.
3. **Mobile and carrier NATs are often symmetric**, and every pair with a symmetric NAT against a filtering one needs a relay. The relay share could be much higher on phones and hotel Wi-Fi than at home; live gate 1 measures it.
4. **STUN before bind only works once per port.** After a network change the public address changes, but iroh now holds the port, so Clover can't ask STUN from it again. Ways out for M1: relays on (n0's QAD, which [D] turns on by default anyway), or iroh's observed-address reports from any connected peer (`send_observed_address_reports` / `receive_observed_address_reports` in iroh's transport config), or rebinding iroh on a fresh port after a fresh STUN.
5. **Priorities don't protect small messages under load** on their own (Q4): the queues that delay them sit below QUIC.
6. **Relay-free iroh follows a new local address slowly.** In the lab it took 6 s, and with an outage in front a tenth of the data was still missing 8 s later. So clover-core must catch the OS's network-change and wake events on all three OSes and re-dial at once; with no event, the old connection limps.
7. **Lossy links collapse loss-based congestion control** (Q4), and noq's BBRv3 did little better there than Cubic.
8. **Browsers:** host candidates are mDNS names libdatachannel can't resolve; SCTP has no priorities; Firefox takes 1.1–1.5 s to open a channel. Safari was not tested.
9. **Windows Firewall** may ask the user the first time clover-core receives unsolicited UDP. CI runners never prompt, so only live gate 3 can show it.
10. **Size:** a compiled clover-core with these addons is 95–131 MB on Linux and 99–115 MB on Windows.
11. **The lab's limits:** shared runners vary by up to 2x between runs, so the comparisons here are within one run; netem's random loss is harsher than real networks' bursty loss; and a loopback or netem pair shares one machine's CPU.

## Left for live gate 1

* Real networks, as plan §10 lists them (home Wi-Fi, mobile, carrier-grade NAT, one strict NAT): the direct success rate with relays off (STUN on iroh's port, both dialling), the connect time, and each network's NAT type (`clover-link-sidecar stun-query` from two ports against Cloudflare's and Google's STUN shows whether mapping depends on the destination).
* With n0's relays on: how often traffic falls back, what a relay adds to the delay, and what direct-first costs against racing (edit 6).
* Time to first byte: cold, on a LAN, after sleep and wake, and after a real Wi-Fi-to-mobile switch on a laptop, with clover-core's network-change hook in place.
* Throughput for 1 MB screenshots and bulk files on real Wi-Fi and across the internet, with the congestion controller and pacing chosen in M1.
* The web companion from Chrome, Firefox and Safari on another device, where host candidates are mDNS names; Safari has not run at all.
* Windows: whether the firewall prompts for clover-core's UDP socket (also live gate 3).
* Spec §8.3 item 7, WireGuard against iroh on the same path, if it is still wanted; the lab half didn't run it.

## What M1 starts with

1. **The addon:** a thin napi-rs addon over iroh 1.4.1 for the four targets, built in CI and shipped beside clover-core rather than embedded (4 ms to load instead of 11–450 ms). Its surface: bind on a chosen port after a STUN query from it, connect and accept by device key, streams with `Buffer` in and out and a priority, path events, `network_change()`, close. Proposed path `native/link/`, with the sidecar kept as a build of the same crate (a path change for the controller).
2. **`LinkTransport` on top**, against the spine's contract: one link per device pair, priority classes (control, token streams, screenshots, files), liveness from any inbound frame with a keep-alive on quiet links (Winter's phone link learned this), re-dial on loss, and the OS network-change and wake hooks on all three OSes.
3. **The handshake's part of punching:** candidates (LAN address and STUN's answer from iroh's port) and a "dial now" message that makes both devices dial at once; for devices paired without an account, LAN discovery and the last known address.
4. **Congestion control and pacing** for bulk streams, chosen from Q4's numbers, so control messages stay fast while files move.
5. **The relay policy**, once the owner decides edit 6.
6. **A timer-lag watchdog** in clover-core, and yields in every hot native loop.
