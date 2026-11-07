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
import { closeSync, existsSync, openSync, readFileSync, readlinkSync, readSync } from "node:fs";
import { ffiLib, ffiPtr } from "../platform/ffi";

/** This machine's supervisor arch, or null where there is none (only x86-64 is measured). */
export function supervisorArch(arch: string = process.arch): "x64" | null {
  return arch === "x64" ? "x64" : null;
}

/** A trapped syscall: which argument holds the dir fd (-1 for none: AT_FDCWD), which hold paths, and for an
 *  open-like call how to tell a write from a read (`open` for open/openat/openat2, `creat` for creat which always
 *  writes, `mutate` for the rest which always change the tree). */
interface TrapSpec {
  readonly nr: number;
  readonly dirfd: number;
  readonly paths: readonly number[];
  readonly kind: "open" | "creat" | "mutate";
  readonly how?: number;
}

/** The mutating path syscalls and their arguments on x86-64 (`asm/unistd_64.h`). */
const TRAPS: readonly TrapSpec[] = [
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
  { nr: 266, dirfd: 0, paths: [1], kind: "mutate" }, // symlinkat (target, linkpath)
  { nr: 88, dirfd: -1, paths: [0, 1], kind: "mutate" }, // symlink (target, linkpath)
];

/** seccomp classic BPF that traps the table above with `SECCOMP_RET_USER_NOTIF` and allows everything else.
 *  Null where there is no supervisor. */
export function buildUserNotifFilter(arch: string = process.arch): Buffer | null {
  if (supervisorArch(arch) !== "x64") return null;
  const LD = 0x20, JEQ = 0x15, RET = 0x06, ALLOW = 0x7fff0000, NOTIF = 0x7fc00000;
  const AUDIT_ARCH_X86_64 = 0xc000003e;
  const k = TRAPS.length;
  const prog: [number, number, number, number][] = [
    [LD, 0, 0, 4],
    [JEQ, 0, k + 1, AUDIT_ARCH_X86_64],
    [LD, 0, 0, 0],
  ];
  TRAPS.forEach((t, i) => prog.push([JEQ, k - i, 0, t.nr]));
  prog.push([RET, 0, 0, ALLOW]);
  prog.push([RET, 0, 0, NOTIF]);
  const b = Buffer.alloc(prog.length * 8);
  prog.forEach(([code, jt, jf, v], i) => { b.writeUInt16LE(code, i * 8); b.writeUInt8(jt, i * 8 + 2); b.writeUInt8(jf, i * 8 + 3); b.writeUInt32LE(v >>> 0, i * 8 + 4); });
  return b;
}

/** Flags that make an open a write (`O_ACCMODE` and the creating/truncating flags). */
const O_WRONLY = 0o1, O_RDWR = 0o2, O_CREAT = 0o100, O_TRUNC = 0o1000, O_APPEND = 0o2000, O_TMPFILE = 0o20000000;

/** Whether an open-like call writes, from its flags word (openat2's comes from its open_how). */
export function openWrites(flags: bigint): boolean {
  const f = Number(flags & 0xffffffffffffffffn);
  return (f & 0o3) !== 0 || (f & (O_CREAT | O_TRUNC | O_APPEND)) !== 0 || (f & O_TMPFILE) !== 0;
}

/** Whether an absolute path is one of the supervised folders (exact), or folds onto one. */
export function matchUnsafe(absPath: string, unsafe: readonly string[]): boolean {
  if (unsafe.includes(absPath)) return true;
  const fold = (s: string) => s.normalize("NFC").toUpperCase().toLowerCase();
  const f = fold(absPath);
  return unsafe.some((u) => fold(u) === f);
}

/** What the supervisor reads from the traced process. `null` is fail-closed (deny). */
export interface ProcIo {
  /** The link's text, or null when it can't be read. */
  readlink(path: string): string | null;
  /** `len` bytes at `addr` in the process, NUL-terminated or shorter, or null when they can't be read. */
  readMem(pid: number, addr: bigint, len: number): Buffer | null;
}

/** A trapped call's number, arguments and target, as the notification carries them. */
export interface TrappedCall {
  readonly nr: number;
  readonly args: readonly bigint[];
  readonly pid: number;
}

/** Decides a trapped call: deny when it would write one of the supervised folders, allow otherwise. Reads (an
 *  open without write intent) always pass: the sandbox's read rules stay exactly the fence's. */
export function decideCall(call: TrappedCall, unsafe: readonly string[], io: ProcIo): "allow" | "deny" {
  const spec = TRAPS.find((t) => t.nr === call.nr);
  if (spec === undefined) return "allow";
  const readPath = (at: number): Buffer | null => {
    const addr = call.args[at];
    if (addr === undefined || addr === 0n) return null;
    return io.readMem(call.pid, addr, 4096);
  };
  const absolutize = (path: string, dirfd: number): string | null => {
    if (path.startsWith("/")) return path;
    if (dirfd === -100) { // AT_FDCWD: relative to the target's working directory
      const cwd = io.readlink(`/proc/${call.pid}/cwd`);
      return cwd === null ? null : `${cwd}/${path}`;
    }
    const dir = io.readlink(`/proc/${call.pid}/fd/${dirfd}`);
    return dir === null ? null : `${dir}/${path}`;
  };
  const norm = (p: string): string => p.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  // Dir fds arrive as unsigned 64-bit words: AT_FDCWD (-100) reads as 2^64-100, past Number's exact range.
  // Convert back to signed before comparing, or every relative path misresolves and fail-closes.
  const dirfdAt = (at: number): number => {
    let d = call.args[at - 1] ?? -100n;
    if (d >= (1n << 63n)) d -= (1n << 64n);
    return Number(d);
  };
  const check = (at: number): "deny" | null => {
    const raw = readPath(at);
    if (raw === null) return "deny"; // unreadable: fail closed
    const end = raw.indexOf(0);
    if (end < 0) return "deny"; // unterminated: fail closed
    // Each path's dirfd is the argument before it (AT_FDCWD where there is none).
    const dirfd = spec.dirfd === -1 ? -100 : dirfdAt(at);
    const abs = absolutize(raw.subarray(0, end).toString("utf8"), dirfd);
    if (abs === null) return "deny";
    return matchUnsafe(norm(abs), unsafe) ? "deny" : null;
  };
  if (spec.kind === "open") {
    // An open-like call (openat, open, openat2): reads pass.
    let flags: bigint;
    if (spec.how !== undefined) {
      // openat2: the write intent lives in its open_how struct.
      const how = call.args[spec.how];
      if (how === undefined || how === 0n) return "deny";
      const b = io.readMem(call.pid, how, 24);
      if (b === null || b.length < 24) return "deny";
      try { flags = b.readBigUInt64LE(0); } catch { return "deny"; }
    } else {
      flags = call.args[spec.dirfd === -1 ? 1 : 2] ?? 0n;
    }
    if (!openWrites(flags)) return "allow";
  }
  for (const at of spec.paths) {
    if (check(at) === "deny") return "deny";
  }
  return "allow";
}

// --- The user-notification plumbing (ioctl numbers from include/uapi/linux/seccomp.h) ---
const NOTIF_RECV = 0xc0502100; // _IOR(0x21, 0, struct seccomp_notif[80])
const NOTIF_SEND = 0xc0182101; // _IOWR(0x21, 1, struct seccomp_notif_resp[24])
const NOTIF_ID_VALID = 0x40082102; // _IOW(0x21, 2, __u64)
const NOTIF_CONTINUE = 1; // SECCOMP_USER_NOTIF_FLAG_CONTINUE
const EACCES = 13;
const SET_MODE_FILTER = 1;
const NEW_LISTENER = 8; // SECCOMP_FILTER_FLAG_NEW_LISTENER

/** libc for the supervisor's own calls. Null where bun:ffi or libc isn't there. */
export function openSupervisorLib(): {
  syscall(nr: number, op: number, flags: number, prog: unknown): number | bigint;
  prctl(option: number, arg2: number, arg3: number, arg4: number, arg5: number): number;
  ioctl(fd: number, req: number, arg: unknown): number;
  poll(fds: unknown, nfds: number, timeout: number): number;
  pread(fd: number, buf: unknown, count: number, offset: bigint): bigint;
  getpid(): number;
} | null {
  const lib = ffiLib("linux-supervisor", "libc.so.6", {
    syscall: { args: ["u64", "u64", "u64", "ptr"], returns: "i64" },
    prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
    ioctl: { args: ["i32", "u64", "ptr"], returns: "i32" },
    poll: { args: ["ptr", "u64", "i32"], returns: "i32" },
    pread: { args: ["i32", "ptr", "u64", "i64"], returns: "i64" },
    getpid: { args: [], returns: "i32" },
  });
  return lib as never;
}

/** Installs the filter with a new listener, returning the listener fd, or null. Unprivileged installs need
 *  no-new-privs first (the sandbox runs that way anyway); libc has no seccomp wrapper everywhere, so this uses the
 *  raw call (x86-64). */
export function installUserNotifFilter(lib: NonNullable<ReturnType<typeof openSupervisorLib>>, filter: Buffer): number | null {
  const PR_SET_NO_NEW_PRIVS = 38;
  const SYS_SECCOMP = 317;
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

/** Answers a notification: EACCES for a refused plant, continue for everything else. */
export function sendVerdict(lib: NonNullable<ReturnType<typeof openSupervisorLib>>, listener: number, id: bigint, allow: boolean): void {
  const b = Buffer.alloc(24);
  b.writeBigUInt64LE(id, 0);
  b.writeBigInt64LE(0n, 8); // val: unused (allow continues, deny reports via error)
  b.writeInt32LE(allow ? 0 : -EACCES, 16); // error: negative errno on deny
  b.writeUInt32LE(allow ? NOTIF_CONTINUE : 0, 20); // flags
  lib.ioctl(listener, NOTIF_SEND, ffiPtr(b));
}

/** Whether the listener has a notification waiting (milliseconds to wait). */
export function pollReadable(lib: NonNullable<ReturnType<typeof openSupervisorLib>>, listener: number, timeoutMs: number): boolean {
  const fds = Buffer.alloc(8);
  fds.writeInt32LE(listener, 0);
  fds.writeUInt16LE(1, 4); // POLLIN
  return (lib.poll(ffiPtr(fds), 1, timeoutMs) as number) > 0;
}

export type SupervisorLib = NonNullable<ReturnType<typeof openSupervisorLib>>;

/** The host's view of a traced process: readlink for cwd and dir fds, and pread for the argument bytes (an
 *  explicit 64-bit offset: high addresses must not be truncated). Anything unreadable fails closed (deny). */
export function hostProcIo(lib: SupervisorLib): ProcIo {
  return {
    readlink: (p) => { try { return readlinkSync(p); } catch { return null; } },
    readMem: (pid, addr, len) => {
      let fd = -1;
      try {
        fd = openSync(`/proc/${pid}/mem`, "r");
        const out = Buffer.alloc(Math.min(len, 4096));
        let at = 0;
        while (at < out.length) {
          const n = Number(lib.pread(fd, ffiPtr(out.subarray(at)) as never, out.length - at, addr + BigInt(at)));
          if (!(n > 0)) break;
          const end = out.indexOf(0, at);
          if (end >= 0) return out.subarray(0, end + 1);
          at += n;
        }
        return null;
      } catch { return null; }
      finally { if (fd !== -1) { try { closeSync(fd); } catch { /* gone */ } } }
    },
  };
}

/** Runs the supervisor loop until `isDone`: answers every trapped call, re-checking each notification's id
 *  immediately before answering it. Yields between polls so the child's exit is noticed. */
export async function supervise(lib: SupervisorLib, listener: number, unsafe: readonly string[], io: ProcIo, isDone: () => boolean): Promise<void> {
  const me = lib.getpid() as number;
  // A trap from our own process (the worker thread that installed the filter shares our pid as its tgid but
  // reports its own tid): always allow without reading its memory (`/proc/<tid>` isn't its view).
  const isOurs = (tid: number): boolean => {
    if (tid === me) return true;
    try { return existsSync(`/proc/self/task/${tid}`); } catch { return false; }
  };
  for (;;) {
    if (isDone()) return;
    if (!pollReadable(lib, listener, 50)) continue;
    // Drain what's queued: re-poll (0ms) before every receive, since a receive blocks on an empty queue.
    for (;;) {
      if (!pollReadable(lib, listener, 0)) break;
      const n = recvNotif(lib, listener);
      if (n === null) break;
      // Our own threads never plant: continue fast. Everything else is judged.
      const verdict = isOurs(n.pid) ? "allow" : decideCall({ nr: n.nr, args: n.args, pid: n.pid }, unsafe, io);
      if (notifIdValid(lib, listener, n.id)) sendVerdict(lib, listener, n.id, verdict === "allow");
    }
    await Bun.sleep(0);
  }
}
