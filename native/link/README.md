# link

`clover-link`, clover-core's link sidecar (spec §8.2, lane H). Spike S1 chose iroh 1.4.1 driven from a sidecar over a napi binding (docs/research/2026-11-05-s1-transport.md); `native/link-sidecar/` keeps the spike's prototype, and this is the one the core ships with.

## What it does

- **One iroh endpoint per device**, keyed by the device's link key. The core sends the key's seed over stdin in the first frame. It never travels in arguments, the environment or a file.
- **Connections and streams only.** The link protocol itself (the hello, lanes, requests, streams and their priorities) lives in the core, in `packages/core/src/links/transport.ts`. The core's `SidecarWire` (`packages/core/src/links/sidecar-wire.ts`) drives this process.
- **What edit 6 decided (items 79–81):**
  - Presence on n0's relays is accepted, and QUIC address discovery is on.
  - Only a device without an account publishes to n0's address lookup, and only its relay URL.
  - UPnP, NAT-PMP and PCP stay off, so there's no firewall prompt (S1).
- **Unknown keys are turned away.** Connections on the link ALPN from keys the core hasn't allowed (`allow`) are closed at once, and the core checks the registry again.
- **The mapping check.** `netReport` answers with iroh's net report: whether this NAT keeps one address for every destination. The dial policy (c) weighs it.

## The wire

Frames go both ways: a big-endian u32 length, then that many bytes. The first byte says what follows:

- `0`: a JSON control message.
  - From the core: `{"op": …}`. The ops are `init`, `dial`, `open`, `finish`, `reset`, `close`, `allow`, `networkChanged`, `netReport` and `shutdown`.
  - To the core: `{"ev": …}`. The events are `ready`, `dialed`, `dialFailed`, `incoming`, `stream`, `fin`, `reset`, `path`, `closed`, `netReport`, `error` and `stopped`.
- `1`: stream bytes: a big-endian u64 stream id, then the data.
  - The core opens streams with even ids.
  - The sidecar numbers the streams it accepts with odd ids.

## Build and test

```sh
cargo build --release --locked --manifest-path native/link/Cargo.toml
cd packages/core && bun test src/links/tests/sidecar.test.ts   # or CLOVER_LINK_BIN=<path> for another build
```

CI's `link` job (`.github/workflows/ci.yml`; its macOS leg is in the `macos` job) builds it on macOS, Windows and Linux (x64 and arm64) and runs the core's link tests over it on loopback. The relay is off and the endpoints bind 127.0.0.1, so nothing leaves the runner.

## What it may touch

- UDP sockets: iroh's own sockets, and QAD towards the relays.
- HTTPS to the relays.
- With `n0Lookup`, HTTPS and DNS to n0's address lookup.
- Its stdin and stdout.

It needs no files, no other network access and no other process. Lane C's fence wraps the spawn (`SidecarWireOptions.spawn`).

## How it ships

Beside the daemon, in the app's `resources/daemon/` (`clover-link`, `clover-link.exe` on Windows), where the daemon looks for it (`packages/core/src/links/sidecar-binary.ts`: beside its own executable, never from the environment or the PATH, since the sidecar is handed the device key). `scripts/build-packages.ts` builds it with `cargo build --release --locked` for the machine it is on and stages it with the daemon; the Linux packages' check holds them to it (`rwxr-xr-x`, root's). Release signing (macOS's Developer ID and notarization, Windows' Authenticode) is M2's, with the daemon's.
