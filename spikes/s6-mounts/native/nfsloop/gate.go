package nfsloop

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"log"
	"net"
	"sync/atomic"

	"github.com/go-git/go-billy/v5"
	nfs "github.com/willscott/go-nfs"
)

// Gate lets exactly one MOUNT in: the daemon's, with the one-time export path the helper gave it
// over its pipe. NFS on the loopback port has no authentication of its own (AUTH_UNIX is whatever
// the caller says), so this is what keeps other local processes out: they can't learn the path,
// the one MOUNT is used up at once, and without a MOUNT a caller has no root handle to start
// from (the caching handler's handles are random).
type Gate struct {
	nfs.Handler
	path    string
	mounted atomic.Bool
	refused atomic.Int64
}

// NewGate wraps h with a fresh random export path (128 bits).
func NewGate(h nfs.Handler) (*Gate, error) {
	tok := make([]byte, 16)
	if _, err := rand.Read(tok); err != nil {
		return nil, err
	}
	return &Gate{Handler: h, path: "/" + base64.RawURLEncoding.EncodeToString(tok)}, nil
}

// Path is the export path to MOUNT: tell it to the daemon, nobody else.
func (g *Gate) Path() string { return g.path }

// Mounted says whether the one MOUNT has happened.
func (g *Gate) Mounted() bool { return g.mounted.Load() }

// Refused counts the MOUNTs turned away.
func (g *Gate) Refused() int64 { return g.refused.Load() }

// Mount answers the MOUNT procedure: the right path, once.
func (g *Gate) Mount(ctx context.Context, conn net.Conn, req nfs.MountRequest) (nfs.MountStatus, billy.Filesystem, []nfs.AuthFlavor) {
	if subtle.ConstantTimeCompare(req.Dirpath, []byte(g.path)) != 1 || !g.mounted.CompareAndSwap(false, true) {
		n := g.refused.Add(1)
		log.Printf("MOUNT refused (%d so far)", n)
		return nfs.MountStatusErrAcces, nil, nil
	}
	return g.Handler.Mount(ctx, conn, req)
}
