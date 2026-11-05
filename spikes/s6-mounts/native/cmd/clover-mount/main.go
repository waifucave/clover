// clover-mount mounts the folder tree: this computer's own home as a link, and each other
// computer's home over its link. One helper per tree; the daemon supervises it.
//
//	clover-mount --mountpoint DIR|T: --self Studio=/home/me --remote Desktop1=127.0.0.1:7500 \
//	             [--policy plain|cached|nocache] [--status 127.0.0.1:7600] [--debug]
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/waifucave/clover/spikes/s6-mounts/native/remote"
)

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

type options struct {
	mountpoint string
	policy     remote.Policy
	self       []string
	remotes    []computerLink
	debug      bool
	status     string
	owner      []uint32
	single     bool
	caseless   bool
	volPrefix  string
	cfg        remote.Config
}

type computerLink struct {
	name string
	fs   *remote.FS
}

func main() {
	var o options
	var remotes, selfs multi
	policy := flag.String("policy", "plain", "caching: nocache, plain or cached")
	flag.StringVar(&o.mountpoint, "mountpoint", "", "where the tree appears (a directory, or a drive letter on Windows)")
	flag.Var(&remotes, "remote", "Name=host:port of another computer's link (repeatable)")
	flag.Var(&selfs, "self", "Name=path of this computer's own home folder")
	flag.BoolVar(&o.debug, "debug", false, "log every kernel request")
	flag.StringVar(&o.status, "status", "", "serve GET /stats on this address")
	flag.DurationVar(&o.cfg.PingEvery, "ping", 250*time.Millisecond, "liveness ping interval")
	flag.DurationVar(&o.cfg.DeadAfter, "dead", 1500*time.Millisecond, "silence that means the computer dropped")
	flag.DurationVar(&o.cfg.OpTimeout, "op-timeout", 10*time.Second, "a request on a live link fails after this")
	flag.StringVar(&o.volPrefix, "volume-prefix", "", `mount as a network volume \server\share (Windows; see cgofs.Tree.VolumePrefix)`)
	flag.BoolVar(&o.caseless, "case-insensitive", false, "tell WinFsp the volume ignores case (Windows; upper-cases names, see the report)")
	flag.BoolVar(&o.single, "single", false, "serve the one --remote computer's home as the whole volume (Windows and macOS; see cgofs.Tree.Single)")
	owner := flag.String("owner", "", "uid:gid to report as every file's owner (Linux; a test knob for a holder with another uid)")
	flag.Parse()
	if *owner != "" {
		u, g, ok := strings.Cut(*owner, ":")
		uid, err1 := strconv.ParseUint(u, 10, 32)
		gid, err2 := strconv.ParseUint(g, 10, 32)
		if !ok || err1 != nil || err2 != nil {
			log.Fatalf("bad --owner %q, want uid:gid", *owner)
		}
		o.owner = []uint32{uint32(uid), uint32(gid)}
	}

	pol, ok := remote.PolicyByName(*policy)
	if !ok || o.mountpoint == "" || len(remotes)+len(selfs) == 0 {
		flag.Usage()
		os.Exit(2)
	}
	o.policy = pol
	o.self = selfs
	logger := log.New(os.Stderr, "", log.Ltime|log.Lmicroseconds)
	for _, r := range remotes {
		name, addr, ok := strings.Cut(r, "=")
		if !ok {
			log.Fatalf("bad --remote %q", r)
		}
		cfg := o.cfg
		cfg.Addr, cfg.Name = addr, name
		cfg.Logf = logger.Printf
		c := remote.New(cfg)
		f := remote.NewFS(c, pol)
		o.remotes = append(o.remotes, computerLink{name: name, fs: f})
	}
	for _, cl := range o.remotes {
		cl.fs.C.Start()
		cl.fs.Start()
	}
	if o.status != "" {
		go serveStatus(o.status, o.remotes)
	}
	logger.Printf("mounting %s (policy %s)", o.mountpoint, pol.Name)
	if err := mount(&o); err != nil {
		logger.Printf("mount: %v", err)
		os.Exit(1)
	}
	logger.Printf("unmounted")
}

func serveStatus(addr string, remotes []computerLink) {
	mux := http.NewServeMux()
	mux.HandleFunc("/stats", func(w http.ResponseWriter, r *http.Request) {
		out := map[string]any{}
		for _, cl := range remotes {
			c := cl.fs.C
			out[cl.name] = map[string]any{
				"online":     c.Online(),
				"requests":   c.Requests.Load(),
				"fastFails":  c.FastFails.Load(),
				"timeouts":   c.Timeouts.Load(),
				"drops":      c.Drops.Load(),
				"reconnects": c.Reconnects.Load(),
				"cacheHits":  cl.fs.Hits.Load(),
				"cacheMiss":  cl.fs.Misses.Load(),
				"prefetches": cl.fs.Prefetches.Load(),
			}
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	})
	if err := http.ListenAndServe(addr, mux); err != nil {
		fmt.Fprintln(os.Stderr, "status:", err)
	}
}
