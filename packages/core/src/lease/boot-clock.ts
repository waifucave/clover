// The clocks the lease runs on (spec §6.4 "Fencing the old main"; contracts/lease.ts): a monotonic clock that counts
// the time the machine slept, and one that doesn't. Their difference is how long the machine slept, which is how the
// core notices a wake on its own (a headless daemon has no app to tell it).
//
// * The lease's deadline is on the sleep-counting clock: a main that slept through its lease never thinks it still
//   holds it (CLOCK_MONOTONIC on macOS, CLOCK_BOOTTIME on Linux, QueryInterruptTime on Windows).
// * The awake clock doesn't count sleep (CLOCK_UPTIME_RAW, CLOCK_MONOTONIC, QueryUnbiasedInterruptTime).
// * Both are read over bun:ffi, a few hundred nanoseconds a call. Where a library can't be opened, the fallback counts
//   sleep from the wall clock: a tick that sees the wall move far more than `performance.now()` adds the difference.
import { dlopen, FFIType, ptr } from "bun:ffi";
import type { Unsubscribe } from "../contracts/common";

export interface MachineClocks {
  /** Milliseconds on a monotonic clock that keeps counting while the machine sleeps. */
  boot(): number;
  /** Milliseconds on a monotonic clock that stops while the machine sleeps. */
  awake(): number;
  /** Where the numbers come from: `os` through the OS's own clocks, `estimate` from the wall clock. */
  readonly source: "os" | "estimate";
}

let cached: MachineClocks | undefined;

/** This machine's clocks, opened once. */
export function machineClocks(): MachineClocks {
  cached ??= openOsClocks() ?? estimatedClocks();
  return cached;
}

function openOsClocks(): MachineClocks | undefined {
  try {
    if (process.platform === "darwin") {
      // <time.h>: _CLOCK_MONOTONIC 6 counts sleep, _CLOCK_UPTIME_RAW 8 doesn't.
      const lib = dlopen("/usr/lib/libSystem.B.dylib", { clock_gettime_nsec_np: { args: [FFIType.i32], returns: FFIType.u64 } });
      const read = (id: number) => Number(lib.symbols.clock_gettime_nsec_np(id)) / 1e6;
      if (!(read(6) > 0) || !(read(8) > 0)) return undefined;
      return { boot: () => read(6), awake: () => read(8), source: "os" };
    }
    if (process.platform === "linux") {
      // CLOCK_BOOTTIME 7 counts suspend, CLOCK_MONOTONIC 1 doesn't; struct timespec is two 64-bit fields.
      const lib = dlopen("libc.so.6", { clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
      const buf = new BigInt64Array(2);
      const p = ptr(buf);
      const read = (id: number) => {
        if (lib.symbols.clock_gettime(id, p) !== 0) return Number.NaN;
        return Number(buf[0]!) * 1000 + Number(buf[1]!) / 1e6;
      };
      if (!(read(7) > 0) || !(read(1) > 0)) return undefined;
      return { boot: () => read(7), awake: () => read(1), source: "os" };
    }
    if (process.platform === "win32") {
      // Both in 100 ns units; QueryInterruptTime (Windows 10 1803+) counts sleep, the unbiased one doesn't.
      const lib = dlopen("KernelBase.dll", {
        QueryInterruptTime: { args: [FFIType.ptr], returns: FFIType.void },
        QueryUnbiasedInterruptTime: { args: [FFIType.ptr], returns: FFIType.i32 },
      });
      const buf = new BigUint64Array(1);
      const p = ptr(buf);
      const boot = () => {
        lib.symbols.QueryInterruptTime(p);
        return Number(buf[0]!) / 1e4;
      };
      const awake = () => {
        lib.symbols.QueryUnbiasedInterruptTime(p);
        return Number(buf[0]!) / 1e4;
      };
      if (!(boot() > 0) || !(awake() > 0)) return undefined;
      return { boot, awake, source: "os" };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The fallback: `performance.now()` as the awake clock, plus every gap where the wall clock ran on without it. A
 *  wall-clock step (NTP, the user) of more than the threshold reads as sleep too, which errs on the safe side: the
 *  lease treats it as a wake. */
function estimatedClocks(): MachineClocks {
  let slept = 0;
  let lastWall = Date.now();
  let lastAwake = performance.now();
  const sample = () => {
    const wall = Date.now();
    const awake = performance.now();
    const gap = wall - lastWall - (awake - lastAwake);
    if (gap > 2_000) slept += gap;
    lastWall = wall;
    lastAwake = awake;
  };
  return {
    boot: () => {
      sample();
      return performance.now() + slept;
    },
    awake: () => performance.now(),
    source: "estimate",
  };
}

export interface SleepWatchOptions {
  clocks?: Pick<MachineClocks, "boot" | "awake">;
  /** How often to compare the two clocks; 2 s by default (half a wakeup a second, well inside the idle budget). */
  everyMs?: number;
  /** A gap over this is a sleep; 1.5 s by default, so a busy event loop never reads as one. */
  thresholdMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** Calls `onWake(sleptMs)` after the machine slept: the boot clock ran on while the awake clock stood still. */
export function watchSleep(onWake: (sleptMs: number) => void, o: SleepWatchOptions = {}): Unsubscribe {
  const clocks = o.clocks ?? machineClocks();
  const every = o.everyMs ?? 2_000;
  const threshold = o.thresholdMs ?? 1_500;
  let lastBoot = clocks.boot();
  let lastAwake = clocks.awake();
  const tick = () => {
    const boot = clocks.boot();
    const awake = clocks.awake();
    const slept = boot - lastBoot - (awake - lastAwake);
    lastBoot = boot;
    lastAwake = awake;
    if (slept > threshold) onWake(slept);
  };
  const set = o.setInterval ?? ((fn: () => void, ms: number) => {
    const h = setInterval(fn, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  });
  const clear = o.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const handle = set(tick, every);
  return () => clear(handle);
}
