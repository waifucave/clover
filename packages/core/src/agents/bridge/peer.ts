// Who is on the other end of a Unix socket: the kernel's own answer, for the bridge's token check (spike S5 edit 4).
//
// The bridge's token is stored in plain text by some agents (Antigravity keeps its `mcpServers` in a database any
// process of the user can read), so a token alone proves nothing. The daemon also asks the kernel for the connecting
// process's pid and accepts the token only from a process under that session's agent. Bun's sockets give the pid
// no other way (computer-use/browser/extension/host-server.ts notes the same), so this reads it with `getsockopt` on
// the socket's descriptor:
// * macOS: `LOCAL_PEERPID` (level `SOL_LOCAL`);
// * Linux: `SO_PEERCRED`'s `ucred.pid` (level `SOL_SOCKET`), untested here (the core suite runs on macOS);
// * Windows: none. There the check is membership of the agent's job object, which lane C's native caller check
//   provides; until it does, `peerPidOf` answers null and the bridge is refused (fail closed).
import { dlopen, FFIType, ptr } from "bun:ffi";

type GetSockOpt = (fd: number, level: number, name: number, value: unknown, len: unknown) => number;

let getsockopt: GetSockOpt | null | undefined;

function load(): GetSockOpt | null {
  if (getsockopt !== undefined) return getsockopt;
  const lib = process.platform === "darwin" ? "libSystem.B.dylib" : process.platform === "linux" ? "libc.so.6" : null;
  if (!lib) return (getsockopt = null);
  try {
    const h = dlopen(lib, { getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } });
    getsockopt = h.symbols.getsockopt as unknown as GetSockOpt;
  } catch {
    getsockopt = null;
  }
  return getsockopt;
}

/** The pid of the process on the other end of the connected Unix socket `fd`, from the kernel; null where it can't
 *  be read (Windows, or a failure), which the caller treats as a refusal. */
export function peerPidOf(fd: number | undefined): number | null {
  if (fd === undefined || fd < 0) return null;
  const fn = load();
  if (!fn) return null;
  if (process.platform === "darwin") {
    const out = new Int32Array(1);
    const len = new Uint32Array([4]);
    return fn(fd, 0 /* SOL_LOCAL */, 0x002 /* LOCAL_PEERPID */, ptr(out), ptr(len)) === 0 && out[0]! > 0 ? out[0]! : null;
  }
  // struct ucred { pid_t pid; uid_t uid; gid_t gid; }
  const out = new Int32Array(3);
  const len = new Uint32Array([12]);
  return fn(fd, 1 /* SOL_SOCKET */, 17 /* SO_PEERCRED */, ptr(out), ptr(len)) === 0 && out[0]! > 0 ? out[0]! : null;
}
