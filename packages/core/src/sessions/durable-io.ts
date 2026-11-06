// Flushing to the drive itself, for what must survive a power cut: a session's inputs, turn boundaries and status
// changes, and the small files rewritten whole (atomic-file.ts). Owner: lane D.
//
// * On macOS, fsync(2) only hands the data to the drive, whose cache a power cut can still lose; `F_FULLFSYNC` asks
//   the drive to write it out (about 4 ms a call, against 0.04 ms for fsync). It is reached over bun:ffi, as the
//   core's other libSystem calls are. A file system without it (a network share) gets a plain fsync.
// * On Linux, fsync writes through the drive's cache already; on Windows, Node's fsync is FlushFileBuffers.
// * A new file, or a rename over one, is durable only once its folder is flushed too. Windows can't open a folder for
//   that and doesn't need it, so there it is skipped.
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, fsyncSync, openSync } from "node:fs";

const F_FULLFSYNC = 51;

type Fcntl = (fd: number, cmd: number) => number;
let fcntl: Fcntl | null | undefined;

function fullFsync(): Fcntl | null {
  if (fcntl !== undefined) return fcntl;
  fcntl = null;
  if (process.platform !== "darwin") return null;
  try {
    // `fcntl` is variadic, but `F_FULLFSYNC` takes no third argument, so the two fixed ones are all it reads.
    const lib = dlopen("/usr/lib/libSystem.B.dylib", { fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    fcntl = (fd, cmd) => lib.symbols.fcntl(fd, cmd) as number;
  } catch {
    fcntl = null;
  }
  return fcntl;
}

/** Flushes an open file to the drive. Throws when the system reports the flush failed. */
export function syncFile(fd: number): void {
  const full = fullFsync();
  if (full !== null && full(fd, F_FULLFSYNC) === 0) return;
  fsyncSync(fd);
}

/** Flushes a folder's entries (a file created or renamed in it). */
export function syncDir(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    syncFile(fd);
  } finally {
    closeSync(fd);
  }
}
