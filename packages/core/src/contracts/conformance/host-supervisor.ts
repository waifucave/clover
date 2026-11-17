// The HostSupervisor conformance suite (spec revision 19, §3.1). `runHostSupervisorConformance(make)` registers every case
// against the implementation `make` builds over a FakeHostWorld; `tests/host-supervisor.test.ts` runs it against
// FakeHostSupervisor, and lane HS runs it against the engine's. What it pins: adoption by the lock, the newest app as the
// source, headless with no app, exits on purpose, restarts with growing delays and safe mode after three crashes in two
// minutes.
import { describe, expect, test } from "bun:test";
import { HOST_CRASH_WINDOW_MS, HOST_RESTART_DELAYS_MS, HOST_START_TIMEOUT_MS, type AppInstallRecord } from "@waifucave/moss-protocol";
import { FakeClock } from "../fakes/clock";
import { FakeHostWorld, type FakeHostSupervisor } from "../fakes/host-supervisor";

export type HostSupervisorHarness = Pick<FakeHostSupervisor, keyof FakeHostSupervisor>;
export type HostSupervisorFactory = (...args: ConstructorParameters<typeof FakeHostSupervisor>) => HostSupervisorHarness;

const app: AppInstallRecord = { record: 1, program: "moss", bundlePath: "/Applications/MOSS.app", release: "1.111.1", carries: { engine: true, host: true }, seenAt: 1 };

export function runHostSupervisorConformance(make: HostSupervisorFactory): void {
  function setup() {
    const clock = new FakeClock();
    const world = new FakeHostWorld();
    world.app = app;
    return { clock, world, host: make({ clock, world }) };
  }

  describe("HostSupervisor", () => {
    test("a restarted engine adopts the host that holds the lock and starts no second", async () => {
      const { world, host } = setup();
      world.holder = 4242;
      expect(await host.boot()).toBe("adopted");
      expect(host.status()).toMatchObject({ state: "running", pid: 4242 });
      expect(world.starts).toEqual([]);
    });

    test("with no host, the engine starts one from the newest app that carries it; with no app left, it runs headless", async () => {
      const { world, host } = setup();
      expect(await host.boot()).toBe("started");
      expect(world.starts).toEqual([{ bundlePath: "/Applications/MOSS.app", safeMode: false }]);
      host.ready({ pid: 7, release: "1.111.1", bundlePath: "/Applications/MOSS.app", safeMode: false });
      expect(host.status()).toMatchObject({ state: "running", pid: 7, safeMode: false });
      const none = setup();
      none.world.app = undefined;
      expect(await none.host.boot()).toBe("absent");
      expect(none.host.status().state).toBe("absent");
    });

    test("an exit on purpose starts nothing; a crash restarts it after growing delays", async () => {
      const { clock, world, host } = setup();
      await host.boot();
      host.ready({ pid: 7, release: "1.111.1", bundlePath: app.bundlePath, safeMode: false });
      host.exiting("update");
      host.exited();
      clock.advance(60_000);
      expect(world.starts.length).toBe(1);
      expect(host.status().state).toBe("stopped");
      await host.boot();
      host.exited();
      expect(host.status()).toMatchObject({ state: "restarting", crashes: 1 });
      clock.advance(HOST_RESTART_DELAYS_MS[0] - 1);
      expect(world.starts.length).toBe(2);
      clock.advance(1);
      expect(world.starts.length).toBe(3);
      host.exited();
      clock.advance(HOST_RESTART_DELAYS_MS[0]);
      expect(world.starts.length).toBe(3);
      clock.advance(HOST_RESTART_DELAYS_MS[1] - HOST_RESTART_DELAYS_MS[0]);
      expect(world.starts.length).toBe(4);
    });

    test("after three crashes in two minutes the host starts in safe mode; crashes older than the window don't count", async () => {
      const { clock, world, host } = setup();
      await host.boot();
      for (let i = 0; i < 3; i++) {
        host.exited();
        clock.advance(HOST_RESTART_DELAYS_MS[HOST_RESTART_DELAYS_MS.length - 1]!);
      }
      expect(world.starts.at(-1)).toEqual({ bundlePath: app.bundlePath, safeMode: true });
      host.ready({ pid: 9, release: "1.111.1", bundlePath: app.bundlePath, safeMode: true });
      expect(host.status()).toMatchObject({ state: "safe-mode", safeMode: true });
      clock.advance(HOST_CRASH_WINDOW_MS);
      host.exited();
      clock.advance(HOST_RESTART_DELAYS_MS[0]);
      expect(world.starts.at(-1)).toEqual({ bundlePath: app.bundlePath, safeMode: false });
    });

    test("the engine's stop is asked of the host and is no crash; with no app left a crashed host isn't restarted for ever", async () => {
      const { clock, world, host } = setup();
      await host.boot();
      host.stop("quit-everything");
      host.exited();
      expect(world.stops).toEqual(["quit-everything"]);
      clock.advance(60_000);
      expect(world.starts.length).toBe(1);
      await host.boot();
      world.app = undefined;
      host.exited();
      clock.advance(HOST_RESTART_DELAYS_MS[0]);
      expect(host.status().state).toBe("absent");
      clock.advance(10 * 60_000);
      expect(world.starts.length).toBe(2);
    });

    test("the safe-mode reason means restart in safe mode: at once, with no crash counted", async () => {
      const { world, host } = setup();
      await host.boot();
      host.ready({ pid: 7, release: "1.111.1", bundlePath: app.bundlePath, safeMode: false });
      host.exiting("safe-mode");
      host.exited();
      expect(world.starts).toEqual([{ bundlePath: app.bundlePath, safeMode: false }, { bundlePath: app.bundlePath, safeMode: true }]);
      expect(host.status()).toMatchObject({ state: "starting", safeMode: true, crashes: 0 });
      // The engine's own stop for safe mode is the same.
      host.ready({ pid: 8, release: "1.111.1", bundlePath: app.bundlePath, safeMode: true });
      host.stop("safe-mode");
      host.exited();
      expect(world.stops).toEqual(["safe-mode"]);
      expect(world.starts.at(-1)).toEqual({ bundlePath: app.bundlePath, safeMode: true });
      expect(world.starts.length).toBe(3);
    });

    test("a host that never says it is ready (it never connected, or died before its hello) counts as a crash", async () => {
      const { clock, world, host } = setup();
      await host.boot();
      clock.advance(HOST_START_TIMEOUT_MS - 1);
      expect(host.status().state).toBe("starting");
      clock.advance(1);
      expect(host.status()).toMatchObject({ state: "restarting", crashes: 1 });
      clock.advance(HOST_RESTART_DELAYS_MS[0]);
      expect(world.starts.length).toBe(2);
      // A host found by its lock that never connects is no host either.
      const adopted = setup();
      adopted.world.holder = 4242;
      await adopted.host.boot();
      adopted.clock.advance(HOST_START_TIMEOUT_MS);
      expect(adopted.host.status()).toMatchObject({ state: "restarting", crashes: 1 });
      adopted.clock.advance(HOST_RESTART_DELAYS_MS[0]);
      expect(adopted.world.starts.length).toBe(1);
      // Once ready, the watchdog is gone.
      adopted.host.ready({ pid: 5, release: "1.111.1", bundlePath: app.bundlePath, safeMode: false });
      adopted.clock.advance(10 * HOST_START_TIMEOUT_MS);
      expect(adopted.host.status().state).toBe("running");
    });

    test("a host that says it is ready while a restart waits cancels the restart; a stop while one waits stops it at once", async () => {
      const { clock, world, host } = setup();
      await host.boot();
      host.exited();
      host.ready({ pid: 11, release: "1.111.1", bundlePath: app.bundlePath, safeMode: false });
      clock.advance(60_000);
      expect(world.starts.length).toBe(1);
      expect(host.status()).toMatchObject({ state: "running", pid: 11 });
      host.exited();
      host.stop("quit-everything");
      expect(host.status().state).toBe("stopped");
      clock.advance(60_000);
      expect(world.starts.length).toBe(1);
    });
  });
}
