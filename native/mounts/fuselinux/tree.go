//go:build linux

// Package fuselinux serves the folder tree through the Linux kernel's FUSE (go-fuse, no cgo).
//
//	/                   the tree's root ($XDG_RUNTIME_DIR/clover in Clover)
//	/home/<self>        a symlink to this computer's own home folder: native speed
//	/home/<other>       another computer's home folder, over its link
package fuselinux

import (
	"context"
	"os"
	"sort"
	"sync"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"

	"github.com/waifucave/clover/native/mounts/remote"
	"github.com/waifucave/clover/native/mounts/wire"
)

// Computer is one entry under home/.
type Computer struct {
	Name  string
	Self  string     // set for this computer: the home folder the entry links to
	FS    *remote.FS // set for another computer
	index uint64
}

type Tree struct {
	Computers []*Computer
	Policy    remote.Policy
	uid, gid  uint32
	server    *fuse.Server

	mu   sync.Mutex
	tops map[*remote.FS]*fs.Inode // each computer's top inode, once looked up
}

// Mount mounts the tree at dir and returns the server; Wait() blocks until unmount.
func Mount(dir string, t *Tree, debug bool) (*fuse.Server, error) {
	t.uid, t.gid = uint32(os.Getuid()), uint32(os.Getgid())
	t.tops = map[*remote.FS]*fs.Inode{}
	for i, c := range t.Computers {
		c.index = uint64(i)
		if c.FS != nil {
			comp := c
			comp.FS.Invalidate = func(p string) { t.invalidate(comp.FS, p) }
			comp.FS.InvalidateAll = func() { t.invalidateAll(comp.FS) }
		}
	}
	ttl := t.Policy.KernelTTL
	neg := ttl
	opts := &fs.Options{
		EntryTimeout:    &ttl,
		AttrTimeout:     &ttl,
		NegativeTimeout: &neg,
		UID:             t.uid,
		GID:             t.gid,
		MountOptions: fuse.MountOptions{
			FsName:               "clover",
			Name:                 "clovertree",
			MaxBackground:        64,
			MaxWrite:             1 << 20,
			MaxReadAhead:         1 << 20,
			DisableXAttrs:        true,
			EnableSymlinkCaching: true,
			DisableReadDirPlus:   t.Policy.TTL == 0,
			Debug:                debug,
		},
	}
	root := &staticDir{t: t, kind: "root"}
	srv, err := fs.Mount(dir, root, opts)
	if err != nil {
		return nil, err
	}
	t.server = srv
	return srv, nil
}

func (t *Tree) top(f *remote.FS) *fs.Inode {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.tops[f]
}

// invalidate tells the kernel to forget p on computer f, after the holder reported a change.
func (t *Tree) invalidate(f *remote.FS, p string) {
	top := t.top(f)
	if top == nil {
		return
	}
	node := top
	parent := top
	name := ""
	for _, part := range splitPath(p) {
		if node == nil {
			break
		}
		parent, name = node, part
		node = node.GetChild(part)
	}
	if node != nil && node != top {
		node.NotifyContent(0, 0)
	}
	if name != "" {
		parent.NotifyEntry(name)
	}
}

func (t *Tree) invalidateAll(f *remote.FS) {
	top := t.top(f)
	if top == nil {
		return
	}
	var walk func(n *fs.Inode, depth int)
	walk = func(n *fs.Inode, depth int) {
		for name, ch := range n.Children() {
			if depth < 64 {
				walk(ch, depth+1)
			}
			ch.NotifyContent(0, 0)
			n.NotifyEntry(name)
		}
	}
	walk(top, 0)
	top.NotifyContent(0, 0)
}

func splitPath(p string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(p); i++ {
		if i == len(p) || p[i] == '/' {
			if i > start {
				out = append(out, p[start:i])
			}
			start = i + 1
		}
	}
	return out
}

func errno(e wire.Errno) syscall.Errno { return syscall.Errno(e) } // Linux numbers on the wire

func modeOf(typ uint8) uint32 {
	switch typ {
	case wire.TypeDir:
		return syscall.S_IFDIR
	case wire.TypeSymlink:
		return syscall.S_IFLNK
	case wire.TypeFile:
		return syscall.S_IFREG
	}
	return syscall.S_IFREG
}

func (t *Tree) fill(a *wire.Attr, out *fuse.Attr) {
	out.Size = a.Size
	out.Blocks = (a.Size + 511) / 512
	out.Blksize = 4096
	out.Mode = modeOf(a.Type) | (a.Mode & 07777)
	out.Nlink = a.Nlink
	if out.Nlink == 0 {
		out.Nlink = 1
	}
	out.Mtime, out.Mtimensec = uint64(a.MtimeNs/1e9), uint32(a.MtimeNs%1e9)
	out.Ctime, out.Ctimensec = uint64(a.CtimeNs/1e9), uint32(a.CtimeNs%1e9)
	out.Atime, out.Atimensec = uint64(a.AtimeNs/1e9), uint32(a.AtimeNs%1e9)
	out.Owner = fuse.Owner{Uid: t.uid, Gid: t.gid} // the remote user is this user
}

// stable gives the remote inode its number here. The first computer keeps the holder's own
// numbers, so git's index (which records inode numbers) stays valid across the mount.
func stable(c *Computer, a *wire.Attr) fs.StableAttr {
	ino := a.Ino
	if c.index > 0 || ino <= 1 {
		ino ^= (c.index + 1) << 56
	}
	return fs.StableAttr{Mode: modeOf(a.Type), Ino: ino, Gen: uint64(a.BirthNs)}
}

// ---- the static part: / and /home --------------------------------------------------------

type staticDir struct {
	fs.Inode
	t    *Tree
	kind string // "root" or "home"
}

var _ = (fs.NodeLookuper)((*staticDir)(nil))
var _ = (fs.NodeReaddirer)((*staticDir)(nil))
var _ = (fs.NodeGetattrer)((*staticDir)(nil))

func (d *staticDir) Getattr(ctx context.Context, f fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	out.Mode = syscall.S_IFDIR | 0o755
	out.Nlink = 2
	out.Owner = fuse.Owner{Uid: d.t.uid, Gid: d.t.gid}
	return 0
}

func (d *staticDir) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if d.kind == "root" {
		if name != "home" {
			return nil, syscall.ENOENT
		}
		ch := d.NewPersistentInode(ctx, &staticDir{t: d.t, kind: "home"}, fs.StableAttr{Mode: syscall.S_IFDIR})
		out.Mode = syscall.S_IFDIR | 0o755
		return ch, 0
	}
	for _, c := range d.t.Computers {
		if c.Name != name {
			continue
		}
		if c.Self != "" {
			ln := &selfLink{target: c.Self}
			out.Mode = syscall.S_IFLNK | 0o777
			out.Size = uint64(len(c.Self))
			return d.NewPersistentInode(ctx, ln, fs.StableAttr{Mode: syscall.S_IFLNK}), 0
		}
		// Another computer: its top directory. Offline computers still appear (as empty
		// directories that answer EHOSTDOWN), so `ls home/` never hangs or lies.
		a, e := c.FS.Stat("")
		top := &remoteNode{t: d.t, c: c}
		var ch *fs.Inode
		if e == wire.OK {
			d.t.fill(&a, &out.Attr)
			ch = d.NewPersistentInode(ctx, top, fs.StableAttr{Mode: syscall.S_IFDIR, Ino: stable(c, &a).Ino})
		} else {
			out.Mode = syscall.S_IFDIR | 0o755
			ch = d.NewPersistentInode(ctx, top, fs.StableAttr{Mode: syscall.S_IFDIR})
		}
		out.SetEntryTimeout(time.Second)
		out.SetAttrTimeout(time.Second)
		d.t.mu.Lock()
		d.t.tops[c.FS] = ch
		d.t.mu.Unlock()
		return ch, 0
	}
	return nil, syscall.ENOENT
}

func (d *staticDir) Readdir(ctx context.Context) (fs.DirStream, syscall.Errno) {
	if d.kind == "root" {
		return fs.NewListDirStream([]fuse.DirEntry{{Name: "home", Mode: syscall.S_IFDIR}}), 0
	}
	var ents []fuse.DirEntry
	for _, c := range d.t.Computers {
		m := uint32(syscall.S_IFDIR)
		if c.Self != "" {
			m = syscall.S_IFLNK
		}
		ents = append(ents, fuse.DirEntry{Name: c.Name, Mode: m})
	}
	return fs.NewListDirStream(ents), 0
}

type selfLink struct {
	fs.Inode
	target string
}

var _ = (fs.NodeReadlinker)((*selfLink)(nil))
var _ = (fs.NodeGetattrer)((*selfLink)(nil))

func (l *selfLink) Readlink(ctx context.Context) ([]byte, syscall.Errno) { return []byte(l.target), 0 }
func (l *selfLink) Getattr(ctx context.Context, f fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	out.Mode = syscall.S_IFLNK | 0o777
	out.Size = uint64(len(l.target))
	return 0
}

// ---- another computer's files ------------------------------------------------------------

type remoteNode struct {
	fs.Inode
	t *Tree
	c *Computer
}

var _ = (fs.NodeLookuper)((*remoteNode)(nil))
var _ = (fs.NodeGetattrer)((*remoteNode)(nil))
var _ = (fs.NodeSetattrer)((*remoteNode)(nil))
var _ = (fs.NodeReaddirer)((*remoteNode)(nil))
var _ = (fs.NodeOpener)((*remoteNode)(nil))
var _ = (fs.NodeCreater)((*remoteNode)(nil))
var _ = (fs.NodeMkdirer)((*remoteNode)(nil))
var _ = (fs.NodeUnlinker)((*remoteNode)(nil))
var _ = (fs.NodeRmdirer)((*remoteNode)(nil))
var _ = (fs.NodeRenamer)((*remoteNode)(nil))
var _ = (fs.NodeSymlinker)((*remoteNode)(nil))
var _ = (fs.NodeReadlinker)((*remoteNode)(nil))
var _ = (fs.NodeLinker)((*remoteNode)(nil))
var _ = (fs.NodeStatfser)((*remoteNode)(nil))
var _ = (fs.NodeReader)((*remoteNode)(nil))
var _ = (fs.NodeWriter)((*remoteNode)(nil))
var _ = (fs.NodeWritever)((*remoteNode)(nil))
var _ = (fs.NodeReleaser)((*remoteNode)(nil))
var _ = (fs.NodeFsyncer)((*remoteNode)(nil))
var _ = (fs.NodeFlusher)((*remoteNode)(nil))

func (n *remoteNode) path() string {
	top := n.t.top(n.c.FS)
	if top == nil || &n.Inode == top {
		return ""
	}
	return n.Path(top)
}

func (n *remoteNode) entry(ctx context.Context, a *wire.Attr, out *fuse.EntryOut) *fs.Inode {
	n.t.fill(a, &out.Attr)
	ch := n.NewInode(ctx, &remoteNode{t: n.t, c: n.c}, stable(n.c, a))
	return ch
}

func (n *remoteNode) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	a, e := n.c.FS.Stat(remote.Join(n.path(), name))
	if e != wire.OK {
		return nil, errno(e)
	}
	return n.entry(ctx, &a, out), 0
}

func (n *remoteNode) Getattr(ctx context.Context, f fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	a, e := n.c.FS.Stat(n.path())
	if e != wire.OK {
		return errno(e)
	}
	n.t.fill(&a, &out.Attr)
	return 0
}

func (n *remoteNode) Setattr(ctx context.Context, f fs.FileHandle, in *fuse.SetAttrIn, out *fuse.AttrOut) syscall.Errno {
	var mask, mode uint32
	var size uint64
	var at, mt int64
	if m, ok := in.GetMode(); ok {
		mask |= wire.SetMode
		mode = m & 07777
	}
	if s, ok := in.GetSize(); ok {
		mask |= wire.SetSize
		size = s
	}
	now := time.Now().UnixNano()
	if t, ok := in.GetATime(); ok {
		mask |= wire.SetAtime
		at = t.UnixNano()
	} else if in.Valid&fuse.FATTR_ATIME_NOW != 0 {
		mask |= wire.SetAtime
		at = now
	}
	if t, ok := in.GetMTime(); ok {
		mask |= wire.SetMtime
		mt = t.UnixNano()
	} else if in.Valid&fuse.FATTR_MTIME_NOW != 0 {
		mask |= wire.SetMtime
		mt = now
	}
	if mask == 0 {
		return n.Getattr(ctx, f, out)
	}
	var h *remote.Handle
	if fh, ok := f.(*fileHandle); ok {
		h = fh.h
	}
	a, e := n.c.FS.Setattr(n.path(), h, mask, mode, size, at, mt)
	if e != wire.OK {
		return errno(e)
	}
	n.t.fill(&a, &out.Attr)
	return 0
}

func (n *remoteNode) Readdir(ctx context.Context) (fs.DirStream, syscall.Errno) {
	ents, e := n.c.FS.List(n.path())
	if e != wire.OK {
		return nil, errno(e)
	}
	sort.Slice(ents, func(i, j int) bool { return ents[i].Name < ents[j].Name })
	out := make([]fuse.DirEntry, len(ents))
	for i := range ents {
		out[i] = fuse.DirEntry{Name: ents[i].Name, Mode: modeOf(ents[i].Attr.Type), Ino: stable(n.c, &ents[i].Attr).Ino}
	}
	return fs.NewListDirStream(out), 0
}

type fileHandle struct{ h *remote.Handle }

func wireFlags(flags uint32) uint32 {
	w := flags & 3
	if flags&syscall.O_CREAT != 0 {
		w |= wire.OCreat
	}
	if flags&syscall.O_EXCL != 0 {
		w |= wire.OExcl
	}
	if flags&syscall.O_TRUNC != 0 {
		w |= wire.OTrunc
	}
	if flags&syscall.O_APPEND != 0 {
		w |= wire.OAppend
	}
	return w
}

func (n *remoteNode) openFlags() uint32 {
	if n.t.Policy.KeepCache {
		return fuse.FOPEN_KEEP_CACHE
	}
	return 0
}

func (n *remoteNode) Open(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	h, _, e := n.c.FS.Open(n.path(), wireFlags(flags), 0)
	if e != wire.OK {
		return nil, 0, errno(e)
	}
	return &fileHandle{h: h}, n.openFlags(), 0
}

func (n *remoteNode) Create(ctx context.Context, name string, flags, mode uint32, out *fuse.EntryOut) (*fs.Inode, fs.FileHandle, uint32, syscall.Errno) {
	p := remote.Join(n.path(), name)
	h, a, e := n.c.FS.Open(p, wireFlags(flags)|wire.OCreat, mode&07777)
	if e != wire.OK {
		return nil, nil, 0, errno(e)
	}
	return n.entry(ctx, &a, out), &fileHandle{h: h}, n.openFlags(), 0
}

// go-fuse calls the node's methods before the handle's, so the handle is a plain value.
func (n *remoteNode) Read(ctx context.Context, f fs.FileHandle, dest []byte, off int64) (fuse.ReadResult, syscall.Errno) {
	var h *remote.Handle
	if fh, ok := f.(*fileHandle); ok {
		h = fh.h
	}
	data, e := n.c.FS.Read(n.path(), h, off, len(dest))
	if e != wire.OK {
		return nil, errno(e)
	}
	return fuse.ReadResultData(data), 0
}

func (n *remoteNode) Write(ctx context.Context, f fs.FileHandle, data []byte, off int64) (uint32, syscall.Errno) {
	fh, ok := f.(*fileHandle)
	if !ok {
		return 0, syscall.EBADF
	}
	w, e := n.c.FS.Write(fh.h, off, data)
	if e != wire.OK {
		return 0, errno(e)
	}
	return uint32(w), 0
}

// Writev joins the kernel's segments; go-fuse refuses multi-segment writes to a node that
// only has Write.
func (n *remoteNode) Writev(ctx context.Context, f fs.FileHandle, data [][]byte, off int64) (uint32, syscall.Errno) {
	if len(data) == 1 {
		return n.Write(ctx, f, data[0], off)
	}
	var all []byte
	for _, d := range data {
		all = append(all, d...)
	}
	return n.Write(ctx, f, all, off)
}

func (n *remoteNode) Release(ctx context.Context, f fs.FileHandle) syscall.Errno {
	if fh, ok := f.(*fileHandle); ok {
		go n.c.FS.Release(fh.h) // never hold close(2) on the network
	}
	return 0
}

func (n *remoteNode) Fsync(ctx context.Context, f fs.FileHandle, flags uint32) syscall.Errno {
	if fh, ok := f.(*fileHandle); ok {
		return errno(n.c.FS.Fsync(fh.h))
	}
	return 0
}

func (n *remoteNode) Flush(ctx context.Context, f fs.FileHandle) syscall.Errno { return 0 }

func (n *remoteNode) Mkdir(ctx context.Context, name string, mode uint32, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	a, e := n.c.FS.Mkdir(remote.Join(n.path(), name), mode&07777)
	if e != wire.OK {
		return nil, errno(e)
	}
	return n.entry(ctx, &a, out), 0
}

func (n *remoteNode) Unlink(ctx context.Context, name string) syscall.Errno {
	return errno(n.c.FS.Unlink(remote.Join(n.path(), name)))
}

func (n *remoteNode) Rmdir(ctx context.Context, name string) syscall.Errno {
	return errno(n.c.FS.Rmdir(remote.Join(n.path(), name)))
}

func (n *remoteNode) Rename(ctx context.Context, name string, newParent fs.InodeEmbedder, newName string, flags uint32) syscall.Errno {
	np, ok := newParent.(*remoteNode)
	if !ok || np.c != n.c {
		return syscall.EXDEV // across computers: mv falls back to copy + delete
	}
	var wf uint32
	if flags&1 != 0 { // RENAME_NOREPLACE
		wf |= 1
	}
	if flags&2 != 0 { // RENAME_EXCHANGE
		wf |= 2
	}
	return errno(n.c.FS.Rename(remote.Join(n.path(), name), remote.Join(np.path(), newName), wf))
}

func (n *remoteNode) Symlink(ctx context.Context, target, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	a, e := n.c.FS.Symlink(remote.Join(n.path(), name), target)
	if e != wire.OK {
		return nil, errno(e)
	}
	return n.entry(ctx, &a, out), 0
}

func (n *remoteNode) Readlink(ctx context.Context) ([]byte, syscall.Errno) {
	t, e := n.c.FS.Readlink(n.path())
	if e != wire.OK {
		return nil, errno(e)
	}
	return []byte(t), 0
}

func (n *remoteNode) Link(ctx context.Context, target fs.InodeEmbedder, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	tn, ok := target.(*remoteNode)
	if !ok || tn.c != n.c {
		return nil, syscall.EXDEV
	}
	a, e := n.c.FS.Link(tn.path(), remote.Join(n.path(), name))
	if e != wire.OK {
		return nil, errno(e)
	}
	return n.entry(ctx, &a, out), 0
}

func (n *remoteNode) Statfs(ctx context.Context, out *fuse.StatfsOut) syscall.Errno {
	s, e := n.c.FS.Statfs()
	if e != wire.OK {
		return errno(e)
	}
	out.Bsize = uint32(s[0])
	out.Frsize = uint32(s[0])
	out.Blocks, out.Bfree, out.Bavail, out.Files, out.Ffree = s[1], s[2], s[3], s[4], s[5]
	out.NameLen = 255
	return 0
}
