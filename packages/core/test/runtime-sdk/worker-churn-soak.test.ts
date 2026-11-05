// A-M1 review S3: Worker churn inside a daemon, what a live code session costs in memory, and the crash trigger.
// OPT-IN (`CLOVER_WORKER_SOAK=1`). Each soak runs in a CHILD process under this package's test preload, so a Bun
// crash is that child's exit status, never the test runner's death. The children print their readings, and these
// tests print them too. They are long: run one at a time (`-t churn`, `-t "mid-turn"`, `-t dispatch`).
//
// What they guard: every code session, Dispatch child and idle re-incarnation spawns and terminates a Worker in the
// always-on daemon, and Bun 1.3.14 has an intermittent Worker use-after-free (`ci.yml` notes it after ~70 Workers).
//
//   churn (`worker-churn-soak.ts`): Workers that end idle, one after another, then several live at once.
//     Measured (A-M1, Bun 1.3.14, macOS arm64): no crash in 80 rounds or in 160. One live code session costs
//     about 40-57 MB of the daemon's RSS. Terminated Workers are not handed back to the OS: RSS went from ~225 MB
//     to 1387 MB after 80 rounds and to 1602 MB after 160, and a full GC does not lower it.
//   mid-turn (`worker-midturn-soak.ts`): the trigger itself. Sessions torn down while their turn runs two Bash
//     tools (process groups of their own): interrupt and end racing, end alone, interrupt then end. Every tool
//     process must be gone after each round, and the daemon's memory must plateau under a budget:
//     SOAK_RSS_BUDGET_MB (peak, default 1024) and SOAK_RSS_PLATEAU_MB (growth over the second half, default 96).
//     The budget holds macOS's phys_footprint (resident pages there include reclaimable ones) and resident memory
//     elsewhere. Every soak prints all three meters, labelled (`soak-support.ts`'s MemoryReading): resident
//     (`ps -o rss=`), footprint, and Bun's `process.memoryUsage().rss`, which is phys_footprint on macOS since
//     Bun 1.4.3, so the same number would compare two meters across a Bun upgrade.
//   dispatch (`test/e2e/dispatch-spawn-e2e.test.ts`, SOAK_DISPATCH_RUNS times, default 20): Dispatch spawning,
//     stopping and messaging children, each run a fresh process that must exit cleanly.
//
// Lane M runs the mid-turn and dispatch soaks on each Bun upgrade as a release gate: crash-free, and the memory
// plateau under budget. Measured on Bun 1.3.14 (A-M1, macOS arm64): the mid-turn soak did not crash in 150
// rounds and left no tool process running; the dispatch soak CRASHED 6 runs in 20 (SIGTRAP, EXC_BREAKPOINT on a
// thread named Worker), more often while other heavy jobs ran. Lane M, on both meters: on 1.3.14 a terminated
// Worker leaves about 6.5 MB of footprint behind, on Bun 1.4.4 about 0.3 MB (the mid-turn soak's 150 rounds:
// footprint peak 167 MB, +17.6 MB over the second half); neither version hands resident pages back (1.4.4: 753 MB
// resident at the peak). One live code session costs about 70 MB of footprint. So on 1.4.4 Worker reuse is not
// needed for memory.
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const PRELOAD = fileURLToPath(new URL("../preload.ts", import.meta.url));
const CORE = fileURLToPath(new URL("../..", import.meta.url));
const SOAK = process.env["CLOVER_WORKER_SOAK"] !== "1";

async function runChild(argv: string[], env: Record<string, string>, limitMs: number): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, ...argv], { cwd: CORE, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), limitMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, signal: proc.signalCode ?? null, stdout, stderr };
}

const crashLines = (stderr: string): string => stderr.split("\n").filter((l) => /panic|Segmentation|crash|error/i.test(l)).slice(0, 10).join("\n");

test.skipIf(SOAK)("churn: Worker churn in a daemon, no crash, and the memory a live code session costs", async () => {
  const r = await runChild(["--preload", PRELOAD, fileURLToPath(new URL("./worker-churn-soak.ts", import.meta.url))], { SOAK_ROUNDS: process.env["SOAK_ROUNDS"] ?? "80", SOAK_CONCURRENT: process.env["SOAK_CONCURRENT"] ?? "8" }, 7 * 60_000);
  const last = r.stdout.trim().split("\n").pop() ?? "";
  console.log(`worker-churn soak: exit ${r.code}${r.signal ? ` (${r.signal})` : ""}: ${last}`);
  if (r.code !== 0) console.log(crashLines(r.stderr));
  expect(r.code).toBe(0);
  const result = JSON.parse(last) as { churnRounds: number; rounds: number; liveAfterChurn: number };
  expect(result.churnRounds).toBe(result.rounds);
  expect(result.liveAfterChurn).toBe(0);
}, 8 * 60_000);

test.skipIf(SOAK)("mid-turn: sessions torn down while their tools run, no crash, no tool left running, RSS on a plateau under budget", async () => {
  const r = await runChild(["--preload", PRELOAD, fileURLToPath(new URL("./worker-midturn-soak.ts", import.meta.url))], { SOAK_ROUNDS: process.env["SOAK_ROUNDS"] ?? "150" }, 7 * 60_000);
  const last = r.stdout.trim().split("\n").pop() ?? "";
  console.log(`worker mid-turn soak: exit ${r.code}${r.signal ? ` (${r.signal})` : ""}: ${last}`);
  if (r.code !== 0) console.log(crashLines(r.stderr));
  expect(r.code).toBe(0);
  const result = JSON.parse(last) as { rounds: number; completedRounds: number; roundsWithTools: number; leakedProcesses: number; liveAfter: number; budget: { peakMb: number; secondHalfGrowthMb: number } };
  expect(result.completedRounds).toBe(result.rounds);
  // Vacuous if the tools were not running when the sessions were torn down.
  expect(result.roundsWithTools).toBe(result.rounds);
  expect(result.leakedProcesses).toBe(0);
  expect(result.liveAfter).toBe(0);
  expect(result.budget.peakMb).toBeLessThanOrEqual(Number(process.env["SOAK_RSS_BUDGET_MB"] ?? "1024"));
  expect(result.budget.secondHalfGrowthMb).toBeLessThanOrEqual(Number(process.env["SOAK_RSS_PLATEAU_MB"] ?? "96"));
}, 8 * 60_000);

test.skipIf(SOAK)("dispatch: dispatch-spawn-e2e, run again and again, every run a clean exit", async () => {
  const runs = Number(process.env["SOAK_DISPATCH_RUNS"] ?? "20");
  const failures: string[] = [];
  for (let i = 1; i <= runs; i++) {
    const t0 = Date.now();
    const r = await runChild(["test", "test/e2e/dispatch-spawn-e2e.test.ts"], {}, 3 * 60_000);
    const summary = (r.stderr.match(/^\s*\d+ (?:pass|fail)$/gm) ?? []).map((l) => l.trim()).join(", ");
    console.log(`dispatch-spawn-e2e run ${i}/${runs}: exit ${r.code}${r.signal ? ` (${r.signal})` : ""}, ${summary}, ${Math.round((Date.now() - t0) / 1000)} s`);
    if (r.code !== 0) failures.push(`run ${i}: exit ${r.code}${r.signal ? ` (${r.signal})` : ""}\n${crashLines(r.stderr)}`);
  }
  expect(failures).toEqual([]);
}, 30 * 60_000);
