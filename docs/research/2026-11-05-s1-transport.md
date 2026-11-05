# S1, the transport: lab results

Lane H, milestone M0: the lab half of spike S1 (spec §8.2, §8.3 and §14.1 item 1; plan §4 lane H). November 5, 2026.

Code: [`spikes/s1-transport/`](../../spikes/s1-transport/README.md) (the Bun side, the network labs, the CI glue) and [`native/link-sidecar/`](../../native/link-sidecar/) (the native half: quinn and iroh peers, a STUN responder, a stdio sidecar). CI: `.github/workflows/spike-s1.yml` on `lane/h-m0`. The runs on real networks, and how often traffic falls back to n0's relays, wait for live gate 1.

## Verdicts

| # | Question | Verdict | Key numbers |
| :- | :- | :- | :- |
| 1 | iroh or plain QUIC (quinn) between a user's computers | **iroh.** The two are equally fast and punch the same NATs; quinn would mean rebuilding iroh's identity, relay and path handling, could not use n0's relays, and has no iOS or Bun binding | Native loopback bulk: iroh 155–439 MB/s, quinn 175–467 MB/s; RPC p50 0.07–0.19 ms against 0.06–0.15 ms; identical NAT matrix |
| 2 | iroh, quinn and WebRTC under Bun and inside `bun build --compile`, on all three OSes | **Works, with limits.** Everything loads and compiles on all four targets. n0's napi binding is too slow for bulk data and makes Bun stop firing timers; a binding that passes buffers fixes both. quinn has no binding: it needs a sidecar or our own addon | iroh napi bulk 21–63 MB/s against native 155–439; a 10 ms timer fired once in 1–2.7 s of transfer; a buffer-typed napi call costs 20–45 µs and moves 1.1–3.3 GB/s; the sidecar's stdio hop is 0.02–0.06 ms |
| 3 | Punching through routers with no relay | PENDING_Q3_VERDICT | PENDING_Q3_NUMBERS |
| 4 | Delay and throughput under `tc netem`, prioritised streams | PENDING_Q4_VERDICT | PENDING_Q4_NUMBERS |
| 5 | WebRTC from a browser to the Bun side | **Works.** Headless Chrome 156 and Firefox 158–159 open data channels to `node-datachannel` under Bun on macOS, Windows and Linux; Lane I can build on [`webrtc-browser.ts`](../../spikes/s1-transport/bun/src/webrtc-browser.ts) | Open 0.15–1.5 s; RTT p50 0.2–0.4 ms; 12–80 MB/s each way; RTT during a parallel upload 7–62 ms (p50) |

Two results change the spec beyond choosing iroh, and one touches decisions:

* **How clover-core holds iroh** [P]: through a thin napi addon of Clover's own, not n0's binding as it is (Q2).
* **Relay-free iroh needs two things from the handshake** [P]: each device learns its public address with STUN on the port iroh then binds, because iroh has no STUN and learns nothing without a relay, and both devices dial each other at the same moment (Q3).
* **Relays on, coordination off them** touches two [D]s: iroh sends a dial's first packets over every path it knows, the relay included, so coordination stays off n0's relays only if Clover dials direct first and adds the relay after a head start (Q3, edit 6).

## Where it ran

* **This session ran on the owner's Mac** (M4 Pro, 14 cores, macOS 26.6.1), not in a cloud session as the brief assumed. So local runs were limited to what needs no root and no window: no browser was started here, and nothing touched Winter. Everything that needs Linux networking, root or another OS ran on GitHub Actions: `macos-latest` (arm64), `windows-latest` (x64), `ubuntu-24.04` (x64) and `ubuntu-24.04-arm` (arm64), all four of the daemon's targets (spec §3.1).
* Versions: Bun 1.3.14; Node 24 on CI and 26.7 here, for comparison; iroh 1.4.1 with noq 1.4.0 (n0's quinn fork), both natively and through `@number0/iroh` 1.2.0, which iroh-ffi v1.2.0's lockfile pins to the same iroh; quinn 0.11.12 with rustls 0.23 and ring; `node-datachannel` 0.33.6 (libdatachannel); headless Chrome 156 and Firefox 158–159 as the runners ship them.
* CI numbers come from shared runners and vary between runs by tens of percent; compare within a table, not across runners. The owner's Mac is faster than every runner.

## The bench

One protocol, written twice: in TypeScript for the napi binding ([`iroh-napi.ts`](../../spikes/s1-transport/bun/src/iroh-napi.ts)) and in Rust for native quinn and iroh ([`bench.rs`](../../native/link-sidecar/src/bench.rs)). The first byte of each bidirectional stream picks the server's handler: `E` echoes 64-byte frames, `R` answers one RPC per stream, `S` sinks a bulk transfer and acks its size. The client measures 64-byte round trips on one stream (`rpc`), one stream per RPC (`rpcPerStream`), one large transfer (`bulk`, MB/s, 10^6 bytes), 1 MB transfers one stream each (`screenshot1MB`), and round trips every 5 ms while a bulk transfer runs on the same connection, with the RPC stream at priority 10 or at the bulk's priority 0 (`rpcUnderLoad`). Every check prints one `S1RESULT` JSON line; the per-run files are in each CI run's artifacts.

## Question 2: under Bun and compiled

**Method.** Each check ran under Bun from source, then as a `bun build --compile` binary copied outside the source tree, on all four targets ([`platform-checks.sh`](../../spikes/s1-transport/ci/platform-checks.sh)). The iroh check also ran under Node, and a small napi probe ([`napi-probe/`](../../spikes/s1-transport/napi-probe/)) measured byte passing on its own.

**iroh through `@number0/iroh` 1.2.0**, two endpoints in one process over loopback, relays off:

| | macOS arm64 | Windows x64 | Linux x64 | Linux arm64 |
| :- | -: | -: | -: | -: |
| loads under Bun / compiled | yes / yes | yes / yes | yes / yes | yes / yes |
| load time, source / compiled (ms) | 9.7 / 24.6 | 18.5 / 146.5 | 5.4 / 13.1 | 5.2 / 11.3 |
| connect, warm (ms) | 0.60 | 1.50 | 0.77 | 0.81 |
| RPC p50 / p99 (ms) | 0.16 / 0.28 | 0.39 / 1.74 | 0.13 / 0.48 | 0.22 / 0.58 |
| bulk (MB/s), napi | 45.5 | 24.0 | 37.2 | 28.6 |
| bulk (MB/s), native iroh, same runner | 181.4 | 154.6 | 438.6 | 407.8 |
| 1 MB transfer p50 (ms), napi | 22.1 | 53.9 | 27.2 | 35.7 |
| 10 ms timer during bulk: fired / expected | 1 / 140 | 1 / 266 | 1 / 171 | 1 / 224 |
| the same, yielding once per write | 129 / 139 | 246 / 278 | 164 / 174 | 202 / 231 |
| bulk under Node 24 (MB/s) | 12.8 | 5.5 | 8.5 | 6.8 |

On the owner's Mac the same check moves 62–64 MB/s; native iroh moves 262–284 MB/s and quinn 290–312.

What this shows:

1. **It loads and compiles everywhere.** napi-rs's loader names each platform package literally, so `bun build --compile` embeds the right `.node` by itself. A compiled binary writes that file to a new temporary file on every start: 11–25 ms on the runners, 147 ms on Windows, 290–450 ms on the owner's Mac. The same file kept beside the binary and loaded from disk (`NAPI_RS_NATIVE_LIBRARY_PATH`) loads in 4 ms once the OS has seen it.
2. **Its byte API is the bottleneck.** Every `read` and `write` takes or returns `Vec<u8>`, which napi-rs turns into a JS `Array<number>`, one element at a time. The probe puts the cost at 0.5–1.6 ms of JS-thread time per 64 KB under Bun (40–135 MB/s) and 2–10 ms under Node. A `Uint8Array` in costs 0.6–2.3 µs, a `Buffer` out 20–27 µs, and either one as an async call 20–45 µs (1.1–3.0 GB/s). So the binding, not iroh or Bun, caps transfers at a tenth of native speed and holds the daemon's thread while it does.
3. **Bun stops firing timers while napi completions keep arriving.** With a transfer running, a 10 ms interval fired once in 1–2.7 s on every OS; Node fired it on time. The probe reproduces it without iroh: two independent loops of async napi calls whose results each take about a millisecond to convert left a 10 ms timer firing once in 44–90 periods, while lock-step pairs, typed buffers and Node all kept it on time. Bun appears to run every queued native completion before its timers, and two loops keep that queue from emptying. For a daemon whose keep-alives, lease renewals and clock sync are timers (spec §6.4), this matters more than speed. Yielding once per write (`setImmediate`) fixes it at no cost to throughput; a buffer-typed binding avoids it, since each completion is cheap. It is worth reporting to Bun; the controller decides.
4. **node-datachannel loads under Bun on all four targets, and compiles with a 10-line plugin.** Its loader computes the package name, so the bundler can't follow it; [`compile.ts`](../../spikes/s1-transport/bun/scripts/compile.ts) swaps the loader for a literal `require` of this platform's `.node`. Bun to Bun in one process: open 3–13 ms, RTT p50 0.10–0.30 ms, 35–96 MB/s.
5. **quinn has no maintained napi binding.** Under Bun it is reachable only through our own addon or a sidecar. The sidecar prototype (`clover-link-sidecar ipc`, framed echo over stdio) measured, from Bun and from compiled binaries: spawn and first round trip 4–21 ms; 64-byte round trip p50 0.02–0.06 ms (p99 0.4–1.5 ms); 0.5–1.6 GB/s each way; timers unaffected. That confirms the spec's "adds microseconds" for the fallback.
6. **Compiled sizes**: 63–76 MB on macOS, 99–115 MB on Windows, 94–131 MB on Linux, for a binary carrying Bun plus one of these addons (iroh's `.node` alone is 12 MB).

**Verdict: works, with limits.** The limits are the binding's, and a binding of Clover's own removes them: the probe shows buffer-typed calls at 1.1–3.3 GB/s with timers unaffected. M1 starts there (below).

## Question 1: iroh or plain quinn

**Method.** Both stacks run the same Rust bench (release builds), relays off, in one process over loopback on all four targets, then under netem (Q4), through the NAT lab (Q3) and through path changes (below). quinn gets the pieces iroh has built in, written for the spike: a self-signed Ed25519 certificate pinned by its hash on the dialling side ([`link.rs`](../../native/link-sidecar/src/link.rs)), STUN on its own socket, and punch packets from that socket ([`punch.rs`](../../native/link-sidecar/src/punch.rs)).

Native, loopback, relays off:

| | macOS arm64 | Windows x64 | Linux x64 | Linux arm64 | owner's Mac |
| :- | -: | -: | -: | -: | -: |
| bulk MB/s, quinn / iroh | 203 / 181 | 175 / 155 | 434 / 439 | 467 / 408 | 312 / 263 |
| RPC p50 ms, quinn / iroh | 0.08 / 0.10 | 0.15 / 0.19 | 0.06 / 0.07 | 0.09 / 0.13 | 0.04 / 0.04 |
| first connect ms, quinn / iroh | 3.7 / 3.6 | 2.5 / 4.0 | 0.8 / 1.6 | 0.9 / 1.3 | 1.0 / 1.0 |
| warm connect ms, quinn / iroh | 0.42 / 0.67 | 1.14 / 1.68 | 0.60 / 0.84 | 0.62 / 1.08 | 0.30 / 0.34 |
| 1 MB transfer p50 ms, quinn / iroh | 4.7 / 5.5 | 5.7 / 6.5 | 2.5 / 2.4 | 2.3 / 2.5 | 3.4 / 3.4 |

PENDING_Q1_NETEM

Beyond speed:

| | iroh 1.4.1 | quinn 0.11, plus what Clover would build |
| :- | :- | :- |
| Identity | Dials an Ed25519 public key (TLS with raw public keys), which is the device key of spec §8.1 | Certificates pinned by hash; built in the spike, mutual authentication still to write |
| Public address with relays off | None: iroh has no STUN, and its QUIC address discovery (QAD) only runs against relays. STUN on the port before iroh binds it, then `add_external_addr` | STUN on its own socket |
| Punching | NAT traversal rounds inside a connection, so the first path must work on its own; both sides dial at once (Q3) | Punch packets from its own socket, and both sides dial (Q3) |
| Relay fallback | Built in; n0's relays, which spec §8.3 turns on by default [D] | None. n0's relays speak iroh's relay protocol, so quinn could not use them |
| Path changes | Multipath, with paths kept alive every 5 s and dropped after 15 s idle | QUIC migration from the client side |
| iOS | Official Swift bindings; Winter's phone already uses iroh-ffi 1.1.0 | None |
| Bun | n0's napi binding (with Q2's limits); or our own addon | Our own addon, or a sidecar |
| Churn | iroh 1.0 shipped in June 2026 and is at 1.4.1 now; the napi binding is at 1.2.0 | quinn's 0.11 line is stable |

**Verdict: iroh.** Speed doesn't separate them: quinn is ahead on some runners by 10–15 %, behind on Linux x64, and both are far above what the network delivers once the link leaves the machine (Q4). Everything else favours iroh, and quinn would also break a decision: n0's relays, on by default [D], are iroh relays.

## Question 3: punching with no relay

PENDING_Q3

## Question 4: delay and throughput

PENDING_Q4

## Network changes

PENDING_MIGRATE

## Question 5: WebRTC from browsers

**Method.** [`webrtc-browser.ts`](../../spikes/s1-transport/bun/src/webrtc-browser.ts) serves one page on 127.0.0.1 and answers its offer over HTTP, the lab's stand-in for waifucave's signalling (spec §8.4). The page, in headless Chrome or Firefox, opens a `ctrl` and a `bulk` channel to `node-datachannel` under Bun and measures: time to open (from the offer to both channels open, gathering included, no trickle), 64-byte round trips on `ctrl`, uploads and downloads on `bulk` with 4 MB of backpressure, and round trips on `ctrl` while an upload runs. The Bun side ran from source and compiled.

| | macOS arm64 | Windows x64 | Linux x64 |
| :- | -: | -: | -: |
| Chrome 156: open (ms) | 244–287 | 155–1,246 | 204–933 |
| Chrome: RTT p50 / p99 (ms) | 0.3 / 0.6–1.0 | 0.4 / 1.1–1.5 | 0.2–0.3 / 0.6–1.4 |
| Chrome: up / down (MB/s) | 17–19 / 25–28 | 14 / 12–13 | 33–36 / 48–53 |
| Chrome: RTT during an upload, p50 (ms) | 12.6–13.7 | 24.7–39.3 | 7.5–15.3 |
| Firefox 158–159: open (ms) | 1,103–1,121 | 1,221–1,341 | 1,444–1,454 |
| Firefox: RTT p50 (ms) | 0.22 | 0.26 | 0.30 |
| Firefox: up / down (MB/s) | 22–34 / 22–27 | 13–29 / 8–23 | 37–62 / 51–80 |
| Firefox: RTT during an upload, p50 (ms) | 18–34 | 22–62 | 11–18 |

Linux arm64 has no Chrome build, so it ran no browser check.

Notes for lane I:

* **Both browsers hide host candidates behind mDNS names** by default, and libdatachannel does not resolve `.local` names. The lab turns that off (`--disable-features=WebRtcHideLocalIpsWithMdns`, Firefox's `media.peerconnection.ice.obfuscate_host_addresses`). A real page can't, so the web companion's direct path depends on server-reflexive candidates from STUN, or on the daemon resolving mDNS names. Live gate 8 tests it from Chrome, Firefox and Safari on another device.
* **Delay under load is the SCTP send buffer.** libdatachannel has no stream priorities, so a `ctrl` message waits behind whatever `bulk` has queued: with 4 MB allowed, 7–62 ms in a browser and 50–190 ms Bun to Bun. A smaller `bufferedAmount` limit trades throughput for delay; spec §8.4 already sends screenshots to the browser at reduced size.
* **Firefox clamps `performance.now()`** to 1 ms unless the page is cross-origin isolated; the page sends COOP and COEP headers so its round trips are real.
* Opening takes 0.15–1.5 s, most of it ICE gathering and Firefox's start; QUIC between devices connects in one round trip (Q1).

**Verdict: works.**

## Proposed spec edits

Each is marked [P] (the controller applies it) or [D] (it touches an owner decision).

PENDING_EDITS

## Risks

PENDING_RISKS

## Left for live gate 1

PENDING_LIVE

## What M1 starts with

PENDING_M1
