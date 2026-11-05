// clover-nfs serves one other computer's folder as an NFSv3 export on localhost, for the
// system's NFS client (macOS: mount_nfs) to mount. See nfsloop/fs.go.
//
//	clover-nfs --listen 127.0.0.1:12049 --remote Desktop1=127.0.0.1:7500 [--policy plain] [--status 127.0.0.1:7600]
//	mount_nfs -o vers=3,tcp,port=12049,mountport=12049,nolocks,locallocks,soft,intr,timeo=10,retrans=2,nobrowse 127.0.0.1:/ <dir>
package main

import (
	"encoding/json"
	"flag"
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
	listen := flag.String("listen", "127.0.0.1:12049", "where the NFS export listens (localhost only)")
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
	if *status != "" {
		go http.ListenAndServe(*status, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{name: map[string]any{
				"online": c.Online(), "requests": c.Requests.Load(), "fastFails": c.FastFails.Load(),
				"timeouts": c.Timeouts.Load(), "drops": c.Drops.Load(), "reconnects": c.Reconnects.Load(),
			}})
		}))
	}
	l, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	logger.Printf("NFSv3 export of %s on %s (policy %s)", name, *listen, pol.Name)
	handler := nfshelper.NewNullAuthHandler(nfsloop.New(f))
	// File handles map to paths; keep enough of them that a large tree never answers STALE.
	log.Fatal(nfs.Serve(l, nfshelper.NewCachingHandler(handler, 1<<20)))
}
