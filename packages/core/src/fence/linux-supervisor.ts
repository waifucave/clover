// The Linux sandbox's supervisor (spec item 1116): a seccomp user-notification filter over the sandboxed
// command that refuses planted startup files no mount can cover — the fenced login-start files that don't exist
// yet, so no read-only bind can name them. The filter traps the path-taking mutating syscalls (openat and the older
// open, creat, mkdir(at), rename(at)(2), link(at), symlink(at), mknodat and openat2); reads pass untouched. Each
// trapped call is judged in userspace against the supervised folders: a write into one is refused with EACCES,
// everything else continues.
//
// Soundness notes, measured against the kernel's own header (`include/uapi/linux/seccomp.h`):
//   * every decision re-checks the notification id (`SECCOMP_IOCTL_NOTIF_ID_VALID`) immediately before answering it,
//     so a dead target (and a recycled pid) never gets an answer meant for someone else;
//   * the target's path is resolved relative to its own dirfd through `/proc/<pid>/fd`, never trusting a bare
//     relative path (the header's warning stands: a traced thread can rewrite its pointed-to arguments while the
//     supervisor reads them, so this is defense in depth behind the mounts, the belt check, and the fence itself —
///     not a proof).
// Where user-notify is unavailable (a kernel or arch this build doesn't cover: only x86-64 today) the sandbox runs
// without the supervisor and the belt below still quarantines anything planted.
import { closeSync, existsSync, fchmodSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { ffiLib, ffiPtr } from "../platform/ffi";

/** This machine's supervisor arch, or null where there is none (x86-64 measured live; arm64 by table). */
export function supervisorArch(arch: string = process.arch): "x64" | "arm64" | null {
  return arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
}

/** A trapped syscall: which argument holds the dir fd (-1 for none: AT_FDCWD), which hold paths, and for an
 *  open-like call how to tell a write from a read (`open` for open/openat/openat2, `creat` for creat which always
 *  writes, `mutate` for the rest which always change the tree). */
export interface TrapSpec {
  readonly nr: number;
  readonly dirfd: number;
  readonly paths: readonly number[];
  readonly kind: "open" | "creat" | "mutate";
  readonly how?: number;
}

/** The mutating path syscalls and their arguments on x86-64 (`asm/unistd_64.h`). symlinkat's linkpath is its
 *  third argument (its dirfd its second): checking the target would refuse ordinary links to odd names. */
const TRAPS_X64: readonly TrapSpec[] = [
  { nr: 257, dirfd: 0, paths: [1], kind: "open" }, // openat
  { nr: 437, dirfd: 0, paths: [1], kind: "open", how: 2 }, // openat2
  { nr: 2, dirfd: -1, paths: [0], kind: "open" }, // open
  { nr: 85, dirfd: -1, paths: [0], kind: "creat" }, // creat
  { nr: 258, dirfd: 0, paths: [1], kind: "mutate" }, // mkdirat
  { nr: 83, dirfd: -1, paths: [0], kind: "mutate" }, // mkdir
  { nr: 259, dirfd: 0, paths: [1], kind: "mutate" }, // mknodat
  { nr: 133, dirfd: -1, paths: [0], kind: "mutate" }, // mknod
  { nr: 316, dirfd: 0, paths: [1, 3], kind: "mutate" }, // renameat2
  { nr: 264, dirfd: 0, paths: [1, 3], kind: "mutate" }, // renameat
  { nr: 38, dirfd: -1, paths: [0, 1], kind: "mutate" }, // rename
  { nr: 265, dirfd: 0, paths: [1, 3], kind: "mutate" }, // linkat
  { nr: 86, dirfd: -1, paths: [0, 1], kind: "mutate" }, // link
  { nr: 266, dirfd: 1, paths: [2], kind: "mutate" }, // symlinkat (target, newdirfd, linkpath)
  { nr: 88, dirfd: -1, paths: [0, 1], kind: "mutate" }, // symlink (target, linkpath)
];

/** The same on arm64 (`asm-generic/unistd.h`): only the `*at` forms and openat2 exist there — no legacy
 *  open/creat/mkdir/mknod/rename/link/symlink. Untested live (an arm64 live check is on the owner's list). */
const TRAPS_ARM64: readonly TrapSpec[] = [
  { nr: 56, dirfd: 0, paths: [1], kind: "open" }, // openat
  { nr: 437, dirfd: 0, paths: [1], kind: "open", how: 2 }, // openat2
  { nr: 34, dirfd: 0, paths: [1], kind: "mutate" }, // mkdirat
  { nr: 33, dirfd: 0, paths: [1], kind: "mutate" }, // mknodat
  { nr: 382, dirfd: 0, paths: [1, 3], kind: "mutate" }, // renameat2
  { nr: 38, dirfd: 0, paths: [1, 3], kind: "mutate" }, // renameat
  { nr: 37, dirfd: 0, paths: [1, 3], kind: "mutate" }, // linkat
  { nr: 36, dirfd: 1, paths: [2], kind: "mutate" }, // symlinkat (target, newdirfd, linkpath)
];

/** The trapped syscalls for an arch, or null where there is no supervisor. */
export function trapTable(arch: string = process.arch): readonly TrapSpec[] | null {
  if (arch === "x64") return TRAPS_X64;
  if (arch === "arm64") return TRAPS_ARM64;
  return null;
}

/** seccomp classic BPF that traps the table above with `SECCOMP_RET_USER_NOTIF` and allows everything else.
 *  Syscall numbers with the x32 bit (>= 0x40000000) and any other architecture are refused with EPERM first:
 *  otherwise an x32 `openat` (same arch, different number) would sail past the traps. Null where there is no
 *  supervisor. */
export function buildUserNotifFilter(arch: string = process.arch): Buffer | null {
  const traps = trapTable(arch);
  if (traps === null) return null;
  const LD = 0x20, JEQ = 0x15, JGE = 0x35, RET = 0x06;
  const ALLOW = 0x7fff0000, NOTIF = 0x7fc00000, EPERM = 0x00050001;
  const AUDIT = arch === "arm64" ? 0xc00000b7 : 0xc000003e;
  const X32 = 0x40000000;
  const k = traps.length;
  // 0: the architecture; 1: wrong arch goes to EPERM; 2: the call number; 3: x32 numbers go to EPERM;
  // 4..: one JEQ per trapped call, each jumping forward to the trap; then allow, trap, EPERM.
  const prog: [number, number, number, number][] = [
    [LD, 0, 0, 4],
    [JEQ, 0, k + 4, AUDIT],
    [LD, 0, 0, 0],
    [JGE, k + 2, 0, X32],
  ];
  traps.forEach((t, i) => prog.push([JEQ, k - i, 0, t.nr]));
  prog.push([RET, 0, 0, ALLOW]);
  prog.push([RET, 0, 0, NOTIF]);
  prog.push([RET, 0, 0, EPERM]);
  const b = Buffer.alloc(prog.length * 8);
  prog.forEach(([code, jt, jf, v], i) => { b.writeUInt16LE(code, i * 8); b.writeUInt8(jt, i * 8 + 2); b.writeUInt8(jf, i * 8 + 3); b.writeUInt32LE(v >>> 0, i * 8 + 4); });
  return b;
}

/** Flags that make an open a write (`O_ACCMODE` and the creating/truncating flags). */
const O_WRONLY = 0o1, O_RDWR = 0o2, O_CREAT = 0o100, O_TRUNC = 0o1000, O_APPEND = 0o2000, O_TMPFILE = 0o20000000;
const O_RDONLY = 0, O_DIRECTORY = 0o200000, O_NOFOLLOW = 0o400000, O_CLOEXEC = 0o2000000, O_EXCL = 0o200, O_NONBLOCK = 0o4000, O_PATH = 0o10000000;
const AT_FDCWD = -100, AT_SYMLINK_NOFOLLOW = 0x100;

/** Whether an open-like call writes, from its flags word (openat2's comes from its open_how). */
export function openWrites(flags: bigint): boolean {
  const f = Number(flags & 0xffffffffffffffffn);
  return (f & 0o3) !== 0 || (f & (O_CREAT | O_TRUNC | O_APPEND)) !== 0 || (f & O_TMPFILE) !== 0;
}

/** Case- and Unicode-insensitive name compare, the way the disks fold. */
export function foldName(s: string): string {
  return s.normalize("NFC").toUpperCase().toLowerCase();
}

/** Splits a raw path into its components, dropping empties. `..` stays: the walk resolves it under the target's
 *  root, where it cannot escape (the root pins it, as the kernel does). */
export function splitComps(path: string): string[] {
  return path.split("/").filter((c) => c !== "");
}

/** Dir fds arrive as unsigned 64-bit words: AT_FDCWD (-100) reads as 2^64-100, past Number's exact range.
 *  Convert back to signed, or every relative path misresolves. */
function signedArg(v: bigint): number {
  let d = v;
  if (d >= (1n << 63n)) d -= (1n << 64n);
  return Number(d);
}

/** Reads `len` bytes at `addr` in the target process, ONCE (process_vm_readv): a thread rewriting the pointer
 *  afterwards cannot change what was read. Null when unreadable. */
export function readPathOnce(lib: SupervisorLib, pid: number, addr: bigint, len: number): Buffer | null {
  if (addr === 0n) return null;
  try {
    const out = Buffer.alloc(Math.min(len, 4096));
    const liov = Buffer.alloc(16);
    liov.writeBigUInt64LE(BigInt(ffiPtr(out) as unknown as number), 0);
    liov.writeBigUInt64LE(BigInt(out.length), 8);
    const riov = Buffer.alloc(16);
    riov.writeBigUInt64LE(addr & 0xffffffffffffffffn, 0);
    riov.writeBigUInt64LE(BigInt(out.length), 8);
    const n = Number(lib.process_vm_readv(pid, ffiPtr(liov), 1, ffiPtr(riov), 1, 0));
    if (!(n > 0)) return null;
    return out.subarray(0, n);
  } catch { return null; }
}

/** Reads a NUL-terminated string at `addr` in the target (one read). Null when missing or unterminated. */
export function readCString(lib: SupervisorLib, pid: number, addr: bigint): string | null {
  const b = readPathOnce(lib, pid, addr, 4096);
  if (b === null) return null;
  const end = b.indexOf(0);
  if (end < 0) return null;
  return b.subarray(0, end).toString("utf8");
}

/** The target's credentials and umask, from its status (sameuid check below). Null when unreadable. */
export interface TargetIds { readonly uid: number; readonly umask: number }
export function targetIds(pid: number): TargetIds | null {
  try {
    let uid = -1, umask = 0o22;
    for (const line of readFileSync(`/proc/${pid}/status`, "utf8").split("\n")) {
      if (line.startsWith("Uid:")) uid = Number(line.split(/\s+/)[1]);
      else if (line.startsWith("Umask:")) umask = parseInt(line.split(/\s+/)[1]!, 8);
    }
    return uid < 0 ? null : { uid, umask };
  } catch { return null; }
}

/** Opens the base a trapped path resolves from: the target's cwd, one of its dir fds, or its root. The fd pins
 *  the directory: nothing the target does afterwards (rename, replace, unmount) moves it. Returns -1 on failure,
 *  with the kernel's errno in `err`. */
export function resolveBase(lib: SupervisorLib, pid: number, absolute: boolean, dirfd: number): { fd: number; err: number } {
  const openDir = (p: string): { fd: number; err: number } => {
    let fd = -1;
    try { fd = openSync(p, O_RDONLY | O_DIRECTORY | O_NONBLOCK); } catch (e) { return { fd: -1, err: errnoOf(e) }; }
    try {
      if (!fstatSync(fd).isDirectory()) { try { closeSync(fd); } catch { /* gone */ } return { fd: -1, err: 20 }; // ENOTDIR
      }
    } catch (e) { try { closeSync(fd); } catch { /* gone */ } return { fd: -1, err: errnoOf(e) }; }
    return { fd, err: 0 };
  };
  if (absolute) return openDir(`/proc/${pid}/root`);
  if (dirfd === AT_FDCWD) return openDir(`/proc/${pid}/cwd`);
  return openDir(`/proc/${pid}/fd/${dirfd}`);
}

/** The kernel errno for a failed call: our own libc errno where there is one, EACCES where there isn't. */
function errnoOf(e: unknown): number {
  const c = (e as NodeJS.ErrnoException)?.code;
  if (c === "ENOENT") return 2;
  if (c === "ELOOP") return 40;
  if (c === "ENOTDIR") return 20;
  if (c === "EACCES" || c === "EPERM") return 13;
  if (c === "EEXIST") return 17;
  return 13; // fail closed everywhere else
}

/** Walks every component but the last under `baseFd`, refusing links and non-directories, and returns the open
 *  parent plus the untouched final name. The walk uses only our own fds: a thread rewriting the target's
 *  pointers, names on disk, or mounts mid-walk cannot redirect it. The base is consumed (closed, or returned as
 *  the parent when there are no components to walk); the caller closes the returned parent. Returns the
 *  kernel's errno on failure. */
export function walkToParent(lib: SupervisorLib, baseFd: number, comps: string[]): { parentFd: number; name: string } | { errno: number } {
  if (comps.length === 0) return { errno: 2 }; // ENOENT, as the kernel for an empty path
  let cur = baseFd;
  for (let i = 0; i < comps.length - 1; i++) {
    const nfd = Number(lib.openat(cur, bufOf(comps[i]!), O_RDONLY | O_DIRECTORY | O_NOFOLLOW, 0));
    try { closeSync(cur); } catch { /* gone */ }
    if (nfd < 0) return { errno: errNo(lib) };
    cur = nfd;
  }
  return { parentFd: cur, name: comps[comps.length - 1]! };
}

/** A NUL-terminated scratch Buffer for an FFI path argument. */
function bufOf(s: string): unknown {
  return ffiPtr(Buffer.from(`${s}\0`, "utf8"));
}

/** The device and inode behind an open fd, or null. */
export function parentIdentity(fd: number): { dev: bigint; ino: bigint } | null {
  try {
    const s = fstatSync(fd);
    return { dev: BigInt(s.dev), ino: BigInt(s.ino) };
  } catch { return null; }
}

/** Whether `(parentFd, finalName)` IS one of the supervised files: the folded final name matches, and the walked
 *  parent is the same directory as the supervised file's parent today (device and inode, both read now — a
 *  planted rename or replacement changes one side and stops matching). */
export function matchSupervised(parentFd: number, finalName: string, unsafe: readonly string[]): boolean {
  const id = parentIdentity(parentFd);
  if (id === null) return false;
  const want = foldName(finalName);
  for (const u of unsafe) {
    const slash = u.lastIndexOf("/");
    if (slash < 0 || foldName(u.slice(slash + 1)) !== want) continue;
    try {
      const st = lstatSync(u.slice(0, slash));
      if (BigInt(st.dev) === id.dev && BigInt(st.ino) === id.ino) return true;
    } catch { /* parent missing now: nothing to plant through */ }
  }
  return false;
}

// --- The user-notification plumbing (ioctl numbers from include/uapi/linux/seccomp.h) ---
const NOTIF_RECV = 0xc0502100; // _IOR(0x21, 0, struct seccomp_notif[80])
const NOTIF_SEND = 0xc0182101; // _IOWR(0x21, 1, struct seccomp_notif_resp[24])
const NOTIF_ID_VALID = 0x40082102; // _IOW(0x21, 2, __u64)
const NOTIF_ADDFD = 0x40182103; // _IOW(0x21, 3, struct seccomp_notif_addfd[24])
const NOTIF_CONTINUE = 1; // SECCOMP_USER_NOTIF_FLAG_CONTINUE
const EACCES = 13;

/** libc for the supervisor's own calls. Null where bun:ffi or libc isn't there. */
export function openSupervisorLib(): {
  syscall(nr: number, op: number, flags: number, prog: unknown): number | bigint;
  prctl(option: number, arg2: number, arg3: number, arg4: number, arg5: number): number;
  ioctl(fd: number, req: number, arg: unknown): number;
  poll(fds: unknown, nfds: number, timeout: number): number;
  openat(dirfd: number, path: unknown, flags: number, mode: number): number | bigint;
  mkdirat(dirfd: number, path: unknown, mode: number): number;
  mknodat(dirfd: number, path: unknown, mode: number, dev: number | bigint): number;
  linkat(olddirfd: number, oldpath: unknown, newdirfd: number, newpath: unknown, flags: number): number;
  symlinkat(target: unknown, newdirfd: number, newpath: unknown): number;
  renameat2(olddirfd: number, oldpath: unknown, newdirfd: number, newpath: unknown, flags: number): number;
  fchmodat(dirfd: number, path: unknown, mode: number, flags: number): number;
  process_vm_readv(pid: number, local: unknown, liovcnt: number, remote: unknown, riovcnt: number, flags: number): number | bigint;
  errnoLocation(): unknown;
  getpid(): number;
} | null {
  const lib = ffiLib("linux-supervisor", "libc.so.6", {
    syscall: { args: ["u64", "u64", "u64", "ptr"], returns: "i64" },
    prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
    ioctl: { args: ["i32", "u64", "ptr"], returns: "i32" },
    poll: { args: ["ptr", "u64", "i32"], returns: "i32" },
    openat: { args: ["i32", "ptr", "i32", "u32"], returns: "i64" },
    mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
    mknodat: { args: ["i32", "ptr", "u32", "u64"], returns: "i32" },
    linkat: { args: ["i32", "ptr", "i32", "ptr", "i32"], returns: "i32" },
    symlinkat: { args: ["ptr", "i32", "ptr"], returns: "i32" },
    renameat2: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" },
    fchmodat: { args: ["i32", "ptr", "u32", "u32"], returns: "i32" },
    process_vm_readv: { args: ["i32", "ptr", "u64", "ptr", "u64", "u64"], returns: "i64" },
    errnoLocation: { args: [], returns: "ptr" },
    getpid: { args: [], returns: "i32" },
  });
  return lib as never;
}

/** Our own libc errno after a failed call (the wrappers return -1 and set it). */
function errNo(lib: SupervisorLib): number {
  try {
    const p = lib.errnoLocation() as unknown;
    const { toArrayBuffer } = require("bun:ffi") as typeof import("bun:ffi");
    return Buffer.from(toArrayBuffer(p as never, 0, 4) as ArrayBuffer).readInt32LE(0);
  } catch { return EACCES; }
}

/** Installs the filter with a new listener, returning the listener fd, or null. Unprivileged installs need
 *  no-new-privs first (the sandbox runs that way anyway); libc has no seccomp wrapper everywhere, so this uses
 *  the raw call (317 on x86-64, 277 on arm64). */
export function installUserNotifFilter(lib: NonNullable<ReturnType<typeof openSupervisorLib>>, filter: Buffer, arch: string = process.arch): number | null {
  const PR_SET_NO_NEW_PRIVS = 38;
  const SYS_SECCOMP = arch === "arm64" ? 277 : 317;
  const SET_MODE_FILTER = 1;
  const NEW_LISTENER = 8; // SECCOMP_FILTER_FLAG_NEW_LISTENER
  if (lib.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) !== 0) return null;
  const prog = Buffer.alloc(16);
  prog.writeUInt16LE(filter.length / 8, 0);
  prog.writeBigUInt64LE(BigInt(ffiPtr(filter) as unknown as number), 8);
  const fd = lib.syscall(SYS_SECCOMP, SET_MODE_FILTER, NEW_LISTENER, ffiPtr(prog));
  const n = typeof fd === "bigint" ? Number(fd) : fd;
  return n < 0 ? null : n;
}

/** A notification: id, target pid, call number and arguments. */
export interface SupervisorNotif {
  readonly id: bigint;
  readonly pid: number;
  readonly nr: number;
  readonly args: readonly bigint[];
}

/** The next notification, blocking; null on a hard error. */
export function recvNotif(lib: NonNullable<ReturnType<typeof openSupervisorLib>>, listener: number): SupervisorNotif | null {
  const b = Buffer.alloc(80);
  if ((lib.ioctl(listener, NOTIF_RECV, ffiPtr(b)) as number) !== 0) return null;
  const args: bigint[] = [];
  for (let i = 0; i < 6; i++) args.push(b.readBigUInt64LE(32 + i * 8));
  return { id: b.readBigUInt64LE(0), pid: b.readUInt32LE(8), nr: b.readInt32LE(16), args };
}

/** Whether the notification's target is still the process that trapped. Check immediately before answering. */
export function notifIdValid(lib: NonNullable<ReturnType<typeof openSupervisorLib>>, listener: number, id: bigint): boolean {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(id, 0);
  return (lib.ioctl(listener, NOTIF_ID_VALID, ffiPtr(b)) as number) === 0;
}

/** What answering a notification carries: the value to return, a negative errno (0 for none), and whether the
 *  original call continues (`cont`). Performed calls never continue: the supervisor did the work itself, so the
 *  kernel must not redo it (its re-read of the target's pointers is exactly the TOCTOU this design removes). */
export interface SuperviseVerdict { readonly val: number; readonly error: number; readonly cont: boolean }

/** Answers a notification: continue, a performed result, or a refused plant. */
export function sendVerdict(lib: NonNullable<ReturnType<typeof openSupervisorLib>>, listener: number, id: bigint, v: SuperviseVerdict): void {
  const b = Buffer.alloc(24);
  b.writeBigUInt64LE(id, 0);
  b.writeBigInt64LE(BigInt(v.val), 8);
  b.writeInt32LE(v.error, 16);
  b.writeUInt32LE(v.cont ? NOTIF_CONTINUE : 0, 20);
  lib.ioctl(listener, NOTIF_SEND, ffiPtr(b));
}

const VERDICT_CONT: SuperviseVerdict = { val: 0, error: 0, cont: true };
const VERDICT_DENY: SuperviseVerdict = { val: 0, error: -EACCES, cont: false };
const verdictErr = (errno: number): SuperviseVerdict => ({ val: 0, error: -errno, cont: false });

/** Injects our local fd into the target process (SECCOMP_IOCTL_NOTIF_ADDFD allocates its lowest free fd, with
 *  O_CLOEXEC applied when asked) and answers with it. Closes the local fd either way. */
function injectFd(lib: SupervisorLib, listener: number, id: bigint, localFd: number, cloexec: boolean): SuperviseVerdict {
  const b = Buffer.alloc(24);
  b.writeBigUInt64LE(id, 0);
  b.writeUInt32LE(0, 8); // flags: no SETFD, the kernel allocates
  b.writeInt32LE(localFd, 12); // srcfd
  b.writeInt32LE(0, 16); // newfd unused without SETFD
  b.writeUInt32LE(cloexec ? O_CLOEXEC : 0, 20); // newfd_flags
  const remote = Number(lib.ioctl(listener, NOTIF_ADDFD, ffiPtr(b)));
  try { closeSync(localFd); } catch { /* answered anyway */ }
  if (remote < 0) return VERDICT_DENY; // fail closed: no fd, no call
  return { val: remote, error: 0, cont: false };
}

/** Opens the final component for lstat-equivalent inspection without following it (`O_PATH|O_NOFOLLOW`), then
 *  stats the fd itself: links, directories and the missing case without ever resolving through a link. */
export function lstatFinal(lib: SupervisorLib, parentFd: number, name: string): { kind: "missing" | "link" | "dir" | "other" } | { errno: number } {
  const fd = Number(lib.openat(parentFd, bufOf(name), 0o10000000 | O_NOFOLLOW, 0)); // O_PATH|O_NOFOLLOW
  if (fd < 0) {
    const e = errNo(lib);
    return e === 2 ? { kind: "missing" } : { errno: e };
  }
  try {
    const s = fstatSync(fd);
    if (s.isSymbolicLink()) return { kind: "link" };
    if (s.isDirectory()) return { kind: "dir" };
    return { kind: "other" };
  } catch (e) { return { errno: errnoOf(e) }; }
  finally { try { closeSync(fd); } catch { /* inspected */ } }
}

/** Walks one trapped path to its parent: resolves the base (cwd, dirfd or root — never the target's strings
 *  past the single read), walks every component but the last refusing links, and returns the open parent with
 *  the untouched final name. The caller closes the parent. */
function walkOne(lib: SupervisorLib, pid: number, dirfd: number, path: string, absolute: boolean): { parentFd: number; name: string } | { errno: number } {
  const comps = splitComps(absolute ? path.slice(1) : path);
  const base = resolveBase(lib, pid, absolute, dirfd);
  if (base.fd < 0) return { errno: base.err };
  if (comps.length === 0) { try { closeSync(base.fd); } catch { /* gone */ } return { errno: 2 }; } // ENOENT, as the kernel
  return walkToParent(lib, base.fd, comps);
}

/** Performs an open-like call (open/openat/openat2/creat) with write intent: walks, refuses supervised finals
 *  and finals reached through links, creates with the target's umask corrected, and injects the fd. Reads and
 *  opens of an existing file without O_CREAT continue (the ruling); everything else is performed or refused —
 *  the kernel never re-reads the target's pointers. */
function performOpen(lib: SupervisorLib, listener: number, id: bigint, pid: number, dirfd: number, path: string, absolute: boolean, flags: bigint, mode: number, unsafe: readonly string[], umask: number): SuperviseVerdict {
  const w = walkOne(lib, pid, dirfd, path, absolute);
  if ("errno" in w) return verdictErr(w.errno);
  const { parentFd, name } = w;
  const done = (v: SuperviseVerdict): SuperviseVerdict => { try { closeSync(parentFd); } catch { /* answered */ } return v; };
  const fin = lstatFinal(lib, parentFd, name);
  if ("errno" in fin) return done(verdictErr(fin.errno)); // missing without O_CREAT lands here as ENOENT
  const f = Number(flags & 0xffffffffffffffffn);
  if (fin.kind === "link") return done((f & O_NOFOLLOW) !== 0 ? verdictErr(40) : VERDICT_DENY); // ELOOP, or refused
  if (fin.kind !== "missing" && (f & O_CREAT) === 0) return done(VERDICT_CONT); // an existing file without O_CREAT may continue
  if (matchSupervised(parentFd, name, unsafe)) return done(VERDICT_DENY);
  if ((f & O_TMPFILE) !== 0) {
    // An unnamed file in the walked directory: the kernel resolves the name to the directory and creates
    // inside it. No supervised file can match (all supervised entries are files).
    const fd = Number(lib.openat(parentFd, bufOf(name), (f | O_NOFOLLOW) >>> 0, mode));
    if (fd < 0) return done(verdictErr(errNo(lib)));
    try { fchmodSync(fd, mode & ~umask); } catch { /* best effort */ }
    const v = injectFd(lib, listener, id, fd, (f & O_CLOEXEC) !== 0);
    return done(v);
  }
  if (fin.kind !== "missing") {
    // Exists, O_CREAT set: open it (O_NOFOLLOW already refused links above), keeping its permissions.
    const fd = Number(lib.openat(parentFd, bufOf(name), (f | O_NOFOLLOW) >>> 0, 0));
    if (fd < 0) return done(verdictErr(errNo(lib)));
    const v = injectFd(lib, listener, id, fd, (f & O_CLOEXEC) !== 0);
    return done(v);
  }
  // Missing with O_CREAT: exclusive create (a race becomes EEXIST, handled below), exact mode, inject.
  let fd = Number(lib.openat(parentFd, bufOf(name), ((f | O_CREAT | O_EXCL | O_NOFOLLOW) >>> 0), mode));
  if (fd < 0) {
    if (errNo(lib) !== 17) return done(verdictErr(errNo(lib))); // not EEXIST: truthful error
    fd = Number(lib.openat(parentFd, bufOf(name), ((f | O_CREAT | O_NOFOLLOW) >>> 0), 0));
    if (fd < 0) return done(verdictErr(errNo(lib)));
    const v = injectFd(lib, listener, id, fd, (f & O_CLOEXEC) !== 0);
    return done(v);
  }
  if (lib.fchmodat(parentFd, bufOf(name), (mode & ~umask) >>> 0, AT_SYMLINK_NOFOLLOW) !== 0) {
    const e = errNo(lib);
    try { closeSync(fd); } catch { /* created */ }
    // The file exists now with the umask-applied mode; report the chmod failure rather than mislead.
    return done(verdictErr(e));
  }
  const v = injectFd(lib, listener, id, fd, (f & O_CLOEXEC) !== 0);
  return done(v);
}

/** Performs a single-path mutating call (mkdir/mknod): walks, refuses supervised finals, runs it on the walked
 *  parent handle with the target's mode (umask-corrected, like its own call would leave it), and returns the
 *  real result or errno. Creation syscalls report EEXIST truthfully. */
function performMake(lib: SupervisorLib, pid: number, dirfd: number, path: string, absolute: boolean, unsafe: readonly string[], umask: number, mode: number, make: (parentFd: number, name: string) => number): SuperviseVerdict {
  const w = walkOne(lib, pid, dirfd, path, absolute);
  if ("errno" in w) return verdictErr(w.errno);
  const { parentFd, name } = w;
  const done = (v: SuperviseVerdict): SuperviseVerdict => { try { closeSync(parentFd); } catch { /* answered */ } return v; };
  if (matchSupervised(parentFd, name, unsafe)) return done(VERDICT_DENY);
  const r = make(parentFd, name);
  if (r !== 0) return done(verdictErr(errNo(lib)));
  if (lib.fchmodat(parentFd, bufOf(name), (mode & ~umask) >>> 0, AT_SYMLINK_NOFOLLOW) !== 0) return done(verdictErr(errNo(lib)));
  return done({ val: 0, error: 0, cont: false });
}

/** Performs a two-path mutating call (rename/link): walks both parents, refuses a supervised destination, runs
 *  it on the walked handles, and returns the real result or errno. */
function performMove(lib: SupervisorLib, pid: number, srcDirfd: number, srcPath: string, srcAbsolute: boolean, dstDirfd: number, dstPath: string, dstAbsolute: boolean, unsafe: readonly string[], move: (srcFd: number, srcName: string, dstFd: number, dstName: string) => number): SuperviseVerdict {
  const src = walkOne(lib, pid, srcDirfd, srcPath, srcAbsolute);
  if ("errno" in src) return verdictErr(src.errno);
  const dst = walkOne(lib, pid, dstDirfd, dstPath, dstAbsolute);
  if ("errno" in dst) { try { closeSync(src.parentFd); } catch { /* gone */ } return verdictErr(dst.errno); }
  const done = (v: SuperviseVerdict): SuperviseVerdict => {
    try { closeSync(src.parentFd); } catch { /* gone */ }
    try { closeSync(dst.parentFd); } catch { /* gone */ }
    return v;
  };
  if (matchSupervised(dst.parentFd, dst.name, unsafe)) return done(VERDICT_DENY);
  const r = move(src.parentFd, src.name, dst.parentFd, dst.name);
  if (r !== 0) return done(verdictErr(errNo(lib)));
  return done({ val: 0, error: 0, cont: false });
}

/** Dispatches one trapped call: reads every pointer argument ONCE, then performs the operation on walked handles
 *  (or continues a read, or refuses a supervised plant). Never lets the kernel re-read the target's pointers. */
function performTrap(lib: SupervisorLib, listener: number, n: SupervisorNotif, unsafe: readonly string[], umask: number): SuperviseVerdict {
  const spec = (trapTable() ?? TRAPS_X64).find((t) => t.nr === n.nr);
  if (spec === undefined) return VERDICT_DENY; // fail closed: the filter only traps the table
  const dirfdAt = (at: number): number => signedArg(n.args[at - 1] ?? -100n);
  const dirfdOf = (at: number): number => (spec.dirfd === -1 ? AT_FDCWD : dirfdAt(at));
  // Every pointer argument is read ONCE per trapped call: later reads hit this cache, so a thread rewriting
  // the target's memory mid-decision cannot change what the supervisor acts on.
  const cache = new Map<number, string | null>();
  const readAt = (at: number): string | null => {
    if (cache.has(at)) return cache.get(at)!;
    const a = n.args[at];
    const s = a === undefined ? null : readCString(lib, n.pid, a);
    cache.set(at, s);
    return s;
  };
  if (spec.kind === "open" || spec.kind === "creat") {
    // Flags and mode are values, not pointers: no TOCTOU in reading them.
    let flags: bigint;
    let mode = 0;
    if (spec.how !== undefined) {
      // openat2: flags, mode and resolve live in its open_how struct. The walk refuses every link and stays
      // pinned under the target's root, which is at least as strict as RESOLVE_NO_SYMLINKS/BENEATH/IN_ROOT —
      // resolve flags need no separate handling.
      const howAddr = n.args[spec.how];
      if (howAddr === undefined || howAddr === 0n) return VERDICT_DENY;
      const how = readPathOnce(lib, n.pid, howAddr, 32);
      if (how === null || how.length < 24) return VERDICT_DENY;
      flags = how.readBigUInt64LE(0);
      mode = Number(how.readBigUInt64LE(8) & 0o7777n);
    } else if (spec.kind === "creat") {
      flags = BigInt(O_CREAT | O_WRONLY | O_TRUNC);
      mode = Number((n.args[1] ?? 0n) & 0o7777n);
    } else {
      flags = n.args[spec.dirfd === -1 ? 1 : 2] ?? 0n;
      if ((flags & BigInt(O_CREAT)) !== 0n) mode = Number((n.args[spec.dirfd === -1 ? 2 : 3] ?? 0n) & 0o7777n);
    }
    if (!openWrites(flags)) return VERDICT_CONT; // reads pass untouched
    const at = spec.paths[0]!;
    const s = readAt(at);
    if (s === null) return VERDICT_DENY; // unreadable: fail closed
    return performOpen(lib, listener, n.id, n.pid, dirfdOf(at), s, s.startsWith("/"), flags, mode, unsafe, umask);
  }
  if (spec.paths.length === 1) {
    const at = spec.paths[0]!;
    const s = readAt(at);
    if (s === null) return VERDICT_DENY;
    const dirfd = dirfdOf(at);
    const absolute = s.startsWith("/");
    if (spec.nr === 266 || spec.nr === 36 || spec.nr === 88) {
      // symlink(linkpath): the target is just bytes, never resolved — only the linkpath is walked.
      const linkAt = spec.paths[spec.paths.length - 1]!;
      const link = readAt(linkAt);
      if (link === null) return VERDICT_DENY;
      const linkDirfd = spec.dirfd === -1 ? AT_FDCWD : dirfdAt(linkAt);
      const w = walkOne(lib, n.pid, linkDirfd, link, link.startsWith("/"));
      if ("errno" in w) return verdictErr(w.errno);
      const done = (v: SuperviseVerdict): SuperviseVerdict => { try { closeSync(w.parentFd); } catch { /* answered */ } return v; };
      if (matchSupervised(w.parentFd, w.name, unsafe)) return done(VERDICT_DENY);
      const target = readAt(at);
      if (target === null) return done(VERDICT_DENY);
      const r = lib.symlinkat(bufOf(target), w.parentFd, bufOf(w.name));
      if (r !== 0) return done(verdictErr(errNo(lib)));
      return done({ val: 0, error: 0, cont: false });
    }
    const mode = spec.kind === "mutate" ? Number((n.args[at + 1] ?? 0o777n) & 0o7777n) : 0;
    return performMake(lib, n.pid, dirfd, s, absolute, unsafe, umask, mode, (parentFd, name) => {
      if (spec.nr === 83 || spec.nr === 258 || spec.nr === 34) return lib.mkdirat(parentFd, bufOf(name), mode >>> 0);
      const dev = n.nr === 133 || n.nr === 259 || n.nr === 33 ? Number(n.args[at + 2] ?? 0n) : 0;
      return lib.mknodat(parentFd, bufOf(name), mode >>> 0, dev);
    });
  }
  // rename/link: two paths. The destination is identity-checked; the source is walked so the handles the
  // kernel acts on are ours (a link on the way is refused, never followed).
  const srcAt = spec.paths[0]!, dstAt = spec.paths[1]!;
  const src = readAt(srcAt);
  const dst = readAt(dstAt);
  if (src === null || dst === null) return VERDICT_DENY;
  const move = (srcFd: number, srcName: string, dstFd: number, dstName: string): number => {
    if (n.nr === 265 || n.nr === 37 || n.nr === 86) {
      return lib.linkat(srcFd, bufOf(srcName), dstFd, bufOf(dstName), Number(n.args[dstAt + 1] ?? 0n));
    }
    return lib.renameat2(srcFd, bufOf(srcName), dstFd, bufOf(dstName), Number(n.args[dstAt + 1] ?? 0n));
  };
  return performMove(lib, n.pid, dirfdOf(srcAt), src, src.startsWith("/"), dirfdOf(dstAt), dst, dst.startsWith("/"), unsafe, move);
}

/** Whether the listener has a notification waiting (milliseconds to wait). */
export function pollReadable(lib: NonNullable<ReturnType<typeof openSupervisorLib>>, listener: number, timeoutMs: number): boolean {
  const fds = Buffer.alloc(8);
  fds.writeInt32LE(listener, 0);
  fds.writeUInt16LE(1, 4); // POLLIN
  return (lib.poll(ffiPtr(fds), 1, timeoutMs) as number) > 0;
}

export type SupervisorLib = NonNullable<ReturnType<typeof openSupervisorLib>>;

/** Runs the supervisor loop until `isDone`: performs every trapped call and answers with the real result,
 *  re-checking each notification's id immediately before answering it. Yields between polls so the child's exit
 *  is noticed. The supervisor runs as the sandbox's user (no user namespace in the sandbox) with its own
 *  unfiltered thread, so performed operations carry identical ownership and permission semantics; modes are
 *  corrected for the target's umask, and kernel mounts still apply to every performed call. */
export async function supervise(lib: SupervisorLib, listener: number, unsafe: readonly string[], isDone: () => boolean): Promise<void> {
  const me = lib.getpid() as number;
  // A trap from our own process (the worker thread that installed the filter shares our pid as its tgid but
  // reports its own tid): always continue without touching it.
  const isOurs = (tid: number): boolean => {
    if (tid === me) return true;
    try { return existsSync(`/proc/self/task/${tid}`); } catch { return false; }
  };
  // The target must run as us (the sandbox keeps the user's uid; no-new-privs blocks setuid gain). Checked once
  // against the first foreign trap: a foreign user means fail closed for the rest of the run.
  let idsOk: boolean | null = null;
  let umask = 0o22;
  for (;;) {
    if (isDone()) return;
    if (!pollReadable(lib, listener, 50)) continue;
    // Drain what's queued: re-poll (0ms) before every receive, since a receive blocks on an empty queue.
    for (;;) {
      if (!pollReadable(lib, listener, 0)) break;
      const n = recvNotif(lib, listener);
      if (n === null) break;
      if (isOurs(n.pid)) {
        if (notifIdValid(lib, listener, n.id)) sendVerdict(lib, listener, n.id, VERDICT_CONT);
        continue;
      }
      if (idsOk === null) {
        const t = targetIds(n.pid);
        idsOk = t !== null && t.uid === (process.getuid?.() ?? t.uid);
        if (t !== null) umask = t.umask;
      }
      const verdict = idsOk ? performTrap(lib, listener, n, unsafe, umask) : VERDICT_DENY;
      if (notifIdValid(lib, listener, n.id)) sendVerdict(lib, listener, n.id, verdict);
    }
    await Bun.sleep(0);
  }
}
