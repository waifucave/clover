package nfsloop

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/go-git/go-billy/v5"
	"github.com/go-git/go-billy/v5/memfs"
	nfs "github.com/willscott/go-nfs"
	nfsc "github.com/willscott/go-nfs-client/nfs"
	rpc "github.com/willscott/go-nfs-client/nfs/rpc"
	nfshelper "github.com/willscott/go-nfs/helpers"
)

// The export's MOUNT gate: a wrong path is refused, the right one works once, and every MOUNT
// after it is refused, the right path included.
func TestGateLetsOneMountIn(t *testing.T) {
	g, err := NewGate(nfshelper.NewNullAuthHandler(memfs.New()))
	if err != nil {
		t.Fatal(err)
	}
	mount := func(p string) nfs.MountStatus {
		st, _, _ := g.Mount(context.Background(), nil, nfs.MountRequest{Dirpath: []byte(p)})
		return st
	}
	if len(g.Path()) < 20 {
		t.Fatalf("export path %q is too short to be a secret", g.Path())
	}
	for _, p := range []string{"/", "", "/x", g.Path() + "x", g.Path()[:len(g.Path())-1], strings.ToUpper(g.Path())} {
		if mount(p) == nfs.MountStatusOk {
			t.Fatalf("MOUNT %q was let in", p)
		}
	}
	if g.Mounted() {
		t.Fatal("a refused MOUNT counted as the one")
	}
	if st := mount(g.Path()); st != nfs.MountStatusOk {
		t.Fatalf("the daemon's MOUNT was refused: %v", st)
	}
	if mount(g.Path()) == nfs.MountStatusOk {
		t.Fatal("a second MOUNT with the right path was let in")
	}
	if got := g.Refused(); got != 7 {
		t.Fatalf("refused %d MOUNTs, want 7", got)
	}
	if a, b := mustGate(t).Path(), mustGate(t).Path(); a == b {
		t.Fatal("two exports got the same path")
	}
}

// Over the wire: a refused MOUNT gets an answer (upstream crashed making a root handle for it),
// and the export goes on serving the right MOUNT on another connection.
func TestGateOverTheWire(t *testing.T) {
	fs := memfs.New()
	_ = fs.MkdirAll("dir", 0o755)
	g := mustGateFS(t, fs)
	nl, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer nl.Close()
	go nfs.Serve(nl, nfshelper.NewCachingHandler(g, 1<<10))
	dial := func() *rpc.Client {
		for i := 0; ; i++ { // go-nfs-client binds a random local port, which can collide
			rc, err := rpc.DialTCP("tcp", nl.Addr().String(), false)
			if err == nil {
				t.Cleanup(func() { rc.Close() })
				return rc
			}
			if i == 20 {
				t.Fatal(err)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	bad := nfsc.Mount{Client: dial()}
	if _, err := bad.Mount("/", rpc.AuthNull); err == nil {
		t.Fatal("MOUNT / was let in")
	}
	good := nfsc.Mount{Client: dial()}
	target, err := good.Mount(g.Path(), rpc.AuthNull)
	if err != nil {
		t.Fatalf("the daemon's MOUNT failed: %v", err)
	}
	if _, _, err := target.Lookup("/dir"); err != nil {
		t.Fatalf("the mounted export doesn't answer: %v", err)
	}
}

func mustGate(t *testing.T) *Gate { return mustGateFS(t, memfs.New()) }

func mustGateFS(t *testing.T, fs billy.Filesystem) *Gate {
	t.Helper()
	g, err := NewGate(nfshelper.NewNullAuthHandler(fs))
	if err != nil {
		t.Fatal(err)
	}
	return g
}
