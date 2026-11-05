import { describe, expect, test } from "bun:test";
import { ensureDaemonReachable } from "../src/main";

// Lifecycle Task 5, C-M1: `clover` starts the daemon through the OS when it is down (and on a desktop
// the daemon starts the app). `ensureDaemonReachable` is the pure, injectable core (OS/clock/env seams
// passed in) — these tests never touch a real endpoint and never run launchctl, systemctl or schtasks;
// `connect()` wires the real seams (see main.ts).
describe("ensureDaemonReachable — the three outcomes", () => {
  test("already-up when the endpoint answers → never starts anything", async () => {
    let started = 0;
    const r = await ensureDaemonReachable({ endpointUp: () => true,
      startDaemon: async () => { started++; return "started"; }, sleepMs: async () => {}, now: () => 0, noAutoLaunch: false });
    expect(r).toBe("already-up"); expect(started).toBe(0);
  });
  test("starts through the OS + polls when the endpoint is down", async () => {
    let started = 0; let up = false;
    const r = await ensureDaemonReachable({ endpointUp: async () => up,
      startDaemon: async () => { started++; setTimeout(() => { up = true; }, 0); return "started"; }, sleepMs: async () => {}, now: (() => { let t = 0; return () => (t += 100); })(), noAutoLaunch: false });
    expect(started).toBe(1); expect(r).toBe("launched");
  });
  test("no-app when the endpoint is down + noAutoLaunch", async () => {
    let started = 0;
    const r = await ensureDaemonReachable({ endpointUp: () => false,
      startDaemon: async () => { started++; return "started"; }, sleepMs: async () => {}, now: () => 0, noAutoLaunch: true });
    expect(r).toBe("no-app"); expect(started).toBe(0);
  });
  test("no-app when no daemon unit is installed for this profile (a dev tree)", async () => {
    const r = await ensureDaemonReachable({ endpointUp: () => false,
      startDaemon: async () => "not-installed", sleepMs: async () => {}, now: () => 0, noAutoLaunch: false });
    expect(r).toBe("no-app");
  });
  test("an OS start that never answers fails with a hint", async () => {
    let t = 0;
    await expect(ensureDaemonReachable({ endpointUp: () => false,
      startDaemon: async () => "failed", sleepMs: async () => {}, now: () => (t += 1000), noAutoLaunch: false })).rejects.toThrow(/isn't responding/);
  });
});
