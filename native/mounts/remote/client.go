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
	OpTimeout   time.Duration // a request on a live link fails after this
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
	sendq   chan []byte
	quit    chan struct{}
	welcome Welcome
}

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

	lastRecv atomic.Int64 // unix nanos of the last inbound frame on cur
	online   atomic.Bool

	// Hooks, set before Start. They run on the client's own goroutines, never on the reader:
	// OnEvent typically tells the kernel to drop a cache, and the kernel can wait for a reply
	// that only the reader can deliver (Linux's inval_inode waits on the page locks of a write
	// in flight on the same file), which would stall the link until the watchdog called it dead.
	OnEvent     func(typ uint8, path string)
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
	l := &link{gen: c.gen, conn: conn, sendq: make(chan []byte, 1024), quit: make(chan struct{}), welcome: w}
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
			c.enqueue(l, wire.NewWriter(wire.KindPong, id).Frame())
		case wire.KindPong:
		default:
			c.drop(l.gen, fmt.Sprintf("unknown frame kind %d", kind))
			return
		}
	}
}

func (c *Client) writer(l *link) {
	bw := bufio.NewWriterSize(l.conn, 256<<10)
	for {
		select {
		case <-l.quit:
			return
		case f := <-l.sendq:
			// A blackholed link fills the socket buffer; the deadline keeps us from blocking past
			// the liveness bound.
			_ = l.conn.SetWriteDeadline(time.Now().Add(c.cfg.DeadAfter))
			if _, err := bw.Write(f); err != nil {
				c.drop(l.gen, "write: "+err.Error())
				return
			}
			if len(l.sendq) == 0 {
				if err := bw.Flush(); err != nil {
					c.drop(l.gen, "flush: "+err.Error())
					return
				}
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
			if now.Sub(lastPing) >= c.cfg.PingEvery {
				seq++
				lastPing = now
				c.enqueue(l, wire.NewWriter(wire.KindPing, seq).Frame())
			}
		}
	}
}

func (c *Client) enqueue(l *link, frame []byte) bool {
	select {
	case l.sendq <- frame:
		return true
	case <-l.quit:
		return false
	case <-time.After(c.cfg.DeadAfter):
		c.drop(l.gen, "send queue stuck")
		return false
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
	if !c.enqueue(l, w.Frame()) {
		c.forget(id)
		return Response{}, wire.EHOSTDOWN
	}
	timer := time.NewTimer(c.cfg.OpTimeout)
	defer timer.Stop()
	select {
	case <-cl.done:
	case <-timer.C:
		if c.forget(id) {
			c.Timeouts.Add(1)
			return Response{}, wire.ETIMEDOUT
		}
		<-cl.done // the answer raced the timer
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
