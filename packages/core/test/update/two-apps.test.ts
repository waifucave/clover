// Two apps installed on one home (spec §3.1, G3, R3, R4, R7; lane PK): each install state, at the level the engine's own code
// decides it, on temp homes with stand-in bundles (an Info.plist and the host helper's folder): which app the engine starts
// the host from, what the engine says to an app that is behind or ahead of it, and what is left when one app is deleted.
// What only a Developer ID signed pair proves (the helper's signature, a packaged app's hello) is the controller's signed run
// (docs/claude/release.md); here the signature check is a stand-in that is handed the requirement and the path.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppInstallRecord } from "@waifucave/moss-protocol";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { appRecordsSource, engineHostWorld, hostHelperPath, launchApp } from "../../src/host/world";
import type { Runner } from "../../src/platform/login/live";
import { appBundleRequirement, copyAcceptable } from "../../src/update/engine-copy";
import { judgeHello } from "../../src/update/release-door";
import { EngineReleaseHome } from "../../src/update/release-home";

const root = mkdtempSync(join(tmpdir(), "pk-two-apps-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

/** A stand-in app bundle: its Info.plist says `release`; with `host`, the helper the engine starts the host from. */
function bundle(dir: string, name: string, release: string, host = true): string {
  const app = join(dir, `${name}.app`);
  mkdirSync(join(app, "Contents"), { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0"?>\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${release}</string></dict></plist>\n`);
  if (host) mkdirSync(join(hostHelperPath(app, "dist"), "Contents"), { recursive: true });
  return app;
}

function world(engine = "1.2.0") {
  const home = join(root, `h${n++}`);
  const apps = join(root, `apps${n}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(apps, { recursive: true });
  const clock = new FakeClock();
  const rh = new EngineReleaseHome({ home, engine, clock, place: () => {}, missGraceMs: 30_000 });
  const ran: string[][] = [];
  const failed: string[] = [];
  const run: Runner = async (argv) => { ran.push([...argv]); return { ok: true, out: "" }; };
  const hw = engineHostWorld({ home, os: "darwin", profile: "dist", release: engine, run, dist: true, testBuild: false, env: { MOSS_HOME: home }, source: () => rh.hostSource(), stopHost: () => false, startFailed: (w) => failed.push(w) });
  const record = (program: "moss" | "code", bundlePath: string, release: string, host = true): AppInstallRecord => {
    const r = rh.record({ program, bundlePath, release, carries: { engine: true, host } });
    clock.advance(1);
    return r;
  };
  /** Where the engine would start the host from now, and the commands it runs to do it. */
  const startHost = async (): Promise<{ from: string | undefined; argv: string[][] }> => {
    const src = hw.source();
    ran.length = 0;
    if (src !== undefined) {
      hw.start(src.bundlePath, { safeMode: false });
      for (let i = 0; i < 20 && ran.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    }
    return { from: src?.bundlePath, argv: ran.map((a) => [...a]) };
  };
  return { home, apps, clock, rh, hw, record, startHost, failed };
}

describe("one home, two apps: where the host comes from", () => {
  test("only MOSS installed: the engine starts the host from MOSS's own helper, checking the host's requirement first", async () => {
    const w = world();
    const moss = bundle(w.apps, "MOSS", "1.2.0");
    w.record("moss", moss, "1.2.0");
    const s = await w.startHost();
    expect(s.from).toBe(moss);
    expect(s.argv[0]?.slice(0, 3)).toEqual(["codesign", "--verify", "--strict"]);
    expect(s.argv[0]?.at(-1)).toBe(hostHelperPath(moss, "dist"));
    expect(s.argv[0]?.find((a) => a.startsWith("-R="))).toContain('identifier "com.waifucave.moss.host"');
    expect(s.argv[1]?.slice(0, 3)).toEqual(["open", "-n", "-g"]);
    expect(s.argv[1]?.at(-1)).toBe(hostHelperPath(moss, "dist"));
    expect(w.failed).toEqual([]);
  });

  test("only MOSS Code installed: as today, from MOSS Code's helper", async () => {
    const w = world();
    const code = bundle(w.apps, "MOSS Code", "1.2.0");
    w.record("code", code, "1.2.0");
    expect((await w.startHost()).from).toBe(code);
  });

  test("both installed on one release: one host, from the newest record (a tie goes to the later); a newer copy wins outright", async () => {
    const w = world();
    const code = bundle(w.apps, "MOSS Code", "1.2.0"), moss = bundle(w.apps, "MOSS", "1.2.0");
    w.record("code", code, "1.2.0");
    w.record("moss", moss, "1.2.0");
    expect((await w.startHost()).from).toBe(moss);
    w.record("code", code, "1.2.0");
    expect((await w.startHost()).from).toBe(code);
    // The engine's fallback reader (before RL's) picks the same.
    expect(appRecordsSource(w.home)?.bundlePath).toBe(code);
    // MOSS updated to a newer release (its bundle says so): its copy is the newest, whatever the order of starts.
    const moss2 = bundle(join(w.apps, "new"), "MOSS", "1.3.0");
    w.record("moss", moss2, "1.3.0");
    w.record("code", code, "1.2.0");
    expect(w.rh.hostSource()?.bundlePath).toBe(moss2);
  });

  test("a record for a copy that carries no helper is no source; a record whose bundle says another release isn't this copy", async () => {
    const w = world();
    const code = bundle(w.apps, "MOSS Code", "1.2.0");
    const old = bundle(w.apps, "MOSS", "1.2.0", false);
    w.record("code", code, "1.2.0");
    w.record("moss", old, "1.2.0", false);
    expect((await w.startHost()).from).toBe(code);
    // MOSS's record claims the host, but its bundle carries no helper (an app from before lane PK): no source, so the engine runs
    // headless rather than retrying a start that can't work.
    w.record("moss", old, "1.2.0", true);
    expect((await w.startHost()).from).toBeUndefined();
    // A record saying 1.2.0 for a bundle that says 1.1.0 (an update half way, a forged record): not this copy.
    const half = bundle(join(w.apps, "half"), "MOSS", "1.1.0");
    w.record("moss", half, "1.2.0");
    expect((await w.startHost()).from).toBeUndefined();
  });

  test("one app deleted: its record goes, and the other still starts the host from its own bundle", async () => {
    const w = world();
    const code = bundle(w.apps, "MOSS Code", "1.2.0"), moss = bundle(w.apps, "MOSS", "1.2.0");
    w.record("code", code, "1.2.0");
    w.record("moss", moss, "1.2.0");
    expect((await w.startHost()).from).toBe(moss);
    rmSync(moss, { recursive: true, force: true });
    // Gone at once from the sources (and from the fallback reader), the file itself after the grace (an update's moment).
    expect((await w.startHost()).from).toBe(code);
    expect(appRecordsSource(w.home)?.bundlePath).toBe(code);
    expect(w.rh.apps().map((r) => r.program)).toEqual(["code"]);
    w.clock.advance(30_000);
    w.rh.apps();
    expect(w.rh.apps().map((r) => r.program)).toEqual(["code"]);
    // And the other way round: MOSS Code deleted, MOSS alone starts the host.
    const w2 = world();
    const code2 = bundle(w2.apps, "MOSS Code", "1.2.0"), moss2 = bundle(w2.apps, "MOSS", "1.2.0");
    w2.record("moss", moss2, "1.2.0");
    w2.record("code", code2, "1.2.0");
    rmSync(code2, { recursive: true, force: true });
    expect((await w2.startHost()).from).toBe(moss2);
  });

  test("both apps deleted: no source; the engine runs headless and starts no host", async () => {
    const w = world();
    const code = bundle(w.apps, "MOSS Code", "1.2.0"), moss = bundle(w.apps, "MOSS", "1.2.0");
    w.record("code", code, "1.2.0");
    w.record("moss", moss, "1.2.0");
    rmSync(code, { recursive: true, force: true });
    rmSync(moss, { recursive: true, force: true });
    const s = await w.startHost();
    expect(s.from).toBeUndefined();
    expect(s.argv).toEqual([]);
  });

  test("the host's menu opens whichever app is there: MOSS alone, MOSS Code alone, or says there is none", async () => {
    const w = world();
    const moss = bundle(w.apps, "MOSS", "1.2.0");
    w.record("moss", moss, "1.2.0");
    const ran: string[][] = [];
    const lines: string[] = [];
    const run: Runner = async (argv) => { ran.push([...argv]); return { ok: true, out: "" }; };
    await launchApp({ home: w.home, os: "darwin", run, log: (l) => lines.push(l) }, "moss");
    expect(ran).toEqual([["open", "-a", moss]]);
    await launchApp({ home: w.home, os: "darwin", run, log: (l) => lines.push(l) }, "code");
    expect(lines).toContain("[host] no MOSS Code on disk to open");
  });

  test("MOSS's bundle is one the engine takes a host or an engine copy from (its identifier is in the apps' requirement)", () => {
    const w = world();
    const moss = bundle(w.apps, "MOSS", "1.2.0");
    w.record("moss", moss, "1.2.0");
    const asked: string[] = [];
    const policy = { platform: "darwin" as const, profile: "dist" as const, developerId: true, records: () => w.rh.apps(), check: (_p: string, req: string) => { asked.push(req); return req.includes('identifier "com.waifucave.moss"'); } };
    expect(copyAcceptable(moss, "host", policy)).toEqual({ ok: true });
    expect(asked[0]).toBe(appBundleRequirement("dist", true));
    expect(copyAcceptable(join(w.apps, "Elsewhere.app"), "engine", policy)).toEqual({ ok: false, reason: "that path isn't there" });
  });
});

describe("one home, two apps: an app behind or ahead of the engine", () => {
  test("the newer app is served the release door (it brings its engine); the older one is refused as behind, told the release it needs", () => {
    const w = world("1.2.0");
    expect(judgeHello(w.rh, { role: "app", release: "1.3.0" }, true)).toEqual({ kind: "door", release: { standing: "ahead", engine: "1.2.0" } });
    expect(judgeHello(w.rh, { role: "app", release: "1.2.0" }, true)).toMatchObject({ kind: "served" });
    expect(judgeHello(w.rh, { role: "app", release: "1.1.0" }, true)).toMatchObject({ kind: "refused", refusal: { standing: "behind", engine: "1.2.0", client: "1.1.0", needs: "1.2.0" } });
    // Once the newer app's engine is in, the app that was current is now the older one: it is told to update to the new release.
    const after = world("1.3.0");
    expect(judgeHello(after.rh, { role: "app", release: "1.2.0" }, true)).toMatchObject({ kind: "refused", refusal: { needs: "1.3.0" } });
  });
});
