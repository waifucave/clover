// WS-27: a workflow worker refuses to run outside a sandbox that denies it the Keychain.
//
// `clover-core __workflow-worker` (the daemon's own worker) and `clover-core __runtime-workflow-worker
// --bridge` (the runtime's, for embedded sessions) run model-authored JavaScript. Their containment is the
// seatbelt the PARENT wraps them in (`/usr/bin/sandbox-exec -p <profile> …`): nothing stopped the same
// binary being launched with those arguments WITHOUT it — by anything that can run a process as the user —
// and then it runs the script with every right `clover-core` has, the Keychain items it created included.
// So each worker checks, before it reads a byte of input, that it is (a) sandboxed at all and (b) denied a
// lookup of the security daemons' mach services — the file-based keychain's `com.apple.SecurityServer`
// (securityd, where `Bun.secrets` and `keychain-ffi.ts` live) and the data-protection keychain's
// `com.apple.securityd.xpc` (secd). Without a connection to either, no Keychain call can succeed.
//
// `sandbox_check(pid, operation, type, ...)` answers what the running process's sandbox would decide,
// without performing the operation (`SANDBOX_CHECK_NO_REPORT`: and without logging a violation). It is
// VARIADIC, and bun:ffi has no variadic call: on Apple arm64 a variadic argument is passed on the STACK,
// so the name is bound as the NINTH parameter (x0–x7 carry the three fixed ones plus five pads, and the
// ninth lands at [sp], exactly where the callee's `va_arg` reads it). On x86_64 variadic arguments ride
// the ordinary registers, so the fourth parameter is the name. A garbage name would be denied by any
// deny-default profile and read as "sandboxed" — which is why the gates also run a worker under a
// profile that ALLOWS `com.apple.SecurityServer` and require the refusal: only a correctly passed name
// can be allowed.
//
// On Linux the worker is confined by the agent SDK's launcher (`linuxConfineMain`: Landlock, a seccomp filter and
// no_new_privs, then the exec), and the secret service it must be denied is reached over D-Bus, a Unix socket. So the
// worker checks that it is confined at all (`/proc/self/status` says `NoNewPrivs: 1` and `Seccomp: 2`, a filter) and
// that it can't make a Unix socket of any kind (`socket(AF_UNIX, type, 0)` fails with EPERM or EACCES for a stream, a
// datagram and a seqpacket socket, with and without the flags), nor holds one it was handed. It never assumes: anything
// it can't read, or any other answer, is not confined.
import { dlopen, FFIType, read } from "bun:ffi";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

/** The worker's exit code when it refuses (`EX_NOPERM`). */
export const WORKER_NOT_SANDBOXED_EXIT_CODE = 77;

/** What a PARENT reports for a worker that exited `WORKER_NOT_SANDBOXED_EXIT_CODE`. */
export const WORKER_NOT_SANDBOXED_MESSAGE = "workflow sandbox not in effect";

/** The mach services a sandboxed worker must be denied. */
export const KEYCHAIN_MACH_SERVICES = ["com.apple.SecurityServer", "com.apple.securityd.xpc"] as const;

const SANDBOX_FILTER_NONE = 0;
const SANDBOX_FILTER_GLOBAL_NAME = 2;
const SANDBOX_CHECK_NO_REPORT = 0x40000000;

type SandboxCheck = (pid: number, operation: string | null, type: number, name: string | null) => number;

function loadSandboxCheck(): SandboxCheck {
  const cstr = (s: string | null): Buffer | null => (s === null ? null : Buffer.from(`${s}\0`, "utf8"));
  if (process.arch === "arm64") {
    const P = FFIType.u64;
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      sandbox_check: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, P, P, P, P, P, FFIType.ptr], returns: FFIType.i32 },
    });
    return (pid, operation, type, name) => {
      const op = cstr(operation);
      const n = cstr(name);
      const r = lib.symbols.sandbox_check(pid, op, type, 0n, 0n, 0n, 0n, 0n, n);
      void [op, n]; // alive until the call returned
      return r;
    };
  }
  if (process.arch === "x64") {
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      sandbox_check: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    });
    return (pid, operation, type, name) => {
      const op = cstr(operation);
      const n = cstr(name);
      const r = lib.symbols.sandbox_check(pid, op, type, n);
      void [op, n];
      return r;
    };
  }
  throw new Error(`no sandbox_check binding for ${process.arch}`);
}

export type KeychainSandboxState = { ok: true } | { ok: false; reason: string };

/** What the Linux check reads: the process's status file, the answer to `socket(AF_UNIX, type, 0)` for each kind of
 *  Unix socket, and what the process's open descriptors are. */
export interface LinuxConfinementProbe {
  /** `/proc/self/status`; undefined when it can't be read. */
  status(): string | undefined;
  /** The new descriptor (closed by the probe), or -1 and the call's errno. */
  unixSocket(type: number): { fd: number; errno: number };
  /** Where each of the process's open descriptors points (`/proc/self/fd/<n>`), or undefined when they can't be read. */
  descriptors(): readonly string[] | undefined;
}

const AF_UNIX = 1;
const SOCK_STREAM = 1;
const SOCK_DGRAM = 2;
const SOCK_SEQPACKET = 5;
const SOCK_NONBLOCK = 0o4000;
const SOCK_CLOEXEC = 0o2000000;
/** Every kind of Unix socket the check asks for: a filter that matched on the type, or on its flags, would let one by. */
export const PROBED_SOCKET_TYPES: readonly number[] = [SOCK_STREAM, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, SOCK_DGRAM, SOCK_DGRAM | SOCK_CLOEXEC, SOCK_SEQPACKET];
const EPERM = 1;
const EACCES = 13;

function loadLinuxProbe(): LinuxConfinementProbe {
  const lib = dlopen("libc.so.6", {
    socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  });
  return {
    status() {
      try {
        return readFileSync("/proc/self/status", "utf8");
      } catch {
        return undefined;
      }
    },
    unixSocket(type) {
      const fd = lib.symbols.socket(AF_UNIX, type, 0);
      if (fd >= 0) {
        lib.symbols.close(fd);
        return { fd, errno: 0 };
      }
      const at = lib.symbols.__errno_location();
      return { fd, errno: at === null ? -1 : read.i32(at, 0) };
    },
    descriptors() {
      try {
        return readdirSync("/proc/self/fd").map((n) => {
          try { return readlinkSync(`/proc/self/fd/${n}`); } catch { return ""; } // closed meanwhile (the listing's own)
        });
      } catch {
        return undefined;
      }
    },
  };
}

/** Is THIS process confined on Linux the way the SDK's launcher confines a worker, every Unix socket denied and none
 *  held? Never throws. */
export function linuxConfinementState(probe?: LinuxConfinementProbe): KeychainSandboxState {
  let p: LinuxConfinementProbe;
  try {
    p = probe ?? loadLinuxProbe();
  } catch (err) {
    return { ok: false, reason: `the confinement could not be inspected (${err instanceof Error ? err.message : "error"})` };
  }
  try {
    const status = p.status();
    if (status === undefined) return { ok: false, reason: "the process's status (/proc/self/status) could not be read" };
    const field = (name: string) => new RegExp(`^${name}:[ \t]*(\\S+)[ \t]*$`, "m").exec(status)?.[1];
    const noNewPrivs = field("NoNewPrivs");
    const seccomp = field("Seccomp");
    if (noNewPrivs === undefined || seccomp === undefined) return { ok: false, reason: "the process's status names no NoNewPrivs or Seccomp" };
    if (noNewPrivs !== "1") return { ok: false, reason: `this process is not confined (NoNewPrivs: ${noNewPrivs})` };
    if (seccomp !== "2") return { ok: false, reason: `this process is not confined (Seccomp: ${seccomp}, not a filter)` };
    for (const type of PROBED_SOCKET_TYPES) {
      const sock = p.unixSocket(type);
      if (sock.fd >= 0) return { ok: false, reason: `the confinement allows a Unix socket (type ${type}; the secret service is reached over one)` };
      if (sock.errno !== EPERM && sock.errno !== EACCES) return { ok: false, reason: `a Unix socket (type ${type}) failed for another reason (errno ${sock.errno}), so the confinement gave no clear answer` };
    }
    // A socket handed down already connected (to the session bus, say) needs no new one.
    const fds = p.descriptors();
    if (fds === undefined) return { ok: false, reason: "the process's descriptors (/proc/self/fd) could not be read" };
    if (fds.some((t) => t.startsWith("socket:"))) return { ok: false, reason: "this process holds a socket it was handed" };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `the confinement could not be inspected (${err instanceof Error ? err.message : "error"})` };
  }
}

/** Is THIS process sandboxed with the Keychain's mach services denied (macOS), or confined with a Unix socket denied
 *  (Linux)? Never throws. */
export function keychainSandboxState(check?: SandboxCheck): KeychainSandboxState {
  if (process.platform === "linux") return linuxConfinementState();
  if (process.platform !== "darwin") return { ok: false, reason: "workflow workers run only under the macOS sandbox or the Linux confinement" };
  let sandboxCheck: SandboxCheck;
  try {
    sandboxCheck = check ?? loadSandboxCheck();
  } catch (err) {
    return { ok: false, reason: `the sandbox could not be inspected (${err instanceof Error ? err.message : "error"})` };
  }
  const pid = process.pid;
  const sandboxed = sandboxCheck(pid, null, SANDBOX_FILTER_NONE, null);
  if (sandboxed === 0) return { ok: false, reason: "this process is not sandboxed" };
  if (sandboxed !== 1) return { ok: false, reason: `the sandbox gave no clear answer (${sandboxed})` };
  for (const service of KEYCHAIN_MACH_SERVICES) {
    // Exactly 1 is "denied". 0 is "allowed", and anything else (an error, an unknown answer) fails closed.
    const answer = sandboxCheck(pid, "mach-lookup", SANDBOX_FILTER_GLOBAL_NAME | SANDBOX_CHECK_NO_REPORT, service);
    if (answer === 0) return { ok: false, reason: `the sandbox allows ${service} (the Keychain)` };
    if (answer !== 1) return { ok: false, reason: `the sandbox gave no clear answer for ${service} (${answer})` };
  }
  return { ok: true };
}

/**
 * The first thing a workflow worker does: exit `WORKER_NOT_SANDBOXED_EXIT_CODE` with one line on stderr
 * unless `keychainSandboxState` is ok. Synchronous, so no input can be read before it returns.
 */
export function refuseUnlessKeychainSandboxed(worker: string): void {
  const state = keychainSandboxState();
  if (state.ok) return;
  process.stderr.write(`clover-core: the ${worker} refuses to run: ${state.reason}. It is started only by Clover, inside a sandbox that denies it the Keychain.\n`);
  process.exit(WORKER_NOT_SANDBOXED_EXIT_CODE);
}
