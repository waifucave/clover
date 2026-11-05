# link-sidecar

The link's transport as a native sidecar, in Rust (lane H). It began as spike S1's native half: quinn and iroh peers, a STUN responder, the benchmarks and NAT-punching probes, and `ipc`, a stdio sidecar `clover-core` can drive if Bun can't load iroh itself (plan §7). `src/main.rs` lists every command. H's in-process addon is to go in `native/link/`, beside this folder.

## Build and test

The same on macOS, Linux and Windows, with a stable Rust toolchain:

```sh
cd native/link-sidecar
cargo build --release --locked                          # target/release/clover-link-sidecar
cargo build --release --locked --features relay-server  # with the lab relay (Linux, the netns lab)
cargo test --locked
```

Spike S1's workflow (`.github/workflows/spike-s1.yml`) builds it and runs the measurements; the results are in `spikes/s1-transport/`.

## What it may touch

The network (UDP and QUIC on the ports it is given, the STUN and relay servers it is pointed at) and the files its flags name (`--info-file`, `--metrics-file`, a rendezvous folder). Nothing else on the machine: no home folder, no secret store, no settings.
