//go:build windows || (darwin && cgo)

// Package cgofs serves the folder tree through a path-based FUSE API (cgofuse):
//
//   - Windows: WinFsp's FUSE layer, without cgo (cgofuse loads WinFsp's DLL itself).
//     T:\ is the tree's root (a drive letter, spec §9.1), T:\home\<self> a link to this
//     computer's home folder, T:\home\<other> another computer's home over its link.
//   - macOS (cgo, macFUSE's libfuse): only to drive macFUSE's FSKit backend in CI, which is how
//     the spike reproduces FSKit's short-read bug without a module of its own (see the report).
package cgofs

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/winfsp/cgofuse/fuse"

	"github.com/waifucave/clover/native/mounts/remote"
	"github.com/waifucave/clover/native/mounts/wire"
)

type Computer struct {
	Name string
	Self string     // this computer: the home folder its entry links to
	FS   *remote.FS // another computer
}

type Tree struct {
	fuse.FileSystemBase
	Computers []*Computer
	Policy    remote.Policy
	Host      *fuse.FileSystemHost
	// Single serves one other computer's home as the whole volume. On Windows that volume is
	// mounted on a folder, <tree>\home\<Other>, beside a junction for this computer: WinFsp's
	// FUSE layer can't make a link that leaves the volume (see the report).
	Single bool
	// CaseInsensitive tells WinFsp the volume ignores case (a test knob; off by default).
	CaseInsensitive bool
	// VolumePrefix makes the WinFsp volume a network one (\\server\share), as sshfs-win does,
	// so Windows can name its files without the Mount Manager (a test knob; see the report).
	VolumePrefix string

	handles sync.Map // uint64 -> *remote.Handle
	next    atomic.Uint64
	started time.Time
}

// Mount mounts the tree and blocks until unmount. Windows: a drive letter ("T:"), "\\.\T:" for
// the Mount Manager, or an absent directory. macOS: a directory, through macFUSE.
func Mount(mountpoint string, t *Tree, debug bool) bool {
	t.started = time.Now()
	t.Host = fuse.NewFileSystemHost(t)
	t.Host.SetCapReaddirPlus(t.Policy.TTL != 0)
	// Case-insensitive makes WinFsp's FUSE layer hand out upper-cased names (\HOME\DESKTOP1),
	// which git then stats and can't find. Without it names keep the holder's case; the holder
	// decides how case is matched (NTFS and APFS ignore it, Linux doesn't). See the report.
	t.Host.SetCapCaseInsensitive(t.CaseInsensitive)
	for _, c := range t.Computers {
		if c.FS != nil {
			comp := c
			comp.FS.Invalidate = func(p string) { t.notify(comp, p) }
			comp.FS.InvalidateAll = func() { t.notify(comp, "") }
		}
	}
	timeout := int(t.Policy.KernelTTL / time.Millisecond)
	var opts []string
	if runtime.GOOS == "windows" {
		opts = []string{
			"-o", "uid=-1,gid=-1", // files belong to the user running the helper
			"-o", "volname=Clover",
			"-o", "FileSystemName=Clover",
			"-o", "FileInfoTimeout=" + itoa(timeout),
			"-o", "DirInfoTimeout=" + itoa(timeout),
			"-o", "VolumeInfoTimeout=" + itoa(maxInt(timeout, 1000)),
		}
		if t.Policy.KeepCache {
			opts = append(opts, "-o", "KeepFileCache")
		}
		if t.VolumePrefix != "" {
			opts = append(opts, "--VolumePrefix="+t.VolumePrefix)
		}
	} else {
		secs := strconv.FormatFloat(t.Policy.KernelTTL.Seconds(), 'f', 3, 64)
		opts = []string{"-o", "volname=Clover,nobrowse,noappledouble,noapplexattr",
			"-o", "attr_timeout=" + secs + ",entry_timeout=" + secs + ",negative_timeout=" + secs}
		if b := os.Getenv("CLOVER_MACFUSE_BACKEND"); b != "" {
			opts = append(opts, "-o", "backend="+b) // "fskit": macFUSE's FSKit backend
		}
	}
	if debug {
		opts = append(opts, "-d")
	}
	return t.Host.Mount(mountpoint, opts)
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

func (t *Tree) notify(c *Computer, p string) {
	if t.Host == nil {
		return
	}
	full := "/home/" + c.Name
	if t.Single {
		full = ""
	}
	if p != "" {
		full += "/" + p
	}
	if full == "" {
		t.Host.Notify("/", fuse.NOTIFY_CHMOD|fuse.NOTIFY_CHOWN|fuse.NOTIFY_UTIME)
		return
	}
	t.Host.Notify(full, fuse.NOTIFY_CHMOD|fuse.NOTIFY_CHOWN|fuse.NOTIFY_UTIME|fuse.NOTIFY_TRUNCATE)
	dir, _ := remote.Parent(full)
	if dir == "" {
		dir = "/"
	}
	t.Host.Notify(dir, fuse.NOTIFY_CREATE|fuse.NOTIFY_UNLINK)
}

// where splits a tree path: kind is "root", "home", "self", "remote" or "" (no such path).
func (t *Tree) where(path string) (kind string, c *Computer, rel string) {
	p := strings.TrimPrefix(path, "/")
	if t.Single {
		for _, cc := range t.Computers {
			if cc.FS != nil {
				return "remote", cc, p
			}
		}
		return "", nil, ""
	}
	if p == "" {
		return "root", nil, ""
	}
	parts := strings.SplitN(p, "/", 3)
	if parts[0] != "home" && !(t.CaseInsensitive && strings.EqualFold(parts[0], "home")) {
		return "", nil, ""
	}
	if len(parts) == 1 {
		return "home", nil, ""
	}
	for _, cc := range t.Computers {
		if strings.EqualFold(cc.Name, parts[1]) {
			c = cc
			break
		}
	}
	if c == nil {
		return "", nil, ""
	}
	if len(parts) == 3 {
		rel = parts[2]
	}
	if c.Self != "" {
		if rel != "" {
			return "", nil, "" // the OS follows the link; nothing below it is ours
		}
		return "self", c, ""
	}
	return "remote", c, rel
}

func errc(e wire.Errno) int {
	switch e {
	case wire.OK:
		return 0
	case wire.EPERM:
		return -fuse.EPERM
	case wire.ENOENT:
		return -fuse.ENOENT
	case wire.EINTR:
		return -fuse.EINTR
	case wire.EBADF:
		return -fuse.EBADF
	case wire.EACCES:
		return -fuse.EACCES
	case wire.EBUSY:
		return -fuse.EBUSY
	case wire.EEXIST:
		return -fuse.EEXIST
	case wire.EXDEV:
		return -fuse.EXDEV
	case wire.ENOTDIR:
		return -fuse.ENOTDIR
	case wire.EISDIR:
		return -fuse.EISDIR
	case wire.EINVAL:
		return -fuse.EINVAL
	case wire.EMFILE:
		return -fuse.EMFILE
	case wire.EFBIG:
		return -fuse.EFBIG
	case wire.ENOSPC:
		return -fuse.ENOSPC
	case wire.EROFS:
		return -fuse.EROFS
	case wire.ENAMETOOLONG:
		return -fuse.ENAMETOOLONG
	case wire.ENOTEMPTY:
		return -fuse.ENOTEMPTY
	case wire.ELOOP:
		return -fuse.ELOOP
	case wire.ENOTSUP:
		return -fuse.ENOTSUP
	case wire.ETIMEDOUT:
		return -fuse.ETIMEDOUT
	case wire.EHOSTDOWN:
		return -fuse.EHOSTUNREACH // "computer offline"; Windows has no EHOSTDOWN
	case wire.ESTALE:
		return -fuse.EIO
	}
	return -fuse.EIO
}

func fileMode(typ uint8) uint32 {
	switch typ {
	case wire.TypeDir:
		return fuse.S_IFDIR
	case wire.TypeSymlink:
		return fuse.S_IFLNK
	}
	return fuse.S_IFREG
}

func ts(ns int64) fuse.Timespec { return fuse.Timespec{Sec: ns / 1e9, Nsec: ns % 1e9} }

func fill(a *wire.Attr, st *fuse.Stat_t) {
	*st = fuse.Stat_t{}
	st.Mode = fileMode(a.Type) | (a.Mode & 0o7777)
	st.Size = int64(a.Size)
	st.Nlink = a.Nlink
	st.Ino = a.Ino
	st.Mtim, st.Ctim, st.Atim, st.Birthtim = ts(a.MtimeNs), ts(a.CtimeNs), ts(a.AtimeNs), ts(a.BirthNs)
	st.Blksize = 4096
	st.Blocks = (st.Size + 511) / 512
}

func (t *Tree) dirStat(st *fuse.Stat_t) {
	*st = fuse.Stat_t{Mode: fuse.S_IFDIR | 0o755, Nlink: 2}
	now := fuse.NewTimespec(t.started)
	st.Mtim, st.Ctim, st.Atim, st.Birthtim = now, now, now, now
}

func (t *Tree) Getattr(path string, st *fuse.Stat_t, fh uint64) int {
	kind, c, rel := t.where(path)
	switch kind {
	case "root", "home":
		t.dirStat(st)
		return 0
	case "self":
		t.dirStat(st)
		st.Mode = fuse.S_IFLNK | 0o777
		st.Size = int64(len(c.Self))
		return 0
	case "remote":
		a, e := c.FS.Stat(rel)
		if e != wire.OK {
			if rel == "" && e == wire.EHOSTDOWN {
				t.dirStat(st) // an offline computer still shows its folder; reads inside fail fast
				return 0
			}
			return errc(e)
		}
		fill(&a, st)
		return 0
	}
	return -fuse.ENOENT
}

func (t *Tree) Readlink(path string) (int, string) {
	kind, c, rel := t.where(path)
	switch kind {
	case "self":
		return 0, c.Self
	case "remote":
		s, e := c.FS.Readlink(rel)
		return errc(e), s
	}
	return -fuse.EINVAL, ""
}

func (t *Tree) Readdir(path string, fill func(name string, stat *fuse.Stat_t, ofst int64) bool, ofst int64, fh uint64) int {
	kind, c, rel := t.where(path)
	var dot fuse.Stat_t
	t.dirStat(&dot)
	switch kind {
	case "root":
		fill(".", &dot, 0)
		fill("..", &dot, 0)
		fill("home", &dot, 0)
		return 0
	case "home":
		fill(".", &dot, 0)
		fill("..", &dot, 0)
		for _, cc := range t.Computers {
			var st fuse.Stat_t
			t.dirStat(&st)
			if cc.Self != "" {
				st.Mode = fuse.S_IFLNK | 0o777
			}
			fill(cc.Name, &st, 0)
		}
		return 0
	case "remote":
		ents, e := c.FS.List(rel)
		if e != wire.OK {
			return errc(e)
		}
		fill(".", &dot, 0)
		fill("..", &dot, 0)
		for i := range ents {
			var st fuse.Stat_t
			fillAttr(&ents[i].Attr, &st)
			if !fill(ents[i].Name, &st, 0) {
				break
			}
		}
		return 0
	}
	return -fuse.ENOENT
}

func fillAttr(a *wire.Attr, st *fuse.Stat_t) { fill(a, st) }

func wireFlags(flags int) uint32 {
	w := uint32(flags & fuse.O_ACCMODE)
	if flags&fuse.O_CREAT != 0 {
		w |= wire.OCreat
	}
	if flags&fuse.O_EXCL != 0 {
		w |= wire.OExcl
	}
	if flags&fuse.O_TRUNC != 0 {
		w |= wire.OTrunc
	}
	if flags&fuse.O_APPEND != 0 {
		w |= wire.OAppend
	}
	return w
}

func (t *Tree) keep(h *remote.Handle) uint64 {
	id := t.next.Add(1)
	t.handles.Store(id, h)
	return id
}

func (t *Tree) handle(fh uint64) *remote.Handle {
	if v, ok := t.handles.Load(fh); ok {
		return v.(*remote.Handle)
	}
	return nil
}

func (t *Tree) Open(path string, flags int) (int, uint64) {
	kind, c, rel := t.where(path)
	if kind != "remote" {
		if kind == "" {
			return -fuse.ENOENT, ^uint64(0)
		}
		return -fuse.EISDIR, ^uint64(0)
	}
	h, _, e := c.FS.Open(rel, wireFlags(flags), 0)
	if e != wire.OK {
		return errc(e), ^uint64(0)
	}
	return 0, t.keep(h)
}

func (t *Tree) Create(path string, flags int, mode uint32) (int, uint64) {
	kind, c, rel := t.where(path)
	if kind != "remote" || rel == "" {
		return -fuse.EACCES, ^uint64(0)
	}
	h, _, e := c.FS.Open(rel, wireFlags(flags)|wire.OCreat, mode&0o7777)
	if e != wire.OK {
		return errc(e), ^uint64(0)
	}
	return 0, t.keep(h)
}

func (t *Tree) Read(path string, buff []byte, ofst int64, fh uint64) int {
	kind, c, rel := t.where(path)
	if kind != "remote" {
		return -fuse.EISDIR
	}
	data, e := c.FS.Read(rel, t.handle(fh), ofst, len(buff))
	if e != wire.OK {
		return errc(e)
	}
	return copy(buff, data)
}

func (t *Tree) Write(path string, buff []byte, ofst int64, fh uint64) int {
	kind, c, _ := t.where(path)
	h := t.handle(fh)
	if kind != "remote" || h == nil {
		return -fuse.EBADF
	}
	n, e := c.FS.Write(h, ofst, buff)
	if e != wire.OK {
		return errc(e)
	}
	return n
}

func (t *Tree) Release(path string, fh uint64) int {
	kind, c, _ := t.where(path)
	if v, ok := t.handles.LoadAndDelete(fh); ok && kind == "remote" {
		go c.FS.Release(v.(*remote.Handle))
	}
	return 0
}

func (t *Tree) Flush(path string, fh uint64) int { return 0 }

func (t *Tree) Fsync(path string, datasync bool, fh uint64) int {
	kind, c, _ := t.where(path)
	if kind != "remote" {
		return 0
	}
	return errc(c.FS.Fsync(t.handle(fh)))
}

func (t *Tree) Truncate(path string, size int64, fh uint64) int {
	kind, c, rel := t.where(path)
	if kind != "remote" {
		return -fuse.EACCES
	}
	_, e := c.FS.Setattr(rel, t.handle(fh), wire.SetSize, 0, uint64(size), 0, 0)
	return errc(e)
}

func (t *Tree) Utimens(path string, tmsp []fuse.Timespec) int {
	kind, c, rel := t.where(path)
	if kind != "remote" || len(tmsp) < 2 {
		return 0
	}
	now := time.Now().UnixNano()
	at, mt := tmsp[0].Time().UnixNano(), tmsp[1].Time().UnixNano()
	if tmsp[0].Nsec == fuse.UTIME_NOW {
		at = now
	}
	if tmsp[1].Nsec == fuse.UTIME_NOW {
		mt = now
	}
	_, e := c.FS.Setattr(rel, nil, wire.SetAtime|wire.SetMtime, 0, 0, at, mt)
	return errc(e)
}

func (t *Tree) Chmod(path string, mode uint32) int {
	kind, c, rel := t.where(path)
	if kind != "remote" {
		return 0
	}
	_, e := c.FS.Setattr(rel, nil, wire.SetMode, mode&0o7777, 0, 0, 0)
	return errc(e)
}

// Mknod makes a regular file. macFUSE's FSKit backend creates files this way, not with create.
func (t *Tree) Mknod(path string, mode uint32, dev uint64) int {
	kind, c, rel := t.where(path)
	if kind != "remote" || rel == "" {
		return -fuse.EACCES
	}
	if f := mode & fuse.S_IFMT; f != 0 && f != fuse.S_IFREG {
		return -fuse.EPERM // no devices, fifos or sockets across computers
	}
	h, _, e := c.FS.Open(rel, wire.OWronly|wire.OCreat|wire.OExcl, mode&0o7777)
	if e != wire.OK {
		return errc(e)
	}
	go c.FS.Release(h)
	return 0
}

func (t *Tree) Symlink(target, newpath string) int {
	kind, c, rel := t.where(newpath)
	if kind != "remote" || rel == "" {
		return -fuse.EACCES
	}
	_, e := c.FS.Symlink(rel, target)
	return errc(e)
}

func (t *Tree) Link(oldpath, newpath string) int {
	k1, c1, r1 := t.where(oldpath)
	k2, c2, r2 := t.where(newpath)
	if k1 != "remote" || k2 != "remote" || r1 == "" || r2 == "" {
		return -fuse.EACCES
	}
	if c1 != c2 {
		return -fuse.EXDEV
	}
	_, e := c1.FS.Link(r1, r2)
	return errc(e)
}

func (t *Tree) Mkdir(path string, mode uint32) int {
	kind, c, rel := t.where(path)
	if kind != "remote" || rel == "" {
		return -fuse.EACCES
	}
	_, e := c.FS.Mkdir(rel, mode&0o7777)
	return errc(e)
}

func (t *Tree) Unlink(path string) int {
	kind, c, rel := t.where(path)
	if kind != "remote" || rel == "" {
		return -fuse.EACCES
	}
	return errc(c.FS.Unlink(rel))
}

func (t *Tree) Rmdir(path string) int {
	kind, c, rel := t.where(path)
	if kind != "remote" || rel == "" {
		return -fuse.EACCES
	}
	return errc(c.FS.Rmdir(rel))
}

func (t *Tree) Rename(oldpath, newpath string) int {
	k1, c1, r1 := t.where(oldpath)
	k2, c2, r2 := t.where(newpath)
	if k1 != "remote" || k2 != "remote" || r1 == "" || r2 == "" {
		return -fuse.EACCES
	}
	if c1 != c2 {
		return -fuse.EXDEV
	}
	return errc(c1.FS.Rename(r1, r2, 0))
}

func (t *Tree) Statfs(path string, st *fuse.Statfs_t) int {
	for _, c := range t.Computers {
		if c.FS == nil {
			continue
		}
		if kind, cc, _ := t.where(path); kind == "remote" && cc != c {
			continue
		}
		s, e := c.FS.Statfs()
		if e != wire.OK {
			continue
		}
		st.Bsize, st.Frsize = s[0], s[0]
		st.Blocks, st.Bfree, st.Bavail, st.Files, st.Ffree = s[1], s[2], s[3], s[4], s[5]
		st.Namemax = 255
		return 0
	}
	st.Bsize, st.Frsize, st.Blocks, st.Bfree, st.Bavail, st.Namemax = 4096, 4096, 1<<20, 1<<19, 1<<19, 255
	return 0
}
