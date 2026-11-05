# Third-party code

## go-nfs v0.0.4

[github.com/willscott/go-nfs](https://github.com/willscott/go-nfs) at v0.0.4, Apache-2.0 (its
`LICENSE` is kept beside it), without its examples and tests. `go.mod` replaces the module with
this copy. Five files are changed, each marked at its top, and `helpers/` has one test file of
ours (`cachinghandler_clover_test.go`):

* `conn.go`: an error from a computer that is offline (EHOSTDOWN, EHOSTUNREACH, ETIMEDOUT)
  answers NFS3ERR_IO, whatever status the handler chose. Unpatched, a read in flight reported
  "Permission denied" and a lookup "No such file", which the macOS client then cached as a
  missing name until the directory changed, so the mount stayed broken after the link returned.
  Second, the requests of one connection run concurrently (at most 64 at a time), except WRITE
  and COMMIT, which run one at a time and in order on a queue of their own, so the read loop
  keeps taking other calls while a write waits on the far computer. The kernel's client sends
  all of a mount's calls over one connection, and upstream handled them one after another, so a
  read waiting on the far computer held up every lookup behind it. With writes concurrent too,
  macOS's client let a writer run on for 18–29 s after the far computer dropped before it
  reported the error (`results/macos2?-nfs-failfast-concurrent-writes.json`). Third, every NFS
  procedure served is counted, with the time spent on it (`Calls`, `CallNanos`; clover-nfs's
  status endpoint reports them per workload).
* `helpers/cachinghandler.go`: `FromHandle` walked every live handle on every call to keep the
  handle's ancestors recent in the LRU, which every NFS procedure pays: 2.3 µs with 100 handles,
  112 µs with 4,000, 5.1 ms with 100,000 (review B1). It now looks each ancestor up through the
  reverse map instead: about 0.3 µs at any size (`TestFromHandleCostIsFlat`).
* `mount.go`: a refused MOUNT answers without a root handle. Upstream built the handle for any
  status and crashed on the nil file system a refusing handler returns (clover-nfs refuses every
  MOUNT but the first with its one-time export path: `nfsloop/gate.go`).
* `nfs_onlookup.go`: a lookup answers NFS3ERR_NOENT only when the name is really missing.
* `nfs_onread.go`: a read that comes back shorter than the size the client was given answers
  NFS3ERR_IO instead of a short read. Unpatched, macOS's NFS client padded such a read with
  zeros up to the size it held (FSKit's short-read corruption, in NFS: report §2), and it did so
  even when the reply's post-op attributes carried the new size, which was the first try.

Known gaps, for M2 (the report's rules): WRITE always answers FILE_SYNC and COMMIT never
reaches the holder, so an fsync on the Mac does not sync the holder's disk; each WRITE costs a
second round trip to the holder for its post-op attributes.
