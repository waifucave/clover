# Third-party code

## go-nfs v0.0.4

[github.com/willscott/go-nfs](https://github.com/willscott/go-nfs) at v0.0.4, Apache-2.0 (its
`LICENSE` is kept beside it), without its examples and tests. `go.mod` replaces the module with
this copy. Three files are changed, each marked at its top:

* `conn.go`: an error from a computer that is offline (EHOSTDOWN, EHOSTUNREACH, ETIMEDOUT)
  answers NFS3ERR_IO, whatever status the handler chose. Unpatched, a read in flight reported
  "Permission denied" and a lookup "No such file", which the macOS client then cached as a
  missing name until the directory changed, so the mount stayed broken after the link returned.
* `nfs_onlookup.go`: a lookup answers NFS3ERR_NOENT only when the name is really missing.
* `nfs_onread.go`: after a short read, the reply's post-op attributes are taken after the read,
  so the client learns that the file shrank. Unpatched, macOS's NFS client padded the read up to
  the old size with zeros: FSKit's short-read corruption, in NFS (report §2).
