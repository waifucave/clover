// Modified for Clover's spike S6 (native/mounts/third_party/README.md): a refused MOUNT answers
// without a root handle.
package nfs

import (
	"bytes"
	"context"

	"github.com/willscott/go-nfs-client/nfs/xdr"
)

const (
	mountServiceID = 100005
)

func init() {
	_ = RegisterMessageHandler(mountServiceID, uint32(MountProcNull), onMountNull)
	_ = RegisterMessageHandler(mountServiceID, uint32(MountProcMount), onMount)
	_ = RegisterMessageHandler(mountServiceID, uint32(MountProcUmnt), onUMount)
}

func onMountNull(ctx context.Context, w *response, userHandle Handler) error {
	return w.writeHeader(ResponseCodeSuccess)
}

func onMount(ctx context.Context, w *response, userHandle Handler) error {
	// TODO: auth check.
	dirpath, err := xdr.ReadOpaque(w.req.Body)
	if err != nil {
		return err
	}
	mountReq := MountRequest{Header: w.req.Header, Dirpath: dirpath}
	status, handle, flavors := userHandle.Mount(ctx, w.conn, mountReq)

	if err := w.writeHeader(ResponseCodeSuccess); err != nil {
		return err
	}

	writer := bytes.NewBuffer([]byte{})
	if err := xdr.Write(writer, uint32(status)); err != nil {
		return err
	}

	// Clover: a refused MOUNT has no file system to hand out; upstream made a handle for it
	// anyway and crashed on the nil file system.
	if status == MountStatusOk {
		_ = xdr.Write(writer, userHandle.ToHandle(handle, []string{}))
		_ = xdr.Write(writer, flavors)
	}
	return w.Write(writer.Bytes())
}

func onUMount(ctx context.Context, w *response, userHandle Handler) error {
	_, err := xdr.ReadOpaque(w.req.Body)
	if err != nil {
		return err
	}

	return w.writeHeader(ResponseCodeSuccess)
}
