// `clover-core __ffi-probe`: bun:ffi inside the compiled daemon, on each OS it ships for. The agents' bridge checks a
// connecting process's pid with getsockopt through bun:ffi (K-M1), as the Keychain and Cowork's descriptor channel
// do on macOS. This asks the C library (kernel32 on Windows) for this process's pid and compares it with
// `process.pid`. It touches no home, no Keychain and no daemon; `build:daemon --smoke` runs it on every CI machine.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import { peerPidOf } from "../../core/src/agents/bridge/peer";

/** The library and the call that answer this process's pid, per OS; undefined where the daemon doesn't ship. */
export function ffiPidCall(platform: NodeJS.Platform): { lib: string; symbol: string } | undefined {
  if (platform === "darwin") return { lib: "libSystem.B.dylib", symbol: "getpid" };
  if (platform === "linux") return { lib: "libc.so.6", symbol: "getpid" };
  if (platform === "win32") return { lib: "kernel32.dll", symbol: "GetCurrentProcessId" };
  return undefined;
}

export function runFfiProbe(platform: NodeJS.Platform = process.platform): { ok: boolean; line: string } {
  const call = ffiPidCall(platform);
  if (call === undefined) return { ok: false, line: `ffi: FAILED (no C library known for ${platform})` };
  try {
    const lib = dlopen(call.lib, { [call.symbol]: { args: [], returns: platform === "win32" ? FFIType.u32 : FFIType.i32 } });
    const pid = Number((lib.symbols[call.symbol] as () => number)());
    lib.close();
    return pid === process.pid
      ? { ok: true, line: `ffi: ok (${call.lib} ${call.symbol}() = ${pid}, this process)` }
      : { ok: false, line: `ffi: FAILED (${call.lib} ${call.symbol}() = ${pid}, but this process is ${process.pid})` };
  } catch (error) {
    return { ok: false, line: `ffi: FAILED (${call.lib}: ${(error as Error).message})` };
  }
}

/**
 * The bridge's own check (K-M1, `peerPidOf`): who is on the other end of a Unix socket, from the kernel. This process
 * connects to a socket of its own, so the answer must be its pid on macOS and Linux. Windows has no such answer
 * (lane C's job-object check takes its place there), and the probe says so.
 */
export async function runPeerPidProbe(platform: NodeJS.Platform = process.platform): Promise<{ ok: boolean; line: string }> {
  if (platform === "win32") return { ok: peerPidOf(0) === null, line: "peer-pid: none on Windows (lane C's job-object check), as expected" };
  const dir = mkdtempSync(join(tmpdir(), "clover-peer-pid-"));
  const path = join(dir, "s");
  let seen: number | null | undefined;
  const server = Bun.listen({ unix: path, socket: { open: (s) => { seen = peerPidOf((s as unknown as { fd: number }).fd); }, data() {} } });
  try {
    const client = await Bun.connect({ unix: path, socket: { data() {} } });
    for (let i = 0; i < 200 && seen === undefined; i++) await Bun.sleep(10);
    client.end();
    if (seen === process.pid) return { ok: true, line: `peer-pid: ok (getsockopt on a socket to itself = ${seen}, this process)` };
    return { ok: false, line: `peer-pid: FAILED (getsockopt gave ${seen === undefined ? "no answer" : String(seen)}, but this process is ${process.pid})` };
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}
