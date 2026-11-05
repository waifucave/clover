//go:build windows

package main

import (
	"errors"
	"os"
	"os/signal"
	"strings"

	"github.com/waifucave/clover/native/mounts/winfsp"
)

func mount(o *options) error {
	t := &winfsp.Tree{Policy: o.policy}
	for _, s := range o.self {
		name, path, _ := strings.Cut(s, "=")
		t.Computers = append(t.Computers, &winfsp.Computer{Name: name, Self: path})
	}
	for _, r := range o.remotes {
		t.Computers = append(t.Computers, &winfsp.Computer{Name: r.name, FS: r.fs})
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	go func() {
		<-sig
		if t.Host != nil {
			t.Host.Unmount()
		}
	}()
	if !winfsp.Mount(o.mountpoint, t, o.debug) {
		return errors.New("WinFsp refused the mount (is WinFsp installed, and the drive letter free?)")
	}
	return nil
}
