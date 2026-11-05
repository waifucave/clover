// The caller check's OS probe (spec §3.1): who is on the other end of a connection. From the
// connection's descriptor it reads the peer's pid, walks the peer's parents (the process-tree half of
// the check), and inspects the peer for every sandbox and escape floor (the `sandbox-floor.ts` policy
// decides with it). Each step fails closed: a pid or a probe the OS won't give is "unknown", and an
// unknown peer is fenced, never the user.
//   macOS:   getsockopt(LOCAL_PEERPID); kinfo_proc's e_ppid (sysctl); sandbox_check(pid, NULL, 0)
//   Linux:   getsockopt(SO_PEERCRED); /proc/<pid>/stat; /proc/<pid>/ns/{user,mnt,pid,net} against ours
//   Windows: GetNamedPipeClientProcessId; NtQueryInformationProcess's parent; the token's
//            IsTokenRestricted and TokenIsAppContainer
// Mapping the result onto B's `Caller` (user, a session's command, the `clover` plugin host or
// another) is the wiring step once B's roles are in.
import { readFileSync, readlinkSync } from "node:fs";
import { callerFloorVerdict, type FloorVerdict, type SandboxProbe } from "./sandbox-floor";
import type { DaemonPlatform } from "./transport";

type Fn = (...args: unknown[]) => unknown;
type Lib = Record<string, Fn>;
const libs = new Map<string, Lib | null>();

function open(key: string, path: string, symbols: Record<string, { args: string[]; returns: string }>): Lib | null {
  if (libs.has(key)) return libs.get(key)!;
  let lib: Lib | null = null;
  try {
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const defs = Object.fromEntries(Object.entries(symbols).map(([name, s]) => [name, {
      args: s.args.map((a) => FFIType[a as keyof typeof FFIType]),
      returns: FFIType[s.returns as keyof typeof FFIType],
    }]));
    lib = dlopen(path, defs as never).symbols as unknown as Lib;
  } catch { lib = null; }
  libs.set(key, lib);
  return lib;
}

const ptr = (b: ArrayBufferView): unknown => (require("bun:ffi") as typeof import("bun:ffi")).ptr(b as never);

function libSystem(): Lib | null {
  return open("darwin", "/usr/lib/libSystem.B.dylib", {
    getsockopt: { args: ["i32", "i32", "i32", "ptr", "ptr"], returns: "i32" },
    sysctl: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "u64"], returns: "i32" },
    sandbox_check: { args: ["i32", "ptr", "i32"], returns: "i32" },
  });
}

function libc(): Lib | null {
  return open("linux", "libc.so.6", { getsockopt: { args: ["i32", "i32", "i32", "ptr", "ptr"], returns: "i32" } });
}

function kernel32(): Lib | null {
  return open("kernel32", "kernel32.dll", {
    GetNamedPipeClientProcessId: { args: ["u64", "ptr"], returns: "i32" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });
}

function advapi32(): Lib | null {
  return open("advapi32", "advapi32.dll", {
    OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
    GetTokenInformation: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    IsTokenRestricted: { args: ["u64"], returns: "i32" },
  });
}

function ntdll(): Lib | null {
  return open("ntdll", "ntdll.dll", { NtQueryInformationProcess: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" } });
}

function currentOs(): DaemonPlatform {
  return process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
}

/** The descriptor (or, on Windows, the pipe handle) under a Bun socket, which Bun exposes as an
 *  undocumented `fd`. `null` when it isn't there. */
export function socketFd(socket: unknown): number | null {
  const fd = (socket as { fd?: unknown } | null)?.fd;
  return typeof fd === "number" && fd >= 0 ? fd : null;
}

/** The peer process of a connected local socket or pipe, or `null`. */
export function peerPid(fd: number, os: DaemonPlatform = currentOs()): number | null {
  if (os === "darwin") {
    const l = libSystem();
    if (!l) return null;
    const out = new Int32Array(1), len = new Uint32Array([4]);
    // SOL_LOCAL 0, LOCAL_PEERPID 2
    return l.getsockopt!(fd, 0, 2, ptr(out), ptr(len)) === 0 && out[0]! > 0 ? out[0]! : null;
  }
  if (os === "linux") {
    const l = libc();
    if (!l) return null;
    const cred = new Int32Array(3), len = new Uint32Array([12]); // struct ucred { pid, uid, gid }
    // SOL_SOCKET 1, SO_PEERCRED 17
    return l.getsockopt!(fd, 1, 17, ptr(cred), ptr(len)) === 0 && cred[0]! > 0 ? cred[0]! : null;
  }
  const k = kernel32();
  if (!k) return null;
  const out = new Uint32Array(1);
  return (k.GetNamedPipeClientProcessId!(BigInt(fd), ptr(out)) as number) !== 0 && out[0]! > 0 ? out[0]! : null;
}

/** A process's parent, or `null` (gone, or the OS wouldn't say). */
export function parentPid(pid: number, os: DaemonPlatform = currentOs()): number | null {
  if (os === "darwin") {
    const l = libSystem();
    if (!l) return null;
    const mib = new Int32Array([1, 14, 1, pid]); // CTL_KERN, KERN_PROC, KERN_PROC_PID
    const out = Buffer.alloc(1024), len = new BigUint64Array([1024n]);
    if (l.sysctl!(ptr(mib), 4, ptr(out), ptr(len), null, 0n) !== 0 || len[0]! < 564n) return null;
    const ppid = out.readInt32LE(560); // kinfo_proc.kp_eproc.e_ppid (measured on arm64 and x86_64)
    return ppid > 0 ? ppid : null;
  }
  if (os === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]); // after "comm) state"
      return ppid > 0 ? ppid : null;
    } catch { return null; }
  }
  return withProcess(pid, (h) => {
    const n = ntdll();
    if (!n) return null;
    const info = Buffer.alloc(48), ret = new Uint32Array(1); // PROCESS_BASIC_INFORMATION
    if ((n.NtQueryInformationProcess!(h, 0, ptr(info), 48, ptr(ret)) as number) !== 0) return null;
    const ppid = Number(info.readBigUInt64LE(40)); // InheritedFromUniqueProcessId
    return ppid > 0 ? ppid : null;
  });
}

/** The peer's parents, nearest first, up to `max` or the first pid the OS won't follow. */
export function ancestry(pid: number, os: DaemonPlatform = currentOs(), max = 64): number[] {
  const out: number[] = [];
  const seen = new Set([pid]);
  let at = pid;
  while (out.length < max) {
    const p = parentPid(at, os);
    if (p === null || seen.has(p)) break;
    out.push(p);
    seen.add(p);
    at = p;
  }
  return out;
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, TOKEN_QUERY = 0x0008, TOKEN_IS_APP_CONTAINER = 29;

function withProcess<T>(pid: number, fn: (handle: bigint) => T | null): T | null {
  const k = kernel32();
  if (!k) return null;
  const h = BigInt(k.OpenProcess!(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) as number | bigint);
  if (h === 0n) return null;
  try { return fn(h); } finally { k.CloseHandle!(h); }
}

/** Inspect a process for the §3.1 floors. A field the OS won't give is left out (fail closed). */
export function sandboxProbe(pid: number, os: DaemonPlatform = currentOs()): SandboxProbe {
  if (os === "darwin") {
    const l = libSystem();
    if (!l) return {};
    // 0: not sandboxed. Non-zero: sandboxed, or a pid that is gone (both fenced).
    return { sandboxedMac: l.sandbox_check!(pid, null, 0) !== 0 };
  }
  if (os === "linux") {
    try {
      const same = ["user", "mnt", "pid", "net"].every((ns) => readlinkSync(`/proc/${pid}/ns/${ns}`) === readlinkSync(`/proc/self/ns/${ns}`));
      return { inHostNamespacesLinux: same };
    } catch { return {}; }
  }
  const r = withProcess(pid, (h) => {
    const a = advapi32();
    if (!a) return null;
    const tok = new BigUint64Array(1);
    if ((a.OpenProcessToken!(h, TOKEN_QUERY, ptr(tok)) as number) === 0) return null;
    const k = kernel32()!;
    try {
      const restricted = (a.IsTokenRestricted!(tok[0]!) as number) !== 0;
      const flag = new Uint32Array(1), ret = new Uint32Array(1);
      if ((a.GetTokenInformation!(tok[0]!, TOKEN_IS_APP_CONTAINER, ptr(flag), 4, ptr(ret)) as number) === 0) return { tokenRestrictedWin: restricted };
      return { tokenRestrictedWin: restricted, appContainerWin: flag[0]! !== 0 };
    } finally { k.CloseHandle!(tok[0]!); }
  });
  return r ?? {};
}

/** Everything the caller check knows about a connection's peer. */
export interface PeerFacts {
  /** The peer's pid, or `null` when the OS wouldn't give it (then `floor` is `fenced`). */
  readonly pid: number | null;
  /** Its parents, nearest first (the process-tree half of the check). */
  readonly ancestors: readonly number[];
  readonly probe: SandboxProbe;
  readonly floor: FloorVerdict;
}

/** Probe the peer of a connected Bun socket (or a descriptor). */
export function probePeer(socketOrFd: unknown, os: DaemonPlatform = currentOs()): PeerFacts {
  const fd = typeof socketOrFd === "number" ? socketOrFd : socketFd(socketOrFd);
  const pid = fd === null ? null : peerPid(fd, os);
  if (pid === null) return { pid: null, ancestors: [], probe: {}, floor: "fenced" };
  const probe = sandboxProbe(pid, os);
  return { pid, ancestors: ancestry(pid, os), probe, floor: callerFloorVerdict(os, probe) };
}

/** The process-tree half: whether any of `pid` and its parents is one the daemon started for a bot,
 *  an agent or a plugin (`spawned`), so the caller is that process's command and never the user. A
 *  double fork escapes this (the parent becomes init or launchd), which is why the floor exists. */
export function descendsFrom(facts: Pick<PeerFacts, "pid" | "ancestors">, spawned: ReadonlySet<number>): boolean {
  if (facts.pid !== null && spawned.has(facts.pid)) return true;
  return facts.ancestors.some((p) => spawned.has(p));
}
