// Writes that survive a power cut, for a server's self-update and its bundled plugins (#244 review B1): a file's
// bytes reach the disk before anything points at it, and a rename is on disk before the next step relies on it.
//
// `syncFile` flushes a file (macOS: F_FULLFSYNC, which also empties the drive's own cache; a plain fsync there only
// reaches the drive), `syncDir` a folder's entries (a rename or a link lives in its folder). Windows has no folder
// sync (its renames are journaled by NTFS), so `syncDir` is a no-op there.
//
// Every step a swap takes goes through `DurableOps`, so tests can stop at any step, as a power cut would, and look at
// what's on disk.
import { closeSync, fsyncSync, linkSync, openSync, renameSync, rmSync, constants } from "node:fs";

/** F_FULLFSYNC (<sys/fcntl.h>). */
const F_FULLFSYNC = 51;

/** The errno values for which F_FULLFSYNC is "not supported here" (<sys/errno.h> on macOS): only these fall back to
 *  a plain fsync; any other failure (EIO, a dying disk) throws. */
export const FULLFSYNC_UNSUPPORTED = new Set([45 /* ENOTSUP */, 25 /* ENOTTY */, 22 /* EINVAL */]);

/**
 * fcntl(fd, F_FULLFSYNC), and the errno it left (`__error()`). They are two ffi calls, so errno is read in a second
 * native call: nothing of ours runs on this thread between them, but the runtime could in principle make a failing
 * system call there (a GC step) and change errno. The window is accepted, because a misread errno fails safe:
 *   - read as "unsupported" when it wasn't: the plain fsync that follows meets the same failure (a disk error stays),
 *     and throws;
 *   - read as another error when it was "unsupported": the flush throws, the swap isn't done, and it is tried later.
 * A C shim reading errno in the same call (the `cc` of bun:ffi) was weighed and refused: it compiles C from a file at
 * run time, and a file a same-user process could swap before the compile would be a door for foreign code into the
 * core.
 */
type FullFsync = (fd: number) => { result: number; errno: number };

let fullFsync: FullFsync | null | undefined;

/** macOS's fcntl(fd, F_FULLFSYNC), or null where it can't be had (another OS; on macOS, a bun:ffi that won't load,
 *  which is said once). */
function fullFsyncFn(log: (line: string) => void = (l) => console.error(l)): FullFsync | null {
  if (fullFsync !== undefined) return fullFsync;
  fullFsync = null;
  if (process.platform !== "darwin") return null;
  try {
    // fcntl is variadic, but F_FULLFSYNC takes no third argument: the two fixed ones go in registers either way.
    const { dlopen, FFIType, read } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });
    fullFsync = (fd) => {
      const result = lib.symbols.fcntl(fd, F_FULLFSYNC) as number;
      const at = lib.symbols.__error();
      return { result, errno: result === 0 || at === null ? 0 : read.i32(at, 0) };
    };
  } catch (err) {
    log(`durable: F_FULLFSYNC can't be had (bun:ffi: ${err instanceof Error ? err.message : String(err)}); flushing with fsync, which reaches the drive but not past its cache`);
    fullFsync = null;
  }
  return fullFsync;
}

/** Flushes `fd`: F_FULLFSYNC on macOS, falling back to fsync only where it isn't supported; fsync elsewhere. */
export function flush(fd: number, full: FullFsync | null = fullFsyncFn()): void {
  if (full === null) {
    fsyncSync(fd);
    return;
  }
  const r = full(fd);
  if (r.result === 0) return;
  if (FULLFSYNC_UNSUPPORTED.has(r.errno)) {
    fsyncSync(fd);
    return;
  }
  throw new Error(`F_FULLFSYNC failed (errno ${r.errno})`);
}

/** Flushes the file at `path` to the disk. Windows' FlushFileBuffers needs write access, so it is opened for writing
 *  there (never truncated). */
export function syncFile(path: string): void {
  const fd = openSync(path, process.platform === "win32" ? "r+" : constants.O_RDONLY);
  try {
    flush(fd);
  } finally {
    closeSync(fd);
  }
}

/** Flushes the folder at `path` (its entries: renames, links, new files). A no-op on Windows. */
export function syncDir(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY);
  try {
    flush(fd);
  } finally {
    closeSync(fd);
  }
}

/** The steps a crash-safe swap takes; tests stop at any of them. */
export interface DurableOps {
  rename(from: string, to: string): void;
  link(existing: string, link: string): void;
  rm(path: string): void;
  syncFile(path: string): void;
  syncDir(path: string): void;
}

export const realOps: DurableOps = {
  rename: (from, to) => renameSync(from, to),
  link: (existing, link) => linkSync(existing, link),
  rm: (path) => rmSync(path, { recursive: true, force: true }),
  syncFile,
  syncDir,
};
