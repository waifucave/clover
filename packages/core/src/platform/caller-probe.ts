// The caller check's OS probe (spec §3.1): who is on the other end of a connection. From the
// connection's descriptor it reads the peer's pid, walks the peer's parents (the process-tree half of
// the check), and inspects the peer for every sandbox and escape floor (the `sandbox-floor.ts` policy
// decides with it). Each step fails closed: a pid or a probe the OS won't give is "unknown", and an
// unknown peer is fenced, never the user.
//   macOS:   getsockopt(LOCAL_PEERPID); kinfo_proc's e_ppid (sysctl); sandbox_check(pid, NULL, 0)
//   Linux:   getsockopt(SO_PEERCRED); /proc/<pid>/stat; /proc/<pid>/ns/{user,mnt,pid,net} against ours
//   Windows: Bun's pipe sockets carry no handle (fd -1, measured), so `WindowsPipePeers` finds the
//            connection's server end among the daemon's own handles and asks it
//            (GetNamedPipeClientProcessId); NtQueryInformationProcess's parent; the token's
//            IsTokenRestricted and TokenIsAppContainer
// Mapping the result onto B's `Caller` (user, a session's command, the `clover` plugin host or
// another) is the wiring step once B's roles are in.
import { readFileSync, readlinkSync } from "node:fs";
import { callerFloorVerdict, type FloorVerdict, type SandboxProbe } from "./sandbox-floor";
import { inDaemonJob } from "./win-job";
import type { PeerHandle } from "./peer-handle";
import type { DaemonPlatform } from "./transport";

import { ffiLib as open, ffiPtr as ptr, type FfiLib as Lib } from "./ffi";

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
    GetCurrentProcess: { args: [], returns: "u64" },
    GetFileType: { args: ["u64"], returns: "u32" },
    GetNamedPipeInfo: { args: ["u64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    GetNamedPipeClientProcessId: { args: ["u64", "ptr"], returns: "i32" },
    GetFileInformationByHandleEx: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
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

function libSystemExtra(): Lib | null {
  return open("darwin-extra", "/usr/lib/libSystem.B.dylib", {
    getpeereid: { args: ["i32", "ptr", "ptr"], returns: "i32" },
    proc_pidpath: { args: ["i32", "ptr", "u32"], returns: "i32" },
  });
}

/** The uid of the process on the other end of a connected Unix socket: `getpeereid` on macOS, `SO_PEERCRED`'s
 *  uid on Linux. For a client, the server's. */
export function peerUid(fd: number, os: DaemonPlatform = currentOs()): number | null {
  if (os === "darwin") {
    const uid = new Uint32Array(1), gid = new Uint32Array(1);
    return (libSystemExtra()?.getpeereid?.(fd, ptr(uid), ptr(gid)) as number | undefined) === 0 ? uid[0]! : null;
  }
  if (os === "linux") {
    const cred = new Int32Array(3), len = new Uint32Array([12]);
    return (libc()?.getsockopt?.(fd, 1, 17, ptr(cred), ptr(len)) as number | undefined) === 0 ? cred[1]! >>> 0 : null;
  }
  return null;
}

/** The executable a process runs: `proc_pidpath` on macOS, `/proc/<pid>/exe` on Linux. */
export function processImage(pid: number, os: DaemonPlatform = currentOs()): string | null {
  if (os === "darwin") {
    const buf = Buffer.alloc(4096);
    const n = libSystemExtra()?.proc_pidpath?.(pid, ptr(buf), buf.length) as number | undefined;
    return n !== undefined && n > 0 ? buf.subarray(0, n).toString("utf8") : null;
  }
  if (os === "linux") { try { return readlinkSync(`/proc/${pid}/exe`); } catch { return null; } }
  return null;
}

/** macOS's responsible process (the one TCC attributes a process to). It survives a double fork, so whatever the daemon
 *  starts keeps the daemon's: the daemon's own pid when it is its own responsible process (`supervise` starts it so,
 *  daemon-children.ts), while the app (started by `open`) and a terminal's CLI have their own. */
function responsibility(): Lib | null {
  return open("darwin-responsibility", "/usr/lib/libSystem.B.dylib", {
    responsibility_get_pid_responsible_for_pid: { args: ["i32"], returns: "i32" },
  });
}

/** macOS: the process `pid` is responsible to (TCC's attribution), or null. A double fork, a `setsid`, a reparent to
 *  launchd and a cleared environment all keep it; only a process spawned with its responsibility disclaimed starts its
 *  own (measured with a dummy disclaimed parent and its double-forked, setsid'd grandchild). */
export function responsiblePid(pid: number, os: DaemonPlatform = currentOs()): number | null {
  if (os !== "darwin") return null;
  const r = responsibility()?.responsibility_get_pid_responsible_for_pid?.(pid) as number | undefined;
  return r !== undefined && r > 0 ? r : null;
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
  /** Started by this daemon, however indirectly: the daemon is among its parents (Linux re-parents a double fork
   *  to it, `PR_SET_CHILD_SUBREAPER`), macOS names the daemon its responsible process, or on Windows it runs in the
   *  daemon's job. Such a process is never the user or the app (review B1). */
  readonly spawnedByDaemon?: boolean;
  /** The process itself, held for the connection's life (review S5): the kill goes through it, never the pid. */
  readonly handle?: PeerHandle;
  /** macOS: the process the peer is responsible to (`responsiblePid`). A process the daemon started on its own
   *  responsibility (the process holder, a disclaimed spawn) is the responsible process of everything under it, after
   *  a `setsid` and a reparent to launchd too, so the caller check finds it among the daemon's noted pids. */
  readonly responsible?: number;
}

/** Whether `pid` (with its parents) was started by this daemon (see `PeerFacts.spawnedByDaemon`). The daemon
 *  itself is not its own child. */
export function spawnedByDaemon(pid: number, ancestors: readonly number[], os: DaemonPlatform = currentOs(), self = process.pid): boolean {
  if (pid === self) return false;
  if (ancestors.includes(self)) return true;
  if (os === "darwin") {
    // Only when the daemon is its own responsible process: otherwise its responsible process (a terminal) is shared
    // with the user's own CLI there, and tells nothing.
    const resp = responsibility()?.responsibility_get_pid_responsible_for_pid;
    const r = resp?.(pid) as number | undefined;
    if (r !== undefined && r === self && resp?.(self) === self) return true;
  }
  if (os === "win32" && inDaemonJob(pid)) return true;
  return false;
}

/** Probe the peer of a connected Bun socket (or a descriptor). On Windows pass the pid
 *  `WindowsPipePeers` found, since the socket carries no handle there. With the connection's `handle`
 *  (`peerHandle`), the pid is its, the floor is read through it where the OS allows, and a process that is no
 *  longer the one connected (its pid reused) is fenced (review S5). */
export function probePeer(socketOrFd: unknown, os: DaemonPlatform = currentOs(), knownPid?: number | null, handle?: PeerHandle | null): PeerFacts {
  const fd = typeof socketOrFd === "number" ? socketOrFd : socketFd(socketOrFd);
  const pid = handle ? handle.pid : knownPid !== undefined ? knownPid : fd === null ? null : peerPid(fd, os);
  if (pid === null) return { pid: null, ancestors: [], probe: {}, floor: "fenced" };
  const probe = handle?.probe() ?? sandboxProbe(pid, os);
  const ancestors = ancestry(pid, os);
  const spawned = spawnedByDaemon(pid, ancestors, os);
  const resp = responsiblePid(pid, os);
  const responsible = resp === null ? {} : { responsible: resp };
  // Read last: every fact above is about the connected process only if it is still there.
  if (handle && !handle.alive()) return { pid, ancestors, probe, floor: "fenced", spawnedByDaemon: spawned, ...responsible, handle };
  return { pid, ancestors, probe, floor: callerFloorVerdict(os, probe), spawnedByDaemon: spawned, ...responsible, ...(handle ? { handle } : {}) };
}

/** One of the daemon's own handles, from NtQueryInformationProcess(ProcessHandleInformation). */
export interface OwnHandle { readonly handle: bigint; readonly access: number }

export function ownHandles(): OwnHandle[] | null {
  const n = ntdll(), k = kernel32();
  if (!n || !k) return null;
  let size = 1 << 16;
  for (let tries = 0; tries < 6; tries++) {
    const buf = Buffer.alloc(size), ret = new Uint32Array(1);
    const status = (n.NtQueryInformationProcess!(k.GetCurrentProcess!(), 51, ptr(buf), size, ptr(ret)) as number) >>> 0;
    if (status === 0xc0000004) { size = Math.max(size * 2, ret[0]! + 4096); continue; } // STATUS_INFO_LENGTH_MISMATCH
    if (status !== 0) return null;
    // PROCESS_HANDLE_SNAPSHOT_INFORMATION: a count, then 40-byte entries (HandleValue, HandleCount,
    // PointerCount, GrantedAccess, ObjectTypeIndex, HandleAttributes, Reserved).
    const count = Number(buf.readBigUInt64LE(0));
    const out: OwnHandle[] = [];
    for (let i = 0; i < count; i++) out.push({ handle: buf.readBigUInt64LE(16 + i * 40), access: buf.readUInt32LE(16 + i * 40 + 24) });
    return out;
  }
  return null;
}

/** A pipe handle's name as GetFileInformationByHandleEx gives it (`\\name`), folded. */
function pipeHandleName(h: bigint): string | null {
  const buf = Buffer.alloc(4 + 1024);
  if ((kernel32()!.GetFileInformationByHandleEx!(h, 2 /* FileNameInfo */, ptr(buf), buf.length) as number) === 0) return null;
  return buf.subarray(4, 4 + buf.readUInt32LE(0)).toString("utf16le").toLowerCase();
}

/** `\\.\pipe\name` → `\name`, folded: the form `pipeHandleName` compares with. */
export function pipeEndName(endpoint: string): string {
  return `\\${endpoint.replace(/^\\\\\.\\pipe\\/i, "")}`.toLowerCase();
}

/** The connected server ends of the named pipe `name` (`pipeEndName`) among `handles`, with their clients' pids;
 *  every pipe's when `name` is null. Another pipe the daemon serves (S7's browser pipes, H's sidecar) never counts
 *  for this endpoint's connections (review S4). */
function connectedServerEnds(handles: readonly OwnHandle[], name: string | null): Map<bigint, { pid: number }> {
  const k = kernel32()!;
  const out = new Map<bigint, { pid: number }>();
  for (const h of handles) {
    if ((k.GetFileType!(h.handle) as number) !== 3) continue; // FILE_TYPE_PIPE
    const flags = new Uint32Array(1);
    if ((k.GetNamedPipeInfo!(h.handle, ptr(flags), null, null, null) as number) === 0 || (flags[0]! & 1) === 0) continue; // PIPE_SERVER_END
    if (name !== null && pipeHandleName(h.handle) !== name) continue;
    const pid = new Uint32Array(1);
    if ((k.GetNamedPipeClientProcessId!(h.handle, ptr(pid)) as number) !== 0 && pid[0]! > 0) out.set(h.handle, { pid: pid[0]! });
  }
  return out;
}

/** WRITE_DAC: libuv creates its named pipe server ends with it (measured: 0x1e019f for the first
 *  instance, 0x16019f after), and the daemon's files and anonymous pipes don't ask for it. */
const WRITE_DAC = 0x40000;

/**
 * Windows: the pid on the other end of each pipe connection. Bun's pipe sockets carry no handle, so
 * when the listener's `open(socket)` runs, this lists the daemon's own handles, takes the connected
 * server ends of named pipes, and gives the socket the one end no earlier socket has (spike on the
 * lane's VM: 1.4–2.3 ms with 206 handles). Two connections that arrive before either is seen, with
 * different clients, are ambiguous and get `null` (fenced; the client connects again). Only handles
 * opened with WRITE_DAC are asked anything, so the daemon's files and other pipes are never touched.
 */
export class WindowsPipePeers {
  private readonly owner = new Map<bigint, object>();
  private readonly bySocket = new WeakMap<object, { handle: bigint; pid: number }>();
  private readonly name: string | null;
  /** Server ends already connected when the pipe's DACL was locked down: their sockets are closed (review M3). */
  private early = new Set<bigint>();

  /** `endpoint`: the pipe this listener serves; only its ends are matched. */
  constructor(endpoint?: string) { this.name = endpoint === undefined ? null : pipeEndName(endpoint); }

  /** Right after the DACL is locked down: whatever is connected now connected under the default DACL. */
  lockedDown(): void {
    const handles = ownHandles();
    this.early = new Set(handles === null ? [] : connectedServerEnds(handles.filter((h) => (h.access & WRITE_DAC) !== 0), this.name).keys());
  }

  /** Whether this socket's connection was made before the DACL was locked down. */
  isEarly(socket: object): boolean {
    const e = this.bySocket.get(socket);
    return e !== undefined && this.early.has(e.handle);
  }

  /** The listener's `open(socket)`: the client pid of this connection, or null. */
  opened(socket: object): number | null {
    const handles = ownHandles();
    if (handles === null) return null;
    const ends = connectedServerEnds(handles.filter((h) => (h.access & WRITE_DAC) !== 0), this.name);
    for (const h of [...this.owner.keys()]) if (!ends.has(h)) this.owner.delete(h);
    const fresh = [...ends].filter(([h]) => !this.owner.has(h)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (fresh.length === 0 || new Set(fresh.map(([, e]) => e.pid)).size !== 1) return null;
    const [handle, end] = fresh[0]!;
    this.owner.set(handle, socket);
    this.bySocket.set(socket, { handle, pid: end.pid });
    return end.pid;
  }

  /** The listener's `close(socket)`. */
  closed(socket: object): void {
    const e = this.bySocket.get(socket);
    if (e && this.owner.get(e.handle) === socket) this.owner.delete(e.handle);
    this.bySocket.delete(socket);
  }

  pidOf(socket: object): number | null {
    return this.bySocket.get(socket)?.pid ?? null;
  }
}

/** The process-tree half: whether any of `pid` and its parents is one the daemon started for a bot,
 *  an agent or a plugin (`spawned`), so the caller is that process's command and never the user. A
 *  double fork escapes this (the parent becomes init or launchd), which is why the floor exists. */
export function descendsFrom(facts: Pick<PeerFacts, "pid" | "ancestors"> & Partial<Pick<PeerFacts, "responsible">>, spawned: ReadonlySet<number>): boolean {
  if (facts.pid !== null && spawned.has(facts.pid)) return true;
  // macOS: responsible to one the daemon started on its own responsibility (a holder, a disclaimed spawn), however far
  // it has gone from it (a double fork, `setsid`, launchd as its parent).
  if (facts.responsible !== undefined && spawned.has(facts.responsible)) return true;
  return facts.ancestors.some((p) => spawned.has(p));
}
