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
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/waifucave/clover/native/mounts/wire"
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

func startService(t *testing.T, root string, port int) *service {
	t.Helper()
	serve := os.Getenv("CLOVER_S6_SERVE")
	if serve == "" {
		t.Skip("CLOVER_S6_SERVE is not set (path to spikes/s6-mounts/server/serve.ts)")
	}
	cmd := exec.Command("bun", serve, "--root", root, "--port", strconv.Itoa(port), "--test-ops")
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
	ln    net.Listener
	to    string
	held  atomic.Bool
	mu    sync.Mutex
	conns []net.Conn
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
	pipe := func(dst, src net.Conn) {
		buf := make([]byte, 64<<10)
		for {
			n, err := src.Read(buf)
			for r.held.Load() {
				time.Sleep(5 * time.Millisecond)
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
	go pipe(up, c)
	go pipe(c, up)
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
