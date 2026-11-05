package nfsloop

// Speaks NFSv3 to the export (go-nfs-client), with the real file service behind it, so the
// adapter is checked on any OS without mounting anything. Needs bun and CLOVER_S6_SERVE.

import (
	"bytes"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	nfs "github.com/willscott/go-nfs"
	nfsc "github.com/willscott/go-nfs-client/nfs"
	rpc "github.com/willscott/go-nfs-client/nfs/rpc"
	nfshelper "github.com/willscott/go-nfs/helpers"

	"github.com/waifucave/clover/native/mounts/remote"
)

func TestExport(t *testing.T) {
	serve := os.Getenv("CLOVER_S6_SERVE")
	if serve == "" {
		t.Skip("CLOVER_S6_SERVE is not set")
	}
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "dir"), 0o755)
	os.WriteFile(filepath.Join(root, "dir", "a.txt"), []byte("alpha"), 0o644)
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	cmd := exec.Command("bun", serve, "--root", root, "--port", strconv.Itoa(port))
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Skip(err)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	for i := 0; i < 200; i++ {
		if c, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(port)); err == nil {
			c.Close()
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	pol, _ := remote.PolicyByName("plain")
	c := remote.New(remote.Config{Addr: "127.0.0.1:" + strconv.Itoa(port), Name: "test", Logf: t.Logf})
	f := remote.NewFS(c, pol)
	c.Start()
	defer c.Close()

	nl, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go nfs.Serve(nl, nfshelper.NewCachingHandler(nfshelper.NewNullAuthHandler(New(f)), 1<<16))
	rc, err := rpc.DialTCP("tcp", nl.Addr().String(), false)
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	var m nfsc.Mount
	m.Client = rc
	target, err := m.Mount("/", rpc.AuthNull)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Unmount()

	ents, err := target.ReadDirPlus("/dir")
	if err != nil || len(ents) == 0 {
		t.Fatalf("readdirplus: %v %v", ents, err)
	}
	rf, err := target.Open("/dir/a.txt")
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 16)
	n, err := rf.Read(buf)
	if err != nil && !errors.Is(err, io.EOF) || string(buf[:n]) != "alpha" {
		t.Fatalf("read %q %v", buf[:n], err)
	}
	rf.Close()
	if _, err := target.Create("/dir/new.bin", 0o644); err != nil {
		t.Fatal(err)
	}
	wf, err := target.OpenFile("/dir/new.bin", 0o644)
	if err != nil {
		t.Fatal(err)
	}
	payload := bytes.Repeat([]byte("0123456789"), 50000)
	if _, err := wf.Write(payload); err != nil {
		t.Fatal(err)
	}
	wf.Close()
	time.Sleep(100 * time.Millisecond)
	got, _ := os.ReadFile(filepath.Join(root, "dir", "new.bin"))
	if !bytes.Equal(got, payload) {
		t.Fatalf("holder has %d bytes, want %d", len(got), len(payload))
	}
	if err := target.Rename("/dir/new.bin", "/dir/moved.bin"); err != nil {
		t.Fatal(err)
	}
	if err := target.Remove("/dir/moved.bin"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "dir", "moved.bin")); !os.IsNotExist(err) {
		t.Fatalf("still there: %v", err)
	}
}
