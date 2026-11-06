// Who serves this home's endpoint, checked before a client sends its token (E-M1's review; review S2, S3). E's
// app is Electron, with no FFI, so it runs `clover-core daemon check-server --json --image <daemon binary>` (the
// binary it already runs for `autostart`) and says hello only when it answers ok; then, on its own connection,
// `protocol.prove` (ipc/clover.ts), which no other connection's answer can stand in for.
// On every OS the check connects and asks the OS for the server's process, then requires:
//   - its user is this user (macOS `getpeereid`, Linux `SO_PEERCRED`, Windows the server's token SID);
//   - its executable is `image`, the daemon's binary;
//   - it runs outside every sandbox and escape floor (`callerFloorVerdict` on the server process);
// and on macOS and Linux, that the socket and its run folder are this user's and closed to others. A socket
// nobody listens on (a crashed daemon's) fails: nothing answers the connect.
import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { peerPid, peerUid, processImage, sandboxProbe, socketFd } from "./caller-probe";
import { callerFloorVerdict } from "./sandbox-floor";
import { isPipe, type DaemonPlatform } from "./transport";
import { currentUserSid, isOurDaemon, pipeServerIdentity } from "./win-pipe";

export interface ServerCheck {
  readonly ok: boolean;
  readonly reason?: string;
  readonly pid?: number;
  readonly userSid?: string;
  readonly uid?: number;
  readonly image?: string;
}

const osNow = (): DaemonPlatform => (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");

/** The same executable: real paths equal, compared folded where the disk folds (macOS). */
function sameFile(a: string, b: string, os: DaemonPlatform): boolean {
  try {
    const x = realpathSync.native(a), y = realpathSync.native(b);
    return os === "linux" ? x === y : x.toLowerCase() === y.toLowerCase();
  } catch { return false; }
}

export async function checkDaemonServer(endpoint: string, expect: { image: string }, os: DaemonPlatform = osNow()): Promise<ServerCheck> {
  if (!expect.image) return { ok: false, reason: "the daemon's binary must be named (--image)" };
  let socket: Awaited<ReturnType<typeof Bun.connect>>;
  try { socket = await Bun.connect({ unix: endpoint, socket: { data() {} } }); }
  catch { return { ok: false, reason: "no daemon answers" }; }
  try {
    if (isPipe(endpoint)) {
      const me = currentUserSid();
      if (me === null) return { ok: false, reason: "this process's user is unknown" };
      const who = pipeServerIdentity(endpoint);
      if (who === null) return { ok: false, reason: "the pipe's server can't be told" };
      const facts = { pid: who.pid, userSid: who.userSid, image: who.image };
      if (!isOurDaemon(who, { userSid: me, image: expect.image })) return { ok: false, reason: "the pipe is served by another user or another binary", ...facts };
      if (callerFloorVerdict("win32", sandboxProbe(who.pid, "win32")) !== "outside-floor") return { ok: false, reason: "the pipe's server runs restricted or in an AppContainer", ...facts };
      return { ok: true, ...facts };
    }
    const fd = socketFd(socket);
    const pid = fd === null ? null : peerPid(fd, os);
    const uid = fd === null ? null : peerUid(fd, os);
    if (pid === null || uid === null) return { ok: false, reason: "the socket's server can't be told" };
    const image = processImage(pid, os) ?? undefined;
    const facts = { pid, uid, ...(image ? { image } : {}) };
    if (uid !== process.getuid?.()) return { ok: false, reason: "the socket is served by another user", ...facts };
    if (!image || !sameFile(image, expect.image, os)) return { ok: false, reason: "the socket is served by another binary", ...facts };
    if (callerFloorVerdict(os, sandboxProbe(pid, os)) !== "outside-floor") return { ok: false, reason: "the socket's server runs in a sandbox", ...facts };
    const sock = lstatSync(endpoint), dir = lstatSync(dirname(endpoint));
    if (sock.uid !== uid || dir.uid !== uid) return { ok: false, reason: "the socket or its directory belongs to another user", ...facts };
    if ((dir.mode & 0o077) !== 0 || (sock.mode & 0o077) !== 0) return { ok: false, reason: "the socket or its directory is open to others", ...facts };
    return { ok: true, ...facts };
  } catch {
    return { ok: false, reason: "the server can't be checked" };
  } finally {
    socket.end();
  }
}
