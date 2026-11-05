// Package remote is the mount helper's side of the link: one connection to the file service on
// one other computer, with request multiplexing, liveness, and failing fast when the computer
// drops (../PROTOCOL.md, "Liveness").
package remote

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/waifucave/clover/native/mounts/wire"
)

// Config tunes the link. The defaults are the spike's measured settings.
type Config struct {
	Addr        string        // host:port of the link (the fake link in the spike)
	Name        string        // the computer's name, for logs
	PingEvery   time.Duration // send a PING this often
	DeadAfter   time.Duration // silence longer than this means the computer dropped
	OpTimeout   time.Duration // a request fails once the link carried no answer bytes for this long
	OpCap       time.Duration // the longest a request waits while the link keeps delivering answers
	DialTimeout time.Duration // connect plus HELLO/WELCOME
	RedialMin   time.Duration
	RedialMax   time.Duration
	Logf        func(format string, args ...any)
}

func (c *Config) defaults() {
	if c.PingEvery == 0 {
		c.PingEvery = 250 * time.Millisecond
	}
	if c.DeadAfter == 0 {
		c.DeadAfter = 1500 * time.Millisecond
	}
	if c.OpTimeout == 0 {
		c.OpTimeout = 10 * time.Second
	}
	if c.OpCap == 0 {
		c.OpCap = 60 * time.Second
	}
	if c.DialTimeout == 0 {
		c.DialTimeout = time.Second
	}
	if c.RedialMin == 0 {
		c.RedialMin = 100 * time.Millisecond
	}
	if c.RedialMax == 0 {
		c.RedialMax = time.Second
	}
	if c.Logf == nil {
		c.Logf = func(string, ...any) {}
	}
}

// Welcome is what the file service said about itself.
type Welcome struct {
	Instance      string
	OS            string
	CaseSensitive bool
}

type call struct {
	done chan struct{}
	body []byte // the RES frame body
	err  wire.Errno
}

type link struct {
	gen     uint64
	conn    net.Conn
	sendq   chan outFrame
	quit    chan struct{}
	welcome Welcome

	// At most one PING and one PONG wait in sendq: on a saturated uplink they queue behind the
	// data, and an uncoalesced ping every 250 ms would fill the queue on a long upload.
	pingQueued atomic.Bool
	pongQueued atomic.Bool
	lastSent   atomic.Int64 // unix nanos of the writer's last chunk on the wire
}

// outFrame is a frame for the writer; sent, when set, is closed once it is on the wire, and
// once, when set, is cleared then (a coalesced PING or PONG).
type outFrame struct {
	b    []byte
	sent chan struct{}
	once *atomic.Bool
}

// writeChunk bounds one write: each chunk gets the liveness bound to leave, so a large frame on
// a slow link only fails when the link stops taking bytes (review S1), not when the whole frame
// takes longer than 1.5 s, which a 1 MiB frame does below about 6 Mbit/s.
const writeChunk = 32 << 10

// Client is one computer's link. It is safe for concurrent use.
type Client struct {
	cfg Config

	mu      sync.Mutex
	cur     *link // nil while offline
	gen     uint64
	pending map[uint32]*call
	nextID  uint32
	dialing bool
	closed  bool

	lastRecv atomic.Int64 // unix nanos of the last inbound bytes on cur
	rxBytes  atomic.Int64 // inbound bytes, all links
	rxCtl    atomic.Int64 // of those, the bytes of PING and PONG frames
	online   atomic.Bool

	// Hooks, set before Start. They run on the client's own goroutines, never on the reader:
	// OnEvent typically tells the kernel to drop a cache, and the kernel can wait for a reply
	// that only the reader can deliver (Linux's inval_inode waits on the page locks of a write
	// in flight on the same file), which would stall the link until the watchdog called it dead.
	OnEvent     func(typ uint8, path string)
	OnConnect   func(reconnect bool)                  // after every successful dial, the first included
	OnReconnect func(w Welcome, instanceChanged bool) // after every reconnect (caches are stale)
	OnOffline   func(reason string)

	events     chan event
	evOverflow atomic.Bool
	done       chan struct{}

	lastInstance string

	// Counters for the benchmarks.
	Requests   atomic.Int64
	FastFails  atomic.Int64 // answered EHOSTDOWN without touching the network
	Timeouts   atomic.Int64
	Drops      atomic.Int64
	Reconnects atomic.Int64
}

type event struct {
	typ  uint8
	path string
}

func New(cfg Config) *Client {
	cfg.defaults()
	return &Client{cfg: cfg, pending: make(map[uint32]*call), events: make(chan event, 4096), done: make(chan struct{})}
}

// QueueEvent hands an event to the event goroutine. A full queue turns into one resync.
func (c *Client) QueueEvent(typ uint8, path string) {
	select {
	case c.events <- event{typ, path}:
	default:
		c.evOverflow.Store(true)
	}
}

func (c *Client) eventLoop() {
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-c.done:
			return
		case e := <-c.events:
			if c.OnEvent != nil {
				c.OnEvent(e.typ, e.path)
			}
		case <-tick.C:
		}
		if c.evOverflow.Swap(false) && c.OnEvent != nil {
			for len(c.events) > 0 {
				<-c.events
			}
			c.OnEvent(wire.EventResync, "")
		}
	}
}

// Start dials once synchronously, so a mount of a reachable computer starts online, then keeps
// redialling in the background whenever the link is down.
func (c *Client) Start() {
	go c.eventLoop()
	if err := c.dial(); err != nil {
		c.cfg.Logf("[%s] offline at start: %v", c.cfg.Name, err)
		c.redialLater()
	}
}

func (c *Client) Online() bool { return c.online.Load() }

// Welcome returns the current file service's welcome (zero while offline).
func (c *Client) Welcome() Welcome {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cur == nil {
		return Welcome{}
	}
	return c.cur.welcome
}

func (c *Client) Close() {
	c.mu.Lock()
	if !c.closed {
		close(c.done)
	}
	c.closed = true
	cur := c.cur
	c.mu.Unlock()
	if cur != nil {
		c.drop(cur.gen, "closed")
	}
}

var errVersion = errors.New("file service speaks another protocol version")

func (c *Client) dial() error {
	conn, err := net.DialTimeout("tcp", c.cfg.Addr, c.cfg.DialTimeout)
	if err != nil {
		return err
	}
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
		_ = tc.SetKeepAlive(false) // liveness is ours, not TCP's
	}
	// Liveness counts bytes, not whole frames: a 1 MiB reply on a slow link takes seconds to
	// arrive, and the watchdog must not call the link dead while it does (review S1).
	conn = &progressConn{Conn: conn, last: &c.lastRecv, n: &c.rxBytes}
	_ = conn.SetDeadline(time.Now().Add(c.cfg.DialTimeout))
	if _, err := conn.Write(wire.NewWriter(wire.KindHello, 0).U32(wire.Version).Str("clover-mount").Frame()); err != nil {
		conn.Close()
		return err
	}
	br := bufio.NewReaderSize(conn, 256<<10)
	hdr := make([]byte, 4)
	body, err := wire.ReadFrame(br, hdr)
	if err != nil {
		conn.Close()
		return fmt.Errorf("no welcome: %w", err)
	}
	r := wire.NewReader(body)
	if kind := r.U8(); kind != wire.KindWelcome {
		conn.Close()
		return fmt.Errorf("expected WELCOME, got kind %d", kind)
	}
	r.U32()
	if v := r.U32(); v != wire.Version {
		conn.Close()
		return errVersion
	}
	w := Welcome{Instance: r.Str(), OS: r.Str(), CaseSensitive: r.U8() != 0}
	if r.Err() != nil {
		conn.Close()
		return r.Err()
	}
	_ = conn.SetDeadline(time.Time{})

	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		conn.Close()
		return errors.New("closed")
	}
	c.gen++
	l := &link{gen: c.gen, conn: conn, sendq: make(chan outFrame, 1024), quit: make(chan struct{}), welcome: w}
	l.lastSent.Store(time.Now().UnixNano())
	c.cur = l
	c.lastRecv.Store(time.Now().UnixNano())
	reconnect := c.lastInstance != ""
	changed := reconnect && c.lastInstance != w.Instance
	c.lastInstance = w.Instance
	c.mu.Unlock()

	go c.reader(l, br)
	go c.writer(l)
	go c.watchdog(l)
	c.online.Store(true)
	if c.OnConnect != nil {
		c.OnConnect(reconnect)
	}
	if reconnect {
		c.Reconnects.Add(1)
		c.cfg.Logf("[%s] link back (service %s, restarted: %v)", c.cfg.Name, short(w.Instance), changed)
		if c.OnReconnect != nil {
			c.OnReconnect(w, changed)
		}
	} else {
		c.cfg.Logf("[%s] online (service %s on %s)", c.cfg.Name, short(w.Instance), w.OS)
	}
	return nil
}

// progressConn records when bytes last arrived, and how many.
type progressConn struct {
	net.Conn
	last *atomic.Int64
	n    *atomic.Int64
}

func (p *progressConn) Read(b []byte) (int, error) {
	n, err := p.Conn.Read(b)
	if n > 0 {
		p.last.Store(time.Now().UnixNano())
		p.n.Add(int64(n))
	}
	return n, err
}

// answerBytes counts inbound bytes that are not pings or pongs: answers and events, including
// a frame still arriving. A request's clock runs only while this stands still (see Do).
func (c *Client) answerBytes() int64 { return c.rxBytes.Load() - c.rxCtl.Load() }

func short(s string) string {
	if len(s) > 8 {
		return s[:8]
	}
	return s
}

// drop takes the link down: every pending request fails with EHOSTDOWN now, and new requests
// fail the same way until the redial succeeds.
func (c *Client) drop(gen uint64, reason string) {
	c.mu.Lock()
	l := c.cur
	if l == nil || l.gen != gen {
		c.mu.Unlock()
		return
	}
	c.cur = nil
	c.online.Store(false)
	failed := c.pending
	c.pending = make(map[uint32]*call)
	closed := c.closed
	c.mu.Unlock()

	close(l.quit)
	l.conn.Close()
	for _, cl := range failed {
		cl.err = wire.EHOSTDOWN
		close(cl.done)
	}
	c.Drops.Add(1)
	c.cfg.Logf("[%s] offline: %s (%d requests failed)", c.cfg.Name, reason, len(failed))
	if c.OnOffline != nil {
		c.OnOffline(reason)
	}
	if !closed {
		c.redialLater()
	}
}

func (c *Client) redialLater() {
	c.mu.Lock()
	if c.dialing || c.closed {
		c.mu.Unlock()
		return
	}
	c.dialing = true
	c.mu.Unlock()
	go func() {
		wait := c.cfg.RedialMin
		for {
			time.Sleep(wait)
			c.mu.Lock()
			if c.closed {
				c.dialing = false
				c.mu.Unlock()
				return
			}
			c.mu.Unlock()
			if err := c.dial(); err == nil {
				c.mu.Lock()
				c.dialing = false
				c.mu.Unlock()
				return
			}
			if wait *= 2; wait > c.cfg.RedialMax {
				wait = c.cfg.RedialMax
			}
		}
	}()
}

func (c *Client) reader(l *link, br *bufio.Reader) {
	hdr := make([]byte, 4)
	for {
		body, err := wire.ReadFrame(br, hdr)
		if err != nil {
			c.drop(l.gen, "read: "+err.Error())
			return
		}
		c.lastRecv.Store(time.Now().UnixNano())
		if len(body) < 5 {
			c.drop(l.gen, "short frame")
			return
		}
		r := wire.NewReader(body)
		kind := r.U8()
		id := r.U32()
		switch kind {
		case wire.KindRes:
			c.mu.Lock()
			cl := c.pending[id]
			delete(c.pending, id)
			c.mu.Unlock()
			if cl != nil {
				cl.body = body
				cl.err = wire.Errno(r.U16())
				close(cl.done)
			}
		case wire.KindEvent:
			typ := r.U8()
			p := r.Str()
			if r.Err() == nil {
				c.QueueEvent(typ, p) // never block the reader (see OnEvent)
			}
		case wire.KindPing:
			c.rxCtl.Add(int64(4 + len(body)))
			// Never block the reader on a full queue: the data in it proves the link alive.
			if l.pongQueued.CompareAndSwap(false, true) {
				select {
				case l.sendq <- outFrame{b: wire.NewWriter(wire.KindPong, id).Frame(), once: &l.pongQueued}:
				default:
					l.pongQueued.Store(false)
				}
			}
		case wire.KindPong:
			c.rxCtl.Add(int64(4 + len(body)))
		default:
			c.drop(l.gen, fmt.Sprintf("unknown frame kind %d", kind))
			return
		}
	}
}

func (c *Client) writer(l *link) {
	bw := bufio.NewWriterSize(l.conn, writeChunk)
	for {
		select {
		case <-l.quit:
			return
		case f := <-l.sendq:
			// A blackholed link fills the socket buffer; a deadline per chunk keeps us from
			// blocking past the liveness bound once the link stops taking bytes.
			for off := 0; off < len(f.b); off += writeChunk {
				end := min(off+writeChunk, len(f.b))
				_ = l.conn.SetWriteDeadline(time.Now().Add(c.cfg.DeadAfter))
				if _, err := bw.Write(f.b[off:end]); err != nil {
					c.drop(l.gen, "write: "+err.Error())
					return
				}
				l.lastSent.Store(time.Now().UnixNano())
			}
			if len(l.sendq) == 0 {
				_ = l.conn.SetWriteDeadline(time.Now().Add(c.cfg.DeadAfter))
				if err := bw.Flush(); err != nil {
					c.drop(l.gen, "flush: "+err.Error())
					return
				}
				l.lastSent.Store(time.Now().UnixNano())
			}
			if f.once != nil {
				f.once.Store(false)
			}
			if f.sent != nil {
				close(f.sent)
			}
		}
	}
}

func (c *Client) watchdog(l *link) {
	t := time.NewTicker(c.cfg.PingEvery / 2)
	defer t.Stop()
	var seq uint32
	lastPing := time.Now()
	for {
		select {
		case <-l.quit:
			return
		case now := <-t.C:
			if silent := now.Sub(time.Unix(0, c.lastRecv.Load())); silent > c.cfg.DeadAfter {
				c.drop(l.gen, fmt.Sprintf("silent for %v", silent.Round(time.Millisecond)))
				return
			}
			if now.Sub(lastPing) >= c.cfg.PingEvery && l.pingQueued.CompareAndSwap(false, true) {
				seq++
				lastPing = now
				c.enqueueOut(l, outFrame{b: wire.NewWriter(wire.KindPing, seq).Frame(), once: &l.pingQueued})
			}
		}
	}
}

func (c *Client) enqueueOut(l *link, f outFrame) bool {
	t := time.NewTimer(c.cfg.DeadAfter)
	defer t.Stop()
	for {
		select {
		case l.sendq <- f:
			return true
		case <-l.quit:
			return false
		case <-t.C:
			// A full queue is a slow link while the writer keeps putting bytes on the wire; it
			// is stuck only when the writer has written nothing for the liveness bound.
			if time.Since(time.Unix(0, l.lastSent.Load())) > c.cfg.DeadAfter {
				c.drop(l.gen, "send queue stuck")
				return false
			}
			t.Reset(c.cfg.DeadAfter)
		}
	}
}

// Response is a successful RES body, positioned after the error code.
type Response struct{ *wire.Reader }

// Do sends one request and waits for its answer. build writes the op's arguments.
// While the computer is offline it answers EHOSTDOWN at once.
func (c *Client) Do(op uint8, build func(w *wire.Writer)) (Response, wire.Errno) {
	c.Requests.Add(1)
	c.mu.Lock()
	l := c.cur
	if l == nil {
		c.mu.Unlock()
		c.FastFails.Add(1)
		return Response{}, wire.EHOSTDOWN
	}
	c.nextID++
	if c.nextID == 0 {
		c.nextID = 1
	}
	id := c.nextID
	cl := &call{done: make(chan struct{})}
	c.pending[id] = cl
	c.mu.Unlock()

	w := wire.NewWriter(wire.KindReq, id).U8(op)
	if build != nil {
		build(w)
	}
	sent := make(chan struct{})
	if !c.enqueueOut(l, outFrame{b: w.Frame(), sent: sent}) {
		c.forget(id)
		return Response{}, wire.EHOSTDOWN
	}
	// The request's own clock starts once it is on the wire: time spent queued behind other
	// requests' data on a slow link is the link's, and the watchdog bounds that (review S1).
	select {
	case <-sent:
	case <-cl.done:
	case <-l.quit:
	}
	// It runs out after OpTimeout in which no answer bytes arrived at all. While answers keep
	// arriving (16 × 1 MiB of NFS readahead queue behind each other on a slow link), the wait
	// is the link's, up to OpCap; a request the holder sits on fails once the link goes quiet.
	start, mark := time.Now(), c.answerBytes()
	timer := time.NewTimer(c.cfg.OpTimeout)
	defer timer.Stop()
wait:
	for {
		select {
		case <-cl.done:
			break wait
		case <-timer.C:
			if now := c.answerBytes(); now != mark && time.Since(start) < c.cfg.OpCap {
				mark = now
				timer.Reset(min(c.cfg.OpTimeout, c.cfg.OpCap-time.Since(start)))
				continue
			}
			if c.forget(id) {
				c.Timeouts.Add(1)
				return Response{}, wire.ETIMEDOUT
			}
			<-cl.done // the answer raced the timer
			break wait
		}
	}
	if cl.err != wire.OK {
		return Response{}, cl.err
	}
	r := wire.NewReader(cl.body)
	r.U8()
	r.U32()
	r.U16()
	return Response{r}, wire.OK
}

func (c *Client) forget(id uint32) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.pending[id]; ok {
		delete(c.pending, id)
		return true
	}
	return false
}
