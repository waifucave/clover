import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COWORK_NATIVE_LIMITS, coworkNativeHostStopWaitMs } from "../../src/cowork/native/protocol";
import { STOP_BUDGET_MS } from "../../src/daemon";

// N2 S7B part 1, item 4: the stop timeouts of everything that can end the daemon, against the 65 s drain bound.
// These are PINS of what the repository says today, so a change to any of them is seen here and decided deliberately; this file edits none of them.
const repo = join(import.meta.dir, "..", "..", "..", "..");
const read = (path: string): string => readFileSync(join(repo, path), "utf8");
const HOST_WAIT_MS = coworkNativeHostStopWaitMs(COWORK_NATIVE_LIMITS.drainBudgetMs);

test("the host's wait for a guest stop is 65 s at the default budget", () => {
  expect(HOST_WAIT_MS).toBe(65_000);
});

test("the app gives the daemon 5 s between SIGTERM and SIGKILL, far below the drain bound", () => {
  const source = read("apple/Winter/Sources/App/DaemonSupervisor.swift");
  expect(/static let gracefulExitTimeout: TimeInterval = 5\.0/.test(source)).toBe(true);
  expect(5_000).toBeLessThan(HOST_WAIT_MS);
});

test("the launchd job states no ExitTimeOut (launchd's own default applies, 20 s), so it also ends the daemon before the drain bound", () => {
  const source = read("packages/cli/src/launchd.ts");
  expect(source.includes("ExitTimeOut")).toBe(false);
  expect(20_000).toBeLessThan(HOST_WAIT_MS);
});

test("the daemon's own SIGTERM handler bounds its stop (stopWithin, STOP_BUDGET_MS = 5 s), far below the drain bound", () => {
  const source = read("packages/core/src/daemon.ts");
  expect(source).toContain('const shutdown = async () => { await stopWithin(daemon); process.exit(0); };');
  expect(source).toContain('process.on("SIGTERM", shutdown);');
  // The CLI's `daemon run` (the packaged core) stops through the same bound.
  // (a test build may cut the bound shorter: the acceptance's capped-stop step; never longer)
  expect(read("packages/cli/src/main.ts")).toMatch(/const shutdown = async \(\) => \{ await stopWithin\(daemon[,)]/);
  expect(STOP_BUDGET_MS).toBe(5_000);
  expect(STOP_BUDGET_MS).toBeLessThan(HOST_WAIT_MS);
});

test("so a daemon ended by the app, launchd or a signal can be SIGKILLed before the drain finishes: the launcher's owner-loss drain, not the daemon's stop, carries the bound", () => {
  // The two bounds that are stated numerically are both below the host wait; the launcher must therefore outlive the daemon's SIGKILL (S2/G2 gate).
  const supervisors = [5_000, 20_000, STOP_BUDGET_MS];
  expect(supervisors.every(bound => bound < HOST_WAIT_MS)).toBe(true);
  // The launcher's own drain budget plus its kill margin is what the daemon's wait mirrors.
  expect(COWORK_NATIVE_LIMITS.drainBudgetMs).toBe(30_000);
});
