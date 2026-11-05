// A-M1 review S3, second soak: THE CRASH TRIGGER. Bun 1.3.14's Worker use-after-free shows when a Worker is torn
// down while it is busy, not when it ends idle (`worker-churn-soak.ts`, which never crashed). Run by
// `worker-churn-soak.test.ts` in a child process, so a Bun crash is that child's exit status.
//
// Boots a daemon on a temp home with `winter-test/calls` (the SDK's prompt-scripted double: no model calls), and
// in every round starts a code session whose turn runs TWO concurrent `Bash` calls, each a process group of its own
// (`sleep` behind a shell), and tears the session down while they run, three ways in turn:
//   0. `session.interrupt` and the session's end at once, racing (abort and terminate mid-turn);
//   1. the session's end alone, mid-tool (the Worker killed with its turn and its tools running);
//   2. `session.interrupt`, the turn's end awaited, then the session's end.
// After each round every process the tools started must be gone (no session child outlives its Worker).
// Prints one JSON line: rounds, leaked processes, live Workers left, and RSS readings (start, a quarter in,
// halfway, the end, the peak) so the test can hold the daemon's memory to a plateau under a budget.
import { METHODS } from "@waifucave/clover-protocol";
import { mb, memory, memoryReport, type MemoryReading, startSoakDaemon } from "./soak-support";

const rounds = Number(process.env["SOAK_ROUNDS"] ?? "150");
// A duration no other process on the machine runs, so `pgrep` finds exactly this soak's tools.
const marker = `sleep 600.${process.pid}`;
const script = [`CALL Bash {"command":"${marker}; true"}`, `+CALL Bash {"command":"${marker}; true"}`].join("\n");

const { daemon, client, cwd, stop } = await startSoakDaemon("worker-midturn-soak", "winter-test/calls");

function toolProcesses(): number[] {
  const r = Bun.spawnSync(["/usr/bin/pgrep", "-f", marker]);
  return r.stdout.toString().split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
}

async function settle(ms: number): Promise<number[]> {
  const t0 = Date.now();
  let left = toolProcesses();
  while (left.length > 0 && Date.now() - t0 < ms) {
    await Bun.sleep(50);
    left = toolProcesses();
  }
  return left;
}

const out: Record<string, unknown> = { rounds };
const samples: MemoryReading[] = [];
let leaked = 0;
let toolsSeen = 0;
try {
  const start = memory();
  for (let i = 0; i < rounds; i++) {
    client.clearEvents();
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "soak", mode: "code", model: "winter-test/calls", cwd, approvalPolicy: "bypass" });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await client.call(METHODS.sessionSend, { sessionId, text: script });
    // Mid-turn: the tools' processes are running.
    const t0 = Date.now();
    while (toolProcesses().length < 2 && Date.now() - t0 < 20_000) await Bun.sleep(20);
    if (toolProcesses().length > 0) toolsSeen++;
    const session = daemon.clover.get(sessionId);
    switch (i % 3) {
      case 0: {
        const interrupted = client.call(METHODS.sessionInterrupt, { sessionId }).catch(() => undefined);
        await session?.end();
        await interrupted;
        break;
      }
      case 1:
        await session?.end();
        break;
      default: {
        await client.call(METHODS.sessionInterrupt, { sessionId }).catch(() => undefined);
        await client.until(sessionId, 0, (e) => e.type === "turn_completed", "interrupted turn", 15_000).catch(() => undefined);
        await session?.end();
      }
    }
    const left = await settle(5_000);
    if (left.length > 0) {
      leaked += left.length;
      for (const pid of left) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
    samples.push(memory());
    if ((i + 1) % 10 === 0) {
      const m = samples.at(-1)!;
      console.error(`round ${i + 1}: ps-rss=${mb(m.psRss)}MB footprint=${m.footprint === null ? "n/a" : `${mb(m.footprint)}MB`} bun-rss=${mb(m.bunRss)}MB leaked=${leaked} live=${daemon.embedded.live().length}`);
    }
  }
  await Bun.sleep(500);
  const at = (fraction: number): MemoryReading => samples[Math.max(0, Math.ceil(samples.length * fraction) - 1)] ?? start;
  const peakOf = (field: "psRss" | "bunRss" | "footprint"): MemoryReading => [start, ...samples].reduce((a, b) => ((b[field] ?? 0) > (a[field] ?? 0) ? b : a));
  out["completedRounds"] = samples.length;
  out["roundsWithTools"] = toolsSeen;
  out["leakedProcesses"] = leaked;
  out["liveAfter"] = daemon.embedded.live().length;
  // Side by side and labelled (`soak-support.ts`): the budget and plateau below are `ps -o rss=`'s, the resident set.
  // Each `peak*` entry is the reading where that field peaked.
  out["memory"] = memoryReport({ start, quarter: at(0.25), half: at(0.5), end: at(1), peakPsRss: peakOf("psRss"), peakFootprint: peakOf("footprint"), peakBunRss: peakOf("bunRss") });
  out["peakPsRssMb"] = mb(peakOf("psRss").psRss);
  out["secondHalfGrowthMb"] = mb(at(1).psRss - at(0.5).psRss);
  const fp = (r: MemoryReading): number | null => r.footprint;
  out["secondHalfFootprintGrowthMb"] = fp(at(1)) === null || fp(at(0.5)) === null ? null : mb(fp(at(1))! - fp(at(0.5))!);
} finally {
  await stop();
}
console.log(JSON.stringify(out));
process.exit(0);
