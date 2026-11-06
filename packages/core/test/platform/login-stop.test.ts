import { describe, expect, test } from "bun:test";
import { stopDaemonCleanly } from "../../src/platform/login/stop";

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

describe("stopping the running daemon cleanly (uninstallers)", () => {
  test("nothing running: nothing asked", async () => {
    let asked = 0;
    const r = await stopDaemonCleanly({ answers: async () => false, stillRunning: () => false, requestQuit: async () => { asked++; return true; }, ...clock() });
    expect(r).toBe("not-running");
    expect(asked).toBe(0);
  });

  test("asked to quit, it is stopped once the endpoint is gone and the process has exited", async () => {
    const c = clock();
    let quitAt = -1;
    const r = await stopDaemonCleanly({
      answers: async () => quitAt < 0 || c.now() - quitAt < 400, // the endpoint closes first
      stillRunning: () => quitAt < 0 || c.now() - quitAt < 1_000, // the process exits after its stores close
      requestQuit: async () => { quitAt = c.now(); return true; },
      ...c,
    });
    expect(r).toBe("stopped");
    expect(c.now()).toBeGreaterThanOrEqual(1_000);
  });

  test("one that can't be asked, or doesn't go in time, is left to the OS's stop", async () => {
    expect(await stopDaemonCleanly({ answers: async () => true, stillRunning: () => true, requestQuit: async () => false, ...clock() })).toBe("timed-out");
    const c = clock();
    expect(await stopDaemonCleanly({ answers: async () => true, stillRunning: () => true, requestQuit: async () => true, ...c }, 10_000)).toBe("timed-out");
    expect(c.now()).toBeGreaterThanOrEqual(10_000);
  });
});
