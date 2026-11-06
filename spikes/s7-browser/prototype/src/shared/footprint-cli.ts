// macOS only: print each pid's physical footprint (bytes) as JSON, for the Electron main process, which has no FFI.
//   bun src/shared/footprint-cli.ts <pid>…
import { dlopen, FFIType, ptr } from "bun:ffi";

const lib = dlopen("/usr/lib/libSystem.B.dylib", {
  proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
});
const out: Record<string, number> = {};
for (const a of process.argv.slice(2)) {
  const pid = Number(a);
  const buf = Buffer.alloc(512);
  // RUSAGE_INFO_V4; ri_phys_footprint at offset 72
  if (lib.symbols.proc_pid_rusage(pid, 4, ptr(buf)) === 0) out[a] = Number(buf.readBigUInt64LE(72));
}
console.log(JSON.stringify(out));
