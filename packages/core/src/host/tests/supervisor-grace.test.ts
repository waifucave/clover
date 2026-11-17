// The real supervisor's own rule beyond the contract (lane HS, RL's review): a record missing for a moment is not "no app".
import { expect, test } from "bun:test";
import { HOST_SOURCE_GRACE_MS, HOST_SOURCE_RECHECK_MS, type AppInstallRecord } from "@waifucave/moss-protocol";
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
