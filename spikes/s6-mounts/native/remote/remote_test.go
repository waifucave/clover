package remote

// These tests run the real file service (spikes/s6-mounts/server/serve.ts under Bun) and drive
// the helper's FS core against it, with a small relay in between that can blackhole the link.
// They need `bun` on PATH; set CLOVER_S6_SERVE to the serve.ts path (the CI job and the
// README's command do).

import (
	"bytes"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/waifucave/clover/spikes/s6-mounts/native/wire"
)

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

type service struct {
	cmd  *exec.Cmd
	port int
	root string
}

func startService(t *testing.T, root string, port int, extra ...string) *service {
	t.Helper()
	serve := os.Getenv("CLOVER_S6_SERVE")
	if serve == "" {
		t.Skip("CLOVER_S6_SERVE is not set (path to spikes/s6-mounts/server/serve.ts)")
	}
	cmd := exec.Command("bun", append([]string{serve, "--root", root, "--port", strconv.Itoa(port), "--test-ops"}, extra...)...)
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start bun: %v", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 200*time.Millisecond); err == nil {
			c.Close()
			return &service{cmd: cmd, port: port, root: root}
		}
		time.Sleep(50 * time.Millisecond)
	}
	cmd.Process.Kill()
	t.Fatal("file service did not start")
	return nil
}

func (s *service) kill() {
	s.cmd.Process.Kill()
	s.cmd.Wait()
}

// relay is a pass-through TCP relay that can hold all traffic (a dropped network).
type relay struct {
	ln     net.Listener
	to     string
	held   atomic.Bool
	upHeld atomic.Bool  // holds only what the helper sends (a stalled uplink)
	rate   atomic.Int64 // bytes per second each way; 0 = unlimited
	mu     sync.Mutex
	conns  []net.Conn
}

func newRelay(t *testing.T, to string) *relay {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	r := &relay{ln: ln, to: to}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go r.serve(c)
		}
	}()
	t.Cleanup(func() { ln.Close(); r.reset() })
	return r
}

func (r *relay) addr() string { return r.ln.Addr().String() }

func (r *relay) serve(c net.Conn) {
	up, err := net.Dial("tcp", r.to)
	if err != nil {
		c.Close()
		return
	}
	r.mu.Lock()
	r.conns = append(r.conns, c, up)
	r.mu.Unlock()
	pipe := func(dst, src net.Conn, uplink bool) {
		buf := make([]byte, 64<<10)
		for {
			chunk := buf
			if r.rate.Load() > 0 {
				chunk = buf[:8<<10]
			}
			n, err := src.Read(chunk)
			for r.held.Load() || (uplink && r.upHeld.Load()) {
				time.Sleep(5 * time.Millisecond)
			}
			if rate := r.rate.Load(); rate > 0 && n > 0 {
				time.Sleep(time.Duration(int64(n) * int64(time.Second) / rate))
			}
			if n > 0 {
				if _, werr := dst.Write(buf[:n]); werr != nil {
					break
				}
			}
			if err != nil {
				break
			}
		}
		dst.Close()
		src.Close()
	}
	go pipe(up, c, true)
	go pipe(c, up, false)
}

func (r *relay) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, c := range r.conns {
		c.Close()
	}
	r.conns = nil
}

func newFS(t *testing.T, addr string, pol Policy) *FS {
	c := New(Config{Addr: addr, Name: "test", Logf: t.Logf})
	f := NewFS(c, pol)
	c.Start()
	f.Start()
	t.Cleanup(c.Close)
	return f
}

func TestOperations(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "a", "b"), 0o755)
	os.WriteFile(filepath.Join(root, "a", "b", "hello.txt"), []byte("hello"), 0o644)
	os.MkdirAll(filepath.Join(root, ".clover"), 0o700)
	os.WriteFile(filepath.Join(root, ".clover", "secret"), []byte("x"), 0o600)
	svc := startService(t, root, freePort(t))
	defer svc.kill()

	for _, name := range []string{"nocache", "plain", "cached"} {
		pol, _ := PolicyByName(name)
		f := newFS(t, "127.0.0.1:"+strconv.Itoa(svc.port), pol)
		if a, e := f.Stat("a/b/hello.txt"); e != wire.OK || a.Size != 5 || a.Type != wire.TypeFile {
			t.Fatalf("%s: stat = %+v, %v", name, a, e)
		}
		if _, e := f.Stat("a/missing"); e != wire.ENOENT {
			t.Fatalf("%s: stat missing = %v", name, e)
		}
		ents, e := f.List("")
		if e != wire.OK {
			t.Fatalf("%s: list: %v", name, e)
		}
		for _, d := range ents {
			if d.Name == ".clover" {
				t.Fatalf("%s: the fenced folder is listed", name)
			}
		}
		if _, e := f.Stat(".clover/secret"); e != wire.EACCES {
			t.Fatalf("%s: fenced stat = %v, want EACCES", name, e)
		}
		if _, e := f.Stat("a/../.."); e != wire.EINVAL {
			t.Fatalf("%s: escaping stat = %v, want EINVAL", name, e)
		}
		// write, read back, rename, delete
		h, _, e := f.Open("a/new-"+name, wire.OWronly|wire.OCreat|wire.OTrunc, 0o644)
		if e != wire.OK {
			t.Fatalf("%s: create: %v", name, e)
		}
		payload := bytes.Repeat([]byte(name), 100000)
		if n, e := f.Write(h, 0, payload); e != wire.OK || n != len(payload) {
			t.Fatalf("%s: write = %d, %v", name, n, e)
		}
		f.Release(h)
		got, e := f.Read("a/new-"+name, nil, 0, len(payload)+10)
		if e != wire.OK || !bytes.Equal(got, payload) {
			t.Fatalf("%s: read back %d bytes, %v", name, len(got), e)
		}
		if e := f.Rename("a/new-"+name, "a/b/moved-"+name, 0); e != wire.OK {
			t.Fatalf("%s: rename: %v", name, e)
		}
		if a, e := f.Stat("a/b/moved-" + name); e != wire.OK || a.Size != uint64(len(payload)) {
			t.Fatalf("%s: stat after rename = %v", name, e)
		}
		if e := f.Unlink("a/b/moved-" + name); e != wire.OK {
			t.Fatalf("%s: unlink: %v", name, e)
		}
		if _, e := f.Stat("a/b/moved-" + name); e != wire.ENOENT {
			t.Fatalf("%s: stat after unlink = %v", name, e)
		}
	}
}

// The holder's change events reach the cache: a file written behind the mount's back is seen.
func TestEventsInvalidate(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "f.txt"), []byte("one"), 0o644)
	svc := startService(t, root, freePort(t))
	defer svc.kill()
	pol, _ := PolicyByName("cached")
	f := newFS(t, "127.0.0.1:"+strconv.Itoa(svc.port), pol)
	if _, e := f.List(""); e != wire.OK {
		t.Fatal(e)
	}
	if a, _ := f.Stat("f.txt"); a.Size != 3 {
		t.Fatalf("size %d", a.Size)
	}
	time.Sleep(300 * time.Millisecond) // let the watch settle
	os.WriteFile(filepath.Join(root, "f.txt"), []byte("three"), 0o644)
	os.WriteFile(filepath.Join(root, "g.txt"), []byte("new"), 0o644)
	deadline := time.Now().Add(5 * time.Second)
	for {
		a, _ := f.Stat("f.txt")
		_, eg := f.Stat("g.txt")
		if a.Size == 5 && eg == wire.OK {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("change not seen: size %d, g.txt %v", a.Size, eg)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A blackholed link fails every pending request within the liveness bound, answers new ones at
// once while it is down, and comes back by itself.
func TestFailFastAndRecover(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "f.txt"), []byte("x"), 0o644)
	svc := startService(t, root, freePort(t))
	defer svc.kill()
	rl := newRelay(t, "127.0.0.1:"+strconv.Itoa(svc.port))
	pol, _ := PolicyByName("nocache")
	f := newFS(t, rl.addr(), pol)
	if _, e := f.Stat("f.txt"); e != wire.OK {
		t.Fatal(e)
	}

	// A request in flight when the link goes silent.
	rl.held.Store(true)
	start := time.Now()
	done := make(chan wire.Errno, 1)
	go func() {
		_, e := f.C.Do(wire.OpSleep, func(w *wire.Writer) { w.U32(100) })
		done <- e
	}()
	e := <-done
	inflight := time.Since(start)
	if e != wire.EHOSTDOWN || inflight > 2500*time.Millisecond {
		t.Fatalf("in-flight request: %v after %v", e, inflight)
	}
	t.Logf("in-flight request failed after %v", inflight.Round(time.Millisecond))

	// While down: at once.
	start = time.Now()
	if _, e := f.Stat("f.txt"); e != wire.EHOSTDOWN {
		t.Fatalf("offline stat: %v", e)
	}
	if d := time.Since(start); d > 10*time.Millisecond {
		t.Fatalf("offline stat took %v", d)
	}

	// Back.
	rl.reset()
	rl.held.Store(false)
	start = time.Now()
	for {
		if _, e := f.Stat("f.txt"); e == wire.OK {
			break
		}
		if time.Since(start) > 5*time.Second {
			t.Fatal("did not recover")
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Logf("recovered %v after the link returned", time.Since(start).Round(time.Millisecond))
}

// Killing the file service fails pending requests at once (the connection closes); a new
// service instance is picked up and open handles are reopened by path.
func TestServiceRestart(t *testing.T) {
	root := t.TempDir()
	port := freePort(t)
	svc := startService(t, root, port)
	pol, _ := PolicyByName("plain")
	f := newFS(t, "127.0.0.1:"+strconv.Itoa(port), pol)
	h, _, e := f.Open("w.bin", wire.OWronly|wire.OCreat, 0o644)
	if e != wire.OK {
		t.Fatal(e)
	}
	if _, e := f.Write(h, 0, []byte("before ")); e != wire.OK {
		t.Fatal(e)
	}
	start := time.Now()
	done := make(chan wire.Errno, 1)
	go func() {
		_, e := f.C.Do(wire.OpSleep, func(w *wire.Writer) { w.U32(5000) })
		done <- e
	}()
	time.Sleep(50 * time.Millisecond)
	svc.kill()
	if e := <-done; e != wire.EHOSTDOWN {
		t.Fatalf("pending request after kill: %v", e)
	}
	t.Logf("pending request failed %v after the kill", (time.Since(start) - 50*time.Millisecond).Round(time.Millisecond))
	svc = startService(t, root, port)
	defer svc.kill()
	deadline := time.Now().Add(5 * time.Second)
	for !f.C.Online() {
		if time.Now().After(deadline) {
			t.Fatal("no reconnect")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, e := f.Write(h, 7, []byte("after")); e != wire.OK {
		t.Fatalf("write through a handle from the old instance: %v", e)
	}
	f.Release(h)
	b, _ := os.ReadFile(filepath.Join(root, "w.bin"))
	if string(b) != "before after" {
		t.Fatalf("file = %q", b)
	}
	_ = io.EOF
}

// A handler that waits on the link, as Linux's inval_inode waits for a write in flight on the
// same file, must not stall it: events run off the reader goroutine. Before that rule, the
// reader blocked in the handler, the reply never arrived, and the watchdog called the computer
// offline after 1.5 s (seen in CI as "write error: Host is down" in the middle of git status).
func TestBlockedEventHandlerDoesNotStallTheLink(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "f.txt"), []byte("one"), 0o644)
	svc := startService(t, root, freePort(t))
	defer svc.kill()
	pol, _ := PolicyByName("cached")
	f := newFS(t, "127.0.0.1:"+strconv.Itoa(svc.port), pol)
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	f.Invalidate = func(string) {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release
	}
	defer close(release)
	if _, e := f.Stat("f.txt"); e != wire.OK {
		t.Fatal(e)
	}
	time.Sleep(300 * time.Millisecond) // let the watch settle
	os.WriteFile(filepath.Join(root, "f.txt"), []byte("three"), 0o644)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("no event arrived")
	}
	// The handler is still blocked. A request must still get its answer, well inside the bound.
	t0 := time.Now()
	a, e := f.Stat("f.txt")
	if e != wire.OK || a.Size != 5 {
		t.Fatalf("stat while a handler is blocked: size %d, %v after %v", a.Size, e, time.Since(t0))
	}
	if d := time.Since(t0); d > 500*time.Millisecond {
		t.Fatalf("stat took %v", d)
	}
}

// A link slower than a 1 MiB frame per liveness bound stays up (review S1): the write deadline
// is per chunk, the holder pings while the helper uploads, liveness counts bytes, and a request's
// clock starts when it is on the wire. At 256 KiB/s each 1 MiB frame takes 4 s.
func TestSlowLinkStaysUp(t *testing.T) {
	root := t.TempDir()
	svc := startService(t, root, freePort(t))
	defer svc.kill()
	r := newRelay(t, "127.0.0.1:"+strconv.Itoa(svc.port))
	pol, _ := PolicyByName("plain")
	f := newFS(t, r.addr(), pol)
	r.rate.Store(256 << 10)
	payload := bytes.Repeat([]byte("slow-link"), (1<<20)/9)
	h, _, e := f.Open("big.bin", wire.OWronly|wire.OCreat|wire.OTrunc, 0o644)
	if e != wire.OK {
		t.Fatal(e)
	}
	if n, e := f.Write(h, 0, payload); e != wire.OK || n != len(payload) {
		t.Fatalf("write: %d %v", n, e)
	}
	f.Release(h)
	got, e := f.Read("big.bin", nil, 0, len(payload))
	if e != wire.OK || !bytes.Equal(got, payload) {
		t.Fatalf("read back %d bytes: %v", len(got), e)
	}
	if d, to := f.C.Drops.Load(), f.C.Timeouts.Load(); d != 0 || to != 0 {
		t.Fatalf("a live link was called dead: %d drops, %d timeouts", d, to)
	}
}

// An uplink that takes nothing for seconds while the holder's pings still arrive is congested,
// not gone (review S1). On Windows a 2 Mbit/s link stalled one 32 KiB write past the 1.5 s bound
// and the link was called dead; here the helper's direction is held for 3 s in the middle of a
// 4 MiB write, and the write must finish with no drop.
func TestStalledUplinkIsNotOffline(t *testing.T) {
	root := t.TempDir()
	svc := startService(t, root, freePort(t))
	defer svc.kill()
	r := newRelay(t, "127.0.0.1:"+strconv.Itoa(svc.port))
	pol, _ := PolicyByName("plain")
	f := newFS(t, r.addr(), pol)
	h, _, e := f.Open("stall.bin", wire.OWronly|wire.OCreat|wire.OTrunc, 0o644)
	if e != wire.OK {
		t.Fatal(e)
	}
	payload := bytes.Repeat([]byte{9}, 4<<20)
	r.upHeld.Store(true)
	go func() { time.Sleep(3 * time.Second); r.upHeld.Store(false) }()
	start := time.Now()
	if n, e := f.Write(h, 0, payload); e != wire.OK || n != len(payload) {
		t.Fatalf("write across a stalled uplink: %d bytes, %v after %v", n, e, time.Since(start).Round(time.Millisecond))
	}
	f.Release(h)
	t.Logf("4 MiB written in %v across a 3 s stall", time.Since(start).Round(time.Millisecond))
	if d := f.C.Drops.Load(); d != 0 {
		t.Fatalf("%d drops on a live link", d)
	}
	if st, err := os.Stat(filepath.Join(root, "stall.bin")); err != nil || st.Size() != int64(len(payload)) {
		t.Fatalf("on the holder: %v %v", st, err)
	}
}

// Answers queued behind each other on a slow link are the link's wait, not a stuck holder's
// (review S1). With a 1 s request clock, six 512 KiB reads at 512 KiB/s arrive over about 6 s
// with no timeouts; the clock runs only while no answer bytes arrive. A request the holder sits
// on, on a link that carries nothing else, still fails after about 1 s.
func TestQueuedAnswersAreNotTimedOut(t *testing.T) {
	root := t.TempDir()
	payload := bytes.Repeat([]byte{7}, 512<<10)
	os.WriteFile(filepath.Join(root, "big.bin"), payload, 0o644)
	svc := startService(t, root, freePort(t))
	defer svc.kill()
	r := newRelay(t, "127.0.0.1:"+strconv.Itoa(svc.port))
	c := New(Config{Addr: r.addr(), Name: "test", Logf: t.Logf, OpTimeout: time.Second})
	pol, _ := PolicyByName("plain")
	f := NewFS(c, pol)
	c.Start()
	f.Start()
	t.Cleanup(c.Close)
	r.rate.Store(512 << 10)
	start := time.Now()
	var wg sync.WaitGroup
	var bad atomic.Int64
	for range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if got, e := f.Read("big.bin", nil, 0, len(payload)); e != wire.OK || len(got) != len(payload) {
				t.Logf("read: %d bytes, %v", len(got), e)
				bad.Add(1)
			}
		}()
	}
	wg.Wait()
	t.Logf("six queued answers took %v", time.Since(start).Round(time.Millisecond))
	if n, to, d := bad.Load(), c.Timeouts.Load(), c.Drops.Load(); n != 0 || to != 0 || d != 0 {
		t.Fatalf("%d reads failed, %d timeouts, %d drops", n, to, d)
	}
	r.rate.Store(0)
	start = time.Now()
	if _, e := c.Do(wire.OpSleep, func(w *wire.Writer) { w.U32(5000) }); e != wire.ETIMEDOUT {
		t.Fatalf("a request the holder sits on: %v", e)
	}
	if d := time.Since(start); d > 2500*time.Millisecond {
		t.Fatalf("a request the holder sits on failed only after %v", d)
	}
}

// The holder's fence holds when a folder the mount knows is swapped for a link to .clover
// (review S2): the path resolves into the fence, so a stat, a read, an open for writing, a
// create and a listing through it all fail and nothing in the fence changes. Links that leave
// the export answer EACCES instead of a target the reading computer would resolve against its
// own disk (review S9); a relative link inside the export passes as it is.
func TestFenceHoldsThroughLinks(t *testing.T) {
	root := t.TempDir()
	elsewhere := t.TempDir()
	os.MkdirAll(filepath.Join(root, ".clover"), 0o700)
	secret := filepath.Join(root, ".clover", "settings.json")
	os.WriteFile(secret, []byte(`{"secret":1}`), 0o600)
	os.MkdirAll(filepath.Join(root, "d"), 0o755)
	os.WriteFile(filepath.Join(root, "d", "settings.json"), []byte("{}"), 0o644)
	svc := startService(t, root, freePort(t))
	defer svc.kill()
	pol, _ := PolicyByName("nocache")
	f := newFS(t, "127.0.0.1:"+strconv.Itoa(svc.port), pol)
	if _, e := f.Stat("d/settings.json"); e != wire.OK {
		t.Fatal(e)
	}
	os.RemoveAll(filepath.Join(root, "d"))
	if err := os.Symlink(filepath.Join(root, ".clover"), filepath.Join(root, "d")); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	if a, e := f.Stat("d/settings.json"); e == wire.OK {
		t.Fatalf("stat through the swapped folder reached the fence (size %d)", a.Size)
	}
	if b, e := f.Read("d/settings.json", nil, 0, 100); e == wire.OK {
		t.Fatalf("read through the swapped folder: %q", b)
	}
	if h, _, e := f.Open("d/settings.json", wire.OWronly|wire.OTrunc, 0); e == wire.OK {
		f.Write(h, 0, []byte("owned"))
		f.Release(h)
		t.Fatal("opened a fenced file for writing through the swapped folder")
	}
	if h, _, e := f.Open("d/new.json", wire.OWronly|wire.OCreat, 0o644); e == wire.OK {
		f.Release(h)
		t.Fatal("created a file in the fence through the swapped folder")
	}
	if ents, e := f.List("d"); e == wire.OK {
		t.Fatalf("listed the fence through the swapped folder: %d entries", len(ents))
	}
	if b, _ := os.ReadFile(secret); string(b) != `{"secret":1}` {
		t.Fatalf("the fenced file changed: %q", b)
	}
	if _, err := os.Stat(filepath.Join(root, ".clover", "new.json")); err == nil {
		t.Fatal("a file appeared in the fence")
	}

	os.Symlink(filepath.Join(elsewhere, "x"), filepath.Join(root, "abs-out"))
	os.Symlink(filepath.Join("..", "..", "outside"), filepath.Join(root, "rel-out"))
	os.Symlink("d2/x", filepath.Join(root, "rel-in"))
	if tgt, e := f.Readlink("abs-out"); e != wire.EACCES {
		t.Fatalf("an absolute link out of the export: %q, %v", tgt, e)
	}
	if tgt, e := f.Readlink("rel-out"); e != wire.EACCES {
		t.Fatalf("a relative link out of the export: %q, %v", tgt, e)
	}
	if tgt, e := f.Readlink("rel-in"); e != wire.OK || tgt != "d2/x" {
		t.Fatalf("a relative link inside the export: %q, %v", tgt, e)
	}
}

// The fence compares names the way the disk under the export does (review round 2): on a Mac
// STAT and RENAME of `.CLOVER` reached `.clover`. Every spelling the disk could take for a fenced
// name is refused with EACCES before the disk is touched: other case, other Unicode
// normalisation, and on Windows a trailing dot or space and the 8.3 short name. On a
// case-sensitive disk `.CLOVER` is a folder of its own, and it is fenced too.
func TestFenceIgnoresCase(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, ".clover", "sub"), 0o700)
	secret := filepath.Join(root, ".clover", "settings.json")
	os.WriteFile(secret, []byte(`{"secret":1}`), 0o600)
	os.WriteFile(filepath.Join(root, "plain.txt"), []byte("plain"), 0o644)
	cafe := ".caf\u00e9" // a fence name with an accent, NFC
	os.MkdirAll(filepath.Join(root, cafe), 0o700)
	os.WriteFile(filepath.Join(root, cafe, "k"), []byte("k"), 0o600)
	caseSensitive := false
	if _, err := os.Stat(filepath.Join(root, ".CLOVER")); err != nil {
		caseSensitive = true
		os.MkdirAll(filepath.Join(root, ".CLOVER"), 0o700)
		os.WriteFile(filepath.Join(root, ".CLOVER", "settings.json"), []byte("x"), 0o600)
	}
	svc := startService(t, root, freePort(t), "--fence", ".clover,.clover-dev,"+cafe)
	defer svc.kill()
	pol, _ := PolicyByName("nocache")
	f := newFS(t, "127.0.0.1:"+strconv.Itoa(svc.port), pol)

	names := []string{".CLOVER", ".Clover", ".cLoVeR", ".CLOVER-DEV", ".cafe\u0301", ".CAF\u00c9", ".CAFE\u0301"}
	if runtime.GOOS == "windows" {
		names = append(names, ".clover.", ".clover ", ".CLOVER. .")
	}
	for _, n := range names {
		want := func(op string, e wire.Errno) {
			t.Helper()
			if e != wire.EACCES {
				t.Errorf("%s %q: %v, want EACCES", op, n, e)
			}
		}
		_, e := f.Stat(n)
		want("STAT", e)
		_, e = f.Stat(n + "/settings.json")
		want("STAT inside", e)
		_, e = f.Read(n+"/settings.json", nil, 0, 100)
		want("READ", e)
		_, e = f.List(n)
		want("LIST", e)
		h, _, e := f.Open(n+"/settings.json", wire.OWronly|wire.OTrunc, 0)
		if e == wire.OK {
			f.Release(h)
		}
		want("OPEN for writing", e)
		h, _, e = f.Open(n+"/new.json", wire.OWronly|wire.OCreat, 0o644)
		if e == wire.OK {
			f.Release(h)
		}
		want("OPEN to create", e)
		_, e = f.Setattr(n+"/settings.json", nil, 1, 0o666, 0, 0, 0)
		want("SETATTR", e)
		want("UNLINK", f.Unlink(n+"/settings.json"))
		want("RMDIR", f.Rmdir(n+"/sub"))
		_, e = f.Mkdir(n+"/new", 0o755)
		want("MKDIR", e)
		_, e = f.Symlink(n+"/ln", "x")
		want("SYMLINK", e)
		want("RENAME away", f.Rename(n, "moved", 0))
		want("RENAME in", f.Rename("plain.txt", n+"/plain.txt", 0))
		_, e = f.Link(n+"/settings.json", "stolen")
		want("LINK out", e)
		_, e = f.Readlink(n)
		want("READLINK", e)
	}
	if runtime.GOOS == "windows" {
		// where short names are on, .clover answers to one; realpath lengthens the folders above
		short := ""
		for _, s := range []string{"CLOVER~1", "CLOVER~2", "CLOVER~3"} {
			a, err1 := os.Stat(filepath.Join(root, s))
			b, err2 := os.Stat(filepath.Join(root, ".clover"))
			if err1 == nil && err2 == nil && os.SameFile(a, b) {
				short = s
				break
			}
		}
		if short == "" {
			t.Log("no 8.3 name for .clover on this disk")
		} else {
			t.Logf(".clover answers to %s", short)
			if _, e := f.Stat(short); e != wire.EACCES {
				t.Errorf("STAT %s: %v, want EACCES", short, e)
			}
			if e := f.Rename(short, "moved", 0); e != wire.EACCES {
				t.Errorf("RENAME %s: %v, want EACCES", short, e)
			}
			if _, e := f.Stat(short + "/settings.json"); e != wire.EACCES {
				t.Errorf("STAT %s/settings.json: %v, want EACCES", short, e)
			}
		}
	}
	ents, e := f.List("")
	if e != wire.OK {
		t.Fatal(e)
	}
	for _, d := range ents {
		if d.Name != "plain.txt" {
			t.Errorf("the export's listing shows %q", d.Name)
		}
	}
	if b, _ := os.ReadFile(secret); string(b) != `{"secret":1}` {
		t.Fatalf("the fenced file changed: %q", b)
	}
	for _, p := range []string{"moved", "stolen", filepath.Join(".clover", "new.json"), filepath.Join(".clover", "new"), filepath.Join(".clover", "plain.txt")} {
		if _, err := os.Lstat(filepath.Join(root, p)); err == nil {
			t.Errorf("%s appeared", p)
		}
	}
	if _, err := os.Stat(filepath.Join(root, ".clover", "sub")); err != nil {
		t.Error("the fenced folder lost sub")
	}
	t.Logf("case-sensitive disk: %v", caseSensitive)
}

// Paths through links that stay inside the export work. WinFsp hands the file service whole
// paths through Bun's node_modules links; a first version of the S2 fix refused any link before
// the last component (ELOOP) and broke tsc on the Windows tree. The link itself still stats as a
// link, and a file created through it lands in the real folder.
func TestPathsThroughLinksInsideTheExport(t *testing.T) {
	root := t.TempDir()
	real := filepath.Join(root, "node_modules", ".bun", "pkg@1", "node_modules", "pkg")
	os.MkdirAll(real, 0o755)
	os.WriteFile(filepath.Join(real, "index.js"), []byte("ok"), 0o644)
	if err := os.Symlink(filepath.Join(".bun", "pkg@1", "node_modules", "pkg"), filepath.Join(root, "node_modules", "pkg")); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	svc := startService(t, root, freePort(t))
	defer svc.kill()
	pol, _ := PolicyByName("nocache")
	f := newFS(t, "127.0.0.1:"+strconv.Itoa(svc.port), pol)
	if a, e := f.Stat("node_modules/pkg/index.js"); e != wire.OK || a.Size != 2 {
		t.Fatalf("stat through the link: %v (size %d)", e, a.Size)
	}
	if b, e := f.Read("node_modules/pkg/index.js", nil, 0, 10); e != wire.OK || string(b) != "ok" {
		t.Fatalf("read through the link: %q %v", b, e)
	}
	if ents, e := f.List("node_modules/pkg"); e != wire.OK || len(ents) != 1 {
		t.Fatalf("list through the link: %d entries, %v", len(ents), e)
	}
	if a, e := f.Stat("node_modules/pkg"); e != wire.OK || a.Type != wire.TypeSymlink {
		t.Fatalf("the link itself: type %d, %v", a.Type, e)
	}
	h, _, e := f.Open("node_modules/pkg/new.js", wire.OWronly|wire.OCreat, 0o644)
	if e != wire.OK {
		t.Fatalf("create through the link: %v", e)
	}
	f.Write(h, 0, []byte("new"))
	f.Release(h)
	if b, err := os.ReadFile(filepath.Join(real, "new.js")); err != nil || string(b) != "new" {
		t.Fatalf("the created file: %q %v", b, err)
	}
}

// A computer that is offline when the mount starts subscribes to change events once its link
// comes up (review S3); before, the cache never heard of a change and stayed stale for good.
func TestOfflineAtStartSubscribes(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "f.txt"), []byte("one"), 0o644)
	port := freePort(t)
	pol, _ := PolicyByName("cached")
	f := newFS(t, "127.0.0.1:"+strconv.Itoa(port), pol) // nothing listens yet
	if _, e := f.Stat("f.txt"); e != wire.EHOSTDOWN {
		t.Fatalf("offline stat: %v", e)
	}
	svc := startService(t, root, port)
	defer svc.kill()
	deadline := time.Now().Add(10 * time.Second)
	for !f.C.Online() {
		if time.Now().After(deadline) {
			t.Fatal("never came online")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !f.C.Welcome().Watching {
		t.Fatal("the link came up without a subscription in its handshake")
	}
	if a, _ := f.Stat("f.txt"); a.Size != 3 {
		t.Fatalf("size %d", a.Size)
	}
	time.Sleep(300 * time.Millisecond) // let the watcher settle
	os.WriteFile(filepath.Join(root, "f.txt"), []byte("three"), 0o644)
	deadline = time.Now().Add(5 * time.Second)
	for {
		if a, _ := f.Stat("f.txt"); a.Size == 5 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("a change on the holder was never seen: the mount did not subscribe")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A fill whose request went out before an event must not cache over that event (review S3).
func TestFillAfterEventIsNotCached(t *testing.T) {
	pol, _ := PolicyByName("cached")
	f := NewFS(New(Config{Addr: "127.0.0.1:1", Name: "test"}), pol)
	e0 := f.mark()
	f.onEvent(wire.EventChanged, "a/b")
	for _, c := range []struct {
		p     string
		sub   bool
		stale bool
	}{
		{"a/b", false, true},   // the path itself
		{"a/b/c", false, true}, // inside a folder that changed
		{"a", false, true},     // its parent: the listing, so the mtime, changed
		{"a", true, true},      // a listing or bulk fetch of the parent
		{"", true, true},       // a bulk fetch above it
		{"a/x", false, false},  // a sibling
		{"z", true, false},     // elsewhere
	} {
		if got := f.staleSince(e0, c.p, c.sub); got != c.stale {
			t.Errorf("staleSince(%q, sub=%v) = %v, want %v", c.p, c.sub, got, c.stale)
		}
	}
	if f.staleSince(f.mark(), "a/b", false) {
		t.Error("a fill that started after the event was treated as stale")
	}
	e1 := f.mark()
	f.onEvent(wire.EventResync, "")
	if !f.staleSince(e1, "z", false) {
		t.Error("a resync did not make every fill in flight stale")
	}
}
