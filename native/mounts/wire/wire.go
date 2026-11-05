// Package wire is the Go side of the clover-tree wire protocol (../PROTOCOL.md).
package wire

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

const (
	Version  = 1
	MaxFrame = 16 << 20
)

// Frame kinds.
const (
	KindHello   = 1
	KindWelcome = 2
	KindReq     = 3
	KindRes     = 4
	KindEvent   = 5
	KindPing    = 6
	KindPong    = 7
)

// Operations.
const (
	OpStat     = 1
	OpList     = 2
	OpTree     = 3
	OpRead     = 4
	OpOpen     = 5
	OpWrite    = 6
	OpClose    = 7
	OpFsync    = 8
	OpSetattr  = 9
	OpMkdir    = 10
	OpUnlink   = 11
	OpRmdir    = 12
	OpRename   = 13
	OpSymlink  = 14
	OpReadlink = 15
	OpStatfs   = 16
	OpLink     = 17
	OpWatch    = 18
	OpSleep    = 19
)

// Event types.
const (
	EventChanged = 1
	EventResync  = 2
)

// File types.
const (
	TypeFile    = 1
	TypeDir     = 2
	TypeSymlink = 3
	TypeOther   = 4
)

// Open flags (Linux values).
const (
	OAccMode = 3
	ORdonly  = 0
	OWronly  = 1
	ORdwr    = 2
	OCreat   = 0x40
	OExcl    = 0x80
	OTrunc   = 0x200
	OAppend  = 0x400
)

// Setattr mask bits.
const (
	SetMode  = 1
	SetSize  = 2
	SetAtime = 4
	SetMtime = 8
)

// Errno is a wire error: a Linux errno number. Zero is success.
type Errno uint16

const (
	OK           Errno = 0
	EPERM        Errno = 1
	ENOENT       Errno = 2
	EINTR        Errno = 4
	EIO          Errno = 5
	EBADF        Errno = 9
	EACCES       Errno = 13
	EBUSY        Errno = 16
	EEXIST       Errno = 17
	EXDEV        Errno = 18
	ENOTDIR      Errno = 20
	EISDIR       Errno = 21
	EINVAL       Errno = 22
	EMFILE       Errno = 24
	ETXTBSY      Errno = 26
	EFBIG        Errno = 27
	ENOSPC       Errno = 28
	EROFS        Errno = 30
	EMLINK       Errno = 31
	ENAMETOOLONG Errno = 36
	ENOTEMPTY    Errno = 39
	ELOOP        Errno = 40
	ENOTSUP      Errno = 95
	ETIMEDOUT    Errno = 110
	EHOSTDOWN    Errno = 112
	ESTALE       Errno = 116
)

var errNames = map[Errno]string{
	OK: "OK", EPERM: "EPERM", ENOENT: "ENOENT", EINTR: "EINTR", EIO: "EIO", EBADF: "EBADF",
	EACCES: "EACCES", EBUSY: "EBUSY", EEXIST: "EEXIST", EXDEV: "EXDEV", ENOTDIR: "ENOTDIR",
	EISDIR: "EISDIR", EINVAL: "EINVAL", EMFILE: "EMFILE", ETXTBSY: "ETXTBSY", EFBIG: "EFBIG",
	ENOSPC: "ENOSPC", EROFS: "EROFS", EMLINK: "EMLINK", ENAMETOOLONG: "ENAMETOOLONG",
	ENOTEMPTY: "ENOTEMPTY", ELOOP: "ELOOP", ENOTSUP: "ENOTSUP", ETIMEDOUT: "ETIMEDOUT",
	EHOSTDOWN: "EHOSTDOWN", ESTALE: "ESTALE",
}

func (e Errno) Error() string {
	if n, ok := errNames[e]; ok {
		return n
	}
	return fmt.Sprintf("errno %d", uint16(e))
}

// Attr is the 65-byte attribute record.
type Attr struct {
	Type    uint8
	Mode    uint32
	Size    uint64
	MtimeNs int64
	CtimeNs int64
	AtimeNs int64
	BirthNs int64
	Ino     uint64
	Nlink   uint32
	Uid     uint32
	Gid     uint32
}

const AttrSize = 65

// Writer builds a frame body. Frame() prefixes the length.
type Writer struct{ b []byte }

func NewWriter(kind uint8, id uint32) *Writer {
	w := &Writer{b: make([]byte, 4, 64)}
	w.U8(kind).U32(id)
	return w
}
func (w *Writer) U8(v uint8) *Writer   { w.b = append(w.b, v); return w }
func (w *Writer) U16(v uint16) *Writer { w.b = binary.LittleEndian.AppendUint16(w.b, v); return w }
func (w *Writer) U32(v uint32) *Writer { w.b = binary.LittleEndian.AppendUint32(w.b, v); return w }
func (w *Writer) U64(v uint64) *Writer { w.b = binary.LittleEndian.AppendUint64(w.b, v); return w }
func (w *Writer) I64(v int64) *Writer  { return w.U64(uint64(v)) }
func (w *Writer) Bytes(p []byte) *Writer {
	w.U32(uint32(len(p)))
	w.b = append(w.b, p...)
	return w
}
func (w *Writer) Str(s string) *Writer {
	w.U32(uint32(len(s)))
	w.b = append(w.b, s...)
	return w
}
func (w *Writer) Attr(a *Attr) *Writer {
	return w.U8(a.Type).U32(a.Mode).U64(a.Size).I64(a.MtimeNs).I64(a.CtimeNs).I64(a.AtimeNs).
		I64(a.BirthNs).U64(a.Ino).U32(a.Nlink).U32(a.Uid).U32(a.Gid)
}

// Frame returns the finished frame, length prefix included.
func (w *Writer) Frame() []byte {
	binary.LittleEndian.PutUint32(w.b[0:4], uint32(len(w.b)-4))
	return w.b
}

var ErrShort = errors.New("wire: short frame")

// Reader decodes a frame body. The first error sticks; check Err() at the end.
type Reader struct {
	b   []byte
	off int
	err error
}

func NewReader(body []byte) *Reader { return &Reader{b: body} }

func (r *Reader) need(n int) bool {
	if r.err != nil {
		return false
	}
	if r.off+n > len(r.b) {
		r.err = ErrShort
		return false
	}
	return true
}
func (r *Reader) Err() error { return r.err }
func (r *Reader) U8() uint8 {
	if !r.need(1) {
		return 0
	}
	v := r.b[r.off]
	r.off++
	return v
}
func (r *Reader) U16() uint16 {
	if !r.need(2) {
		return 0
	}
	v := binary.LittleEndian.Uint16(r.b[r.off:])
	r.off += 2
	return v
}
func (r *Reader) U32() uint32 {
	if !r.need(4) {
		return 0
	}
	v := binary.LittleEndian.Uint32(r.b[r.off:])
	r.off += 4
	return v
}
func (r *Reader) U64() uint64 {
	if !r.need(8) {
		return 0
	}
	v := binary.LittleEndian.Uint64(r.b[r.off:])
	r.off += 8
	return v
}
func (r *Reader) I64() int64 { return int64(r.U64()) }

// Bytes returns a slice into the frame (valid while the frame is).
func (r *Reader) Bytes() []byte {
	n := int(r.U32())
	if !r.need(n) {
		return nil
	}
	v := r.b[r.off : r.off+n]
	r.off += n
	return v
}
func (r *Reader) Str() string { return string(r.Bytes()) }
func (r *Reader) Attr(a *Attr) {
	a.Type = r.U8()
	a.Mode = r.U32()
	a.Size = r.U64()
	a.MtimeNs = r.I64()
	a.CtimeNs = r.I64()
	a.AtimeNs = r.I64()
	a.BirthNs = r.I64()
	a.Ino = r.U64()
	a.Nlink = r.U32()
	a.Uid = r.U32()
	a.Gid = r.U32()
}

// ReadFrame reads one frame body (without the length prefix).
func ReadFrame(rd io.Reader, hdr []byte) ([]byte, error) {
	if _, err := io.ReadFull(rd, hdr[:4]); err != nil {
		return nil, err
	}
	n := binary.LittleEndian.Uint32(hdr[:4])
	if n > MaxFrame {
		return nil, fmt.Errorf("wire: frame of %d bytes is too large", n)
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(rd, body); err != nil {
		return nil, err
	}
	return body, nil
}
