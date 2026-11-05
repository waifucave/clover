//go:build windows || (darwin && cgo)

package main

import (
	"errors"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/waifucave/clover/native/mounts/cgofs"
)

func mount(o *options) error {
	t := &cgofs.Tree{Policy: o.policy}
	for _, s := range o.self {
		name, path, _ := strings.Cut(s, "=")
		t.Computers = append(t.Computers, &cgofs.Computer{Name: name, Self: path})
	}
	for _, r := range o.remotes {
		t.Computers = append(t.Computers, &cgofs.Computer{Name: r.name, FS: r.fs})
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		if t.Host != nil {
			t.Host.Unmount()
		}
	}()
	if !cgofs.Mount(o.mountpoint, t, o.debug) {
		return errors.New("the FUSE layer refused the mount (WinFsp installed and the drive letter free? macFUSE installed?)")
	}
	return nil
}
