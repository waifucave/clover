module github.com/waifucave/clover/native/mounts

go 1.24

require (
	github.com/go-git/go-billy/v5 v5.6.0
	github.com/hanwen/go-fuse/v2 v2.12.1
	github.com/willscott/go-nfs v0.0.4
	github.com/willscott/go-nfs-client v0.0.0-20240104095149-b44639837b00
	github.com/winfsp/cgofuse v1.6.0
)

require (
	github.com/google/uuid v1.6.0 // indirect
	github.com/hashicorp/golang-lru/v2 v2.0.7 // indirect
	github.com/rasky/go-xdr v0.0.0-20170124162913-1a41d1a06c93 // indirect
	golang.org/x/sys v0.28.0 // indirect
)

// go-nfs with four patches for the macOS loopback (third_party/README.md)
replace github.com/willscott/go-nfs => ./third_party/go-nfs
