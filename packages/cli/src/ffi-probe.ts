// `clover-core __ffi-probe`: bun:ffi inside the compiled daemon, on each OS it ships for. The agents' bridge checks a
// connecting process's pid with getsockopt through bun:ffi (K-M1), as the Keychain and Cowork's descriptor channel
// do on macOS. This asks the C library (kernel32 on Windows) for this process's pid and compares it with
// `process.pid`. It touches no home, no Keychain and no daemon; `build:daemon --smoke` runs it on every CI machine.
import { dlopen, FFIType } from "bun:ffi";

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
