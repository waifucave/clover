// One daemon per home, holding an OS file lock for its whole life (spec §3.1): the kernel drops the lock when the
// process dies, however it dies, so a crashed daemon never leaves a stale lock and a second daemon can never take
// over one that is still starting (Winter's pid-file lock could). Bun only (bun:ffi).
//   macOS, Linux: flock(LOCK_EX | LOCK_NB) on <home>/run/core.lock
//   Windows:      the lock file opened with no sharing (CreateFileW, dwShareMode 0) for the process's life
// Only "another process holds it" means busy (EWOULDBLOCK; ERROR_SHARING_VIOLATION). Any other failure throws, so
// the daemon exits non-zero and its login item retries, instead of exiting 0 as a second daemon would and leaving
// the pair down until the next login (round eight: a full disk, a permissions error). A process that opens the file
// without sharing, such as a virus scanner at login, still looks like a second daemon on Windows; the report gives
// lane C the fix (dial the socket before exiting 0).
import { openSync } from "node:fs";

export interface HeldLock { kind: string; release(): void }

/**
 * What a failed lock means, from the OS's error code alone (round eleven: a pure function, unit-tested on every OS).
 * Only "another process holds it" is busy: EWOULDBLOCK from flock (35 on macOS, 11 on Linux) or a sharing violation
 * (32) from CreateFileW. Everything else is an error, so the daemon exits non-zero and is started again.
 * bun:ffi has no call that keeps errno or the last error, so they are read by a second FFI call straight after the
 * failing one. A misread can only turn "busy" into an error (a non-zero exit, and a retry), and a "busy" that no
 * daemon answers on the socket is treated as an error too (daemon.ts). Lane C should read them inside one native call.
 */
export function classifyLockFailure(platform: NodeJS.Platform, code: number): "busy" | "error" {
  if (platform === "win32") return code === 32 ? "busy" : "error";
  if (platform === "darwin") return code === 35 ? "busy" : "error";
  return code === 11 ? "busy" : "error";
}

export async function takeLock(path: string): Promise<HeldLock | { busy: true; detail: string }> {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  if (process.platform === "win32") {
    const k32 = dlopen("kernel32.dll", {
      CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
      GetLastError: { args: [], returns: FFIType.u32 },
      CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
    });
    const wide = Buffer.from(`${path}\0`, "utf16le");
    const GENERIC_RW = 0xc0000000, OPEN_ALWAYS = 4, FILE_ATTRIBUTE_NORMAL = 0x80;
    const raw = k32.symbols.CreateFileW(ptr(wide), GENERIC_RW, 0, null, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null) as unknown as number | bigint;
    const h = typeof raw === "bigint" ? raw : BigInt(raw);
    if (h === -1n) {
      const err = k32.symbols.GetLastError();
      if (classifyLockFailure("win32", err) === "busy") return { busy: true, detail: "CreateFileW: error 32 (sharing violation: another process holds it)" };
      throw new Error(`the daemon lock ${path}: CreateFileW failed with error ${err}`);
    }
    return { kind: "CreateFileW share-none", release: () => { k32.symbols.CloseHandle(h); } };
  }
  const errnoFn = process.platform === "darwin" ? "__error" : "__errno_location";
  const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [errnoFn]: { args: [], returns: FFIType.ptr },
  });
  const { read } = await import("bun:ffi");
  const fd = openSync(path, "a");
  const LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8;
  const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;
  if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    const where = (libc.symbols as Record<string, () => unknown>)[errnoFn]!() as Parameters<typeof read.i32>[0];
    const errno = read.i32(where, 0);
    if (classifyLockFailure(process.platform, errno) === "busy") return { busy: true, detail: "flock: held by another process" };
    throw new Error(`the daemon lock ${path}: flock failed with errno ${errno}`);
  }
  return { kind: "flock", release: () => { libc.symbols.flock(fd, LOCK_UN); } };
}
