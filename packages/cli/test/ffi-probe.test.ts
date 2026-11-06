// `clover-core __ffi-probe` (src/ffi-probe.ts): bun:ffi reaches the C library and gets this process's pid. The compiled
// binary's own run is `build:daemon --smoke`'s, on each CI machine.
import { expect, test } from "bun:test";
import { ffiPidCall, runFfiProbe } from "../src/ffi-probe";

test("each OS the daemon ships for has its pid call, and nothing else claims one", () => {
  expect(ffiPidCall("darwin")).toEqual({ lib: "libSystem.B.dylib", symbol: "getpid" });
  expect(ffiPidCall("linux")).toEqual({ lib: "libc.so.6", symbol: "getpid" });
  expect(ffiPidCall("win32")).toEqual({ lib: "kernel32.dll", symbol: "GetCurrentProcessId" });
  expect(ffiPidCall("freebsd")).toBeUndefined();
  expect(runFfiProbe("freebsd").ok).toBe(false);
});

test("on this machine the C library answers this process's pid", () => {
  const r = runFfiProbe();
  expect(r.line).toBe(`ffi: ok (${ffiPidCall(process.platform)!.lib} ${ffiPidCall(process.platform)!.symbol}() = ${process.pid}, this process)`);
  expect(r.ok).toBe(true);
});
