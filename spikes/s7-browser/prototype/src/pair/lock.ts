// One daemon per home, holding an OS file lock for its whole life (spec §3.1): the kernel drops the lock when the
// process dies, however it dies, so a crashed daemon never leaves a stale lock and a second daemon can never take
// over one that is still starting (Winter's pid-file lock could). Bun only (bun:ffi).
//   macOS, Linux: flock(LOCK_EX | LOCK_NB) on <home>/run/core.lock
//   Windows:      the lock file opened with no sharing (CreateFileW, dwShareMode 0) for the process's life
import { openSync } from "node:fs";

export interface HeldLock { kind: string; release(): void }

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
      return { busy: true, detail: `CreateFileW: error ${err}${err === 32 ? " (sharing violation: another daemon holds it)" : ""}` };
    }
    return { kind: "CreateFileW share-none", release: () => { k32.symbols.CloseHandle(h); } };
  }
  const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  const fd = openSync(path, "a");
  const LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8;
  if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) return { busy: true, detail: "flock: held by another process" };
  return { kind: "flock", release: () => { libc.symbols.flock(fd, LOCK_UN); } };
}
