// clover-tree wire protocol v1 — the TypeScript side (native/mounts/PROTOCOL.md).

export const VERSION = 1;
export const MAX_FRAME = 16 * 1024 * 1024;

export const Kind = { HELLO: 1, WELCOME: 2, REQ: 3, RES: 4, EVENT: 5, PING: 6, PONG: 7 } as const;

export const Op = {
  STAT: 1, LIST: 2, TREE: 3, READ: 4, OPEN: 5, WRITE: 6, CLOSE: 7, FSYNC: 8, SETATTR: 9,
  MKDIR: 10, UNLINK: 11, RMDIR: 12, RENAME: 13, SYMLINK: 14, READLINK: 15, STATFS: 16,
  LINK: 17, WATCH: 18, SLEEP: 19,
} as const;

export const Err = {
  OK: 0, EPERM: 1, ENOENT: 2, EINTR: 4, EIO: 5, EBADF: 9, EACCES: 13, EBUSY: 16, EEXIST: 17,
  EXDEV: 18, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, EMFILE: 24, ETXTBSY: 26, EFBIG: 27,
  ENOSPC: 28, EROFS: 30, EMLINK: 31, ENAMETOOLONG: 36, ENOTEMPTY: 39, ELOOP: 40,
  ENOTSUP: 95, ETIMEDOUT: 110, EHOSTDOWN: 112, ESTALE: 116,
} as const;

/** Node error codes to wire errors. Anything unknown is EIO. */
export function errFromCode(code: string | undefined): number {
  switch (code) {
    case "EPERM": return Err.EPERM;
    case "ENOENT": return Err.ENOENT;
    case "EINTR": return Err.EINTR;
    case "EBADF": return Err.EBADF;
    case "EACCES": return Err.EACCES;
    case "EBUSY": return Err.EBUSY;
    case "EEXIST": return Err.EEXIST;
    case "EXDEV": return Err.EXDEV;
    case "ENOTDIR": return Err.ENOTDIR;
    case "EISDIR": return Err.EISDIR;
    case "EINVAL": return Err.EINVAL;
    case "EMFILE": case "ENFILE": return Err.EMFILE;
    case "ETXTBSY": return Err.ETXTBSY;
    case "EFBIG": return Err.EFBIG;
    case "ENOSPC": return Err.ENOSPC;
    case "EROFS": return Err.EROFS;
    case "EMLINK": return Err.EMLINK;
    case "ENAMETOOLONG": return Err.ENAMETOOLONG;
    case "ENOTEMPTY": return Err.ENOTEMPTY;
    case "ELOOP": return Err.ELOOP;
    case "ENOTSUP": case "EOPNOTSUPP": case "ENOSYS": return Err.ENOTSUP;
    default: return Err.EIO;
  }
}

export const EventType = { CHANGED: 1, RESYNC: 2 } as const;

export const FileType = { FILE: 1, DIR: 2, SYMLINK: 3, OTHER: 4 } as const;

export interface Attr {
  type: number;
  mode: number;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  atimeNs: bigint;
  birthNs: bigint;
  ino: bigint;
  nlink: number;
  uid: number;
  gid: number;
}

export const ATTR_SIZE = 65;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** A growable little-endian writer. */
export class Writer {
  buf: Uint8Array;
  view: DataView;
  len = 0;
  constructor(cap = 256) {
    this.buf = new Uint8Array(cap);
    this.view = new DataView(this.buf.buffer);
  }
  private room(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number) { this.room(1); this.view.setUint8(this.len, v); this.len += 1; return this; }
  u16(v: number) { this.room(2); this.view.setUint16(this.len, v, true); this.len += 2; return this; }
  u32(v: number) { this.room(4); this.view.setUint32(this.len, v >>> 0, true); this.len += 4; return this; }
  u64(v: bigint) { this.room(8); this.view.setBigUint64(this.len, BigInt.asUintN(64, v), true); this.len += 8; return this; }
  i64(v: bigint) { this.room(8); this.view.setBigInt64(this.len, BigInt.asIntN(64, v), true); this.len += 8; return this; }
  bytes(b: Uint8Array) { this.u32(b.length); this.room(b.length); this.buf.set(b, this.len); this.len += b.length; return this; }
  str(s: string) { return this.bytes(enc.encode(s)); }
  attr(a: Attr) {
    this.room(ATTR_SIZE);
    this.u8(a.type).u32(a.mode).u64(a.size).i64(a.mtimeNs).i64(a.ctimeNs).i64(a.atimeNs)
      .i64(a.birthNs).u64(a.ino).u32(a.nlink).u32(a.uid).u32(a.gid);
    return this;
  }
  /** Prefix the body with its frame length and return the frame. */
  frame(): Uint8Array {
    const out = new Uint8Array(4 + this.len);
    new DataView(out.buffer).setUint32(0, this.len, true);
    out.set(this.buf.subarray(0, this.len), 4);
    return out;
  }
}

export class Reader {
  off = 0;
  view: DataView;
  constructor(public buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  private need(n: number) {
    if (this.off + n > this.buf.length) throw new RangeError("short frame");
  }
  remaining() { return this.buf.length - this.off; }
  u8() { this.need(1); return this.view.getUint8(this.off++); }
  u16() { this.need(2); const v = this.view.getUint16(this.off, true); this.off += 2; return v; }
  u32() { this.need(4); const v = this.view.getUint32(this.off, true); this.off += 4; return v; }
  u64() { this.need(8); const v = this.view.getBigUint64(this.off, true); this.off += 8; return v; }
  i64() { this.need(8); const v = this.view.getBigInt64(this.off, true); this.off += 8; return v; }
  bytes() { const n = this.u32(); this.need(n); const b = this.buf.subarray(this.off, this.off + n); this.off += n; return b; }
  str() { return dec.decode(this.bytes()); }
  attr(): Attr {
    return {
      type: this.u8(), mode: this.u32(), size: this.u64(), mtimeNs: this.i64(), ctimeNs: this.i64(),
      atimeNs: this.i64(), birthNs: this.i64(), ino: this.u64(), nlink: this.u32(), uid: this.u32(),
      gid: this.u32(),
    };
  }
}

/** Splits a byte stream into frame bodies (without the length prefix). */
export class FrameSplitter {
  private chunks: Uint8Array[] = [];
  private have = 0;
  push(chunk: Uint8Array, onFrame: (body: Uint8Array) => void) {
    this.chunks.push(chunk);
    this.have += chunk.length;
    for (;;) {
      if (this.have < 4) return;
      const head = this.peek(4);
      const len = new DataView(head.buffer, head.byteOffset, 4).getUint32(0, true);
      if (len > MAX_FRAME) throw new RangeError(`frame of ${len} bytes is too large`);
      if (this.have < 4 + len) return;
      const all = this.take(4 + len);
      onFrame(all.subarray(4));
    }
  }
  private peek(n: number): Uint8Array {
    const first = this.chunks[0]!;
    if (first.length >= n) return first.subarray(0, n);
    return this.flatten().subarray(0, n);
  }
  private take(n: number): Uint8Array {
    let first = this.chunks[0]!;
    if (first.length < n) first = this.flatten();
    const out = first.subarray(0, n);
    const rest = first.subarray(n);
    if (rest.length) this.chunks[0] = rest; else this.chunks.shift();
    this.have -= n;
    return out;
  }
  private flatten(): Uint8Array {
    const all = new Uint8Array(this.have);
    let o = 0;
    for (const c of this.chunks) { all.set(c, o); o += c.length; }
    this.chunks = [all];
    return all;
  }
}
