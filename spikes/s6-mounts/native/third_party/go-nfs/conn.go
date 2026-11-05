// Modified for Clover's spike S6 (spikes/s6-mounts/native/third_party/README.md): a computer that is offline
// answers NFS3ERR_IO, whatever status the handler chose (offlineAsIO); the requests of one
// connection are handled concurrently, writes in line (serve, readRequestHeader); and every NFS
// procedure served is counted (Calls, CallNanos).
package nfs

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync/atomic"
	"syscall"
	"time"

	xdr2 "github.com/rasky/go-xdr/xdr2"
	"github.com/willscott/go-nfs-client/nfs/rpc"
	"github.com/willscott/go-nfs-client/nfs/xdr"
)

var (
	// ErrInputInvalid is returned when input cannot be parsed
	ErrInputInvalid = errors.New("invalid input")
	// ErrAlreadySent is returned when writing a header/status multiple times
	ErrAlreadySent = errors.New("response already started")
)

// ResponseCode is a combination of accept_stat and reject_stat.
type ResponseCode uint32

// ResponseCode Codes
const (
	ResponseCodeSuccess ResponseCode = iota
	ResponseCodeProgUnavailable
	ResponseCodeProcUnavailable
	ResponseCodeGarbageArgs
	ResponseCodeSystemErr
	ResponseCodeRPCMismatch
	ResponseCodeAuthError
)

type conn struct {
	*Server
	writeSerializer chan []byte
	net.Conn
}

func (c *conn) serve(ctx context.Context) {
	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	c.writeSerializer = make(chan []byte, 1)
	go c.serializeWrites(connCtx)

	// Clover: a kernel client sends all of a mount's calls over one connection. Upstream handled
	// them one after another, so a read waiting on the far computer held up every lookup behind
	// it. Each request now runs on its own goroutine, at most maxInflight at a time; replies go
	// out through writeSerializer as before, each whole, in the order they finish.
	//
	// WRITE and COMMIT still run in line, as upstream ran everything, so a lookup can wait behind
	// one write. With writes concurrent, macOS's client let a writer run on for 18-29 s after the
	// far computer dropped before it reported the error. A queue of their own, with the loop
	// reading on (review S5), did the same: 18-29 s, because the loop then takes every write the
	// client sends and the client never feels the far computer slow down. In line, the writer
	// meets the drop within the link's bound.
	const maxInflight = 64
	sem := make(chan struct{}, maxInflight)
	bio := bufio.NewReader(c.Conn)
	for {
		w, err := c.readRequestHeader(connCtx, bio)
		if err != nil {
			if err == io.EOF {
				// Clean close.
				c.Close()
				return
			}
			return
		}
		if h := w.req.Header; h.Prog == nfsServiceID && (h.Proc == uint32(NFSProcedureWrite) || h.Proc == uint32(NFSProcedureCommit)) {
			if !c.serveOne(connCtx, w) {
				return
			}
			continue
		}
		select {
		case sem <- struct{}{}:
		case <-connCtx.Done():
			return
		}
		go func(w *response) {
			defer func() { <-sem }()
			c.serveOne(connCtx, w)
		}(w)
	}
}

// Calls counts the NFS procedures served, indexed by NFSProcedure, and CallNanos sums the time
// spent handling each (Clover: the spike's per-workload counts).
var (
	Calls     [NFSProcedureCommit + 1]atomic.Int64
	CallNanos [NFSProcedureCommit + 1]atomic.Int64
)

// serveOne handles one request and sends its reply. It closes the connection and answers false
// when the connection can't go on.
func (c *conn) serveOne(ctx context.Context, w *response) bool {
	Log.Tracef("request: %v", w.req)
	start := time.Now()
	err := c.handle(ctx, w)
	if h := w.req.Header; h.Prog == nfsServiceID && h.Proc <= uint32(NFSProcedureCommit) {
		Calls[h.Proc].Add(1)
		CallNanos[h.Proc].Add(int64(time.Since(start)))
	}
	respErr := w.finish(ctx)
	if err != nil {
		Log.Errorf("error handling req: %v", err)
		// failure to handle at a level needing to close the connection.
		c.Close()
		return false
	}
	if respErr != nil {
		Log.Errorf("error sending response: %v", respErr)
		c.Close()
		return false
	}
	return true
}

func (c *conn) serializeWrites(ctx context.Context) {
	// todo: maybe don't need the extra buffer
	writer := bufio.NewWriter(c.Conn)
	var fragmentBuf [4]byte
	var fragmentInt uint32
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-c.writeSerializer:
			if !ok {
				return
			}
			// prepend the fragmentation header
			fragmentInt = uint32(len(msg))
			fragmentInt |= (1 << 31)
			binary.BigEndian.PutUint32(fragmentBuf[:], fragmentInt)
			n, err := writer.Write(fragmentBuf[:])
			if n < 4 || err != nil {
				return
			}
			n, err = writer.Write(msg)
			if err != nil {
				return
			}
			if n < len(msg) {
				panic("todo: ensure writes complete fully.")
			}
			if err = writer.Flush(); err != nil {
				return
			}
		}
	}
}

// Handle a request. errors from this method indicate a failure to read or
// write on the network stream, and trigger a disconnection of the connection.
func (c *conn) handle(ctx context.Context, w *response) error {
	handler := c.Server.handlerFor(w.req.Header.Prog, w.req.Header.Proc)
	if handler == nil {
		Log.Errorf("No handler for %d.%d", w.req.Header.Prog, w.req.Header.Proc)
		if err := w.drain(ctx); err != nil {
			return err
		}
		return c.err(ctx, w, &ResponseCodeProcUnavailableError{})
	}
	appError := handler(ctx, w, c.Server.Handler)
	if drainErr := w.drain(ctx); drainErr != nil {
		return drainErr
	}
	if appError != nil && !w.responded {
		if err := c.err(ctx, w, appError); err != nil {
			return err
		}
	}
	if !w.responded {
		Log.Errorf("Handler did not indicate response status via writing or erroring")
		if err := c.err(ctx, w, &ResponseCodeSystemError{}); err != nil {
			return err
		}
	}
	return nil
}

func (c *conn) err(ctx context.Context, w *response, err error) error {
	select {
	case <-ctx.Done():
		return nil
	default:
	}

	if w.err == nil {
		w.err = err
	}

	if w.responded {
		return nil
	}

	err = offlineAsIO(err)
	rpcErr := w.errorFmt(err)
	if writeErr := w.writeHeader(rpcErr.Code()); writeErr != nil {
		return writeErr
	}

	body, _ := rpcErr.MarshalBinary()
	return w.Write(body)
}

type request struct {
	xid uint32
	rpc.Header
	Body io.Reader
}

func (r *request) String() string {
	if r.Header.Prog == nfsServiceID {
		return fmt.Sprintf("RPC #%d (nfs.%s)", r.xid, NFSProcedure(r.Header.Proc))
	} else if r.Header.Prog == mountServiceID {
		return fmt.Sprintf("RPC #%d (mount.%s)", r.xid, MountProcedure(r.Header.Proc))
	}
	return fmt.Sprintf("RPC #%d (%d.%d)", r.xid, r.Header.Prog, r.Header.Proc)
}

type response struct {
	*conn
	writer    *bytes.Buffer
	responded bool
	err       error
	errorFmt  func(error) RPCError
	req       *request
}

func (w *response) writeXdrHeader() error {
	err := xdr.Write(w.writer, &w.req.xid)
	if err != nil {
		return err
	}
	respType := uint32(1)
	err = xdr.Write(w.writer, &respType)
	if err != nil {
		return err
	}
	return nil
}

func (w *response) writeHeader(code ResponseCode) error {
	if w.responded {
		return ErrAlreadySent
	}
	w.responded = true
	if err := w.writeXdrHeader(); err != nil {
		return err
	}

	status := rpc.MsgAccepted
	if code == ResponseCodeAuthError || code == ResponseCodeRPCMismatch {
		status = rpc.MsgDenied
	}

	err := xdr.Write(w.writer, &status)
	if err != nil {
		return err
	}

	if status == rpc.MsgAccepted {
		// Write opaque_auth header.
		err = xdr.Write(w.writer, &rpc.AuthNull)
		if err != nil {
			return err
		}
	}

	return xdr.Write(w.writer, &code)
}

// Write a response to an xdr message
func (w *response) Write(dat []byte) error {
	if !w.responded {
		if err := w.writeHeader(ResponseCodeSuccess); err != nil {
			return err
		}
	}

	acc := 0
	for acc < len(dat) {
		n, err := w.writer.Write(dat[acc:])
		if err != nil {
			return err
		}
		acc += n
	}
	return nil
}

// drain reads the rest of the request frame if not consumed by the handler.
func (w *response) drain(ctx context.Context) error {
	if reader, ok := w.req.Body.(*io.LimitedReader); ok {
		if reader.N == 0 {
			return nil
		}
		// todo: wrap body in a context reader.
		_, err := io.CopyN(io.Discard, w.req.Body, reader.N)
		if err == nil || err == io.EOF {
			return nil
		}
		return err
	}
	return io.ErrUnexpectedEOF
}

func (w *response) finish(ctx context.Context) error {
	select {
	case w.conn.writeSerializer <- w.writer.Bytes():
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *conn) readRequestHeader(ctx context.Context, reader *bufio.Reader) (w *response, err error) {
	fragment, err := xdr.ReadUint32(reader)
	if err != nil {
		if xdrErr, ok := err.(*xdr2.UnmarshalError); ok {
			if xdrErr.Err == io.EOF {
				return nil, io.EOF
			}
		}
		return nil, err
	}
	if fragment&(1<<31) == 0 {
		Log.Warnf("Warning: haven't implemented fragment reconstruction.\n")
		return nil, ErrInputInvalid
	}
	reqLen := fragment - uint32(1<<31)
	if reqLen < 40 {
		return nil, ErrInputInvalid
	}

	// Clover: read the whole record first, so the next request can be read while this one is
	// handled (serve).
	body := make([]byte, reqLen)
	if _, err := io.ReadFull(reader, body); err != nil {
		return nil, err
	}
	r := io.LimitedReader{R: bytes.NewReader(body), N: int64(reqLen)}

	xid, err := xdr.ReadUint32(&r)
	if err != nil {
		return nil, err
	}
	reqType, err := xdr.ReadUint32(&r)
	if err != nil {
		return nil, err
	}
	if reqType != 0 { // 0 = request, 1 = response
		return nil, ErrInputInvalid
	}

	req := request{
		xid,
		rpc.Header{},
		&r,
	}
	if err = xdr.Read(&r, &req.Header); err != nil {
		return nil, err
	}

	w = &response{
		conn:     c,
		req:      &req,
		errorFmt: basicErrorFormatter,
		// TODO: use a pool for these.
		writer: bytes.NewBuffer([]byte{}),
	}
	return w, nil
}

// offlineAsIO turns any error that comes from an unreachable computer (EHOSTDOWN, EHOSTUNREACH,
// ETIMEDOUT) into NFS3ERR_IO. Left alone, handlers report it as NFS3ERR_ACCES or NFS3ERR_NOENT,
// and the client caches a missing name until the directory changes.
func offlineAsIO(err error) error {
	if errors.Is(err, syscall.EHOSTDOWN) || errors.Is(err, syscall.EHOSTUNREACH) || errors.Is(err, syscall.ETIMEDOUT) {
		return &NFSStatusError{NFSStatusIO, err}
	}
	return err
}
