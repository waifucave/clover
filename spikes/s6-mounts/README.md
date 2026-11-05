# Spike S6 — folder-tree mounts

The checks behind [the S6 report](../../docs/research/2026-11-05-s6-mounts.md): mounting another
computer's folder with FUSE (Linux), WinFsp (Windows) and FSKit (macOS); speed across the
mount against local disk; failing fast when the computer drops.

| Path | What |
| :- | :- |
| `server/serve.ts` | the file service: the daemon's half on the computer that holds the files (Bun) |
| `server/wire.ts` | the wire protocol in TypeScript ([PROTOCOL.md](../../native/mounts/PROTOCOL.md)) |
| `link/proxy.ts` | the fake link: a TCP relay with an added round trip, blackhole and reset |
| `bench/speed.ts` | question 3: `git status`, `tsc`, 256 MiB reads and writes, folder copies, cold and warm, at 0/20/80 ms |
| `bench/failfast.ts` | question 4: faults injected while a read, write, `git status` or `tsc` is in flight |
| `bench/coherence.ts` | question 2: a file that shrinks or grows behind the mount (FSKit's short-read bug), new names, deletions |
| `bench/rw.ts` | the read/write/copy workload processes |
| `bench/tables.ts` | renders the report's tables from `results/` |
| `ci/prepare.sh` | makes "the other computer's home": a clone of this repo with `node_modules` |
| `ci/macfuse.sh` | CI only, on a disposable macOS runner: installs macFUSE and turns its FSKit module on by hand |
| `ci/windows-git.ps1` | CI only: Git for Windows and Git Bash inside the tree, three layouts |
| `results/` | the numbers from CI, as JSON |

No `package.json` here on purpose: `spikes/*` is a workspace glob, so one would join the root
workspace. Everything runs as plain Bun scripts.

## One command per check

Linux (FUSE; needs `fuse3`) and Windows (WinFsp 2.1 installed). Build the helper first:
`cd native/mounts && CGO_ENABLED=0 go build -o /tmp/s6/clover-mount ./cmd/clover-mount`
(`clover-mount.exe` on Windows), then `bash spikes/s6-mounts/ci/prepare.sh /tmp/s6/export`.
On Windows pass `--tree T:`.

```sh
# protocol-level checks, any OS, no mount (also the fail-fast core):
cd native/mounts && CLOVER_S6_SERVE=$PWD/../../spikes/s6-mounts/server/serve.ts go test ./... -v

# question 1 + 2: mount, read, write, and what a reader sees when files change behind the mount
bun spikes/s6-mounts/bench/coherence.ts --root /tmp/s6/export --tree /tmp/s6/tree --helper /tmp/s6/clover-mount --out /tmp/s6/results/coherence.json

# question 3: speed, one caching policy per run (cached, plain or nocache)
bun spikes/s6-mounts/bench/speed.ts --root /tmp/s6/export --tree /tmp/s6/tree --helper /tmp/s6/clover-mount --policies cached --rtts 0,20,80 --out /tmp/s6/results/speed-cached.json

# question 4: fail fast and recover
bun spikes/s6-mounts/bench/failfast.ts --root /tmp/s6/export --tree /tmp/s6/tree --helper /tmp/s6/clover-mount --rtt 20 --out /tmp/s6/results/failfast.json

# git across the mount when the holder's user has another uid (Linux)
bun spikes/s6-mounts/bench/speed.ts --root /tmp/s6/export --tree /tmp/s6/tree --helper /tmp/s6/clover-mount --policies cached --rtts 0,20,80 --local 0 --workloads git-status,git-status-minimal --owner 4242:4242 --out /tmp/s6/results/speed-owner.json

# the tables in the report
bun spikes/s6-mounts/bench/tables.ts spikes/s6-mounts/results
```

macOS over NFS (no extension): build `clover-nfs` (`GOOS=darwin CGO_ENABLED=0 go build -o /tmp/s6/clover-nfs ./cmd/clover-nfs`)
and pass `--helper none --nfs-helper /tmp/s6/clover-nfs` to `coherence.ts`, `failfast.ts` or
`speed.ts`. The rig mounts with `mount_nfs` as the user, and falls back to `sudo` if that fails
(it records which in the results).

macOS, FSKit: CI builds the module and stops at "Module … is disabled!" (it cannot be turned on
without System Settings, and an ad-hoc signature can't carry its entitlement). CI reaches FSKit
itself through macFUSE's FSKit backend instead (`ci/macfuse.sh`, then the helper built with cgo
and `CLOVER_MACFUSE_BACKEND=fskit`), on disposable runners only. At live gate 2 the owner runs,
in a terminal:

```sh
CLOVER_TEAM_ID=<team id> native/mounts/macos/gate.sh
```

which signs the module, asks for the one click in System Settings, then runs the coherence
check with the short-read guard on and off, the speed matrix and the fail-fast scenarios on the
FSKit volume, and removes the app again.

The CI workflow is `.github/workflows/spike-s6.yml`; every push to `lane/j-m0` runs it.
