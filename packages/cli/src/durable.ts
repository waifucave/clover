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

let fullFsync: ((fd: number) => number) | null | undefined;

/** macOS's fcntl(fd, F_FULLFSYNC), or null where it can't be had (another OS, or no bun:ffi). */
function fullFsyncFn(): ((fd: number) => number) | null {
  if (fullFsync !== undefined) return fullFsync;
  fullFsync = null;
  if (process.platform !== "darwin") return null;
  try {
    // fcntl is variadic, but F_FULLFSYNC takes no third argument: the two fixed ones go in registers either way.
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen("/usr/lib/libSystem.B.dylib", { fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    fullFsync = (fd) => lib.symbols.fcntl(fd, F_FULLFSYNC) as number;
  } catch {
    fullFsync = null;
  }
  return fullFsync;
}

function flush(fd: number): void {
  const full = fullFsyncFn();
  // F_FULLFSYNC can be refused (some file systems); a plain fsync is the floor.
  if (full === null || full(fd) !== 0) fsyncSync(fd);
}

/** Flushes the file at `path` to the disk. */
export function syncFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
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
