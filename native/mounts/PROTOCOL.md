# clover-tree wire protocol, version 1 (spike S6)

The mount helper on one computer talks to the file service on the computer that
holds the files. In the spike they meet over one TCP connection (the fake link);
in Clover the same frames ride the device link (spec §8.2), one QUIC stream per
direction. Three implementations exist: TypeScript (the file service,
`spikes/s6-mounts/server/wire.ts`), Go (`native/mounts/wire`) and Swift
(`native/mounts/macos/CloverTreeFS/Wire.swift`).

All integers are little-endian. `str` is a `u32` byte length then UTF-8.
`bytes` is a `u32` length then raw bytes.

## Frames

```
u32 length            bytes after this field, at most 16 MiB
u8  kind
u32 id                request id (REQ/RES), sequence (PING/PONG), else 0
...  payload
```

| kind | name | direction | payload |
| :- | :- | :- | :- |
| 1 | HELLO | helper → service | `u32 version`, `str client`, `u8 flags` (1 = watch) |
| 2 | WELCOME | service → helper | `u32 version`, `str instance`, `str os`, `u8 caseSensitive`, `u8 watching` |
| 3 | REQ | helper → service | `u8 op`, then the op's arguments |
| 4 | RES | service → helper | `u16 err`, then the op's results when `err` is 0 |
| 5 | EVENT | service → helper | `u8 type`, `str path` |
| 6 | PING | either | none |
| 7 | PONG | either | none (echoes the PING's id) |

`instance` changes every time the service starts, so the helper knows its open
handles and caches died with the old one. Responses may arrive in any order.

**Watching from the first byte.** A helper that caches sets the watch flag in
HELLO, and the service subscribes the connection before it sends WELCOME, so
every change after WELCOME is reported and there is no window between going
online and a separate WATCH in which a lookup could be cached without events
(review round 2). `watching` says the service did. WATCH still turns events on
or off later.

**Liveness.** Any inbound frame counts as proof the link is alive. The helper
sends a PING every `pingEvery` (250 ms); if nothing at all has arrived for
`deadAfter` (1.5 s) the helper declares the computer offline: it closes the
connection, fails every pending request with `EHOSTDOWN`, answers every new
request with `EHOSTDOWN` at once, and redials in the background. A request
also fails with `ETIMEDOUT` after `opTimeout` (10 s) even on a live link.

## Attributes (65 bytes)

```
u8  type      1 file, 2 directory, 3 symlink, 4 other
u32 mode      permission bits (0o7777)
u64 size
i64 mtimeNs   i64 ctimeNs   i64 atimeNs   i64 birthNs
u64 ino       the holder's own inode number (passed through, so git's index stays valid)
u32 nlink     u32 uid     u32 gid
```

## Operations

Paths are relative to the exported folder, `/`-separated, with no leading
slash; `""` is the folder itself. The service refuses `..`, `.`, empty
components and NUL with `EINVAL`.

| op | name | arguments | results |
| :- | :- | :- | :- |
| 1 | STAT | `str path` | `Attr` |
| 2 | LIST | `str path` | `u32 n`, n × (`str name`, `Attr`) |
| 3 | TREE | `str path`, `u32 maxEntries` | `u32 dirs`, dirs × (`str dir`, `u32 n`, n × (`str name`, `Attr`)) |
| 4 | READ | `str path`, `u64 handle`, `u64 offset`, `u32 length` | `bytes data` (short at end of file) |
| 5 | OPEN | `str path`, `u32 flags`, `u32 mode` | `u64 handle`, `Attr` |
| 6 | WRITE | `str path`, `u64 handle`, `u64 offset`, `bytes data` | `u32 written` |
| 7 | CLOSE | `u64 handle` | — |
| 8 | FSYNC | `str path`, `u64 handle` | — |
| 9 | SETATTR | `str path`, `u64 handle`, `u32 mask`, `u32 mode`, `u64 size`, `i64 atimeNs`, `i64 mtimeNs` | `Attr` |
| 10 | MKDIR | `str path`, `u32 mode` | `Attr` |
| 11 | UNLINK | `str path` | — |
| 12 | RMDIR | `str path` | — |
| 13 | RENAME | `str from`, `str to`, `u32 flags` | — |
| 14 | SYMLINK | `str path`, `str target` | `Attr` |
| 15 | READLINK | `str path` | `str target` |
| 16 | STATFS | — | `u64 bsize`, `u64 blocks`, `u64 bfree`, `u64 bavail`, `u64 files`, `u64 ffree` |
| 17 | LINK | `str from`, `str to` | `Attr` |
| 18 | WATCH | `u8 on` | — |
| 19 | SLEEP | `u32 ms` | — (test only, refused unless the service runs with `--test-ops`) |

* **TREE** lists `path` and then its subdirectories breadth first, each one
  complete, until about `maxEntries` entries have been sent. A directory that
  is missing from the answer was not listed; the helper lists it when needed.
  Symlinked directories are not followed.
* **READ with handle 0** is stateless: the service reads by path (from a small
  cache of read-only descriptors). Writes go through OPEN handles.
* **A stale handle** (unknown to this service instance) answers `ESTALE`; the
  helper reopens by path without `O_CREAT|O_EXCL|O_TRUNC` and retries once.
* **OPEN flags** use Linux values: access mode 0/1/2, `O_CREAT` 0x40,
  `O_EXCL` 0x80, `O_TRUNC` 0x200, `O_APPEND` 0x400.
* **SETATTR mask:** 1 mode, 2 size, 4 atime, 8 mtime.
* **RENAME flags:** 1 no-replace, 2 exchange.

## Events

`EVENT` type 1 (`CHANGED`) says something at `path` was created, removed,
renamed or modified; the helper drops what it cached for `path` and for its
parent's listing, and tells its kernel. Type 2 (`RESYNC`) says events were lost;
the helper drops everything. The helper also drops everything after any
reconnect, because changes made while it was away were not seen.

## Errors

`err` is a Linux errno number: 1 EPERM, 2 ENOENT, 4 EINTR, 5 EIO, 9 EBADF,
13 EACCES, 16 EBUSY, 17 EEXIST, 18 EXDEV, 20 ENOTDIR, 21 EISDIR, 22 EINVAL,
24 EMFILE, 26 ETXTBSY, 27 EFBIG, 28 ENOSPC, 30 EROFS, 31 EMLINK,
36 ENAMETOOLONG, 39 ENOTEMPTY, 40 ELOOP, 95 ENOTSUP, 110 ETIMEDOUT,
112 EHOSTDOWN, 116 ESTALE. Each side maps them to its own platform's codes.
