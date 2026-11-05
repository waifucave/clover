//go:build linux

package main

import (
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"

	"github.com/waifucave/clover/native/mounts/fuselinux"
)

func mount(o *options) error {
	t := &fuselinux.Tree{Policy: o.policy, Owner: o.owner}
	for _, s := range o.self {
		name, path, _ := strings.Cut(s, "=")
		t.Computers = append(t.Computers, &fuselinux.Computer{Name: name, Self: path})
	}
	for _, r := range o.remotes {
		t.Computers = append(t.Computers, &fuselinux.Computer{Name: r.name, FS: r.fs})
	}
	srv, err := fuselinux.Mount(o.mountpoint, t, o.debug)
	if err != nil {
		return err
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		if err := srv.Unmount(); err != nil {
			// Busy: detach lazily so the helper can exit and never leaves a dead mount behind.
			_ = exec.Command("fusermount3", "-u", "-z", o.mountpoint).Run()
			os.Exit(0)
		}
	}()
	srv.Wait()
	return nil
}
