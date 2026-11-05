# Third-party code

## go-nfs v0.0.4

[github.com/willscott/go-nfs](https://github.com/willscott/go-nfs) at v0.0.4, Apache-2.0 (its
`LICENSE` is kept beside it), without its examples and tests. `go.mod` replaces the module with
this copy. Three files are changed, each marked at its top:

* `conn.go`: an error from a computer that is offline (EHOSTDOWN, EHOSTUNREACH, ETIMEDOUT)
  answers NFS3ERR_IO, whatever status the handler chose. Unpatched, a read in flight reported
  "Permission denied" and a lookup "No such file", which the macOS client then cached as a
  missing name until the directory changed, so the mount stayed broken after the link returned.
  Second, the requests of one connection run concurrently (at most 64 at a time). The kernel's
  client sends all of a mount's calls over one connection, and upstream handled them one after
  another, so a read waiting on the far computer held up every lookup behind it.
* `nfs_onlookup.go`: a lookup answers NFS3ERR_NOENT only when the name is really missing.
* `nfs_onread.go`: a read that comes back shorter than the size the client was given answers
  NFS3ERR_IO instead of a short read. Unpatched, macOS's NFS client padded such a read with
  zeros up to the size it held (FSKit's short-read corruption, in NFS: report §2), and it did so
  even when the reply's post-op attributes carried the new size, which was the first try.
