// S1 question 2, the binding's cost: how fast bytes cross napi under Bun when a binding takes
// Vec<u8> (a JS Array<number>, as @number0/iroh 1.2.0 does) against Uint8Array/Buffer, sync and
// async, and whether a 10 ms timer still fires while async napi loops run.
//
//   bun src/napi-probe.ts [--addon ../napi-probe/s1-napi-probe.node]
//
// Build the addon first: cargo build --release --manifest-path ../napi-probe/Cargo.toml, then
// copy target/release/libs1_napi_probe.{dylib,so} or s1_napi_probe.dll to s1-napi-probe.node.

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { arg, emit, mbps, now, round } from "./lib/report.ts";

const addonPath = resolve(arg("addon", "../napi-probe/s1-napi-probe.node")!);
const totalMB = Number(arg("mb", "64"));
const chunk = Number(arg("chunk", String(64 * 1024)));
const calls = Math.ceil((totalMB * 1e6) / chunk);

type Addon = {
  sinkVec(b: number[]): number;
  sourceVec(n: number): number[];
  sinkTyped(b: Uint8Array): number;
  sourceBuffer(n: number): Buffer;
  sinkTypedAsync(b: Uint8Array): Promise<number>;
  sourceBufferAsync(n: number): Promise<Buffer>;
  sinkVecAsync(b: number[]): Promise<number>;
  sourceVecAsync(n: number): Promise<number[]>;
};

function timer() {
  const gaps: number[] = [];
  let last = now();
  const id = setInterval(() => {
    const t = now();
    gaps.push(t - last);
    last = t;
  }, 10);
  return (ms: number) => {
    clearInterval(id);
    return { expected: Math.floor(ms / 10), fired: gaps.length };
  };
}

async function measure(name: string, fn: () => unknown | Promise<unknown>, n = calls) {
  const stop = timer();
  const t = now();
  for (let i = 0; i < n; i++) await fn();
  const ms = now() - t;
  return { name, MBps: mbps(n * chunk, ms), usPerCall: round((ms * 1000) / n, 2), timer10ms: stop(ms) };
}

// Two loops that each await only their own calls, as a link's sender and receiver do.
async function independent(name: string, a: () => Promise<unknown>, b: () => Promise<unknown>, n: number) {
  const stop = timer();
  const t = now();
  const loop = async (f: () => Promise<unknown>) => {
    for (let i = 0; i < n; i++) await f();
  };
  await Promise.all([loop(a), loop(b)]);
  const ms = now() - t;
  return { name, MBps: mbps(2 * n * chunk, ms), usPerCall: round((ms * 1000) / (2 * n), 2), timer10ms: stop(ms) };
}

try {
  const addon = createRequire(import.meta.url)(addonPath) as Addon;
  const arr = new Array<number>(chunk).fill(1);
  const u8 = new Uint8Array(chunk).fill(1);
  const results = [
    await measure("Array<number> in (iroh's write)", () => addon.sinkVec(arr)),
    await measure("Array<number> in, from a Uint8Array each time", () => addon.sinkVec(Array.from(u8))),
    await measure("Array<number> out (iroh's read), to Buffer", () => Buffer.from(addon.sourceVec(chunk))),
    await measure("Uint8Array in", () => addon.sinkTyped(u8)),
    await measure("Buffer out", () => addon.sourceBuffer(chunk)),
    await measure("Array<number> in, async", () => addon.sinkVecAsync(arr)),
    await measure("Array<number> out, async", () => addon.sourceVecAsync(chunk)),
    await measure("Uint8Array in, async", () => addon.sinkTypedAsync(u8)),
    await measure("Buffer out, async", () => addon.sourceBufferAsync(chunk)),
    await measure(
      "lock-step pair of async calls (Array<number>)",
      () => Promise.all([addon.sinkVecAsync(arr), addon.sourceVecAsync(chunk)]),
      Math.ceil(calls / 2),
    ),
    await independent(
      "two independent async loops (Array<number>)",
      () => addon.sinkVecAsync(arr),
      () => addon.sourceVecAsync(chunk),
      Math.ceil(calls / 2),
    ),
    await independent(
      "two independent async loops (typed, 32x the bytes)",
      () => addon.sinkTypedAsync(u8),
      () => addon.sourceBufferAsync(chunk),
      Math.ceil(calls * 16),
    ),
  ];
  emit("napi-probe", { ok: true, chunk, totalMB, results });
  process.exit(0);
} catch (e) {
  emit("napi-probe", { ok: false, error: String((e as Error)?.stack ?? e) });
  process.exit(1);
}
