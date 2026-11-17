// The real supervisor's own rule beyond the contract (lane HS, RL's review): a record missing for a moment is not "no app".
import { expect, test } from "bun:test";
import { HOST_SOURCE_GRACE_MS, HOST_SOURCE_RECHECK_MS, HOST_START_ATTEMPTS, type AppInstallRecord } from "@waifucave/moss-protocol";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakeHostWorld } from "../../contracts/fakes/host-supervisor";
import { EngineHostSupervisor } from "../supervisor";

const app: AppInstallRecord = { record: 1, program: "moss", bundlePath: "/Applications/MOSS.app", release: "1.111.1", carries: { engine: true, host: true }, seenAt: 1 };

test("an app record gone for a moment (an update replacing its bundle) is looked for again, and the host starts when it is back", async () => {
  const clock = new FakeClock();
  const world = new FakeHostWorld();
  const host = new EngineHostSupervisor({ clock, world });
  expect(await host.boot()).toBe("absent");
  clock.advance(HOST_SOURCE_RECHECK_MS);
  expect(world.starts).toEqual([]);
  world.app = app;
  clock.advance(HOST_SOURCE_RECHECK_MS);
  expect(world.starts).toEqual([{ bundlePath: app.bundlePath, safeMode: false }]);
  expect(host.status().state).toBe("starting");
});

test("after the grace it stays headless, until a window connects and an app is there again; never after the engine stopped it", async () => {
  const clock = new FakeClock();
  const world = new FakeHostWorld();
  const host = new EngineHostSupervisor({ clock, world });
  await host.boot();
  clock.advance(HOST_SOURCE_GRACE_MS + HOST_SOURCE_RECHECK_MS * 2);
  world.app = app;
  clock.advance(10 * 60_000);
  expect(world.starts).toEqual([]);
  host.poke();
  expect(world.starts.length).toBe(1);
  host.ready({ pid: 3, release: "1.111.1", bundlePath: app.bundlePath, safeMode: false });
  host.stop("quit-everything");
  host.exited();
  host.poke();
  expect(world.starts.length).toBe(1);
});

test("a host that never starts is tried HOST_START_ATTEMPTS times, then the engine stops trying and says so (no endless restarting)", async () => {
  const clock = new FakeClock();
  const world = new FakeHostWorld();
  world.app = app;
  const host = new EngineHostSupervisor({ clock, world, startTimeoutMs: 1_000 });
  const seen: string[] = [];
  host.watch((s) => seen.push(`${s.state}${s.gaveUp === true ? " gave up" : ""}`));
  await host.boot();
  // Each start dies before its ready (the watchdog's crash), then waits its restart delay.
  for (let i = 0; i < HOST_START_ATTEMPTS + 2; i++) clock.advance(1_000 + 30_000);
  expect(world.starts.length).toBe(HOST_START_ATTEMPTS);
  expect(host.status()).toMatchObject({ state: "absent", gaveUp: true });
  expect(seen.at(-1)).toBe("absent gave up");
  // A window connecting doesn't start the round again; a long while later neither does anything.
  host.poke();
  clock.advance(60 * 60_000);
  expect(world.starts.length).toBe(HOST_START_ATTEMPTS);
});

test("a host that says ready starts the count over: crashes after a ready keep restarting it", async () => {
  const clock = new FakeClock();
  const world = new FakeHostWorld();
  world.app = app;
  const host = new EngineHostSupervisor({ clock, world, startTimeoutMs: 1_000 });
  await host.boot();
  for (let i = 0; i < HOST_START_ATTEMPTS * 2; i++) {
    host.ready({ pid: 10 + i, release: app.release, bundlePath: app.bundlePath, safeMode: false });
    clock.advance(200_000);
    host.exited();
    clock.advance(500);
  }
  expect(world.starts.length).toBe(HOST_START_ATTEMPTS * 2 + 1);
  expect(host.status().gaveUp).toBeUndefined();
});
