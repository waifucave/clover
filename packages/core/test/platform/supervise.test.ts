import { describe, expect, test } from "bun:test";
import { backoffMs, superviseLoop, type DaemonRun, type SuperviseDeps } from "../../src/platform/login/supervise";

function run(code: number | null): DaemonRun {
  return { exited: Promise.resolve(code), stop() {} };
}

describe("supervise loop", () => {
  test("a clean daemon exit ends the loop without a restart", async () => {
    let started = 0;
    const deps: SuperviseDeps = {
      startDaemon() { started++; return run(0); },
      async wait() { return true; },
      shouldContinue: () => true,
      log: () => {},
    };
    const r = await superviseLoop(deps);
    expect(started).toBe(1);
    expect(r).toEqual({ starts: 1, crashes: 0, ended: "clean-exit" });
  });

  test("a crash restarts; a later clean exit ends the loop", async () => {
    const codes = [1, 1, 0];
    let i = 0;
    const waits: number[] = [];
    const deps: SuperviseDeps = {
      startDaemon() { return run(codes[i++] ?? 0); },
      async wait(ms) { waits.push(ms); return true; },
      shouldContinue: () => true,
      log: () => {},
    };
    const r = await superviseLoop(deps);
    expect(r.starts).toBe(3);
    expect(r.crashes).toBe(2);
    expect(r.ended).toBe("clean-exit");
    expect(waits).toEqual([1000, 2000]); // back-off after the 1st and 2nd crash
  });

  test("a stop request ends the loop even amid crashes", async () => {
    let alive = true;
    const deps: SuperviseDeps = {
      startDaemon() { return run(1); },
      async wait() { return true; },
      shouldContinue: () => alive,
      log: () => {},
    };
    // stop after the first crash's wait
    const orig = deps.wait;
    deps.wait = async (ms) => { alive = false; return orig(ms); };
    const r = await superviseLoop(deps);
    expect(r.ended).toBe("stopped");
    expect(r.starts).toBe(1);
  });

  test("back-off grows and caps at 30s", () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(2)).toBe(2000);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(10)).toBe(30000);
  });
});
