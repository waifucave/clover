package remote

import (
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/waifucave/clover/spikes/s6-mounts/native/wire"
)

// Policy is how hard the helper caches. The spike measures three:
//
//	nocache  every lookup and stat goes to the computer that holds the files
//	plain    1 s attribute/entry caching, like a stock FUSE file system (sshfs, libfuse defaults)
//	cached   cache until the holder says something changed (EVENT), plus a breadth-first
//	         prefetch of a directory's subtree the first time a lookup or a listing misses in
//	         it (never the home folder itself)
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
	// Prefetch bookkeeping: each directory's subtree is fetched in bulk once (the first time a
	// lookup or a listing misses in it); later misses there, after events, go one by one, so a
	// busy folder (.git) is never refetched whole. Lookups wait for a bulk fetch in flight
	// above them instead of crossing the link on their own.
	prefetched map[string]bool
	inflight   map[string]chan struct{}

	// Fill vs event (review S3): a reply fetched before a change must not be cached after that
	// change's event dropped the old entry, or it stays for good. Every event bumps epoch and is
	// remembered in recent; a fill skips what an event touched since its request went out.
	epoch       uint64
	recent      []touch
	recentFloor uint64 // epochs at or below this were trimmed from recent

	// Adapter hooks: tell the kernel to forget a path, or everything.
	Invalidate    func(path string)
	InvalidateAll func()

	// Counters for the status endpoint; read them with atomic loads.
	Hits, Misses, Prefetches atomic.Int64
}

type touch struct {
	epoch uint64
	path  string
	all   bool
}

const recentMax = 8192

// touchedLocked records an event (f.mu held).
func (f *FS) touchedLocked(p string, all bool) {
	f.epoch++
	if len(f.recent) >= recentMax {
		f.recentFloor = f.recent[len(f.recent)/2-1].epoch
		f.recent = append(f.recent[:0], f.recent[len(f.recent)/2:]...)
	}
	f.recent = append(f.recent, touch{f.epoch, p, all})
}

// under reports whether p is dir or inside it.
func under(p, dir string) bool {
	return dir == "" || p == dir || strings.HasPrefix(p, dir+"/")
}

// staleSince reports whether an event since epoch e0 touched what a fill of p would cache: p,
// a folder above it, a name in it (p's own mtime changes with its listing), or, for a listing
// or a bulk fetch (sub), anything inside it. f.mu held.
func (f *FS) staleSince(e0 uint64, p string, sub bool) bool {
	if e0 < f.recentFloor {
		return true
	}
	for i := len(f.recent) - 1; i >= 0 && f.recent[i].epoch > e0; i-- {
		t := f.recent[i]
		if t.all || under(p, t.path) {
			return true
		}
		if dir, _ := Parent(t.path); dir == p {
			return true
		}
		if sub && under(t.path, p) {
			return true
		}
	}
	return false
}

// mark is the epoch a fill starts from.
func (f *FS) mark() uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.epoch
}

func NewFS(c *Client, pol Policy) *FS {
	f := &FS{C: c, Pol: pol, attrs: map[string]attrEnt{}, dirs: map[string]dirEnt{}, prefetched: map[string]bool{}, inflight: map[string]chan struct{}{}}
	c.OnEvent = f.onEvent
	// Every link, the first included, subscribes in its HELLO: a computer that was offline when
	// the mount started is covered from its first answer (S3), and so is every reconnect.
	c.Watch = pol.Watch
	prev := c.OnReconnect
	c.OnReconnect = func(w Welcome, changed bool) {
		f.mu.Lock()
		f.attrs = map[string]attrEnt{}
		f.dirs = map[string]dirEnt{}
		f.prefetched = map[string]bool{}
		f.mu.Unlock()
		c.QueueEvent(wire.EventResync, "") // the kernel's caches, off the dialler and the reader
		if prev != nil {
			prev(w, changed)
		}
	}
	return f
}

// Start subscribes a link that was already up before NewFS set Watch (a client started first).
// Links dialled after NewFS subscribe in their HELLO.
func (f *FS) Start() {
	if f.Pol.Watch && f.C.Online() && !f.C.Welcome().Watching {
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

// forgetEvent is Forget for a change the holder reported: fills in flight skip p (staleSince).
func (f *FS) forgetEvent(p string) {
	f.mu.Lock()
	f.touchedLocked(p, false)
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
		// The parent's listing changed, and so did its own mtime and ctime. An NFS client decides
		// from the folder's attributes whether the names it remembers as missing still are, so a
		// stale parent kept a new file invisible on macOS for good.
		dir, _ := Parent(p)
		delete(f.dirs, dir)
		delete(f.attrs, dir)
	}
}

func (f *FS) dropAll() {
	f.mu.Lock()
	f.touchedLocked("", true)
	f.attrs = map[string]attrEnt{}
	f.dirs = map[string]dirEnt{}
	f.prefetched = map[string]bool{}
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
	f.forgetEvent(p)
	if f.Invalidate != nil {
		f.Invalidate(p)
	}
}

// Stat answers lstat for p.
// cachedStat answers p from the cache; ok is false on a miss. f.mu must be held.
func (f *FS) cachedStat(p string) (a wire.Attr, e wire.Errno, ok bool) {
	if c, hit := f.attrs[p]; hit && live(c.expires) {
		if c.neg {
			return a, wire.ENOENT, true
		}
		return c.attr, wire.OK, true
	}
	// A complete, live listing of the parent that lacks the name is a negative answer.
	if p != "" {
		dir, name := Parent(p)
		if d, hit := f.dirs[dir]; hit && live(d.expires) {
			for _, n := range d.names {
				if n == name {
					return a, 0, false
				}
			}
			return a, wire.ENOENT, true
		}
	}
	return a, 0, false
}

// prefetchFor makes sure a bulk fetch covering p has run: it waits for one in flight above p,
// or starts one for p's directory if that directory was never fetched in bulk. The home folder
// itself is never fetched whole (a home's first 20,000 entries are mostly ~/Library). It
// reports whether it waited or fetched, so the caller looks in the cache again.
func (f *FS) prefetchFor(p string, self bool) bool {
	if f.Pol.Prefetch == 0 || f.Pol.TTL == 0 {
		return false
	}
	f.mu.Lock()
	d := p
	if !self {
		d, _ = Parent(p)
	}
	for a := d; ; {
		if ch, ok := f.inflight[a]; ok {
			f.mu.Unlock()
			<-ch
			return true
		}
		if a == "" {
			break
		}
		a, _ = Parent(a)
	}
	if d == "" || f.prefetched[d] {
		f.mu.Unlock()
		return false
	}
	f.prefetched[d] = true
	ch := make(chan struct{})
	f.inflight[d] = ch
	f.mu.Unlock()
	_, _ = f.tree(d)
	f.mu.Lock()
	delete(f.inflight, d)
	f.mu.Unlock()
	close(ch)
	return true
}

func (f *FS) Stat(p string) (wire.Attr, wire.Errno) {
	if f.Pol.TTL != 0 {
		f.mu.Lock()
		a, e, ok := f.cachedStat(p)
		f.mu.Unlock()
		if !ok && f.prefetchFor(p, false) {
			f.mu.Lock()
			a, e, ok = f.cachedStat(p)
			f.mu.Unlock()
		}
		if ok {
			f.Hits.Add(1)
		} else {
			f.Misses.Add(1)
		}
		if ok {
			return a, e
		}
	}
	var a wire.Attr
	e0 := f.mark()
	r, e := f.C.Do(wire.OpStat, func(w *wire.Writer) { w.Str(p) })
	if e == wire.ENOENT {
		f.mu.Lock()
		if !f.staleSince(e0, p, false) {
			f.putNeg(p)
		}
		f.mu.Unlock()
		return a, e
	}
	if e != wire.OK {
		return a, e
	}
	r.Attr(&a)
	f.mu.Lock()
	if !f.staleSince(e0, p, false) {
		f.putAttr(p, &a)
	}
	f.mu.Unlock()
	return a, wire.OK
}

// cachedList answers a listing of p from the cache. f.mu must be held.
func (f *FS) cachedList(p string) ([]DirEntry, bool) {
	d, ok := f.dirs[p]
	if !ok || !live(d.expires) {
		return nil, false
	}
	out := make([]DirEntry, 0, len(d.names))
	for _, n := range d.names {
		e, ok := f.attrs[Join(p, n)]
		if !ok || e.neg {
			return nil, false
		}
		out = append(out, DirEntry{Name: n, Attr: e.attr})
	}
	return out, true
}

// List answers a directory listing with attributes (readdirplus).
func (f *FS) List(p string) ([]DirEntry, wire.Errno) {
	if f.Pol.TTL != 0 {
		f.mu.Lock()
		if out, ok := f.cachedList(p); ok {
			f.mu.Unlock()
			f.Hits.Add(1)
			return out, wire.OK
		}
		f.mu.Unlock()
		f.Misses.Add(1)
		if f.prefetchFor(p, true) {
			f.mu.Lock()
			out, ok := f.cachedList(p)
			f.mu.Unlock()
			if ok {
				return out, wire.OK
			}
		}
	}
	e0 := f.mark()
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
	if !f.staleSince(e0, p, true) {
		f.putDir(p, out)
	}
	f.mu.Unlock()
	return out, wire.OK
}

func (f *FS) tree(p string) ([]DirEntry, wire.Errno) {
	e0 := f.mark()
	r, e := f.C.Do(wire.OpTree, func(w *wire.Writer) { w.Str(p).U32(f.Pol.Prefetch) })
	if e != wire.OK {
		return nil, e
	}
	var first []DirEntry
	f.mu.Lock()
	f.Prefetches.Add(1)
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
		if !f.staleSince(e0, dir, true) {
			f.putDir(dir, ents)
		}
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
	e0 := f.mark()
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
	if !f.staleSince(e0, p, false) {
		f.putAttr(p, &a)
	}
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
	e0 := f.mark()
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
	if !f.staleSince(e0, p, false) {
		f.putAttr(p, &a)
	}
	f.mu.Unlock()
	return a, wire.OK
}

func (f *FS) attrOp(op uint8, p string, build func(w *wire.Writer)) (wire.Attr, wire.Errno) {
	var a wire.Attr
	e0 := f.mark()
	r, e := f.C.Do(op, build)
	f.Forget(p)
	if e != wire.OK {
		return a, e
	}
	r.Attr(&a)
	f.mu.Lock()
	if !f.staleSince(e0, p, false) {
		f.putAttr(p, &a)
	}
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
