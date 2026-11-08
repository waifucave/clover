import { describe, expect, test } from "bun:test";
import { backoffMs, superviseLoop, UPDATE_RESTART_EXIT_CODE, type DaemonRun, type SuperviseDeps } from "../../src/platform/login/supervise";

function run(code: number | null): DaemonRun {
  return { exited: Promise.resolve(code), stop() {} };
}

describe("supervise loop", () => {
  test("a clean daemon exit ends the loop without a restart", async () => {
    let started = 0;
    const deps: SuperviseDeps = {
      spawnDaemon() { started++; return run(0); },
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
      spawnDaemon() { return run(codes[i++] ?? 0); },
      async wait(ms) { waits.push(ms); return true; },
      shouldContinue: () => true,
      log: () => {},
    };
    const r = await superviseLoop(deps);
    expect(r.starts).toBe(3);
    expect(r.crashes).toBe(2);
    expect(r.ended).toBe("clean-exit");
    expect(waits).toEqual([500, 1000]); // back-off after the 1st and 2nd crash
  });

  test("an update's restart starts the daemon again at once, and is no crash", async () => {
    const codes = [UPDATE_RESTART_EXIT_CODE, 1, UPDATE_RESTART_EXIT_CODE, 0];
    let i = 0;
    const waits: number[] = [];
    const r = await superviseLoop({
      spawnDaemon() { return run(codes[i++] ?? 0); },
      async wait(ms) { waits.push(ms); return true; },
      shouldContinue: () => true,
      log: () => {},
    });
    expect(r).toEqual({ starts: 4, crashes: 1, ended: "clean-exit" });
    expect(waits).toEqual([500]);
  });

  test("a stop request ends the loop even amid crashes", async () => {
    let alive = true;
    const deps: SuperviseDeps = {
      spawnDaemon() { return run(1); },
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

  test("crashes older than two minutes no longer raise the back-off", async () => {
    let t = 0;
    const gaps = [0, 1_000, 300_000, 1_000];
    let i = 0;
    const codes = [1, 1, 1, 1, 0];
    const waits: number[] = [];
    const deps: SuperviseDeps = {
      spawnDaemon() { t += gaps[i] ?? 0; return run(codes[i++] ?? 0); },
      async wait(ms) { waits.push(ms); return true; },
      shouldContinue: () => true,
      log: () => {},
      now: () => t,
    };
    await superviseLoop(deps);
    // two quick crashes, then one five minutes later starts over at 0.5 s
    expect(waits).toEqual([500, 1000, 500, 1000]);
  });

  test("back-off grows from 0.5 s and caps at 30 s", () => {
    expect(backoffMs(1)).toBe(500);
    expect(backoffMs(2)).toBe(1000);
    expect(backoffMs(3)).toBe(2000);
    expect(backoffMs(10)).toBe(30000);
  });
});
