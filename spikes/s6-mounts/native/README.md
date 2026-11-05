# The folder tree's mount helper (prototype, spike S6; evidence only)

The folder tree (spec §9.1) shows every connected computer's home under `home/<Computer>/`.
This spike served every other computer's entry as an OS mount, over that computer's link, by the
helper here. The owner decided on November 5 that Clover mounts nothing (the report's edit 1),
so this folder is the record of why: FUSE, WinFsp and NFS loopback all worked, and mounts
aren't needed. It moved here from `native/mounts/`, which the plan's `native/*` layout no
longer has. The report is
[docs/research/2026-11-05-s6-mounts.md](../../../docs/research/2026-11-05-s6-mounts.md).

| Path | What |
| :- | :- |
| `PROTOCOL.md` | the wire protocol between the helper and the file service on the computer that holds the files |
| `wire/` | the protocol in Go |
| `remote/` | one computer's link (liveness, fail-fast, redial, events off the reader) and the path-based file system with the three caching policies |
| `fuselinux/` | Linux: FUSE through go-fuse (pure Go, no cgo, needs `fusermount3`) |
| `cgofs/` | Windows: WinFsp's FUSE layer through cgofuse (no cgo: it loads WinFsp's DLL). Also macOS with cgo against macFUSE, which CI uses to drive FSKit through macFUSE's FSKit backend |
| `nfsloop/`, `cmd/clover-nfs/` | macOS: one computer's home as an NFSv3 export on the loopback address, for the kernel's NFS client |
| `third_party/go-nfs/` | go-nfs v0.0.4 with patches to five files (see `third_party/README.md`) |
| `cmd/clover-mount/` | the helper: one process mounts the whole tree (or, with `--single`, one computer's home) |
| `macos/` | macOS: the `clovertree` FSKit module (Swift), its host app, the CI probe and the live-gate script |

The other half, the file service, runs in the daemon on the computer that holds the files; its
prototype is `spikes/s6-mounts/server/serve.ts` (Bun).

## Build

```sh
cd spikes/s6-mounts/native
GOOS=linux   CGO_ENABLED=0 go build -o bin/clover-mount     ./cmd/clover-mount
GOOS=windows CGO_ENABLED=0 go build -o bin/clover-mount.exe ./cmd/clover-mount
GOOS=darwin  CGO_ENABLED=0 go build -o bin/clover-nfs       ./cmd/clover-nfs
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
clover-mount.exe --mountpoint T: --volume-prefix \clover\tree --remote Desktop1=127.0.0.1:7400  # Windows: a network volume
clover-mount.exe --mountpoint "*" --single --volume-prefix \clover\Desktop1 --remote Desktop1=127.0.0.1:7400  # one computer, \\clover\Desktop1
clover-nfs --remote Desktop1=127.0.0.1:7400 --policy cached      # macOS: prints {"port":N,"export":"/<token>"}, then, as the user:
mount_nfs -o vers=3,tcp,port=N,mountport=N,nolocks,locallocks,soft,intr,dumbtimer,timeo=110,retrans=2,deadtimeout=5,rsize=1048576,wsize=1048576,readahead=16,nobrowse,noresvport,noac 127.0.0.1:/<token> ~/tree/home/Desktop1
mount -F -t clovertree clovertree://127.0.0.1:7400/Desktop1 ~/clover-tree        # macOS FSKit, once enabled
```

On macOS, clover-nfs listens on an ephemeral loopback port and accepts exactly one MOUNT, of a
one-time random export path; it refuses every other MOUNT, whatever path it asks for. The
port and the path reach the mounting process on the helper's stdout, the daemon's pipe in M2.
Who else can reach the export, and what M2 adds, is in the report (edit 1).

Policies: `nocache` (every lookup crosses the link), `plain` (1 s caching, like stock FUSE file
systems) and `cached` (cache until the holder reports a change, plus a breadth-first prefetch
of a directory's subtree on the first lookup or listing that misses in it).

On Windows, mount the tree as a network volume (`--volume-prefix`): on a plain drive letter or a
folder, Windows can't name the volume, Node's `realpath` fails, and `tsc` in a Bun or pnpm
workspace finds no types (see the report). A network volume can't be mounted on a folder.

Test knobs: `--owner uid:gid` (Linux) reports another owner for every file, as a holder whose
user has another uid would; `--case-insensitive` (Windows) turns on WinFsp's case-insensitive
mode, which upper-cases names (see the report).
