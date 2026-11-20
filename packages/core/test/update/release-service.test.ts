// `release.bring` and friends (src/update/release-service.ts): a newer app brings its engine only when nothing is mid-work,
// or at the person's "switch now"; the host is asked to stop first; the copy is checked before it runs; a failed swap
// reopens everything. Temp homes only; no engine is started and no real update is downloaded.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { stopWithin } from "../../src/daemon";
import { engineBinaryPath, placeEngine, locateEngineIn, verifyStagedEngine, type CopyPolicy } from "../../src/update/engine-copy";
import { UpdateGate } from "../../src/update/gate";
import { EngineReleaseHome } from "../../src/update/release-home";
import { ReleaseService, ReleaseRefused, type ReleaseEventBody } from "../../src/update/release-service";
import { writeSidecars } from "./fixtures/sidecars";

const root = mkdtempSync(join(tmpdir(), "moss-rl-svc-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

/** A newer app's bundle on disk: a fake engine that says which release it is, and a tree. */
function bundle(release: string): string {
  const dir = join(root, `app${n++}`);
  // The two layouts an app has: macOS's Contents/Resources and the others' resources.
  for (const res of [join(dir, "resources"), join(dir, "Contents", "Resources")]) {
    mkdirSync(join(res, "daemon"), { recursive: true });
    mkdirSync(join(res, "plugins", "x"), { recursive: true });
    writeFileSync(join(res, "daemon", "moss-core"), `#!/bin/sh\necho "moss ${release}"\n`);
    chmodSync(join(res, "daemon", "moss-core"), 0o755);
    writeSidecars(join(res, "daemon"), release);
    writeFileSync(join(res, "plugins", "x", "a.txt"), "tree");
  }
  return dir;
}

function setup(o: { engine?: string; platform?: NodeJS.Platform; check?: (p: string, r: string) => boolean; failPlace?: boolean } = {}) {
  const home = join(root, `home${n++}`);
  mkdirSync(home, { recursive: true });
  const platform = o.platform ?? "linux";
  const records: CopyPolicy["records"] = () => home_.apps();
  const policy: CopyPolicy = { platform, profile: "dist", developerId: true, records: () => records(), ...(o.check ? { check: o.check } : {}) };
  const home_ = new EngineReleaseHome({
    home, engine: o.engine ?? "1.0.0", clock: new FakeClock(),
    place: (copy) => {
      if (o.failPlace) throw new Error("disk full");
      const src = locateEngineIn(copy.from, platform)!;
      placeEngine(home, { ...src, root: copy.from }, copy, platform, (s) => verifyStagedEngine(s, copy.release, policy));
    },
  });
  const gate = new UpdateGate();
  let turns = 0, agents = 0;
  gate.register({ name: "turns", count: () => turns });
  gate.register({ name: "agents", count: () => agents });
  // The bots' own turns are a source of their own (bots/wiring.ts `bot-turns`).
  let botTurns = 0;
  gate.register({ name: "bot-turns", count: () => botTurns });
  const events: ReleaseEventBody[] = [];
  const calls: string[] = [];
  const host = { stop: (r: string) => calls.push(`host.stop:${r}`), boot: async () => { calls.push("host.boot"); } };
  const service = new ReleaseService({
    home: home_, engine: { release: o.engine ?? "1.0.0", path: "/engine" }, gate, host, policy, homeDir: home, pollMs: 1,
    emit: (e) => events.push(e), restart: () => { calls.push("restart"); }, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  const app = (release: string, program: "code" | "moss" = "code") => {
    const dir = bundle(release);
    home_.record({ program, bundlePath: dir, release, build: "9", carries: { engine: true, host: true } });
    return dir;
  };
  return { home, home_, gate, service, events, calls, app, setBusy: (t: number, a = 0, b = 0) => { turns = t; agents = a; botTurns = b; } };
}
const until = async (f: () => boolean) => { for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); expect(f()).toBe(true); };

describe("release.bring", () => {
  test("waits while a turn runs, says what it waits for, then stops the host, swaps and restarts", async () => {
    const t = setup();
    const dir = t.app("1.1.0");
    t.setBusy(1, 0);
    expect(await t.service.bring("code", { release: "1.1.0", bundlePath: dir })).toEqual({ state: "waiting" });
    await until(() => t.events.some((e) => e.waitingFor?.turns === 1));
    expect(t.events[0]).toMatchObject({ state: "waiting", engine: "1.0.0", incoming: "1.1.0" });
    expect(t.calls).toEqual([]);
    expect(t.gate.closed).toBe(false);
    t.setBusy(0, 0);
    await until(() => t.calls.includes("restart"));
    expect(t.calls).toEqual(["host.stop:update", "restart"]);
    expect(t.events.map((e) => e.state)).toContain("switching");
    expect(readFileSync(engineBinaryPath(t.home), "utf8")).toContain("moss 1.1.0");
    expect(readFileSync(join(t.home, "bin", "plugins", "x", "a.txt"), "utf8")).toBe("tree");
    expect(t.gate.committed).toBe(true);
  });

  test("a bot's turn is a running turn to the wait's words (the `bot-turns` source), added to the sessions'", async () => {
    const t = setup();
    const dir = t.app("1.1.0");
    t.setBusy(1, 0, 2);
    await t.service.bring("code", { release: "1.1.0", bundlePath: dir });
    await until(() => t.events.some((e) => e.waitingFor?.turns === 3));
    expect(t.calls).toEqual([]);
  });

  test("an agent running holds it too; \"switch now\" doesn't wait", async () => {
    const t = setup();
    const dir = t.app("1.1.0");
    t.setBusy(0, 2);
    await t.service.bring("code", { release: "1.1.0", bundlePath: dir });
    await until(() => t.events.some((e) => e.waitingFor?.agents === 2));
    expect(t.calls).toEqual([]);
    expect(await t.service.bring("code", { release: "1.1.0", bundlePath: dir, now: true })).toEqual({ state: "waiting" });
    await until(() => t.calls.includes("restart"));
    expect(t.calls[0]).toBe("host.stop:update");
  });

  test("idle at once: no wait", async () => {
    const t = setup();
    const dir = t.app("1.1.0");
    await t.service.bring("code", { release: "1.1.0", bundlePath: dir });
    await until(() => t.calls.includes("restart"));
    expect(t.events.at(-1)).toMatchObject({ state: "switching", incoming: "1.1.0" });
  });

  test("refuses what isn't newer, what the app didn't record for itself, and a path no app recorded", async () => {
    const t = setup();
    const dir = t.app("1.1.0");
    await expect(t.service.bring("code", { release: "1.0.0", bundlePath: dir })).rejects.toThrow(ReleaseRefused);
    await expect(t.service.bring("code", { release: "1.2.0", bundlePath: dir })).rejects.toThrow("record doesn't name");
    await expect(t.service.bring("moss", { release: "1.1.0", bundlePath: dir })).rejects.toThrow("record doesn't name");
    await expect(t.service.bring(undefined, { release: "1.1.0", bundlePath: dir })).rejects.toThrow("only an app");
    const other = bundle("1.1.0");
    await expect(t.service.bring("code", { release: "1.1.0", bundlePath: other })).rejects.toThrow("record doesn't name");
    expect(t.service.state).toBe("current");
    expect(t.calls).toEqual([]);
  });

  test("a copy that doesn't say it is the release named is refused AT bring: nothing waited for, nothing stopped, nothing placed", async () => {
    const t = setup();
    const dir = t.app("1.1.0");
    t.setBusy(1, 0);
    // The app claims 1.2.0 but carries an engine that says 1.1.0.
    t.home_.record({ program: "code", bundlePath: dir, release: "1.2.0", build: "9", carries: { engine: true, host: true } });
    await expect(t.service.bring("code", { release: "1.2.0", bundlePath: dir })).rejects.toMatchObject({ code: "not-acceptable" });
    expect(t.service.state).toBe("current");
    expect(existsSync(engineBinaryPath(t.home))).toBe(false);
    expect(t.calls).toEqual([]);
    expect(t.events).toEqual([]);
    expect(t.gate.closed).toBe(false);
    // The scratch the check used is gone.
    expect(existsSync(join(t.home, "bin", `.verify-${process.pid}`))).toBe(false);
  });

  test("macOS: a copy whose signature isn't the product's is refused at bring, before the wait", async () => {
    const t = setup({ platform: "darwin", check: () => false });
    const dir = t.app("1.1.0");
    t.setBusy(2, 0);
    await expect(t.service.bring("code", { release: "1.1.0", bundlePath: dir })).rejects.toThrow("code signature");
    expect(existsSync(engineBinaryPath(t.home, "darwin"))).toBe(false);
    expect(t.calls).toEqual([]);
    expect(t.events).toEqual([]);
  });

  test("a restart loop: a second bring for a release already restarted into, with the engine still below it, is refused plainly", async () => {
    const t = setup();
    const dir = t.app("1.1.0");
    await t.service.bring("code", { release: "1.1.0", bundlePath: dir });
    await until(() => t.calls.includes("restart"));
    // The engine came back on 1.0.0 (supervise started the same binary): the app asks again.
    // Same home, a fresh service on the old release.
    const svc = new ReleaseService({ home: t.home_, engine: { release: "1.0.0", path: "/engine" }, gate: new UpdateGate(), host: { stop: () => {} }, policy: { platform: "linux", profile: "dist", developerId: true, records: () => t.home_.apps() }, homeDir: t.home, emit: () => {}, restart: () => {} });
    await expect(svc.bring("code", { release: "1.1.0", bundlePath: dir })).rejects.toMatchObject({ code: "loop" });
    // Once the engine is on it, the file is stale and a later release is free to go.
    const later = new ReleaseService({ home: t.home_, engine: { release: "1.1.0", path: "/engine" }, gate: new UpdateGate(), host: { stop: () => {} }, policy: { platform: "linux", profile: "dist", developerId: true, records: () => t.home_.apps() }, homeDir: t.home, emit: () => {}, restart: () => {} });
    const dir2 = t.app("1.2.0");
    expect(await later.bring("code", { release: "1.2.0", bundlePath: dir2 })).toEqual({ state: "waiting" });
  });

  test("the old-home copy's exit-76 restart is not a release restart: it writes no marker, clears none, and blocks no bring", async () => {
    const marker = (home: string) => join(home, "bin", ".restarted-into.json");
    const t = setup();
    // The home copy's restart (`requestRestart` in `daemon run`): a bounded stop that keeps the app, then exit 76. No release service is involved.
    const homeCopyStop = async () => { const stops: unknown[] = []; await stopWithin({ stop: (o?: unknown) => { stops.push(o); } } as Parameters<typeof stopWithin>[0], 50, { keepApp: true }); return stops; };
    expect(await homeCopyStop()).toEqual([{ keepApp: true }]);
    expect(existsSync(marker(t.home))).toBe(false);
    // So a bring right after it is taken, and only THAT restart writes the marker.
    const dir = t.app("1.1.0");
    await t.service.bring("code", { release: "1.1.0", bundlePath: dir });
    await until(() => t.calls.includes("restart"));
    const written = readFileSync(marker(t.home), "utf8");
    expect(JSON.parse(written)).toEqual({ release: "1.1.0" });
    // A home-copy restart after it leaves the marker as it was (still on 1.0.0, the loop guard holds) ...
    await homeCopyStop();
    expect(readFileSync(marker(t.home), "utf8")).toBe(written);
    const same = new ReleaseService({ home: t.home_, engine: { release: "1.0.0", path: "/engine" }, gate: new UpdateGate(), host: { stop: () => {} }, policy: { platform: "linux", profile: "dist", developerId: true, records: () => t.home_.apps() }, homeDir: t.home, emit: () => {}, restart: () => {} });
    await expect(same.bring("code", { release: "1.1.0", bundlePath: dir })).rejects.toMatchObject({ code: "loop" });
    // ... and once the engine is on 1.1.0 (after both restarts) the next release is free, the home copy's restart having counted for nothing.
    await homeCopyStop();
    const on = new ReleaseService({ home: t.home_, engine: { release: "1.1.0", path: "/engine" }, gate: new UpdateGate(), host: { stop: () => {} }, policy: { platform: "linux", profile: "dist", developerId: true, records: () => t.home_.apps() }, homeDir: t.home, emit: () => {}, restart: () => {} });
    expect(await on.bring("code", { release: "1.2.0", bundlePath: t.app("1.2.0") })).toEqual({ state: "waiting" });
  });

  test("a release restart and the home copy's restart together stop the daemon once, the first one's options standing", async () => {
    const stops: unknown[] = [];
    const daemon = { stop: (o?: unknown) => { stops.push(o); } } as Parameters<typeof stopWithin>[0];
    const a = stopWithin(daemon, 50, { keepApp: true });
    const b = stopWithin(daemon, 50);
    await Promise.all([a, b]);
    expect(stops).toEqual([{ keepApp: true }]);
  });

  test("macOS: the requirement asked is the engine's identifier, the team and Developer ID", async () => {
    const asked: string[] = [];
    const t = setup({ platform: "darwin", check: (_p, r) => { asked.push(r); return true; } });
    const dir = t.app("1.1.0");
    await t.service.bring("code", { release: "1.1.0", bundlePath: dir });
    await until(() => t.calls.includes("restart"));
    expect(asked[0]).toContain('identifier "com.waifucave.moss.core"');
    expect(asked[0]).toContain("anchor apple generic");
    expect(asked[0]).toContain("1.2.840.113635.100.6.1.13");
    expect(asked[0]).toContain("37N77U9RSZ");
  });

  test("a failed placement reopens the gate and boots the host again", async () => {
    const t = setup({ failPlace: true });
    const dir = t.app("1.1.0");
    await t.service.bring("code", { release: "1.1.0", bundlePath: dir });
    await until(() => t.service.state === "current");
    expect(t.calls).toEqual(["host.stop:update", "host.boot"]);
    expect(t.gate.closed).toBe(false);
    expect(t.events.at(-1)).toMatchObject({ state: "current" });
  });
});

describe("release.status and release.record", () => {
  test("status names the engine, the recorded apps and the state", () => {
    const t = setup();
    t.app("1.0.0", "moss");
    const s = t.service.status();
    expect(s).toMatchObject({ engine: { release: "1.0.0", path: "/engine" }, state: "current" });
    expect(s.apps.map((a) => a.program)).toEqual(["moss"]);
  });

  test("an app records its own program only", () => {
    const t = setup();
    const dir = bundle("1.0.0");
    const p = { program: "code" as const, bundlePath: dir, release: "1.0.0", carries: { engine: true, host: true } };
    expect(() => t.service.record(undefined, p)).toThrow(ReleaseRefused);
    expect(() => t.service.record("moss", p)).toThrow("own program");
    t.service.record("code", p);
    expect(t.home_.apps().map((a) => a.program)).toEqual(["code"]);
  });
});
