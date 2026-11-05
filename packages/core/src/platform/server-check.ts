// Who serves this home's endpoint, checked before a client sends its token (from E-M1's review). E's
// app is Electron, with no FFI, so it runs `clover-core daemon check-server --json` (the binary it
// already runs for `autostart`) and says hello only when it answers ok.
//   Windows: connect, then GetNamedPipeServerProcessId on this process's end, and the server's user
//            SID and image path (`pipeServerIdentity`): the user's own, and with `image`, that binary.
//            The pipe's DACL is the user's and SYSTEM's alone and its first instance can't be shared,
//            so whoever serves the name serves every instance of it; the check answers for the app's
//            connection too (the name can change hands only if the daemon exits in between, and the
//            next daemon mints a new app token).
//   macOS, Linux: the socket and its run directory belong to this user and are closed to others
//            (no other user can create one there; the fence keeps the user's bots out of run/).
import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { isPipe } from "./transport";
import { currentUserSid, isOurDaemon, pipeServerIdentity } from "./win-pipe";

export interface ServerCheck {
  readonly ok: boolean;
  readonly reason?: string;
  readonly pid?: number;
  readonly userSid?: string;
  readonly image?: string;
}

export async function checkDaemonServer(endpoint: string, expect: { image?: string } = {}): Promise<ServerCheck> {
  if (isPipe(endpoint)) {
    const me = currentUserSid();
    if (me === null) return { ok: false, reason: "this process's user is unknown" };
    let socket: Awaited<ReturnType<typeof Bun.connect>>;
    try { socket = await Bun.connect({ unix: endpoint, socket: { data() {} } }); }
    catch { return { ok: false, reason: "no daemon answers" }; }
    try {
      const who = pipeServerIdentity(endpoint);
      if (who === null) return { ok: false, reason: "the pipe's server can't be told" };
      const ok = isOurDaemon(who, { userSid: me, ...(expect.image ? { image: expect.image } : {}) });
      return { ok, ...(ok ? {} : { reason: "the pipe is served by another user or another binary" }), pid: who.pid, userSid: who.userSid, image: who.image };
    } finally { socket.end(); }
  }
  const uid = process.getuid?.();
  try {
    const sock = lstatSync(endpoint), dir = lstatSync(dirname(endpoint));
    if (!sock.isSocket()) return { ok: false, reason: "the endpoint is not a socket" };
    if (uid !== undefined && (sock.uid !== uid || dir.uid !== uid)) return { ok: false, reason: "the socket or its directory belongs to another user" };
    if ((dir.mode & 0o077) !== 0 || (sock.mode & 0o077) !== 0) return { ok: false, reason: "the socket or its directory is open to others" };
    return { ok: true };
  } catch { return { ok: false, reason: "no daemon socket" }; }
}
