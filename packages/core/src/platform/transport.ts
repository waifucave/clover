// The daemon's IPC endpoint per OS (spec §3.1: "the transport is a Unix socket on macOS and Linux
// and a named pipe on Windows"). One endpoint per home, so a second daemon on the same home meets
// the lock (lock.ts), never a half-open socket. Pure: the daemon and every client resolve the same
// endpoint from the home's run directory, and tests resolve it for another OS by passing `platform`.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

export type DaemonPlatform = "darwin" | "linux" | "win32";

export interface Endpoint {
  /** `unix` on macOS/Linux (a socket file under the run directory); `pipe` on Windows (a name in the
   *  `\\.\pipe\` namespace, not a file on disk). */
  readonly kind: "unix" | "pipe";
  /** What a client connects to and the daemon listens on. A socket path, or a pipe name. */
  readonly path: string;
  /** The option both `Bun.listen` and `Bun.connect` take; Bun maps a `\\.\pipe\` path to a named
   *  pipe on Windows and to a Unix socket elsewhere, so one shape serves both transports. */
  readonly listen: { readonly unix: string };
}

/** The Windows pipe namespace prefix. A named pipe is not a filesystem path, so the run directory
 *  only seeds a stable per-home name; the daemon still holds the file lock in the run directory. */
export const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

function currentPlatform(): DaemonPlatform {
  return process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
}

/** A short, stable id for a home's run directory, so each home gets its own pipe name. Lower-case
 *  hex of a hash, 16 chars — a pipe name is case-insensitive and length-bounded, and the run
 *  directory is already per-home, so collisions need a hash collision. */
export function homePipeId(runDir: string): string {
  return createHash("sha256").update(runDir).digest("hex").slice(0, 16);
}

/** The endpoint for a home's run directory. `core.sock` under it on macOS/Linux (as Winter's was),
 *  and `\\.\pipe\clover-core-<id>` on Windows, where `<id>` is `homePipeId(runDir)`. The profile
 *  suffix (dev) is already in the home, hence in `runDir`, so dev and dist never share an endpoint. */
export function resolveEndpoint(runDir: string, platform: DaemonPlatform = currentPlatform()): Endpoint {
  if (platform === "win32") {
    const path = `${WINDOWS_PIPE_PREFIX}clover-core-${homePipeId(runDir)}`;
    return { kind: "pipe", path, listen: { unix: path } };
  }
  const path = join(runDir, "core.sock");
  return { kind: "unix", path, listen: { unix: path } };
}

/** Whether an endpoint path is a Windows named pipe. A pipe is never `unlink`ed or `chmod`ed (the OS
 *  reclaims it when the last handle closes), so the daemon's socket-file cleanup skips it. */
export function isPipe(path: string): boolean {
  return path.startsWith(WINDOWS_PIPE_PREFIX);
}

/** Whether a daemon answers on an endpoint (a Unix socket or a Windows named pipe): a connect that
 *  succeeds within `timeoutMs`. */
export function endpointAnswers(path: string, timeoutMs = 300): Promise<boolean> {
  if (!isPipe(path) && !existsSync(path)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const done = (ok: boolean) => { clearTimeout(timer); socket.destroy(); resolve(ok); };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** A cheap "is a daemon there" for clients deciding whether to connect at all: the socket file on
 *  macOS/Linux (as before; no connection is made), a dial on Windows, where a pipe has no file. */
export function endpointPresent(path: string): Promise<boolean> {
  return isPipe(path) ? endpointAnswers(path) : Promise.resolve(existsSync(path));
}
