// A-M1 review S3: Worker churn inside a daemon, and what a live code session costs in memory. OPT-IN
// (`CLOVER_WORKER_SOAK=1`): it runs `worker-churn-soak.ts` (a real daemon on a temp home, a fake model, no model
// calls) in a CHILD process under this package's test preload, so a Bun crash is that child's exit status, never
// the test runner's death. The child prints its readings, and this test prints them too.
//
// What it guards: every code session, Dispatch child and idle re-incarnation spawns and terminates a Worker in the
// always-on daemon, and Bun 1.3.14 has an intermittent Worker use-after-free (`ci.yml` notes it after ~70 Workers).
//
// Measured (A-M1, Bun 1.3.14, macOS arm64): no crash in 80 rounds or in 160. One live code session costs about
// 40-57 MB of the daemon's RSS. Terminated Workers are not handed back to the OS: RSS went from ~225 MB to 1387 MB
// after 80 rounds and to 1602 MB after 160 (the growth slows, so it looks like a high-water mark rather than a
// steady leak), and a full GC does not lower it. The soak did not reproduce the crash, so no Worker cap was
// added; the retained memory is an open item for the Bun upgrade or Worker reuse.
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const SOAK = fileURLToPath(new URL("./worker-churn-soak.ts", import.meta.url));
const PRELOAD = fileURLToPath(new URL("../preload.ts", import.meta.url));
const CORE = fileURLToPath(new URL("../..", import.meta.url));

test.skipIf(process.env["CLOVER_WORKER_SOAK"] !== "1")("Worker churn in a daemon: no crash, and the memory a live code session costs", async () => {
  const proc = Bun.spawn([process.execPath, "--preload", PRELOAD, SOAK], {
    cwd: CORE,
    env: { ...process.env, SOAK_ROUNDS: process.env["SOAK_ROUNDS"] ?? "80", SOAK_CONCURRENT: process.env["SOAK_CONCURRENT"] ?? "8" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 7 * 60_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  const last = stdout.trim().split("\n").pop() ?? "";
  console.log(`worker-churn soak: exit ${code}${proc.signalCode ? ` (${proc.signalCode})` : ""}: ${last}`);
  if (code !== 0) console.log(stderr.split("\n").filter((l) => /panic|Segmentation|crash|error/i.test(l)).slice(0, 10).join("\n"));
  expect(code).toBe(0);
  const result = JSON.parse(last) as { churnRounds: number; rounds: number; liveAfterChurn: number };
  expect(result.churnRounds).toBe(result.rounds);
  expect(result.liveAfterChurn).toBe(0);
}, 8 * 60_000);
