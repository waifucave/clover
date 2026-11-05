# native/mounts — the folder tree's mount helper (prototype, spike S6)

The folder tree (spec §9.1) shows every connected computer's home under `home/<Computer>/`.
This computer's own entry is a link to its home folder; every other computer's entry is served
over that computer's link by the helper here. The report is
[docs/research/2026-11-05-s6-mounts.md](../../docs/research/2026-11-05-s6-mounts.md).

| Path | What |
| :- | :- |
| `PROTOCOL.md` | the wire protocol between the helper and the file service on the computer that holds the files |
| `wire/` | the protocol in Go |
| `remote/` | one computer's link (liveness, fail-fast, redial) and the path-based file system with the three caching policies |
| `fuselinux/` | Linux: FUSE through go-fuse (pure Go, no cgo, needs `fusermount3`) |
| `winfsp/` | Windows: WinFsp's FUSE layer through cgofuse (no cgo: it loads WinFsp's DLL) |
| `cmd/clover-mount/` | the helper: one process mounts the whole tree |
| `macos/` | macOS: the `clovertree` FSKit module (Swift), its host app, the CI probe and the live-gate script |

The other half, the file service, runs in the daemon on the computer that holds the files; its
prototype is `spikes/s6-mounts/server/serve.ts` (Bun).

## Build

```sh
cd native/mounts
GOOS=linux   CGO_ENABLED=0 go build -o bin/clover-mount       ./cmd/clover-mount
GOOS=windows CGO_ENABLED=0 go build -o bin/clover-mount.exe   ./cmd/clover-mount
cd macos && xcodegen generate && xcodebuild -project CloverTree.xcodeproj -scheme CloverTree \
  -configuration Release -derivedDataPath /tmp/dd-clovertree CODE_SIGNING_ALLOWED=NO build
```

The FSKit module only runs once it is signed with a team whose App ID has the FSKit Module
capability and turned on in System Settings; `macos/gate.sh` does both at the live gate.

## Run

```sh
bun spikes/s6-mounts/server/serve.ts --root ~/some/folder --port 7400          # on the holder
clover-mount --mountpoint /run/user/$UID/clover --self Me=$HOME \
             --remote Desktop1=127.0.0.1:7400 --policy cached                    # Linux
clover-mount.exe --mountpoint T: --self Me=%USERPROFILE% --remote Desktop1=127.0.0.1:7400   # Windows
mount -F -t clovertree clovertree://127.0.0.1:7400/Desktop1 ~/clover-tree        # macOS, once enabled
```

Policies: `nocache` (every lookup crosses the link), `plain` (1 s caching, like stock FUSE file
systems) and `cached` (cache until the holder reports a change, plus a breadth-first prefetch
of a directory's subtree on first listing).
