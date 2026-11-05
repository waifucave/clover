// clover-nfs serves one other computer's folder as an NFSv3 export on localhost, for the
// system's NFS client (macOS: mount_nfs) to mount. See nfsloop/fs.go.
//
//	clover-nfs --remote Desktop1=127.0.0.1:7500 [--policy cached] [--status 127.0.0.1:7600]
//
// It listens on a port the kernel picks and prints one line to stdout, for the daemon that
// started it: {"port":49823,"export":"/<token>"}. The export path is a one-time random token,
// and the export lets exactly one MOUNT in, with that path; every other MOUNT is refused. The
// daemon mounts it at once, and refuses to go on if its own MOUNT failed:
//
//	mount_nfs -o vers=3,tcp,port=49823,mountport=49823,nolocks,locallocks,soft,intr,dumbtimer,timeo=110,retrans=2,deadtimeout=5,nobrowse,noresvport,noac 127.0.0.1:/<token> <dir>
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	nfs "github.com/willscott/go-nfs"
	nfshelper "github.com/willscott/go-nfs/helpers"

	"github.com/waifucave/clover/native/mounts/nfsloop"
	"github.com/waifucave/clover/native/mounts/remote"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:0", "where the NFS export listens (localhost only; port 0: the kernel picks one)")
	rem := flag.String("remote", "", "Name=host:port of the computer's link")
	policy := flag.String("policy", "plain", "caching: nocache, plain or cached")
	status := flag.String("status", "", "serve GET /stats on this address")
	flag.Parse()
	name, addr, ok := strings.Cut(*rem, "=")
	pol, okp := remote.PolicyByName(*policy)
	if !ok || !okp {
		flag.Usage()
		os.Exit(2)
	}
	if h, _, err := net.SplitHostPort(*listen); err != nil || (h != "127.0.0.1" && h != "localhost" && h != "::1") {
		log.Fatalf("--listen must be a loopback address: the export has no authentication of its own")
	}
	logger := log.New(os.Stderr, "", log.Ltime|log.Lmicroseconds)
	c := remote.New(remote.Config{Addr: addr, Name: name, Logf: logger.Printf, PingEvery: 250 * time.Millisecond})
	f := remote.NewFS(c, pol)
	c.Start()
	f.Start()
	g, err := nfsloop.NewGate(nfshelper.NewNullAuthHandler(nfsloop.New(f)))
	if err != nil {
		log.Fatal(err)
	}
	if *status != "" {
		go http.ListenAndServe(*status, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls, nanos := map[string]int64{}, map[string]int64{}
			for p := range nfs.Calls {
				if n := nfs.Calls[p].Load(); n > 0 {
					calls[nfs.NFSProcedure(p).String()] = n
					nanos[nfs.NFSProcedure(p).String()] = nfs.CallNanos[p].Load()
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{name: map[string]any{
				"online": c.Online(), "requests": c.Requests.Load(), "fastFails": c.FastFails.Load(),
				"timeouts": c.Timeouts.Load(), "drops": c.Drops.Load(), "reconnects": c.Reconnects.Load(),
				"nfsCalls": calls, "nfsNanos": nanos, "mounted": g.Mounted(), "mountsRefused": g.Refused(),
			}})
		}))
	}
	l, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	logger.Printf("NFSv3 export of %s on 127.0.0.1:%d (policy %s)", name, port, pol.Name)
	// The daemon reads this line from the pipe; nobody else learns the port's export path.
	fmt.Printf("{\"port\":%d,\"export\":%q}\n", port, g.Path())
	// File handles map to paths; keep enough of them that a large tree never answers STALE.
	log.Fatal(nfs.Serve(l, nfshelper.NewCachingHandler(g, 1<<20)))
}
