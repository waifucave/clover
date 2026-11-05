import { closeSync, existsSync, ftruncateSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { isPipe } from "./platform/transport";

// One daemon per home, under an OS lock held for the daemon's whole life (spec §3.1). The lock is a
// kernel advisory lock (`flock`) on an open file descriptor, so the OS drops it the instant the
// daemon exits or is killed — a crashed daemon never leaves the home locked. A second daemon that
// cannot take the lock defers to the holder, even one that is still starting and has not opened its
// socket yet: Winter's pid-file lock let a second daemon take that one over; this one does not.
//
// Where `flock` cannot be loaded (an unusual build, or Windows, which has no `flock`), the lock
// falls back to refusing while the pid in the lock file is alive — the same "no takeover of a
// starting daemon" rule, without the kernel's guarantee against pid reuse.

export class AlreadyRunningError extends Error {
  constructor(public readonly pid: number) {
    super(`clover-core already running (pid ${pid})`);
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function holderPidOf(lockPath: string): number {
  try { const pid = JSON.parse(readFileSync(lockPath, "utf8")).pid; return typeof pid === "number" && pid > 0 ? pid : -1; }
  catch { return -1; }
}

// `flock(2)`, loaded once, best-effort. null when it cannot be loaded, so the caller falls back.
const LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8;
type Flock = { lock(fd: number): boolean; unlock(fd: number): void };
const flockApi: Flock | null = (() => {
  if (process.platform === "win32") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const candidates = process.platform === "darwin"
      ? ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"]
      : ["libc.so.6", "libc.so"];
    for (const lib of candidates) {
      try {
        const { symbols } = dlopen(lib, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
        return {
          lock: (fd: number) => symbols.flock(fd, LOCK_EX | LOCK_NB) === 0,
          unlock: (fd: number) => { try { symbols.flock(fd, LOCK_UN); } catch { /* exiting anyway */ } },
        };
      } catch { /* try the next library name */ }
    }
  } catch { /* bun:ffi unavailable */ }
  return null;
})();

export interface Lock { release(): void }

/**
 * Take the home's daemon lock, or throw `AlreadyRunningError` naming the holder. `socketPath` is the
 * endpoint to clean up on release (a Unix socket file; a Windows named pipe is left to the OS).
 */
export async function acquireLock(lockPath: string, socketPath: string): Promise<Lock> {
  // Open (creating if absent) without truncating, so a live holder's pid stays readable.
  const fd = openSync(lockPath, "a+", 0o600);
  let held = false;
  try {
    if (flockApi) {
      // The kernel lock is authoritative: if it is ours, the file's stale pid (a reboot's reused pid,
      // a crash) does not matter; if it is held, the holder is live by definition.
      if (!flockApi.lock(fd)) throw new AlreadyRunningError(holderPidOf(lockPath));
      held = true;
    } else {
      // No `flock`: refuse while the recorded pid is alive and not ours.
      const holder = holderPidOf(lockPath);
      if (holder > 0 && holder !== process.pid && pidAlive(holder)) throw new AlreadyRunningError(holder);
    }
    ftruncateSync(fd, 0);
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 0, "utf8");
  } catch (err) {
    if (flockApi && held) flockApi.unlock(fd);
    try { closeSync(fd); } catch { /* already closed */ }
    throw err;
  }

  // A stale socket file from a crashed daemon would make a client connect to nothing; clear it.
  // (A named pipe has no file to remove; the OS reclaims it when the last handle closes.)
  if (!isPipe(socketPath) && existsSync(socketPath)) { try { unlinkSync(socketPath); } catch { /* raced */ } }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      if (flockApi) flockApi.unlock(fd);
      try { closeSync(fd); } catch { /* already closed */ }
      // Ownership check: never clobber a newer daemon's files. With `flock` a newer daemon cannot
      // exist while we hold the lock, but the check also covers the no-`flock` fallback.
      try { if (JSON.parse(readFileSync(lockPath, "utf8")).pid !== process.pid) return; } catch { return; }
      try { unlinkSync(lockPath); } catch { /* raced */ }
      if (!isPipe(socketPath)) { try { unlinkSync(socketPath); } catch { /* raced */ } }
    },
  };
}
