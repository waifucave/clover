package remote

import (
	"strings"
	"sync"
	"time"

	"github.com/waifucave/clover/native/mounts/wire"
)

// Policy is how hard the helper caches. The spike measures three:
//
//	nocache  every lookup and stat goes to the computer that holds the files
//	plain    1 s attribute/entry caching, like a stock FUSE file system (sshfs, libfuse defaults)
//	cached   cache until the holder says something changed (EVENT), plus a breadth-first
//	         prefetch of a directory's subtree the first time it is listed
type Policy struct {
	Name      string
	TTL       time.Duration // client cache lifetime; 0 = none; <0 = until invalidated
	KernelTTL time.Duration // what the adapter tells the kernel
	Prefetch  uint32        // TREE budget on a listing miss; 0 = plain LIST
	Watch     bool          // subscribe to change events
	KeepCache bool          // keep the kernel's page cache across opens
}

func PolicyByName(name string) (Policy, bool) {
	switch name {
	case "nocache":
		return Policy{Name: name}, true
	case "plain":
		return Policy{Name: name, TTL: time.Second, KernelTTL: time.Second}, true
	case "cached":
		return Policy{Name: name, TTL: -1, KernelTTL: time.Hour, Prefetch: 20000, Watch: true, KeepCache: true}, true
	}
	return Policy{}, false
}

// DirEntry is one listed name.
type DirEntry struct {
	Name string
	Attr wire.Attr
}

type attrEnt struct {
	attr    wire.Attr
	neg     bool
	expires time.Time // zero = until invalidated
}
type dirEnt struct {
	names   []string
	expires time.Time
}

// FS is the path-based file system over one computer's link. Paths are relative to the
// computer's exported folder ("" is the folder itself).
type FS struct {
	C   *Client
	Pol Policy

	mu    sync.Mutex
	attrs map[string]attrEnt
	dirs  map[string]dirEnt

	// Adapter hooks: tell the kernel to forget a path, or everything.
	Invalidate    func(path string)
	InvalidateAll func()

	Hits, Misses, Prefetches int64
}

func NewFS(c *Client, pol Policy) *FS {
	f := &FS{C: c, Pol: pol, attrs: map[string]attrEnt{}, dirs: map[string]dirEnt{}}
	c.OnEvent = f.onEvent
	prev := c.OnReconnect
	c.OnReconnect = func(w Welcome, changed bool) {
		f.dropAll()
		if pol.Watch {
			go f.C.Do(wire.OpWatch, func(w *wire.Writer) { w.U8(1) })
		}
		if prev != nil {
			prev(w, changed)
		}
	}
	return f
}

// Start subscribes to change events when the policy wants them.
func (f *FS) Start() {
	if f.Pol.Watch && f.C.Online() {
		f.C.Do(wire.OpWatch, func(w *wire.Writer) { w.U8(1) })
	}
}

func Parent(p string) (string, string) {
	i := strings.LastIndexByte(p, '/')
	if i < 0 {
		return "", p
	}
	return p[:i], p[i+1:]
}

func Join(dir, name string) string {
	if dir == "" {
		return name
	}
	return dir + "/" + name
}

func (f *FS) expiry() (time.Time, bool) {
	switch {
	case f.Pol.TTL == 0:
		return time.Time{}, false
	case f.Pol.TTL < 0:
		return time.Time{}, true
	default:
		return time.Now().Add(f.Pol.TTL), true
	}
}

func live(exp time.Time) bool { return exp.IsZero() || time.Now().Before(exp) }

func (f *FS) putAttr(p string, a *wire.Attr) {
	exp, ok := f.expiry()
	if !ok {
		return
	}
	f.attrs[p] = attrEnt{attr: *a, expires: exp}
}

func (f *FS) putNeg(p string) {
	exp, ok := f.expiry()
	if !ok {
		return
	}
	f.attrs[p] = attrEnt{neg: true, expires: exp}
}

func (f *FS) putDir(dir string, ents []DirEntry) {
	exp, ok := f.expiry()
	if !ok {
		return
	}
	names := make([]string, len(ents))
	for i := range ents {
		names[i] = ents[i].Name
		f.attrs[Join(dir, ents[i].Name)] = attrEnt{attr: ents[i].Attr, expires: exp}
	}
	f.dirs[dir] = dirEnt{names: names, expires: exp}
}

// Forget drops what is cached for p, its subtree and its parent's listing.
func (f *FS) Forget(p string) {
	f.mu.Lock()
	f.forgetLocked(p)
	f.mu.Unlock()
}

func (f *FS) forgetLocked(p string) {
	delete(f.attrs, p)
	if _, ok := f.dirs[p]; ok {
		delete(f.dirs, p)
		prefix := p + "/"
		if p == "" {
			prefix = ""
		}
		for k := range f.attrs {
			if strings.HasPrefix(k, prefix) {
				delete(f.attrs, k)
			}
		}
		for k := range f.dirs {
			if strings.HasPrefix(k, prefix) {
				delete(f.dirs, k)
			}
		}
	}
	if p != "" {
		dir, _ := Parent(p)
		delete(f.dirs, dir)
	}
}

func (f *FS) dropAll() {
	f.mu.Lock()
	f.attrs = map[string]attrEnt{}
	f.dirs = map[string]dirEnt{}
	f.mu.Unlock()
	if f.InvalidateAll != nil {
		f.InvalidateAll()
	}
}

func (f *FS) onEvent(typ uint8, p string) {
	if typ == wire.EventResync {
		f.dropAll()
		return
	}
	f.Forget(p)
	if f.Invalidate != nil {
		f.Invalidate(p)
	}
}

// Stat answers lstat for p.
func (f *FS) Stat(p string) (wire.Attr, wire.Errno) {
	if f.Pol.TTL != 0 {
		f.mu.Lock()
		if e, ok := f.attrs[p]; ok && live(e.expires) {
			f.Hits++
			f.mu.Unlock()
			if e.neg {
				return wire.Attr{}, wire.ENOENT
			}
			return e.attr, wire.OK
		}
		// A complete, live listing of the parent that lacks the name is a negative answer.
		if p != "" {
			dir, name := Parent(p)
			if d, ok := f.dirs[dir]; ok && live(d.expires) {
				found := false
				for _, n := range d.names {
					if n == name {
						found = true
						break
					}
				}
				if !found {
					f.Hits++
					f.mu.Unlock()
					return wire.Attr{}, wire.ENOENT
				}
			}
		}
		f.Misses++
		f.mu.Unlock()
	}
	var a wire.Attr
	r, e := f.C.Do(wire.OpStat, func(w *wire.Writer) { w.Str(p) })
	if e == wire.ENOENT {
		f.mu.Lock()
		f.putNeg(p)
		f.mu.Unlock()
		return a, e
	}
	if e != wire.OK {
		return a, e
	}
	r.Attr(&a)
	f.mu.Lock()
	f.putAttr(p, &a)
	f.mu.Unlock()
	return a, wire.OK
}

// List answers a directory listing with attributes (readdirplus).
func (f *FS) List(p string) ([]DirEntry, wire.Errno) {
	if f.Pol.TTL != 0 {
		f.mu.Lock()
		if d, ok := f.dirs[p]; ok && live(d.expires) {
			out := make([]DirEntry, 0, len(d.names))
			complete := true
			for _, n := range d.names {
				e, ok := f.attrs[Join(p, n)]
				if !ok || e.neg {
					complete = false
					break
				}
				out = append(out, DirEntry{Name: n, Attr: e.attr})
			}
			if complete {
				f.Hits++
				f.mu.Unlock()
				return out, wire.OK
			}
		}
		f.Misses++
		f.mu.Unlock()
	}
	if f.Pol.Prefetch > 0 {
		return f.tree(p)
	}
	r, e := f.C.Do(wire.OpList, func(w *wire.Writer) { w.Str(p) })
	if e != wire.OK {
		return nil, e
	}
	n := r.U32()
	out := make([]DirEntry, n)
	for i := range out {
		out[i].Name = r.Str()
		r.Attr(&out[i].Attr)
	}
	if r.Err() != nil {
		return nil, wire.EIO
	}
	f.mu.Lock()
	f.putDir(p, out)
	f.mu.Unlock()
	return out, wire.OK
}

func (f *FS) tree(p string) ([]DirEntry, wire.Errno) {
	r, e := f.C.Do(wire.OpTree, func(w *wire.Writer) { w.Str(p).U32(f.Pol.Prefetch) })
	if e != wire.OK {
		return nil, e
	}
	var first []DirEntry
	f.mu.Lock()
	f.Prefetches++
	ndirs := r.U32()
	for i := uint32(0); i < ndirs; i++ {
		dir := r.Str()
		n := r.U32()
		ents := make([]DirEntry, n)
		for j := range ents {
			ents[j].Name = r.Str()
			r.Attr(&ents[j].Attr)
		}
		if r.Err() != nil {
			f.mu.Unlock()
			return nil, wire.EIO
		}
		f.putDir(dir, ents)
		if i == 0 {
			first = ents
		}
	}
	f.mu.Unlock()
	return first, wire.OK
}

// Read reads from p; handle 0 is a stateless read by path.
func (f *FS) Read(p string, h *Handle, off int64, n int) ([]byte, wire.Errno) {
	var remote uint64
	if h != nil {
		remote = h.remoteHandle()
	}
	data, e := f.read(p, remote, off, n)
	if e == wire.ESTALE && h != nil {
		if e = f.reopen(h); e == wire.OK {
			data, e = f.read(p, h.remoteHandle(), off, n)
		}
	}
	return data, e
}

func (f *FS) read(p string, remote uint64, off int64, n int) ([]byte, wire.Errno) {
	r, e := f.C.Do(wire.OpRead, func(w *wire.Writer) { w.Str(p).U64(remote).U64(uint64(off)).U32(uint32(n)) })
	if e != wire.OK {
		return nil, e
	}
	b := r.Bytes()
	if r.Err() != nil {
		return nil, wire.EIO
	}
	return b, wire.OK
}

// Handle is an open file. Read-only opens are lazy: no round trip, stateless reads.
type Handle struct {
	mu     sync.Mutex
	Path   string
	Flags  uint32
	remote uint64
}

func (h *Handle) remoteHandle() uint64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.remote
}

// Open opens p with wire flags. Opens that only read cost no round trip.
func (f *FS) Open(p string, flags, mode uint32) (*Handle, wire.Attr, wire.Errno) {
	h := &Handle{Path: p, Flags: flags}
	var a wire.Attr
	if flags&wire.OAccMode == wire.ORdonly && flags&(wire.OCreat|wire.OTrunc) == 0 {
		return h, a, wire.OK
	}
	r, e := f.C.Do(wire.OpOpen, func(w *wire.Writer) { w.Str(p).U32(flags).U32(mode) })
	if e != wire.OK {
		return nil, a, e
	}
	h.remote = r.U64()
	r.Attr(&a)
	f.mu.Lock()
	if flags&(wire.OCreat|wire.OTrunc) != 0 {
		f.forgetLocked(p)
	}
	f.putAttr(p, &a)
	f.mu.Unlock()
	return h, a, wire.OK
}

// reopen gets a fresh remote handle after the old one died with its service connection.
func (f *FS) reopen(h *Handle) wire.Errno {
	flags := h.Flags &^ (wire.OCreat | wire.OExcl | wire.OTrunc)
	r, e := f.C.Do(wire.OpOpen, func(w *wire.Writer) { w.Str(h.Path).U32(flags).U32(0) })
	if e != wire.OK {
		return e
	}
	h.mu.Lock()
	h.remote = r.U64()
	h.mu.Unlock()
	return wire.OK
}

func (f *FS) Write(h *Handle, off int64, data []byte) (int, wire.Errno) {
	if h.remoteHandle() == 0 {
		if e := f.reopen(h); e != wire.OK {
			return 0, e
		}
	}
	n, e := f.write(h, off, data)
	if e == wire.ESTALE {
		if e = f.reopen(h); e == wire.OK {
			n, e = f.write(h, off, data)
		}
	}
	if e == wire.OK {
		f.mu.Lock()
		delete(f.attrs, h.Path)
		f.mu.Unlock()
	}
	return n, e
}

func (f *FS) write(h *Handle, off int64, data []byte) (int, wire.Errno) {
	r, e := f.C.Do(wire.OpWrite, func(w *wire.Writer) { w.Str(h.Path).U64(h.remoteHandle()).U64(uint64(off)).Bytes(data) })
	if e != wire.OK {
		return 0, e
	}
	return int(r.U32()), wire.OK
}

func (f *FS) Release(h *Handle) {
	if rh := h.remoteHandle(); rh != 0 {
		f.C.Do(wire.OpClose, func(w *wire.Writer) { w.U64(rh) })
	}
}

func (f *FS) Fsync(h *Handle) wire.Errno {
	var rh uint64
	if h != nil {
		rh = h.remoteHandle()
	}
	if rh == 0 {
		return wire.OK
	}
	_, e := f.C.Do(wire.OpFsync, func(w *wire.Writer) { w.Str(h.Path).U64(rh) })
	return e
}

// Setattr changes mode, size or times; it returns the new attributes.
func (f *FS) Setattr(p string, h *Handle, mask, mode uint32, size uint64, atimeNs, mtimeNs int64) (wire.Attr, wire.Errno) {
	var rh uint64
	if h != nil {
		rh = h.remoteHandle()
	}
	var a wire.Attr
	r, e := f.C.Do(wire.OpSetattr, func(w *wire.Writer) {
		w.Str(p).U64(rh).U32(mask).U32(mode).U64(size).I64(atimeNs).I64(mtimeNs)
	})
	f.mu.Lock()
	delete(f.attrs, p)
	f.mu.Unlock()
	if e != wire.OK {
		return a, e
	}
	r.Attr(&a)
	f.mu.Lock()
	f.putAttr(p, &a)
	f.mu.Unlock()
	return a, wire.OK
}

func (f *FS) attrOp(op uint8, p string, build func(w *wire.Writer)) (wire.Attr, wire.Errno) {
	var a wire.Attr
	r, e := f.C.Do(op, build)
	f.Forget(p)
	if e != wire.OK {
		return a, e
	}
	r.Attr(&a)
	f.mu.Lock()
	f.putAttr(p, &a)
	f.mu.Unlock()
	return a, wire.OK
}

func (f *FS) Mkdir(p string, mode uint32) (wire.Attr, wire.Errno) {
	return f.attrOp(wire.OpMkdir, p, func(w *wire.Writer) { w.Str(p).U32(mode) })
}

func (f *FS) Symlink(p, target string) (wire.Attr, wire.Errno) {
	return f.attrOp(wire.OpSymlink, p, func(w *wire.Writer) { w.Str(p).Str(target) })
}

func (f *FS) Link(from, to string) (wire.Attr, wire.Errno) {
	f.Forget(from)
	return f.attrOp(wire.OpLink, to, func(w *wire.Writer) { w.Str(from).Str(to) })
}

func (f *FS) simple(op uint8, p string, build func(w *wire.Writer)) wire.Errno {
	_, e := f.C.Do(op, build)
	f.Forget(p)
	return e
}

func (f *FS) Unlink(p string) wire.Errno {
	return f.simple(wire.OpUnlink, p, func(w *wire.Writer) { w.Str(p) })
}

func (f *FS) Rmdir(p string) wire.Errno {
	return f.simple(wire.OpRmdir, p, func(w *wire.Writer) { w.Str(p) })
}

func (f *FS) Rename(from, to string, flags uint32) wire.Errno {
	_, e := f.C.Do(wire.OpRename, func(w *wire.Writer) { w.Str(from).Str(to).U32(flags) })
	f.Forget(from)
	f.Forget(to)
	return e
}

func (f *FS) Readlink(p string) (string, wire.Errno) {
	r, e := f.C.Do(wire.OpReadlink, func(w *wire.Writer) { w.Str(p) })
	if e != wire.OK {
		return "", e
	}
	return r.Str(), wire.OK
}

// Statfs returns bsize, blocks, bfree, bavail, files, ffree.
func (f *FS) Statfs() ([6]uint64, wire.Errno) {
	var out [6]uint64
	r, e := f.C.Do(wire.OpStatfs, nil)
	if e != wire.OK {
		return out, e
	}
	for i := range out {
		out[i] = r.U64()
	}
	return out, wire.OK
}
