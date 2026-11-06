// Check-then-open without the gap (#205's S7). A path the fence allowed can be swapped for a link between the check
// and the open, so a caller that reads or writes a file for a bot, an agent or a plugin (B's file tools, memory sync,
// transcripts under `bots/`) opens it here instead:
//   1. the fence judges the path as given;
//   2. it is opened without following a link at its last component (O_NOFOLLOW on macOS and Linux), never
//      truncated, and never created through a link: a write opens the file as it is, and creates it atomically only
//      when asked (`exclusive`: `O_CREAT|O_EXCL`, so a planted name fails with EEXIST instead of being reused);
//   3. the opened file's real path is read back from the handle (macOS `proc_pidfdinfo`'s vnode path, Linux
//      `/proc/self/fd`, Windows `GetFinalPathNameByHandleW` on a handle shown to be the same file) and judged again;
//   4. only then is it truncated, if asked, and handed back. Refused at 2 or 3: closed, and a file it just created
//      is removed.
// Callers must use this (or `readChecked` / `writeChecked`) for every file access the fence judges; `fence.check`
// alone is advice, not a lock.
import { closeSync, constants, fstatSync, ftruncateSync, openSync, readFileSync, readlinkSync, unlinkSync, writeSync } from "node:fs";
import type { FenceOp, FenceVerdict } from "../contracts/fence";
import { ffiLib, ffiPtr as ptr } from "../platform/ffi";

export class FenceRefused extends Error {
  constructor(readonly verdict: Exclude<FenceVerdict, { allowed: true }>, readonly at: string) {
    super(`the fence refuses ${at}: ${verdict.reason}`);
    this.name = "FenceRefused";
  }
}

export interface Judge { check(op: FenceOp): FenceVerdict }

/** The real path of an open file, from its handle; null when the OS won't say. */
/** `path`: the path just opened (Windows needs it, see below). */
export function fdRealPath(fd: number, platform: NodeJS.Platform = process.platform, path?: string): string | null {
  if (platform === "linux") { try { return readlinkSync(`/proc/self/fd/${fd}`); } catch { return null; } }
  if (platform === "darwin") {
    const l = ffiLib("open-checked-darwin", "/usr/lib/libSystem.B.dylib", { proc_pidfdinfo: { args: ["i32", "i32", "i32", "ptr", "i32"], returns: "i32" } });
    if (!l) return null;
    // PROC_PIDFDVNODEPATHINFO: struct vnode_fdinfowithpath, 1200 bytes, the path at 176 (measured on macOS 26).
    const b = Buffer.alloc(1200);
    if ((l.proc_pidfdinfo!(process.pid, fd, 2, ptr(b), b.length) as number) !== b.length) return null;
    const end = b.indexOf(0, 176);
    return end > 176 ? b.subarray(176, end).toString("utf8") : null;
  }
  if (platform === "win32") {
    // Bun's descriptors aren't the C runtime's, so the handle is taken by opening `path` again, and believed only when
    // it is the same file as the descriptor (the volume's serial and the file's index, against fstat's dev and ino).
    if (path === undefined) return null;
    const k = ffiLib("open-checked-k32", "kernel32.dll", {
      CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
      GetFileInformationByHandle: { args: ["u64", "ptr"], returns: "i32" },
      GetFinalPathNameByHandleW: { args: ["u64", "ptr", "u32", "u32"], returns: "u32" },
      CloseHandle: { args: ["u64"], returns: "i32" },
    });
    if (!k) return null;
    let st: ReturnType<typeof fstatSync>;
    try { st = fstatSync(fd, { bigint: true }) as unknown as ReturnType<typeof fstatSync>; } catch { return null; }
    const wide = Buffer.from(`${path}\0`, "utf16le");
    // No access asked (attributes only), every sharing mode, FILE_FLAG_BACKUP_SEMANTICS so a folder opens too.
    const h = BigInt(k.CreateFileW!(ptr(wide), 0, 7, null, 3 /* OPEN_EXISTING */, 0x02000000, 0n) as number | bigint);
    if (h === 0n || h === 0xffffffffffffffffn) return null;
    try {
      const info = Buffer.alloc(52); // BY_HANDLE_FILE_INFORMATION
      if ((k.GetFileInformationByHandle!(h, ptr(info)) as number) === 0) return null;
      const serial = BigInt(info.readUInt32LE(28));
      const index = (BigInt(info.readUInt32LE(44)) << 32n) | BigInt(info.readUInt32LE(48));
      const s = st as unknown as { dev: bigint; ino: bigint };
      if (s.dev !== serial || s.ino !== index) return null;
      const buf = Buffer.alloc(32_768 * 2);
      const n = k.GetFinalPathNameByHandleW!(h, ptr(buf), 32_768, 0) as number;
      if (n === 0 || n >= 32_768) return null;
      const p = buf.subarray(0, n * 2).toString("utf16le");
      return p.startsWith("\\\\?\\UNC\\") ? `\\\\${p.slice(8)}` : p.startsWith("\\\\?\\") ? p.slice(4) : p;
    } finally { k.CloseHandle!(h); }
  }
  return null;
}

export interface OpenChecked {
  /** Open for writing (else reading). */
  readonly write?: boolean;
  /** Create the file when it isn't there (exclusively only with `exclusive`: without it, a file that appears
   *  between the open and the create is opened as it is). */
  readonly create?: boolean;
  /** Fail when the file is already there (`O_CREAT|O_EXCL`): for temp files nothing may reuse the name. Implies
   *  `create`, at mode `0o600`. */
  readonly exclusive?: boolean;
  /** Empty it once it's known to be the file that was judged. */
  readonly truncate?: boolean;
  readonly append?: boolean;
}

/** Opens `path` for `fence` (a `Fence` or a `forCaller` view) as above; the caller closes the descriptor. Throws
 *  `FenceRefused`, or the open's own error (ENOENT, ELOOP for a link at the last component, EEXIST for `exclusive`
 *  when the file is already there). */
export function openChecked(fence: Judge, path: string, o: OpenChecked = {}): number {
  const op: FenceOp = o.write ? { op: "write", path } : { op: "read", path };
  const first = fence.check(op);
  if (!first.allowed) throw new FenceRefused(first, path);
  const nofollow = (constants as Record<string, number>).O_NOFOLLOW ?? 0;
  const base = (o.write ? (o.append ? constants.O_WRONLY | constants.O_APPEND : constants.O_RDWR) : constants.O_RDONLY) | nofollow;
  let fd: number;
  let created = false;
  if (o.exclusive) {
    fd = openSync(path, base | constants.O_CREAT | constants.O_EXCL, 0o600);
    created = true;
  } else {
    try { fd = openSync(path, base); }
    catch (e) {
      if (!(o.write && o.create && (e as NodeJS.ErrnoException).code === "ENOENT")) throw e;
      fd = openSync(path, base | constants.O_CREAT | constants.O_EXCL, 0o644);
      created = true;
    }
  }
  const real = fdRealPath(fd, process.platform, path);
  const second: FenceVerdict = real === null
    ? { allowed: false, reason: "clover-home", path }
    : fence.check(o.write ? { op: "write", path: real } : { op: "read", path: real });
  if (!second.allowed) {
    closeSync(fd);
    if (created && real !== null) { try { unlinkSync(real); } catch { /* gone */ } }
    throw new FenceRefused(second, real ?? path);
  }
  if (o.write && o.truncate) ftruncateSync(fd, 0);
  return fd;
}

/** The whole file, read through `openChecked`. */
export function readChecked(fence: Judge, path: string): Buffer {
  const fd = openChecked(fence, path);
  try { return readFileSync(fd); } finally { closeSync(fd); }
}

/** The whole file, replaced through `openChecked` (created when it isn't there). */
export function writeChecked(fence: Judge, path: string, data: string | Uint8Array): void {
  const fd = openChecked(fence, path, { write: true, create: true, truncate: true });
  try {
    const b = typeof data === "string" ? Buffer.from(data) : data;
    for (let off = 0; off < b.length;) off += writeSync(fd, b, off, b.length - off);
  } finally { closeSync(fd); }
}
