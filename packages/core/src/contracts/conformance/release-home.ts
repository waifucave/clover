// The ReleaseHome conformance suite (spec revision 19, §3.1, ruling D). `runReleaseHomeConformance(make)` registers every
// case against the implementation `make` builds; `tests/release-home.test.ts` runs it against FakeReleaseHome, and lane RL
// runs it against the engine's. What it pins: the hello's three standings, the release door, the apps' records and the
// one install lock with the newer copy winning.
import { describe, expect, test } from "bun:test";
import { FakeClock } from "../fakes/clock";
import type { FakeReleaseHome } from "../fakes/release-home";

export type ReleaseHomeHarness = Pick<FakeReleaseHome, keyof FakeReleaseHome>;
export type ReleaseHomeFactory = (...args: ConstructorParameters<typeof FakeReleaseHome>) => ReleaseHomeHarness;

export function runReleaseHomeConformance(make: ReleaseHomeFactory): void {
  describe("ReleaseHome", () => {
    test("a hello's release: none isn't judged, the same is served, an older one is refused with what it needs, a newer one gets the door", () => {
      const home = make({ clock: new FakeClock(), engine: "1.111.1" });
      expect(home.judge(undefined)).toEqual({ kind: "served" });
      expect(home.judge("1.111.1")).toEqual({ kind: "served", standing: "same" });
      expect(home.judge("1.111.0")).toEqual({ kind: "refused", refusal: { standing: "behind", engine: "1.111.1", client: "1.111.0", needs: "1.111.1" } });
      expect(home.judge("1.111.1-rc.1")).toMatchObject({ kind: "refused" });
      expect(home.judge("1.112.0")).toEqual({ kind: "door", standing: "ahead", engine: "1.111.1" });
      expect(["release.status", "release.bring", "events.subscribe"].map((m) => home.doorAllows(m))).toEqual([true, true, true]);
      expect(["session.send", "card.answer", "presence.report"].map((m) => home.doorAllows(m))).toEqual([false, false, false]);
    });

    test("each program's latest record; a record whose bundle is gone is dropped; the host comes from the newest app that carries it", () => {
      const clock = new FakeClock();
      const home = make({ clock, engine: "1.111.1" });
      home.bundles.add("/Applications/MOSS.app");
      home.bundles.add("/Applications/MOSS Code.app");
      home.record({ program: "moss", bundlePath: "/Applications/MOSS.app", release: "1.111.1", carries: { engine: true, host: true } });
      clock.advance(1);
      home.record({ program: "code", bundlePath: "/Applications/MOSS Code.app", release: "1.111.2", carries: { engine: true, host: true } });
      expect(home.apps().map((a) => a.program).sort()).toEqual(["code", "moss"]);
      expect(home.hostSource()?.program).toBe("code");
      home.bundles.delete("/Applications/MOSS Code.app");
      expect(home.apps().map((a) => a.program)).toEqual(["moss"]);
      expect(home.hostSource()?.program).toBe("moss");
      home.bundles.delete("/Applications/MOSS.app");
      expect(home.hostSource()).toBeUndefined();
    });

    test("installs run one at a time under the lock: the newer copy wins, the other just connects", async () => {
      const clock = new FakeClock();
      const home = make({ clock, engine: "1.111.1", installed: { release: "1.111.1", build: "100", from: "/a" } });
      home.slowInstallMs = 1_000;
      const order: string[] = [];
      const older = home.install({ release: "1.111.0", from: "/old" }).then((r) => { order.push("old"); return r; });
      const newer = home.install({ release: "1.111.2", build: "5", from: "/new" }).then((r) => { order.push("new"); return r; });
      const newerBuild = home.install({ release: "1.111.2", build: "7", from: "/new2" }).then((r) => { order.push("new2"); return r; });
      const sameAgain = home.install({ release: "1.111.2", build: "7", from: "/again" }).then((r) => { order.push("again"); return r; });
      // Each install holds the lock for a second of the clock: drive it until all four are done.
      for (let i = 0; i < 40 && order.length < 4; i++) {
        await new Promise((r) => setTimeout(r, 0));
        clock.advance(250);
      }
      expect(order).toEqual(["old", "new", "new2", "again"]);
      expect(await older).toMatchObject({ installed: false, current: { release: "1.111.1" } });
      expect(await newer).toMatchObject({ installed: true, current: { release: "1.111.2", build: "5" } });
      expect(await newerBuild).toMatchObject({ installed: true, current: { release: "1.111.2", build: "7" } });
      expect(await sameAgain).toMatchObject({ installed: false, current: { release: "1.111.2", build: "7", from: "/new2" } });
      expect(home.installed()).toMatchObject({ release: "1.111.2", build: "7" });
    });
  });
}
