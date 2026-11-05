# Spike S1: the transport (lab half)

Lane H, milestone M0. It answers spec §8.3 and §14.1 item 1 in the lab: iroh against plain QUIC (quinn) between a user's computers, both under Bun and inside `bun build --compile`, punching through emulated NATs with no relay, delay and throughput under `tc netem`, and a WebRTC data channel from a headless browser to the Bun side. The report is [docs/research/2026-11-05-s1-transport.md](../../docs/research/2026-11-05-s1-transport.md). Runs on real networks wait for live gate 1.

## Layout

| Path | What |
| :- | :- |
| `bun/` | The Bun side: its own `package.json` and `bun.lock`, one level below `spikes/` so the root workspace glob (`spikes/*`) does not take it in |
| `bun/src/iroh-napi.ts` | iroh through n0's napi binding `@number0/iroh` 1.2.0 (iroh 1.4.1) |
| `bun/src/webrtc-dc.ts` | WebRTC data channels through `node-datachannel` 0.33.6 (libdatachannel), Bun to Bun |
| `bun/src/webrtc-browser.ts` | A headless Chrome or Firefox to the Bun side over a data channel |
| `bun/src/sidecar-ipc.ts` | clover-core's hop to the native sidecar over stdio |
| `bun/src/napi-probe.ts` | What byte passing across napi costs under Bun and Node, with `napi-probe/` (a tiny napi-rs addon) |
| `bun/scripts/compile.ts` | Builds every check with `bun build --compile` |
| `bun/scripts/summarize.ts` | Result files to Markdown tables and compact CI notices |
| `ci/platform-checks.sh` | Every per-OS check in one go (what CI runs on macOS, Windows and Linux) |
| `nat/matrix.sh` | The NAT matrix: network namespaces and iptables, Linux and root only |
| `nat/netem.sh` | Delay and throughput under `tc netem`, Linux and root only |
| `nat/migrate.sh` | One live connection through an address change and blackouts, Linux and root only |
| [`../../native/link-sidecar/`](../../native/link-sidecar/) | The native half: quinn and iroh peers, a STUN responder, the stdio sidecar |
| `results/2026-11-05/` | The result files behind the report: the platform checks and netem from CI run 3, the NAT matrix and network changes from run 4, and in `run5/` all three labs again from run 5 |

Every check prints one line, `S1RESULT <json>`. Set `S1_ANNOTATE=1` to also print it as a GitHub `::notice`.

## Setup

```sh
cargo build --release --manifest-path native/link-sidecar/Cargo.toml
cd spikes/s1-transport/bun && bun install --frozen-lockfile
```

## One command per check

From `spikes/s1-transport/bun`, with `SIDECAR=../../../native/link-sidecar/target/release/clover-link-sidecar`:

| Question | Check | Command |
| :- | :- | :- |
| 2 | iroh (napi) under Bun | `bun src/iroh-napi.ts` |
| 2 | the same, yielding to the event loop after each write | `bun src/iroh-napi.ts --yield-every 1` |
| 2 | the same binding under Node, for comparison | `node src/iroh-napi.ts` |
| 2 | WebRTC (node-datachannel) under Bun | `bun src/webrtc-dc.ts` |
| 2 | the sidecar hop from Bun | `bun src/sidecar-ipc.ts --sidecar $SIDECAR` |
| 2 | napi byte passing, `Vec<u8>` against `Buffer` | `cargo build --release --manifest-path ../napi-probe/Cargo.toml`, copy `target/release/libs1_napi_probe.{dylib,so}` (or `s1_napi_probe.dll`) to `../napi-probe/s1-napi-probe.node`, then `bun src/napi-probe.ts` |
| 2 | every check compiled | `bun scripts/compile.ts && ./out/iroh-napi --quick && ./out/webrtc-dc --quick && ./out/sidecar-ipc --sidecar $SIDECAR` |
| 1, 4 | native quinn, loopback | `$SIDECAR local-bench --transport quinn [--cc bbr]` |
| 1, 4 | native iroh, loopback | `$SIDECAR local-bench --transport iroh [--cc bbr]` |
| 5 | Chrome to Bun | `bun src/webrtc-browser.ts --browser chrome` |
| 5 | Firefox to Bun | `bun src/webrtc-browser.ts --browser firefox` |
| 3 | the NAT matrix (Linux, root) | `sudo ../nat/matrix.sh $SIDECAR ../results/nat.jsonl` |
| 4 | netem delay and throughput (Linux, root) | `sudo ../nat/netem.sh $SIDECAR "$(command -v bun)" ../results/netem.jsonl` |
| 4 | an address change and blackouts under one connection (Linux, root) | `sudo ../nat/migrate.sh $SIDECAR ../results/migrate.jsonl` |
| 2–5 | everything for one OS | `../ci/platform-checks.sh ../results/local.jsonl` (from the repo root: `spikes/s1-transport/ci/platform-checks.sh`) |
| — | a public STUN server's view of this machine | `$SIDECAR stun-query --server stun.cloudflare.com:3478` |

`--quick` shrinks every size. The bench options are `--rpc`, `--rpc-streams`, `--bulk-mb`, `--shots`, `--load-mb`, `--chunk` and `--load-gap-ms`.

## The bench

The same protocol runs in TypeScript (`iroh-napi.ts`) and Rust (`native/link-sidecar/src/bench.rs`). The first byte of each bidirectional stream picks the server's handler: `E` echoes 64-byte frames (small RPCs on one long-lived stream), `R` answers one RPC per stream, `S` sinks a bulk transfer and acks its byte count. The client measures:

* `rpcStream`: 64-byte round trips on one stream
* `rpcPerStream`: one new stream per RPC
* `bulk`: one large transfer, in MB/s (10^6 bytes)
* `screenshot1MB`: 1 MB transfers, one stream each
* `rpcUnderLoad_prioritised` and `rpcUnderLoad_equal`: round trips every 5 ms while a bulk transfer runs on the same connection, with the RPC stream at priority 10 or at the bulk's priority 0

## CI

`.github/workflows/spike-s1.yml` runs on pushes to `lane/h-m0`: the platform checks on `macos-latest`, `windows-latest`, `ubuntu-24.04` and `ubuntu-24.04-arm`, and the NAT matrix, netem and network changes on `ubuntu-24.04`. Each job writes a Markdown summary, uploads its result files, and leaves up to ten compact notices, which `GET https://api.github.com/repos/waifucave/clover/commits/<sha>/check-runs` and each run's `/annotations` serve without auth.
