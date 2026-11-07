// Measures the stream sender's thresholds on a throttled link (virtual time; `throttle-sim.ts`). Run by hand:
//   scripts/pinned-bun packages/core/test/browser/stream-measure.ts [baseline|sweep]
// `baseline` prints every scenario under the current defaults, with a socket buffer of 0, 64 KiB and 256 KiB;
// `sweep` ranks combinations of the thresholds by the sum of the scenarios' scores (`refine` sweeps around the first
// sweep's best, with the goodput rule); `loopback` runs the real-time TCP runs; `compare` prints chosen tunings side by side.
import { SCENARIOS, simulate, type Metrics } from "./throttle-sim";
import { DEFAULT_STREAM_TUNING, type StreamTuning } from "../../src/browser/stream";
import { LOOPBACK_SCENARIOS, runLoopback } from "./stream-loopback";

const f = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "inf");
const row = (m: Metrics) =>
  `${m.scenario.padEnd(50)} frozen ${f(m.frozenSec).padStart(5)}s lag ${f(m.laggingSec).padStart(5)}s p50 ${f(m.latencyP50, 0).padStart(5)} p95 ${f(m.latencyP95, 0).padStart(6)} max ${f(m.latencyMax, 0).padStart(6)} ms  util ${f(m.utilization * 100, 0).padStart(3)}%  ask ${f(m.askRatio, 2)}  dropped ${f(m.droppedShare * 100, 0).padStart(2)}%  key ${String(m.keyframes).padStart(3)}  -${m.lowered} +${m.raised}  score ${f(m.score)}`;

async function all(tuning: Partial<StreamTuning>, sndbufBytes: number): Promise<Metrics[]> {
  const out: Metrics[] = [];
  for (const s of SCENARIOS) out.push(await simulate(s, { tuning, sndbufBytes }));
  return out;
}

const mode = process.argv[2] ?? "baseline";
if (mode === "baseline") {
  for (const sndbufBytes of [0, 64 * 1024, 256 * 1024]) {
    console.log(`\n== socket buffer ${sndbufBytes / 1024} KiB, current defaults`);
    const ms = await all({}, sndbufBytes);
    for (const m of ms) console.log(row(m));
    console.log(`total score ${f(ms.reduce((s, m) => s + m.score, 0))}`);
  }
} else if (mode === "loopback") {
  for (const sc of LOOPBACK_SCENARIOS) {
    const r = await runLoopback(sc, { tuning: process.argv[3] !== undefined ? JSON.parse(process.argv[3]) : {} });
    console.log(`${r.scenario.padEnd(36)} p50 ${f(r.latencyP50, 0)} p95 ${f(r.latencyP95, 0)} max ${f(r.latencyMax, 0)} ms  longest gap ${f(r.longestGapMs, 0)} ms  util ${f(r.utilization * 100, 0)}%  ask ${f(r.askRatio, 2)}  -${r.lowered} +${r.raised}  peak sender backlog ${r.peakBacklog} B, relay queue ${r.peakRelayQueue} B`);
  }
} else if (mode === "compare") {
  const candidates: Record<string, Partial<StreamTuning>> = JSON.parse(process.argv[3] ?? "{}");
  for (const [name, tuning] of Object.entries({ "current defaults (before)": { highWaterSeconds: 0.5, lowerFactor: 0.6, raiseFactor: 1.25, raiseAfterMs: 4000, lowerEveryMs: 1000, goodputFactor: 0 }, "defaults now": {}, ...candidates })) {
    for (const sndbufBytes of [0, 64 * 1024, 256 * 1024]) {
      const ms = await all({ ...DEFAULT_STREAM_TUNING, ...tuning }, sndbufBytes);
      console.log(`${name.padEnd(28)} buffer ${String(sndbufBytes / 1024).padStart(3)} KiB  total ${f(ms.reduce((s, m) => s + m.score, 0)).padStart(6)}  worst p95 ${f(Math.max(...ms.map((m) => m.latencyP95)), 0).padStart(5)} ms  lagging ${f(ms.reduce((s, m) => s + m.laggingSec, 0))} s  frozen ${f(ms.reduce((s, m) => s + m.frozenSec, 0))} s  mean util ${f((ms.reduce((s, m) => s + m.utilization, 0) / ms.length) * 100, 0)}%`);
    }
  }
} else {
  const refine = mode === "refine";
  const grid = refine ? {
    highWaterSeconds: [0.35, 0.5, 0.75],
    lowerFactor: [0.4, 0.5, 0.6],
    raiseFactor: [1.05, 1.1, 1.25],
    raiseAfterMs: [8000, 12000],
    lowerEveryMs: [250, 500],
    goodputFactor: [0, 0.85],
  } : {
    highWaterSeconds: [0.25, 0.5, 1],
    lowerFactor: [0.5, 0.6, 0.75],
    raiseFactor: [1.1, 1.25, 1.5],
    raiseAfterMs: [2000, 4000, 8000],
    lowerEveryMs: [500, 1000, 2000],
    goodputFactor: [0],
  };
  const buffers = refine ? [0, 64 * 1024, 256 * 1024] : [0, 64 * 1024];
  const results: { tuning: Partial<StreamTuning>; score: number; worst: number }[] = [];
  for (const highWaterSeconds of grid.highWaterSeconds)
    for (const lowerFactor of grid.lowerFactor)
      for (const raiseFactor of grid.raiseFactor)
        for (const raiseAfterMs of grid.raiseAfterMs)
          for (const lowerEveryMs of grid.lowerEveryMs)
            for (const goodputFactor of grid.goodputFactor) {
              const tuning = { highWaterSeconds, lowerFactor, raiseFactor, raiseAfterMs, lowerEveryMs, goodputFactor };
              let score = 0;
              let worst = 0;
              // The score is the mean over the buffer sizes a real link has (a QUIC or TCP stream takes tens of KiB).
              for (const sndbufBytes of buffers) {
                const ms = await all(tuning, sndbufBytes);
                score += ms.reduce((s, m) => s + m.score, 0) / buffers.length;
                worst = Math.max(worst, ...ms.map((m) => m.frozenSec));
              }
              results.push({ tuning, score, worst });
            }
  results.sort((a, b) => a.score - b.score);
  for (const r of results.slice(0, 15)) console.log(`${f(r.score)}  worst freeze ${f(r.worst)}s  ${JSON.stringify(r.tuning)}`);
  const same = (t: Partial<StreamTuning>) => t.highWaterSeconds === 0.5 && t.lowerFactor === 0.6 && t.raiseFactor === 1.25 && t.raiseAfterMs === 4000 && t.lowerEveryMs === 1000 && (t.goodputFactor ?? 0) === 0;
  const current = results.find((r) => same(r.tuning));
  console.log(`before (0.5 s, x0.6, x1.25, 4 s, 1 s): ${current === undefined ? "not in this grid" : `${f(current.score)} (rank ${results.indexOf(current) + 1} of ${results.length})`}`);
}
