// Modified for Clover's spike S6 (native/mounts/third_party/README.md): a read that comes back
// shorter than the size the client was given answers NFS3ERR_IO, never a short read.
package nfs

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/willscott/go-nfs-client/nfs/xdr"
)

type nfsReadArgs struct {
	Handle []byte
	Offset uint64
	Count  uint32
}

type nfsReadResponse struct {
	Count uint32
	EOF   uint32
	Data  []byte
}

// MaxRead is the advertised largest buffer the server is willing to read
const MaxRead = 1 << 24

func onRead(ctx context.Context, w *response, userHandle Handler) error {
	w.errorFmt = opAttrErrorFormatter
	var obj nfsReadArgs
	err := xdr.Read(w.req.Body, &obj)
	if err != nil {
		return &NFSStatusError{NFSStatusInval, err}
	}
	fs, path, err := userHandle.FromHandle(obj.Handle)
	if err != nil {
		return &NFSStatusError{NFSStatusStale, err}
	}

	fh, err := fs.Open(fs.Join(path...))
	if err != nil {
		if os.IsNotExist(err) {
			return &NFSStatusError{NFSStatusNoEnt, err}
		}
		return &NFSStatusError{NFSStatusAccess, err}
	}
	defer fh.Close()

	resp := nfsReadResponse{}
	setEOF := false

	fullPath := fs.Join(path...)
	info, err := fs.Stat(fullPath)
	if err != nil {
		return &NFSStatusError{NFSStatusAccess, err}
	}
	if int64(obj.Offset) >= info.Size() {
		obj.Count = 0
		setEOF = true
	} else if info.Size()-int64(obj.Offset) <= int64(obj.Count) {
		obj.Count = uint32(uint64(info.Size()) - obj.Offset)
		setEOF = true
	}
	if obj.Count > MaxRead {
		obj.Count = MaxRead
	}
	resp.Data = make([]byte, obj.Count)
	// todo: multiple reads if size isn't full
	cnt, err := fh.ReadAt(resp.Data, int64(obj.Offset))
	if err != nil && !errors.Is(err, io.EOF) {
		return &NFSStatusError{NFSStatusIO, err}
	}
	resp.Count = uint32(cnt)
	resp.Data = resp.Data[:resp.Count]
	if errors.Is(err, io.EOF) || setEOF {
		resp.EOF = 1
	}
	// A read that came back shorter than the size the client was given means the file shrank
	// since the stat above. macOS's NFS client pads such a reply with zeros up to the size it
	// holds, even when the reply's attributes carry the new one (S6 CI), so it must never see a
	// short read inside the file: answer EIO instead, as Clover's FSKit module does (report §2).
	// The file system has dropped its cached size, so the client's next GETATTR gets the new one.
	if uint32(cnt) < obj.Count {
		return &NFSStatusError{NFSStatusIO, fmt.Errorf("%s shrank under the read: %d of %d bytes", fullPath, cnt, obj.Count)}
	}

	writer := bytes.NewBuffer([]byte{})
	if err := xdr.Write(writer, uint32(NFSStatusOk)); err != nil {
		return &NFSStatusError{NFSStatusServerFault, err}
	}
	if err := WritePostOpAttrs(writer, ToFileAttribute(info, fullPath)); err != nil {
		return &NFSStatusError{NFSStatusServerFault, err}
	}

	if err := xdr.Write(writer, resp); err != nil {
		return &NFSStatusError{NFSStatusServerFault, err}
	}
	if err := w.Write(writer.Bytes()); err != nil {
		return &NFSStatusError{NFSStatusServerFault, err}
	}
	return nil
}
