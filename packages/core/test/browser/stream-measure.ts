// Measures the stream sender's thresholds on a throttled link (virtual time; `throttle-sim.ts`). Run by hand:
//   scripts/pinned-bun packages/core/test/browser/stream-measure.ts [baseline|sweep]
// `baseline` prints every scenario under the current defaults, with a socket buffer of 0, 64 KiB and 256 KiB;
// `sweep` ranks combinations of the thresholds by the sum of the scenarios' scores.
import { SCENARIOS, simulate, type Metrics } from "./throttle-sim";
import type { StreamTuning } from "../../src/browser/stream";

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
} else {
  const grid = {
    highWaterSeconds: [0.25, 0.5, 1],
    lowerFactor: [0.5, 0.6, 0.75],
    raiseFactor: [1.1, 1.25, 1.5],
    raiseAfterMs: [2000, 4000, 8000],
    lowerEveryMs: [500, 1000, 2000],
  };
  const results: { tuning: Partial<StreamTuning>; score: number; worst: number }[] = [];
  for (const highWaterSeconds of grid.highWaterSeconds)
    for (const lowerFactor of grid.lowerFactor)
      for (const raiseFactor of grid.raiseFactor)
        for (const raiseAfterMs of grid.raiseAfterMs)
          for (const lowerEveryMs of grid.lowerEveryMs) {
            const tuning = { highWaterSeconds, lowerFactor, raiseFactor, raiseAfterMs, lowerEveryMs };
            let score = 0;
            let worst = 0;
            // The score is the mean over the buffer sizes a real link has (a QUIC or TCP stream takes tens of KiB).
            for (const sndbufBytes of [0, 64 * 1024]) {
              const ms = await all(tuning, sndbufBytes);
              score += ms.reduce((s, m) => s + m.score, 0) / 2;
              worst = Math.max(worst, ...ms.map((m) => m.frozenSec));
            }
            results.push({ tuning, score, worst });
          }
  results.sort((a, b) => a.score - b.score);
  for (const r of results.slice(0, 15)) console.log(`${f(r.score)}  worst freeze ${f(r.worst)}s  ${JSON.stringify(r.tuning)}`);
  const current = results.find((r) => r.tuning.highWaterSeconds === 0.5 && r.tuning.lowerFactor === 0.6 && r.tuning.raiseFactor === 1.25 && r.tuning.raiseAfterMs === 4000 && r.tuning.lowerEveryMs === 1000);
  console.log(`current defaults: ${current === undefined ? "?" : `${f(current.score)} (rank ${results.indexOf(current) + 1} of ${results.length})`}`);
}
