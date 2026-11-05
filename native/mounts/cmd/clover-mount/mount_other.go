//go:build !linux && !windows && !(darwin && cgo)

package main

import "errors"

func mount(o *options) error {
	return errors.New("on macOS the tree is served by the FSKit module (native/mounts/macos)")
}
