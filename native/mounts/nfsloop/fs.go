// Package nfsloop serves one other computer's folder as an NFSv3 export on localhost, for the
// operating system's own NFS client to mount. It is the macOS alternative to an FSKit module:
// no file-system extension to approve in System Settings and no restricted entitlement, because
// the kernel's NFS client does the mounting (the approach FUSE-T and rclone's nfsmount take).
// Behind the export is the same link and caching as the FUSE and WinFsp helpers (package remote).
package nfsloop

import (
	"io"
	"os"
	"path"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-git/go-billy/v5"
	nfsfile "github.com/willscott/go-nfs/file"

	"github.com/waifucave/clover/native/mounts/remote"
	"github.com/waifucave/clover/native/mounts/wire"
)

// FS adapts remote.FS to billy.Filesystem (+ billy.Change), the interface go-nfs serves.
type FS struct {
	R   *remote.FS
	uid uint32
	gid uint32

	mu      sync.Mutex
	writers map[string]*sharedHandle // one remote write handle per file across NFS WRITE calls
}

type sharedHandle struct {
	h     *remote.Handle
	refs  int
	timer *time.Timer
}

func New(r *remote.FS) *FS {
	return &FS{R: r, uid: uint32(os.Getuid()), gid: uint32(os.Getgid()), writers: map[string]*sharedHandle{}}
}

func clean(p string) string { return strings.TrimPrefix(path.Clean("/"+p), "/") }

func perr(op, p string, e wire.Errno) error {
	if e == wire.OK {
		return nil
	}
	return &os.PathError{Op: op, Path: p, Err: toErrno(e)}
}

// toErrno maps wire (Linux) numbers to this platform's errno, which go-nfs turns into NFS status.
func toErrno(e wire.Errno) syscall.Errno {
	switch e {
	case wire.EPERM:
		return syscall.EPERM
	case wire.ENOENT:
		return syscall.ENOENT
	case wire.EACCES:
		return syscall.EACCES
	case wire.EEXIST:
		return syscall.EEXIST
	case wire.EXDEV:
		return syscall.EXDEV
	case wire.ENOTDIR:
		return syscall.ENOTDIR
	case wire.EISDIR:
		return syscall.EISDIR
	case wire.EINVAL:
		return syscall.EINVAL
	case wire.EFBIG:
		return syscall.EFBIG
	case wire.ENOSPC:
		return syscall.ENOSPC
	case wire.EROFS:
		return syscall.EROFS
	case wire.ENAMETOOLONG:
		return syscall.ENAMETOOLONG
	case wire.ENOTEMPTY:
		return syscall.ENOTEMPTY
	case wire.ELOOP:
		return syscall.ELOOP
	case wire.ENOTSUP:
		return syscall.ENOTSUP
	case wire.ESTALE:
		return syscall.ESTALE
	case wire.ETIMEDOUT:
		return syscall.ETIMEDOUT
	case wire.EHOSTDOWN:
		return syscall.EHOSTDOWN
	}
	return syscall.EIO
}

// info is an os.FileInfo carrying the holder's attributes.
type info struct {
	name string
	a    wire.Attr
	uid  uint32
	gid  uint32
}

func (i *info) Name() string { return i.name }
func (i *info) Size() int64  { return int64(i.a.Size) }
func (i *info) Mode() os.FileMode {
	m := os.FileMode(i.a.Mode & 0o777)
	switch i.a.Type {
	case wire.TypeDir:
		m |= os.ModeDir
	case wire.TypeSymlink:
		m |= os.ModeSymlink
	}
	return m
}
func (i *info) ModTime() time.Time { return time.Unix(0, i.a.MtimeNs) }
func (i *info) IsDir() bool        { return i.a.Type == wire.TypeDir }
func (i *info) Sys() any {
	n := i.a.Nlink
	if n == 0 {
		n = 1
	}
	return &nfsfile.FileInfo{Nlink: n, UID: i.uid, GID: i.gid, Fileid: i.a.Ino}
}

func (f *FS) info(p string, a wire.Attr) *info {
	return &info{name: path.Base("/" + p), a: a, uid: f.uid, gid: f.gid}
}

func (f *FS) Lstat(name string) (os.FileInfo, error) {
	p := clean(name)
	a, e := f.R.Stat(p)
	if e == wire.EHOSTDOWN && p == "" {
		// An offline computer still has a folder, so the mount itself succeeds (and `ls home/`
		// never fails); everything inside it answers EIO until the computer is back.
		return f.info(p, wire.Attr{Type: wire.TypeDir, Mode: 0o755, Nlink: 2, Ino: 1}), nil
	}
	if e != wire.OK {
		return nil, perr("lstat", name, e)
	}
	return f.info(p, a), nil
}

// Stat is Lstat: the NFS client resolves symlinks itself (READLINK).
func (f *FS) Stat(name string) (os.FileInfo, error) { return f.Lstat(name) }

func (f *FS) ReadDir(name string) ([]os.FileInfo, error) {
	p := clean(name)
	ents, e := f.R.List(p)
	if e != wire.OK {
		return nil, perr("readdir", name, e)
	}
	out := make([]os.FileInfo, len(ents))
	for i := range ents {
		out[i] = &info{name: ents[i].Name, a: ents[i].Attr, uid: f.uid, gid: f.gid}
	}
	return out, nil
}

func wireFlags(flag int) uint32 {
	w := uint32(0)
	switch flag & (os.O_RDONLY | os.O_WRONLY | os.O_RDWR) {
	case os.O_WRONLY:
		w = wire.OWronly
	case os.O_RDWR:
		w = wire.ORdwr
	}
	if flag&os.O_CREATE != 0 {
		w |= wire.OCreat
	}
	if flag&os.O_EXCL != 0 {
		w |= wire.OExcl
	}
	if flag&os.O_TRUNC != 0 {
		w |= wire.OTrunc
	}
	if flag&os.O_APPEND != 0 {
		w |= wire.OAppend
	}
	return w
}

func (f *FS) OpenFile(name string, flag int, perm os.FileMode) (billy.File, error) {
	p := clean(name)
	wf := wireFlags(flag)
	if wf&wire.OAccMode == wire.ORdonly && wf&(wire.OCreat|wire.OTrunc) == 0 {
		h, _, e := f.R.Open(p, wf, 0)
		if e != wire.OK {
			return nil, perr("open", name, e)
		}
		return &file{fs: f, path: p, h: h}, nil
	}
	// go-nfs opens the file for every NFS WRITE; share one remote handle per file instead of a
	// round trip to open and close each time.
	f.mu.Lock()
	if sh, ok := f.writers[p]; ok && wf&(wire.OCreat|wire.OTrunc|wire.OExcl) == 0 {
		sh.refs++
		if sh.timer != nil {
			sh.timer.Stop()
			sh.timer = nil
		}
		f.mu.Unlock()
		return &file{fs: f, path: p, h: sh.h, shared: true}, nil
	}
	f.mu.Unlock()
	h, _, e := f.R.Open(p, (wf&^wire.OAccMode)|wire.ORdwr, uint32(perm.Perm())) // shared by readers and writers
	if e != wire.OK {
		return nil, perr("open", name, e)
	}
	f.mu.Lock()
	if old, ok := f.writers[p]; ok && old.refs == 0 {
		go f.R.Release(old.h)
	}
	f.writers[p] = &sharedHandle{h: h, refs: 1}
	f.mu.Unlock()
	return &file{fs: f, path: p, h: h, shared: true}, nil
}

func (f *FS) release(p string, h *remote.Handle) {
	f.mu.Lock()
	defer f.mu.Unlock()
	sh, ok := f.writers[p]
	if !ok || sh.h != h {
		go f.R.Release(h)
		return
	}
	if sh.refs--; sh.refs > 0 {
		return
	}
	sh.timer = time.AfterFunc(2*time.Second, func() {
		f.mu.Lock()
		if cur, ok := f.writers[p]; ok && cur == sh && sh.refs == 0 {
			delete(f.writers, p)
			f.mu.Unlock()
			f.R.Release(sh.h)
			return
		}
		f.mu.Unlock()
	})
}

func (f *FS) Open(name string) (billy.File, error) { return f.OpenFile(name, os.O_RDONLY, 0) }
func (f *FS) Create(name string) (billy.File, error) {
	return f.OpenFile(name, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o666)
}

func (f *FS) Rename(from, to string) error {
	return perr("rename", from, f.R.Rename(clean(from), clean(to), 0))
}

func (f *FS) Remove(name string) error {
	p := clean(name)
	a, e := f.R.Stat(p)
	if e != wire.OK {
		return perr("remove", name, e)
	}
	if a.Type == wire.TypeDir {
		return perr("rmdir", name, f.R.Rmdir(p))
	}
	return perr("unlink", name, f.R.Unlink(p))
}

func (f *FS) Join(elem ...string) string { return path.Join(elem...) }

func (f *FS) TempFile(dir, prefix string) (billy.File, error) {
	name := path.Join(dir, prefix+time.Now().Format("150405.000000000"))
	return f.OpenFile(name, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
}

func (f *FS) MkdirAll(name string, perm os.FileMode) error {
	p := clean(name)
	if p == "" {
		return nil
	}
	parts := strings.Split(p, "/")
	for i := range parts {
		sub := strings.Join(parts[:i+1], "/")
		if a, e := f.R.Stat(sub); e == wire.OK {
			if a.Type != wire.TypeDir {
				return perr("mkdir", sub, wire.ENOTDIR)
			}
			continue
		}
		if _, e := f.R.Mkdir(sub, uint32(perm.Perm())); e != wire.OK && e != wire.EEXIST {
			return perr("mkdir", sub, e)
		}
	}
	return nil
}

func (f *FS) Symlink(target, link string) error {
	_, e := f.R.Symlink(clean(link), target)
	return perr("symlink", link, e)
}

func (f *FS) Readlink(link string) (string, error) {
	t, e := f.R.Readlink(clean(link))
	return t, perr("readlink", link, e)
}

func (f *FS) Chroot(string) (billy.Filesystem, error) { return nil, billy.ErrNotSupported }
func (f *FS) Root() string                            { return "/" }

// billy.Change

func (f *FS) Chmod(name string, mode os.FileMode) error {
	_, e := f.R.Setattr(clean(name), nil, wire.SetMode, uint32(mode.Perm()), 0, 0, 0)
	return perr("chmod", name, e)
}
func (f *FS) Lchown(string, int, int) error { return nil } // ownership is the local user's
func (f *FS) Chown(string, int, int) error  { return nil }
func (f *FS) Chtimes(name string, atime, mtime time.Time) error {
	_, e := f.R.Setattr(clean(name), nil, wire.SetAtime|wire.SetMtime, 0, 0, atime.UnixNano(), mtime.UnixNano())
	return perr("chtimes", name, e)
}

// file is an open file; offsets are the caller's.
type file struct {
	fs     *FS
	path   string
	h      *remote.Handle
	off    int64
	shared bool
}

func (x *file) Name() string { return x.path }

func (x *file) ReadAt(p []byte, off int64) (int, error) {
	n := 0
	for n < len(p) {
		data, e := x.fs.R.Read(x.path, x.h, off+int64(n), len(p)-n)
		if e != wire.OK {
			return n, perr("read", x.path, e)
		}
		n += copy(p[n:], data)
		if len(data) == 0 {
			break
		}
	}
	if n < len(p) {
		// The file ends before the size the client was given. Drop the cached size, so the
		// reply's post-op attributes (patched go-nfs, onRead) carry the new one.
		x.fs.R.Forget(x.path)
		return n, io.EOF
	}
	return n, nil
}

func (x *file) Read(p []byte) (int, error) {
	n, err := x.ReadAt(p, x.off)
	x.off += int64(n)
	return n, err
}

func (x *file) WriteAt(p []byte, off int64) (int, error) {
	n, e := x.fs.R.Write(x.h, off, p)
	return n, perr("write", x.path, e)
}

func (x *file) Write(p []byte) (int, error) {
	n, err := x.WriteAt(p, x.off)
	x.off += int64(n)
	return n, err
}

func (x *file) Seek(off int64, whence int) (int64, error) {
	switch whence {
	case io.SeekStart:
		x.off = off
	case io.SeekCurrent:
		x.off += off
	case io.SeekEnd:
		a, e := x.fs.R.Stat(x.path)
		if e != wire.OK {
			return 0, perr("seek", x.path, e)
		}
		x.off = int64(a.Size) + off
	}
	return x.off, nil
}

func (x *file) Close() error {
	if x.shared {
		x.fs.release(x.path, x.h)
	} else {
		go x.fs.R.Release(x.h)
	}
	return nil
}

func (x *file) Lock() error   { return nil }
func (x *file) Unlock() error { return nil }
func (x *file) Truncate(size int64) error {
	_, e := x.fs.R.Setattr(x.path, x.h, wire.SetSize, 0, uint64(size), 0, 0)
	return perr("truncate", x.path, e)
}
