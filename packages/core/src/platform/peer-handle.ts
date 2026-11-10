// A connection's peer process, held so a later pid can't stand in for it (review S5, C-M2's first item). A pid read
// at hello time can belong to someone else later: a fenced client whose child keeps the socket open can wait until its
// pid is reused. So each connection keeps what the OS gives to name the process itself, not its number:
//   macOS    the peer's audit token (LOCAL_PEERTOKEN), whose pid version the kernel checks: the sandbox floor is read
//            through it (`sandbox_check_by_audit_token`), and the process's start time is kept for the kill
//   Linux    a pidfd (SO_PEERPIDFD, kernel 6.5 or later): alive and kill go through it (`pidfd_send_signal`), and the
//            floor's namespace reads count only while it says the process is still there
//   Windows  the client's process handle, opened as the connection opens and held for its life: while it is held
//            the pid can't be given to another process, so the floor and the daemon's-job check read by pid, and the
//            kill goes through the handle
// Where none is available (an older kernel, x86_64 macOS for the token's floor), it falls back to the pid, as before.
import { readFileSync, readlinkSync } from "node:fs";
import { ffiLib, ffiPtr as ptr } from "./ffi";
import type { SandboxProbe } from "./sandbox-floor";
import type { DaemonPlatform } from "./transport";

export interface PeerHandle {
  readonly pid: number;
  /** How it's held: `token` (macOS), `pidfd` (Linux), `handle` (Windows), or `pid` alone. */
  readonly via: "token" | "pidfd" | "handle" | "pid";
  /** Still the same process. */
  alive(): boolean;
  /** Ends that process, never another with its pid. False when it's gone. */
  kill(): boolean;
  /** The floor's facts, read through the handle where the OS allows it; null to read them by pid. */
  probe(): SandboxProbe | null;
  /** macOS: the peer's 32-byte audit token (pid plus pid version), for the `app` role's code-signature check
   *  (`peer-signature.ts`). Absent elsewhere and wherever the kernel gave no token. */
  readonly auditToken?: Uint8Array;
  close(): void;
}

function darwin() {
  return ffiLib("peer-darwin", "/usr/lib/libSystem.B.dylib", {
    getsockopt: { args: ["i32", "i32", "i32", "ptr", "ptr"], returns: "i32" },
    proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
  });
}

function darwinSandbox() {
  return ffiLib("peer-darwin-sandbox", "/usr/lib/libSystem.B.dylib", {
    sandbox_check_by_audit_token: { args: ["ptr", "ptr", "i32"], returns: "i32" },
  });
}

function linux() {
  return ffiLib("peer-linux", "libc.so.6", {
    getsockopt: { args: ["i32", "i32", "i32", "ptr", "ptr"], returns: "i32" },
    syscall: { args: ["i64", "i32", "i32", "ptr", "u32"], returns: "i64" },
    close: { args: ["i32"], returns: "i32" },
    __errno_location: { args: [], returns: "ptr" },
  });
}

function win() {
  return ffiLib("peer-win", "kernel32.dll", {
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
    WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
    TerminateProcess: { args: ["u64", "u32"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });
}

/** macOS: a process's start time (PROC_PIDTBSDINFO's pbi_start_tvsec and _tvusec), to tell it from a later one. */
function darwinStart(pid: number): string | null {
  const d = darwin();
  if (!d) return null;
  const info = Buffer.alloc(136);
  if ((d.proc_pidinfo!(pid, 3 /* PROC_PIDTBSDINFO */, 0n, ptr(info), info.length) as number) !== info.length) return null;
  return `${info.readBigUInt64LE(120)}.${info.readBigUInt64LE(128)}`;
}

const SYS_PIDFD_SEND_SIGNAL = 424n; // the same number on x86_64 and arm64 (the shared table since 5.1)
const SO_PEERPIDFD = 77;

/** A peer that is already gone when the connection is looked at: fenced, never a pid that someone else may have now
 *  (#205's S1). */
function gone(pid: number): PeerHandle {
  return { pid, via: "pidfd", alive: () => false, kill: () => false, probe: () => ({}), close: () => {} };
}

const ENOPROTOOPT = 92;

/** SO_PEERPIDFD came with Linux 6.5. */
function kernelHasPeerPidfd(release: string = require("node:os").release()): boolean {
  const m = /^(\d+)\.(\d+)/.exec(release);
  return m !== null && (Number(m[1]) > 6 || (Number(m[1]) === 6 && Number(m[2]) >= 5));
}

function pidOnly(pid: number): PeerHandle {
  return {
    pid, via: "pid",
    alive: () => { try { process.kill(pid, 0); return true; } catch { return false; } },
    kill: () => { try { process.kill(pid, "SIGKILL"); return true; } catch { return false; } },
    probe: () => null,
    close: () => {},
  };
}

/** The peer of a connected socket's descriptor (macOS, Linux), or of a pipe connection whose client pid is known
 *  (Windows). Null when the OS names no process. */
export function peerHandle(fd: number | null, os: DaemonPlatform, knownPid?: number | null): PeerHandle | null {
  if (os === "win32") {
    if (knownPid === undefined || knownPid === null) return null;
    const k = win();
    if (!k) return pidOnly(knownPid);
    let h = BigInt(k.OpenProcess!(0x1000 /* QUERY_LIMITED */ | 0x100000 /* SYNCHRONIZE */ | 0x1 /* TERMINATE */, 0, knownPid) as number | bigint);
    // A process we may not end (another user's, a protected one) is still held, so its pid can't be reused.
    if (h === 0n) h = BigInt(k.OpenProcess!(0x1000 | 0x100000, 0, knownPid) as number | bigint);
    if (h === 0n) return pidOnly(knownPid);
    let open = true;
    return {
      pid: knownPid, via: "handle",
      alive: () => open && (k.WaitForSingleObject!(h, 0) as number) === 258 /* WAIT_TIMEOUT */,
      kill: () => open && (k.WaitForSingleObject!(h, 0) as number) === 258 && (k.TerminateProcess!(h, 1) as number) !== 0,
      probe: () => null, // the token's flags are read by pid while this handle keeps the process (and its pid) alive
      close: () => { if (open) { open = false; k.CloseHandle!(h); } },
    };
  }
  if (fd === null) return null;
  if (os === "darwin") {
    const d = darwin();
    if (!d) return null;
    const token = new Uint32Array(8), len = new Uint32Array([32]);
    if ((d.getsockopt!(fd, 0 /* SOL_LOCAL */, 6 /* LOCAL_PEERTOKEN */, ptr(token), ptr(len)) as number) !== 0) return null;
    const pid = token[5]!;
    if (!(pid > 0)) return null;
    const started = darwinStart(pid);
    const same = () => started !== null && darwinStart(pid) === started;
    // A 32-byte struct passed by value goes by reference on arm64, so a pointer is the call; x86_64 passes it on the
    // stack, which bun:ffi can't, so there the floor is read by pid (still checked against the start time).
    const sb = process.arch === "arm64" ? darwinSandbox() : null;
    return {
      pid, via: "token",
      auditToken: new Uint8Array(token.buffer.slice(0)),
      alive: same,
      kill: () => { if (!same()) return false; try { process.kill(pid, "SIGKILL"); return true; } catch { return false; } },
      probe: () => (sb ? { sandboxedMac: (sb.sandbox_check_by_audit_token!(ptr(token), null, 0) as number) !== 0 } : null),
      close: () => {},
    };
  }
  const l = linux();
  if (!l) return null;
  const cred = new Int32Array(3), clen = new Uint32Array([12]);
  const credPid = (l.getsockopt!(fd, 1, 17 /* SO_PEERCRED */, ptr(cred), ptr(clen)) as number) === 0 && cred[0]! > 0 ? cred[0]! : 0;
  const out = new Int32Array(1), len = new Uint32Array([4]);
  if ((l.getsockopt!(fd, 1 /* SOL_SOCKET */, SO_PEERPIDFD, ptr(out), ptr(len)) as number) !== 0 || out[0]! < 0) {
    // Only a kernel without SO_PEERPIDFD (before 6.5) falls back to SO_PEERCRED's pid; any other failure (ESRCH: the
    // peer has exited) is a peer that is gone.
    // ENOPROTOOPT, or a kernel before 6.5 (errno is read after the call, and Bun may have touched it since, so the
    // version decides too): the option doesn't exist here.
    const errno = (require("bun:ffi") as typeof import("bun:ffi")).read.i32(l.__errno_location!() as never, 0);
    if (errno === ENOPROTOOPT || !kernelHasPeerPidfd()) return credPid > 0 ? pidOnly(credPid) : null;
    return gone(credPid);
  }
  const pidfd = out[0]!;
  let pid = 0;
  try { pid = Number(/^Pid:\s+(-?\d+)/m.exec(readFileSync(`/proc/self/fdinfo/${pidfd}`, "utf8"))?.[1] ?? 0); } catch { /* no fdinfo */ }
  // `Pid: -1`: the process has exited (and been reaped); 0: in a pid namespace we can't see into. Both are fenced.
  if (!(pid > 0)) { l.close!(pidfd); return gone(credPid); }
  let open = true;
  const signal = (sig: number) => open && Number(l.syscall!(SYS_PIDFD_SEND_SIGNAL, pidfd, sig, null, 0)) === 0;
  return {
    pid, via: "pidfd",
    alive: () => signal(0),
    kill: () => signal(9),
    probe: () => {
      // The namespaces by pid, believed only if the pidfd still names a live process after the reads.
      try {
        const same = ["user", "mnt", "pid", "net"].every((ns) => readlinkSync(`/proc/${pid}/ns/${ns}`) === readlinkSync(`/proc/self/ns/${ns}`));
        return signal(0) ? { inHostNamespacesLinux: same } : {};
      } catch { return {}; }
    },
    close: () => { if (open) { open = false; l.close!(pidfd); } },
  };
}
