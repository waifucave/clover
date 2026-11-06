import { closeSync, existsSync, ftruncateSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { endpointAnswers, isPipe } from "./platform/transport";

export { endpointAnswers };

// One daemon per home, under an OS lock held for the daemon's whole life (spec §3.1; measured in
// spike S7 §5 on all three OSes). The kernel drops the lock the instant the daemon exits or is
// killed, so a crash never leaves the home locked, and a second daemon can never take over one that
// is still starting (the inherited pid-file lock could).
//   macOS, Linux: flock(LOCK_EX | LOCK_NB) on <home>/run/core.lock
//   Windows:      <home>/run/core.lock opened with no sharing (CreateFileW, dwShareMode 0)
//
// Only "another process holds it" means busy: EWOULDBLOCK from flock (35 on macOS, 11 on Linux) or
// ERROR_SHARING_VIOLATION (32) from CreateFileW. Any other failure (a full disk, a permissions error,
// a missing directory) throws `LockFailedError`, so the daemon exits non-zero and is started again,
// rather than exiting 0 like a second daemon and leaving the pair down until the next login.
//
// "Busy" is confirmed on the endpoint: something else can hold the file (a virus scanner opening it
// without sharing, on Windows), and an error code read by a second FFI call (bun:ffi keeps neither
// errno nor the last error; `cc` would read it in one call but does not work inside a compiled
// binary) could be misread. So a daemon that finds the lock busy dials the endpoint. If a daemon
// answers, it is a second daemon: `AlreadyRunningError`, exit 0. If none answers, it keeps trying the
// lock for `confirmMs` (a daemon still starting answers within that); if the lock is still held and
// still no daemon answers, `LockHeldNoDaemonError`, exit 1, and the OS or the supervisor retries.

/** A daemon already holds this home and answers on its endpoint. The second daemon exits 0. */
export class AlreadyRunningError extends Error {
  constructor(public readonly pid: number) {
    super(`clover-core already running (pid ${pid})`);
  }
}

/** The lock stayed held for the whole confirmation window and no daemon answered. Exit 1. */
export class LockHeldNoDaemonError extends Error {
  constructor(public readonly lockPath: string) {
    super(`the daemon lock ${lockPath} is held by another process, and no daemon answers`);
  }
}

/** The OS refused the lock for a reason other than another holder. Exit non-zero. */
export class LockFailedError extends Error {
  constructor(public readonly lockPath: string, public readonly code: number | string) {
    super(`the daemon lock ${lockPath} could not be taken (${code})`);
  }
}

/** What a failed lock means, from the OS's error code alone. */
export function classifyLockFailure(platform: NodeJS.Platform, code: number): "busy" | "error" {
  if (platform === "win32") return code === 32 ? "busy" : "error";
  if (platform === "darwin") return code === 35 ? "busy" : "error";
  return code === 11 ? "busy" : "error";
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Where the holder records its pid: in the lock file on macOS/Linux, beside it on Windows (where
 *  the lock file cannot be read while it is held without sharing). */
function pidPath(lockPath: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? join(dirname(lockPath), "core.pid") : lockPath;
}

function readPid(path: string): number {
  try { const pid = JSON.parse(readFileSync(path, "utf8")).pid; return typeof pid === "number" && pid > 0 ? pid : -1; }
  catch { return -1; }
}

/** A held lock. `release(onOwned)` clears the pid and runs `onOwned` (the socket cleanup) while the
 *  lock is still held, then lets go. The lock file itself is never removed: with a kernel lock it is
 *  only a name, and unlinking it after letting go would race a new daemon onto a fresh file. */
type Attempt = { kind: "held"; writePid(): void; release(onOwned: () => void): void } | { kind: "busy" };
interface LockBackend { attempt(lockPath: string): Attempt }

const LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8;

function posixBackend(platform: NodeJS.Platform): LockBackend | null {
  try {
    const { dlopen, FFIType, read } = require("bun:ffi") as typeof import("bun:ffi");
    const errnoFn = platform === "darwin" ? "__error" : "__errno_location";
    const libs = platform === "darwin" ? ["/usr/lib/libSystem.B.dylib", "libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
    for (const lib of libs) {
      let libc: { symbols: Record<string, (...a: number[]) => unknown> };
      try {
        libc = dlopen(lib, {
          flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
          [errnoFn]: { args: [], returns: FFIType.ptr },
        }) as unknown as typeof libc;
      } catch { continue; }
      return {
        attempt(lockPath) {
          let fd: number;
          try { fd = openSync(lockPath, "a+", 0o600); }
          catch (e) { throw new LockFailedError(lockPath, (e as NodeJS.ErrnoException).code ?? "open"); }
          if ((libc.symbols.flock!(fd, LOCK_EX | LOCK_NB) as number) !== 0) {
            const errno = read.i32(libc.symbols[errnoFn]!() as Parameters<typeof read.i32>[0], 0);
            try { closeSync(fd); } catch { /* closing */ }
            if (classifyLockFailure(platform, errno) === "busy") return { kind: "busy" };
            throw new LockFailedError(lockPath, errno);
          }
          return {
            kind: "held",
            writePid() { ftruncateSync(fd, 0); writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 0, "utf8"); },
            release(onOwned) {
              try { ftruncateSync(fd, 0); } catch { /* best-effort */ }
              onOwned();
              try { libc.symbols.flock!(fd, LOCK_UN); } catch { /* exiting */ }
              try { closeSync(fd); } catch { /* closed */ }
            },
          };
        },
      };
    }
  } catch { /* bun:ffi unavailable */ }
  return null;
}

function windowsBackend(): LockBackend | null {
  try {
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const k32 = dlopen("kernel32.dll", {
      CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
      GetLastError: { args: [], returns: FFIType.u32 },
      CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
    });
    const GENERIC_RW = 0xc0000000, OPEN_ALWAYS = 4, FILE_ATTRIBUTE_NORMAL = 0x80;
    return {
      attempt(lockPath) {
        const wide = Buffer.from(`${lockPath}\0`, "utf16le");
        const raw = k32.symbols.CreateFileW(ptr(wide), GENERIC_RW, 0, null, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null) as unknown as number | bigint;
        const handle = typeof raw === "bigint" ? raw : BigInt(raw);
        if (handle === -1n) {
          const err = k32.symbols.GetLastError() as number;
          if (classifyLockFailure("win32", err) === "busy") return { kind: "busy" };
          throw new LockFailedError(lockPath, err);
        }
        const pids = pidPath(lockPath, "win32");
        return {
          kind: "held",
          writePid() { writeFileSync(pids, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { mode: 0o600 }); },
          release(onOwned) {
            try { unlinkSync(pids); } catch { /* best-effort */ }
            onOwned();
            try { k32.symbols.CloseHandle(handle as unknown as number); } catch { /* exiting */ }
          },
        };
      },
    };
  } catch { return null; }
}

/** Without FFI: the lock file records the holder's pid, and a live pid that is not ours is busy. */
function pidFileBackend(): LockBackend {
  return {
    attempt(lockPath) {
      const holder = readPid(lockPath);
      if (holder > 0 && holder !== process.pid && pidAlive(holder)) return { kind: "busy" };
      return {
        kind: "held",
        writePid() { writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { mode: 0o600 }); },
        // Without a kernel lock, clean up only while the file still names us.
        release(onOwned) {
          if (readPid(lockPath) !== process.pid) return;
          try { unlinkSync(lockPath); } catch { /* raced */ }
          onOwned();
        },
      };
    },
  };
}

function backendFor(platform: NodeJS.Platform, kind: "os" | "pidfile"): LockBackend {
  if (kind === "pidfile") return pidFileBackend();
  return (platform === "win32" ? windowsBackend() : posixBackend(platform)) ?? pidFileBackend();
}

export interface Lock { release(): void }

export interface AcquireLockOptions {
  /** How long a busy lock with no answering daemon is retried before giving up (S7: about 3 s). */
  readonly confirmMs?: number;
  readonly pollMs?: number;
  /** Test seams. */
  readonly platform?: NodeJS.Platform;
  readonly answers?: (endpoint: string) => Promise<boolean>;
  /** Test seam: force the pid-file fallback used where FFI cannot load. */
  readonly backend?: "os" | "pidfile";
}

/**
 * Take the home's daemon lock. Throws `AlreadyRunningError` (exit 0) when a daemon holds it and
 * answers on `socketPath`, `LockHeldNoDaemonError` (exit 1) when it stays held with no daemon
 * answering, and `LockFailedError` (exit 1) when the OS refuses it for another reason.
 */
export async function acquireLock(lockPath: string, socketPath: string, opts: AcquireLockOptions = {}): Promise<Lock> {
  const platform = opts.platform ?? process.platform;
  const backend = backendFor(platform, opts.backend ?? "os");
  const answers = opts.answers ?? ((p: string) => endpointAnswers(p));
  const confirmMs = opts.confirmMs ?? 3_000;
  const pollMs = opts.pollMs ?? 250;
  const started = Date.now();
  for (;;) {
    const attempt = backend.attempt(lockPath);
    if (attempt.kind === "held") {
      attempt.writePid();
      // We hold the lock, so no daemon is running: a socket file left by a crash is stale. (A named
      // pipe has no file; the OS reclaims it when its last handle closes.)
      if (!isPipe(socketPath) && existsSync(socketPath)) { try { unlinkSync(socketPath); } catch { /* raced */ } }
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          attempt.release(() => {
            if (!isPipe(socketPath)) { try { unlinkSync(socketPath); } catch { /* raced */ } }
          });
        },
      };
    }
    if (await answers(socketPath)) throw new AlreadyRunningError(readPid(pidPath(lockPath, platform)));
    if (Date.now() - started >= confirmMs) throw new LockHeldNoDaemonError(lockPath);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
