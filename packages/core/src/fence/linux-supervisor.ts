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
import { closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, lstatSync, readFileSync } from "node:fs";
import { ffiLib, ffiPtr } from "../platform/ffi";

/** This machine's supervisor arch, or null where there is none (x86-64 measured live; arm64 by table). */
export function supervisorArch(arch: string = process.arch): "x64" | "arm64" | null {
  return arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
}

/** A trapped syscall: which argument holds the dir fd (-1 for none: AT_FDCWD), which hold paths, for an
 *  open-like call how to tell a write from a read (`open` for open/openat/openat2, `creat` for creat which always
 *  writes, `mutate` for the rest which always change the tree), which argument (if any) holds an open_how struct,
 *  and which argument (if any) holds the *at flags word (absent on legacy rename/renameat/link: always 0). */
export interface TrapSpec {
  readonly nr: number;
  readonly dirfd: number;
  readonly paths: readonly number[];
  readonly kind: "open" | "creat" | "mutate";
  readonly how?: number;
  readonly flagsAt?: number;
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
  { nr: 316, dirfd: 0, paths: [1, 3], kind: "mutate", flagsAt: 4 }, // renameat2
  { nr: 264, dirfd: 0, paths: [1, 3], kind: "mutate" }, // renameat (no flags)
  { nr: 38, dirfd: -1, paths: [0, 1], kind: "mutate" }, // rename (no flags)
  { nr: 265, dirfd: 0, paths: [1, 3], kind: "mutate", flagsAt: 4 }, // linkat
  { nr: 86, dirfd: -1, paths: [0, 1], kind: "mutate" }, // link (no flags)
  { nr: 266, dirfd: 1, paths: [2], kind: "mutate" }, // symlinkat (target, newdirfd, linkpath)
  { nr: 88, dirfd: -1, paths: [1], kind: "mutate" }, // symlink (target, linkpath): only the linkpath is walked
];

/** The same on arm64 (`asm-generic/unistd.h`): only the `*at` forms and openat2 exist there — no legacy
 *  open/creat/mkdir/mknod/rename/link/symlink. Untested live (an arm64 live check is on the owner's list). */
const TRAPS_ARM64: readonly TrapSpec[] = [
  { nr: 56, dirfd: 0, paths: [1], kind: "open" }, // openat
  { nr: 437, dirfd: 0, paths: [1], kind: "open", how: 2 }, // openat2
  { nr: 34, dirfd: 0, paths: [1], kind: "mutate" }, // mkdirat
  { nr: 33, dirfd: 0, paths: [1], kind: "mutate" }, // mknodat
  { nr: 382, dirfd: 0, paths: [1, 3], kind: "mutate", flagsAt: 4 }, // renameat2
  { nr: 38, dirfd: 0, paths: [1, 3], kind: "mutate" }, // renameat (no flags)
  { nr: 37, dirfd: 0, paths: [1, 3], kind: "mutate", flagsAt: 4 }, // linkat
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
const O_WRONLY = 0o1, O_RDWR = 0o2, O_CREAT = 0o100, O_TRUNC = 0o1000, O_APPEND = 0o2000;
const O_CLOEXEC = 0o2000000, O_EXCL = 0o200, O_PATH = 0o10000000;
/** O_NOFOLLOW and therefore O_TMPFILE (`__O_TMPFILE|O_DIRECTORY`) differ by platform (i386 values on some ARM
 *  kernels): always take them from the platform's own constants, never hardcode them. Everything else above is
 *  universal across the platforms Clover ships (verified against both). */
const O_NOFOLLOW: number = fsConstants.O_NOFOLLOW as number;
const O_TMPFILE: number = (0o20000000 | (fsConstants.O_DIRECTORY as number)) >>> 0;
const AT_FDCWD = -100, AT_SYMLINK_NOFOLLOW = 0x100, AT_SYMLINK_FOLLOW = 0x400;
/** openat2 resolve flags (linux/openat2.h) the walk must not silently ignore. */
const RESOLVE_BENEATH = 0x08, RESOLVE_IN_ROOT = 0x10;

/** Whether an open-like call writes, from its flags word (openat2's comes from its open_how). */
export function openWrites(flags: bigint): boolean {
  const f = Number(flags & 0xffffffffffffffffn);
  return (f & 0o3) !== 0 || (f & (O_CREAT | O_TRUNC | O_APPEND)) !== 0 || (f & O_TMPFILE) !== 0;
}

/** Case- and Unicode-insensitive name compare, the way the disks fold. */
export function foldName(s: string): string {
  return s.normalize("NFC").toUpperCase().toLowerCase();
}

/** Splits a raw path into parent and final name, dropping trailing slashes (the kernel ignores them except to
 *  require a directory, which it reports itself). Never empty-names a real final component. */
export function splitParent(path: string): { dir: string; name: string } {
  const absolute = path.startsWith("/");
  const t = path.replace(/\/+$/, "");
  if (t === "" || t === "/") return { dir: absolute ? "/" : "", name: "" };
  const i = t.lastIndexOf("/");
  if (i < 0) return { dir: "", name: t };
  if (i === 0) return { dir: "/", name: t.slice(1) };
  return { dir: t.slice(0, i), name: t.slice(i + 1) };
}

/** Opens the directory holding the final name, component by component: each step opens with O_PATH|O_NOFOLLOW
 *  (never following a link, never blocking) and checks it is a directory, refusing anything else. The walk uses only our own fds pinned before the target can change anything; the
 *  kernel still applies the target's mounts at every step, so the view matches the target's own (verified: a
 *  file hidden by the sandbox's tmpfs stays hidden, creates land in the sandbox's mounts). The base is consumed;
 *  the caller closes the returned parent. Returns the kernel's errno on failure. */
export function openParentDir(lib: SupervisorLib, baseFd: number, dir: string): { parentFd: number } | { errno: number } {
  if (dir === "") return { parentFd: baseFd };
  const comps = dir.split("/").filter((c) => c !== "");
  let cur = baseFd;
  for (const c of comps) {
    const nfd = Number(lib.openat(cur, bufOf(c), O_PATH | O_NOFOLLOW, 0));
    try { closeSync(cur); } catch { /* gone */ }
    if (nfd < 0) return { errno: errNo(lib) };
    let isDir = false;
    try { isDir = fstatSync(nfd).isDirectory(); } catch { /* gone */ }
    if (!isDir) { try { closeSync(nfd); } catch { /* gone */ } return { errno: 20 }; } // ENOTDIR
    cur = nfd;
  }
  return { parentFd: cur };
}

/** Dir fds arrive as unsigned words: AT_FDCWD (-100) reads as 2^64-100 or, when the caller passes a 32-bit
 *  int, 2^32-100 (both forms appear on x86-64). Convert back to signed, or every relative path misresolves. */
function signedArg(v: bigint): number {
  const low32 = Number(v & 0xffffffffn);
  return low32 >= 0x80000000 ? low32 - 0x100000000 : low32;
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

/** The target's credentials and umask, from its status. Real, effective and filesystem uids are all
 *  read (a setuid gain changes only some of them); null when unreadable. */
export interface TargetIds { readonly ruid: number; readonly euid: number; readonly fsuid: number; readonly umask: number }
export function targetIds(pid: number): TargetIds | null {
  try {
    let ruid = -1, euid = -1, fsuid = -1, umask = 0o22;
    for (const line of readFileSync(`/proc/${pid}/status`, "utf8").split("\n")) {
      if (line.startsWith("Uid:")) {
        const p = line.split(/\s+/);
        ruid = Number(p[1]); euid = Number(p[2]); fsuid = Number(p[4] ?? p[1]);
      } else if (line.startsWith("Umask:")) umask = parseInt(line.split(/\s+/)[1]!, 8);
    }
    return ruid < 0 ? null : { ruid, euid, fsuid, umask };
  } catch { return null; }
}

/** The target's umask, read through the pinned `/proc/<pid>` handle (never by pid string, so a recycled
 *  pid cannot substitute another process's mask). Null when unreadable — the trap is refused then, never
 *  run under a guessed mask. */
export function targetUmask(procFd: number): number | null {
  try {
    for (const line of readFileSync(`/proc/self/fd/${procFd}/status`, "utf8").split("\n")) {
      if (line.startsWith("Umask:")) {
        const m = parseInt(line.split(/\s+/)[1]!, 8);
        return Number.isSafeInteger(m) ? m : null;
      }
    }
  } catch { /* gone */ }
  return null;
}

/** Our own real/effective/filesystem uids, for the credential check. Null when unreadable. */
export function selfIds(): { ruid: number; euid: number; fsuid: number } | null {
  try {
    for (const line of readFileSync("/proc/self/status", "utf8").split("\n")) {
      if (line.startsWith("Uid:")) {
        const p = line.split(/\s+/);
        return { ruid: Number(p[1]), euid: Number(p[2]), fsuid: Number(p[4] ?? p[1]) };
      }
    }
  } catch { /* gone */ }
  return null;
}

/** Whether this process may supervise: never as root and never with effective capabilities (a performed
 *  call runs with our credentials, so a privileged supervisor would hand its privilege to the target).
 *  Returns the refusal reason, or null when running unprivileged. Unreadable credentials refuse too. */
export function supervisorSelfRefusal(): string | null {
  try {
    if (typeof process.geteuid === "function" && process.geteuid() === 0) return "refuses to run as root (euid 0)";
    const self = selfIds();
    if (self === null) return "refuses to run where its own credentials can't be read";
    if (self.ruid === 0 || self.euid === 0 || self.fsuid === 0) return "refuses to run as root (uid 0)";
    for (const line of readFileSync("/proc/self/status", "utf8").split("\n")) {
      if (line.startsWith("CapEff:")) {
        if (BigInt(`0x${line.split(/\s+/)[1]}`) !== 0n) return "refuses to run with effective capabilities";
        break;
      }
    }
  } catch {
    return "refuses to run where its own credentials can't be read";
  }
  return null;
}

/** Opens `/proc/<pid>` itself as a dir fd (O_PATH|O_DIRECTORY|O_NOFOLLOW), pinning the process against
 *  pid reuse: root, cwd and fd lookups below resolve relative to this handle, not by pid string. Returns -1
 *  on failure, with the kernel's errno in `err`. */
export function openProcPid(lib: SupervisorLib, pid: number): { fd: number; err: number } {
  const fd = Number(lib.openat(AT_FDCWD, bufOf(`/proc/${pid}`), (O_PATH | (fsConstants.O_DIRECTORY as number) | O_NOFOLLOW) >>> 0, 0));
  if (fd < 0) return { fd: -1, err: errNo(lib) };
  return { fd, err: 0 };
}

/** Opens the base a trapped path resolves from: the target's cwd, one of its dir fds, or its root — all
 *  resolved relative to the pinned `/proc/<pid>` handle (never by pid string, so a recycled pid cannot
 *  redirect them). Opens with O_PATH (never blocking, no read permission needed) and checks the result is
 *  a directory. The base is consumed; the caller closes the returned parent. Returns -1 on failure. */
export function resolveBase(lib: SupervisorLib, procFd: number, absolute: boolean, dirfd: number): { fd: number; err: number } {
  const openDir = (rel: string): { fd: number; err: number } => {
    const fd = Number(lib.openat(procFd, bufOf(rel), O_PATH, 0));
    if (fd < 0) return { fd: -1, err: errNo(lib) };
    try {
      if (!fstatSync(fd).isDirectory()) { try { closeSync(fd); } catch { /* gone */ } return { fd: -1, err: 20 }; // ENOTDIR
      }
    } catch { try { closeSync(fd); } catch { /* gone */ } return { fd: -1, err: 13 }; }
    return { fd, err: 0 };
  };
  if (absolute) return openDir("root");
  if (dirfd === AT_FDCWD) return openDir("cwd");
  return openDir(`fd/${dirfd}`);
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

/** Walks one trapped path to its open parent: resolves the base (cwd, dirfd or root — all magic links
 *  resolved relative to the pinned /proc/pid handle, no traversal), then lets the kernel resolve every
 *  component but the last (`openParentDir`). The path string was read ONCE from the target; nothing the
 *  target does afterwards (rewriting pointers, swapping links, moving mounts) redirects it. The base is
 *  consumed; the caller closes the returned parent. */
function walkOne(lib: SupervisorLib, procFd: number, dirfd: number, path: string, absolute: boolean): { parentFd: number; name: string } | { errno: number } {
  const { dir, name } = splitParent(path);
  if (name === "") {
    // An empty final component: ENOENT, except the root itself (`/`), which names `.` under its own root.
    if (!absolute) return { errno: 2 };
    const base = resolveBase(lib, procFd, true, dirfd);
    if (base.fd < 0) return { errno: base.err };
    return { parentFd: base.fd, name: "." };
  }
  const base = resolveBase(lib, procFd, absolute, dirfd);
  if (base.fd < 0) return { errno: base.err };
  if (dir === "" && !absolute) return { parentFd: base.fd, name };
  const w = openParentDir(lib, base.fd, dir);
  if ("errno" in w) return w;
  return { parentFd: w.parentFd, name };
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

/** The mount id of an open file, from its fdinfo (the kernel's own view — unlike device numbers, this catches
 *  same-filesystem bind mounts too). Null when unreadable. */
export function mntIdOf(fd: number): number | null {
  try {
    for (const line of readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").split("\n")) {
      const m = /^mnt_id:\s*(\d+)$/.exec(line.trim());
      if (m !== null) return parseInt(m[1]!, 10);
    }
  } catch { /* gone */ }
  return null;
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
const ADDFD_FLAG_SEND = 0x2; // SECCOMP_ADDFD_FLAG_SEND (5.14+): answer with the remote fd
const FILTER_FLAG_WAIT_KILLABLE_RECV = 0x20; // SECCOMP_FILTER_FLAG_WAIT_KILLABLE_RECV (5.19+)
const EACCES = 13, EINVAL = 22;

/** libc for the supervisor's own calls. Null where bun:ffi or libc isn't there. */
export function openSupervisorLib(): {
  syscall(nr: number, op: number, flags: number, prog: unknown): number;
  prctl(option: number, arg2: number, arg3: number, arg4: number, arg5: number): number;
  ioctl(fd: number, req: number, arg: unknown): number;
  poll(fds: unknown, nfds: number, timeout: number): number;
  openat(dirfd: number, path: unknown, flags: number, mode: number): number;
  mkdirat(dirfd: number, path: unknown, mode: number): number;
  mknodat(dirfd: number, path: unknown, mode: number, dev: number | bigint): number;
  linkat(olddirfd: number, oldpath: unknown, newdirfd: number, newpath: unknown, flags: number): number;
  symlinkat(target: unknown, newdirfd: number, newpath: unknown): number;
  renameat2(olddirfd: number, oldpath: unknown, newdirfd: number, newpath: unknown, flags: number): number;
  process_vm_readv(pid: number, local: unknown, liovcnt: number, remote: unknown, riovcnt: number, flags: number): number;
  __errno_location(): unknown;
  umask(mask: number): number;
  getpid(): number;
} | null {
  const lib = ffiLib("linux-supervisor", "libc.so.6", {
    syscall: { args: ["u64", "u64", "u64", "ptr"], returns: "i32" },
    prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
    ioctl: { args: ["i32", "u64", "ptr"], returns: "i32" },
    poll: { args: ["ptr", "u64", "i32"], returns: "i32" },
    openat: { args: ["i32", "ptr", "i32", "u32"], returns: "i32" },
    mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
    mknodat: { args: ["i32", "ptr", "u32", "u64"], returns: "i32" },
    linkat: { args: ["i32", "ptr", "i32", "ptr", "i32"], returns: "i32" },
    symlinkat: { args: ["ptr", "i32", "ptr"], returns: "i32" },
    renameat2: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" },
    process_vm_readv: { args: ["i32", "ptr", "u64", "ptr", "u64", "u64"], returns: "i32" },
    __errno_location: { args: [], returns: "ptr" },
    umask: { args: ["u32"], returns: "u32" },
    getpid: { args: [], returns: "i32" },
  });
  return lib as never;
}

/** Our own libc errno after a failed call (the wrappers return -1 and set it). */
function errNo(lib: SupervisorLib): number {
  try {
    const f = (lib as unknown as Record<string, () => unknown>).__errno_location;
    if (typeof f !== "function") return EACCES;
    const p = f() as unknown;
    const { toArrayBuffer } = require("bun:ffi") as typeof import("bun:ffi");
    return Buffer.from(toArrayBuffer(p as never, 0, 4) as ArrayBuffer).readInt32LE(0);
  } catch { return EACCES; }
}

/** Installs the filter with a new listener, returning the listener fd, or null. Unprivileged installs need
 *  no-new-privs first (the sandbox runs that way anyway); libc has no seccomp wrapper everywhere, so this uses
 *  the raw call (317 on x86-64, 277 on arm64). WAIT_KILLABLE_RECV (5.19+) is tried first so a stuck supervisor
 *  stays killable, falling back to plain NEW_LISTENER where the kernel predates it (EINVAL). */
export function installUserNotifFilter(lib: NonNullable<ReturnType<typeof openSupervisorLib>>, filter: Buffer, arch: string = process.arch): number | null {
  const PR_SET_NO_NEW_PRIVS = 38;
  const SYS_SECCOMP = arch === "arm64" ? 277 : 317;
  const SET_MODE_FILTER = 1;
  const NEW_LISTENER = 8; // SECCOMP_FILTER_FLAG_NEW_LISTENER
  if (lib.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) !== 0) return null;
  const prog = Buffer.alloc(16);
  prog.writeUInt16LE(filter.length / 8, 0);
  prog.writeBigUInt64LE(BigInt(ffiPtr(filter) as unknown as number), 8);
  let fd: number | bigint = lib.syscall(SYS_SECCOMP, SET_MODE_FILTER, NEW_LISTENER | FILTER_FLAG_WAIT_KILLABLE_RECV, ffiPtr(prog));
  let n = typeof fd === "bigint" ? Number(fd) : fd;
  if (n < 0 && errNo(lib as never) === EINVAL) {
    fd = lib.syscall(SYS_SECCOMP, SET_MODE_FILTER, NEW_LISTENER, ffiPtr(prog));
    n = typeof fd === "bigint" ? Number(fd) : fd;
  }
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

/** Injects our local fd into the target process and answers with it. ADDFD_FLAG_SEND (5.14+) makes the
 *  ioctl return the remote fd directly; older kernels predate the flag (EINVAL), where the ioctl returns 0
 *  and the fd is still installed — but without its number we cannot answer it, so that path fails closed.
 *  Closes the local fd either way. */
function injectFd(lib: SupervisorLib, listener: number, id: bigint, localFd: number, cloexec: boolean): SuperviseVerdict {
  const attempt = (flags: number): number => {
    const b = Buffer.alloc(24);
    b.writeBigUInt64LE(id, 0);
    b.writeUInt32LE(flags, 8);
    b.writeInt32LE(localFd, 12); // srcfd
    b.writeInt32LE(0, 16); // newfd unused without SETFD
    b.writeUInt32LE(cloexec ? O_CLOEXEC : 0, 20); // newfd_flags
    return Number(lib.ioctl(listener, NOTIF_ADDFD, ffiPtr(b)));
  };
  let remote = attempt(ADDFD_FLAG_SEND);
  if (remote < 0 && errNo(lib) === EINVAL) remote = attempt(0);
  try { closeSync(localFd); } catch { /* answered anyway */ }
  // The target's 0-2 are runCommand's pipes, so a fresh open never allocates 0; a 0 here is the pre-SEND
  // kernel's success-without-a-number, which cannot be answered truthfully — fail closed.
  if (remote <= 0) return VERDICT_DENY; // fail closed: no fd, no call
  return { val: remote, error: 0, cont: false };
}

/** Opens the final component for lstat-equivalent inspection without following it (`O_PATH|O_NOFOLLOW`), then
 *  stats the fd itself: links, directories and the missing case without ever resolving through a link. The
 *  device comes along for mountpoint checks. */
export function lstatFinal(lib: SupervisorLib, parentFd: number, name: string): { kind: "missing" } | { kind: "link" | "dir" | "other"; dev: bigint } | { errno: number } {
  const fd = Number(lib.openat(parentFd, bufOf(name), 0o10000000 | O_NOFOLLOW, 0)); // O_PATH|O_NOFOLLOW
  if (fd < 0) {
    const e = errNo(lib);
    return e === 2 ? { kind: "missing" } : { errno: e };
  }
  try {
    const s = fstatSync(fd);
    if (s.isSymbolicLink()) return { kind: "link", dev: BigInt(s.dev) };
    if (s.isDirectory()) return { kind: "dir", dev: BigInt(s.dev) };
    return { kind: "other", dev: BigInt(s.dev) };
  } catch (e) { return { errno: errnoOf(e) }; }
  finally { try { closeSync(fd); } catch { /* inspected */ } }
}

/** Performs an open-like call (open/openat/openat2/creat) with write intent: walks, refuses supervised finals
 *  and finals reached through links, then performs the open on the walked handle and injects the fd. Reads and
 *  opens of an existing file without O_CREAT continue (the ruling) — unless `noCont` (openat2 is never
 *  continued: its flags live in the target's memory, so continuing would let the kernel re-read them).
 *  The kernel never re-reads the target's pointers. The caller's umask is already the target's (switched per
 *  trap in `supervise`), so created files get the kernel's own setgid-inheritance and default-ACL behavior. */
function performOpen(lib: SupervisorLib, listener: number, id: bigint, procFd: number, dirfd: number, path: string, absolute: boolean, flags: bigint, mode: number, unsafe: readonly string[], noCont: boolean): SuperviseVerdict {
  const f = Number(flags & 0xffffffffffffffffn);
  // Reads never need the walk: continue, so the kernel handles even paths no walk could name (like `/` itself).
  if (!openWrites(flags) && !noCont) return VERDICT_CONT;
  const w = walkOne(lib, procFd, dirfd, path, absolute);
  if ("errno" in w) return verdictErr(w.errno);
  const { parentFd, name } = w;
  const done = (v: SuperviseVerdict): SuperviseVerdict => { try { closeSync(parentFd); } catch { /* answered */ } return v; };
  const fin = lstatFinal(lib, parentFd, name);
  if ("errno" in fin) return done(verdictErr(fin.errno)); // missing without O_CREAT lands here as ENOENT
  if (fin.kind === "link") return done((f & O_NOFOLLOW) !== 0 ? verdictErr(40) : VERDICT_DENY); // ELOOP, or refused
  // Without O_CREAT a missing final is ENOENT — never create it (an O_TMPFILE name is the exception: it names
  // the directory to create inside, and is handled below).
  if (fin.kind === "missing" && (f & O_CREAT) === 0 && (f & O_TMPFILE) === 0) return done(verdictErr(2));
  if (fin.kind !== "missing" && (f & O_CREAT) === 0 && !noCont) return done(VERDICT_CONT); // an existing file without O_CREAT may continue
  if (matchSupervised(parentFd, name, unsafe)) return done(VERDICT_DENY);
  // O_TMPFILE names a directory to create an unnamed file in: every supervised entry is a file, so this
  // branch can never match one — it is kept (not removed) so the performed call still returns the kernel's
  // own result for ordinary uses rather than inventing an error.
  if ((f & O_TMPFILE) !== 0) {
    const fd = Number(lib.openat(parentFd, bufOf(name), (f | O_NOFOLLOW) >>> 0, mode));
    if (fd < 0) return done(verdictErr(errNo(lib)));
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
  // Missing with O_CREAT: exclusive create (a race becomes EEXIST, handled below), then inject.
  let fd = Number(lib.openat(parentFd, bufOf(name), ((f | O_CREAT | O_EXCL | O_NOFOLLOW) >>> 0), mode));
  if (fd < 0) {
    if (errNo(lib) !== 17) return done(verdictErr(errNo(lib))); // not EEXIST: truthful error
    fd = Number(lib.openat(parentFd, bufOf(name), ((f | O_CREAT | O_NOFOLLOW) >>> 0), 0));
    if (fd < 0) return done(verdictErr(errNo(lib)));
  }
  const v = injectFd(lib, listener, id, fd, (f & O_CLOEXEC) !== 0);
  return done(v);
}

/** Performs a single-path mutating call (mkdir/mknod): walks, refuses supervised finals, runs it on the walked
 *  parent handle, and returns the real result or errno. Creation syscalls report EEXIST truthfully. The
 *  caller's umask is already the target's (switched per trap in `supervise`), so no chmod correction is
 *  needed — and none is done, so setgid inheritance and default ACLs behave exactly as the kernel does them. */
function performMake(lib: SupervisorLib, procFd: number, dirfd: number, path: string, absolute: boolean, unsafe: readonly string[], mode: number, make: (parentFd: number, name: string) => number): SuperviseVerdict {
  const w = walkOne(lib, procFd, dirfd, path, absolute);
  if ("errno" in w) return verdictErr(w.errno);
  const { parentFd, name } = w;
  const done = (v: SuperviseVerdict): SuperviseVerdict => { try { closeSync(parentFd); } catch { /* answered */ } return v; };
  if (matchSupervised(parentFd, name, unsafe)) return done(VERDICT_DENY);
  const r = make(parentFd, name);
  if (r !== 0) return done(verdictErr(errNo(lib)));
  return done({ val: 0, error: 0, cont: false });
}

/** Performs a two-path mutating call (rename/link): walks both parents, refuses a supervised destination, runs
 *  it on the walked handles, and returns the real result or errno. */
function performMove(lib: SupervisorLib, procFd: number, srcDirfd: number, srcPath: string, srcAbsolute: boolean, dstDirfd: number, dstPath: string, dstAbsolute: boolean, unsafe: readonly string[], move: (srcFd: number, srcName: string, dstFd: number, dstName: string) => number): SuperviseVerdict {
  const src = walkOne(lib, procFd, srcDirfd, srcPath, srcAbsolute);
  if ("errno" in src) return verdictErr(src.errno);
  const dst = walkOne(lib, procFd, dstDirfd, dstPath, dstAbsolute);
  if ("errno" in dst) { try { closeSync(src.parentFd); } catch { /* gone */ } return verdictErr(dst.errno); }
  const done = (v: SuperviseVerdict): SuperviseVerdict => {
    try { closeSync(src.parentFd); } catch { /* gone */ }
    try { closeSync(dst.parentFd); } catch { /* gone */ }
    return v;
  };
  if (matchSupervised(dst.parentFd, dst.name, unsafe)) return done(VERDICT_DENY);
  // Mountpoints can never be renamed (the kernel reports EBUSY): a final name whose mount id differs from its
  // parent's lives on another mount — including same-filesystem bind mounts, which share the parent's device
  // and a dev+ino check would miss. Detected through the supervisor's own fds; fail closed when unreadable.
  const EBUSY = 16;
  for (const [fd, name] of [[src.parentFd, src.name], [dst.parentFd, dst.name]] as const) {
    const fin = lstatFinal(lib, fd, name);
    if ("errno" in fin) { if (fin.errno !== 2) return done(verdictErr(fin.errno)); else continue; } // missing: fine
    if (fin.kind === "missing") continue; // nothing there: no mount to protect
    const self = Number(lib.openat(fd, bufOf(name), O_PATH | O_NOFOLLOW, 0));
    if (self < 0) return done(verdictErr(errNo(lib)));
    let verdict: SuperviseVerdict | null = null;
    try {
      const selfMnt = mntIdOf(self);
      const parentMnt = mntIdOf(fd);
      if (selfMnt === null || parentMnt === null) verdict = VERDICT_DENY;
      else if (selfMnt !== parentMnt) verdict = verdictErr(EBUSY);
    } finally { try { closeSync(self); } catch { /* inspected */ } }
    if (verdict !== null) return done(verdict);
  }
  const r = move(src.parentFd, src.name, dst.parentFd, dst.name);
  if (r !== 0) return done(verdictErr(errNo(lib)));
  return done({ val: 0, error: 0, cont: false });
}

/** Dispatches one trapped call: pins `/proc/<pid>`, checks the notification is still live, runs the call
 *  under the target's own umask (read through the pinned handle), then performs the operation on walked
 *  handles (or continues a read, or refuses a supervised plant). Never lets the kernel re-read the target's
 *  pointers. The supervisor is single-threaded here (the loop awaits only between traps), so switching the
 *  umask around each performed call is safe. */
function performTrap(lib: SupervisorLib, listener: number, n: SupervisorNotif, unsafe: readonly string[]): SuperviseVerdict {
  const spec = (trapTable() ?? TRAPS_X64).find((t) => t.nr === n.nr);
  if (spec === undefined) return VERDICT_DENY; // fail closed: the filter only traps the table
  // Pin /proc/<pid> FIRST, then check the id is still valid: a recycled pid gets a fresh id, so answering
  // would hit the wrong process — the loop's second check (before answering) closes the other side.
  const proc = openProcPid(lib, n.pid);
  if (proc.fd < 0) return VERDICT_DENY;
  try {
    if (!notifIdValid(lib, listener, n.id)) return VERDICT_DENY;
    // The target's umask, read through the pinned handle and switched around the single-threaded perform,
    // so setgid inheritance and default ACLs behave exactly as the kernel does them. Unreadable refuses:
    // never run a performed call under a guessed mask.
    const umask = targetUmask(proc.fd);
    if (umask === null) return VERDICT_DENY;
    const prev = lib.umask(umask);
    try {
      return dispatchTrap(lib, listener, n, spec, proc, unsafe);
    } finally {
      lib.umask(prev);
    }
  } finally {
    try { closeSync(proc.fd); } catch { /* pinned */ }
  }
}

/** Runs one trapped call: reads every pointer argument ONCE, then performs the operation on walked handles
 *  (or continues a read, or refuses a supervised plant). The umask is already the target's. */
function dispatchTrap(lib: SupervisorLib, listener: number, n: SupervisorNotif, spec: TrapSpec, proc: { fd: number }, unsafe: readonly string[]): SuperviseVerdict {
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
    // The *at flags word (absent on legacy rename/renameat/link: always 0 — never a neighbouring register).
    const atFlags = spec.flagsAt === undefined ? 0 : Number(n.args[spec.flagsAt] ?? 0n);
    if (spec.kind === "open" || spec.kind === "creat") {
      // Flags and mode are values, not pointers: no TOCTOU in reading them.
      const isOpenAt2 = spec.how !== undefined;
      let flags: bigint;
      let mode = 0;
      if (isOpenAt2) {
        // openat2: flags, mode and resolve live in its open_how struct. Never CONTINUE: the kernel would
        // re-read that memory — perform every openat2. The walk refuses every link and stays pinned under
        // the target's root (as strict as RESOLVE_NO_SYMLINKS), but it cannot emulate a scoped lookup, so
        // RESOLVE_BENEATH and RESOLVE_IN_ROOT are refused rather than silently ignored.
        const howAddr = n.args[spec.how];
        if (howAddr === undefined || howAddr === 0n) return VERDICT_DENY;
        const how = readPathOnce(lib, n.pid, howAddr, 32);
        if (how === null || how.length < 24) return VERDICT_DENY;
        flags = how.readBigUInt64LE(0);
        mode = Number(how.readBigUInt64LE(8) & 0o7777n);
        const resolve = how.readBigUInt64LE(16);
        if ((resolve & BigInt(RESOLVE_BENEATH | RESOLVE_IN_ROOT)) !== 0n) return VERDICT_DENY;
      } else if (spec.kind === "creat") {
        flags = BigInt(O_CREAT | O_WRONLY | O_TRUNC);
        mode = Number((n.args[1] ?? 0n) & 0o7777n);
      } else {
        flags = n.args[spec.dirfd === -1 ? 1 : 2] ?? 0n;
        if ((flags & BigInt(O_CREAT)) !== 0n) mode = Number((n.args[spec.dirfd === -1 ? 2 : 3] ?? 0n) & 0o7777n);
      }
      if (!openWrites(flags) && !isOpenAt2) return VERDICT_CONT; // reads pass untouched
      const at = spec.paths[0]!;
      const s = readAt(at);
      if (s === null) return VERDICT_DENY; // unreadable: fail closed
      return performOpen(lib, listener, n.id, proc.fd, dirfdOf(at), s, s.startsWith("/"), flags, mode, unsafe, isOpenAt2);
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
        const w = walkOne(lib, proc.fd, linkDirfd, link, link.startsWith("/"));
        if ("errno" in w) return verdictErr(w.errno);
        const done = (v: SuperviseVerdict): SuperviseVerdict => { try { closeSync(w.parentFd); } catch { /* answered */ } return v; };
        if (matchSupervised(w.parentFd, w.name, unsafe)) return done(VERDICT_DENY);
        const target = readAt(at);
        if (target === null) return done(VERDICT_DENY);
        const r = lib.symlinkat(bufOf(target), w.parentFd, bufOf(w.name));
        if (r !== 0) return done(verdictErr(errNo(lib)));
        return done({ val: 0, error: 0, cont: false });
      }
      const isMknod = n.nr === 133 || n.nr === 259 || n.nr === 33;
      // mknod's mode carries the file-type bits (S_IFIFO and friends) above the permission bits: keep them,
      // so a FIFO is still a FIFO. mkdir's mode is permissions only.
      const mode = spec.kind === "mutate" ? Number((n.args[at + 1] ?? 0o777n) & (isMknod ? 0o177777n : 0o7777n)) : 0;
      return performMake(lib, proc.fd, dirfd, s, absolute, unsafe, mode, (parentFd, name) => {
        if (spec.nr === 83 || spec.nr === 258 || spec.nr === 34) return lib.mkdirat(parentFd, bufOf(name), mode >>> 0);
        const dev = isMknod ? Number(n.args[at + 2] ?? 0n) : 0;
        return lib.mknodat(parentFd, bufOf(name), mode >>> 0, dev);
      });
    }
    // rename/link: two paths. The destination is identity-checked; the source is walked so the handles the
    // kernel acts on are ours (a link on the way is refused, never followed).
    const srcAt = spec.paths[0]!, dstAt = spec.paths[1]!;
    const src = readAt(srcAt);
    const dst = readAt(dstAt);
    if (src === null || dst === null) return VERDICT_DENY;
    const isLink = n.nr === 265 || n.nr === 37 || n.nr === 86;
    if (isLink && (atFlags & AT_SYMLINK_FOLLOW) !== 0) return VERDICT_DENY; // following a link to hardlink it: refuse
    const move = (srcFd: number, srcName: string, dstFd: number, dstName: string): number => {
      if (isLink) return lib.linkat(srcFd, bufOf(srcName), dstFd, bufOf(dstName), atFlags);
      return lib.renameat2(srcFd, bufOf(srcName), dstFd, bufOf(dstName), atFlags);
    };
    return performMove(lib, proc.fd, dirfdOf(srcAt), src, src.startsWith("/"), dirfdOf(dstAt), dst, dst.startsWith("/"), unsafe, move);
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
 *  unfiltered thread, so performed operations carry identical ownership and permission semantics; each trap
 *  runs under the target's own umask (switched around the single-threaded perform), and kernel mounts still
 *  apply to every performed call.
 *
 *  Note on future confinement: any Landlock or LSM policy applied to the supervisor itself would be bypassed
 *  by design here — performed calls act with the supervisor's credentials on the supervisor's fds, not the
 *  target's. Confinement belongs in the mounts (read-only binds) and the identity checks, not in restricting
 *  this process. */
export async function supervise(lib: SupervisorLib, listener: number, unsafe: readonly string[], isDone: () => boolean): Promise<void> {
  const selfRefusal = supervisorSelfRefusal();
  if (selfRefusal !== null) return; // fail closed: the shim maps a supervisor that never answers to refusal
  const me = lib.getpid() as number;
  // A trap from our own process (the worker thread that installed the filter shares our pid as its tgid but
  // reports its own tid): always continue without touching it.
  const isOurs = (tid: number): boolean => {
    if (tid === me) return true;
    try { return existsSync(`/proc/self/task/${tid}`); } catch { return false; }
  };
  // The target must run as us (the sandbox keeps the user's uid; no-new-privs blocks setuid gain): real,
  // effective AND filesystem uids must all match ours. Checked once against the first foreign trap — a
  // foreign user means fail closed for the rest of the run.
  let idsOk: boolean | null = null;
  const self = selfIds();
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
        idsOk = t !== null && self !== null &&
          t.ruid === self.ruid && t.euid === self.euid && t.fsuid === self.fsuid;
      }
      if (!idsOk) {
        if (notifIdValid(lib, listener, n.id)) sendVerdict(lib, listener, n.id, VERDICT_DENY);
        continue;
      }
      // The trap runs under the target's own umask (read through its pinned /proc handle inside the trap,
      // refused when unreadable); the loop's pre-answer id check is the second half of the pid sandwich.
      const verdict = performTrap(lib, listener, n, unsafe);
      if (notifIdValid(lib, listener, n.id)) sendVerdict(lib, listener, n.id, verdict);
    }
    await Bun.sleep(0);
  }
}
