// One release for everything, the app's side (src/main/release.ts, pair/pair.ts's behind and ahead): the record the app
// writes before it connects, an app that is behind updating itself (and, offline, not connecting and saying so), an app that
// is ahead asking for its engine to be brought in with the waiting notice and "Switch now". No real update is fetched.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MossHelloParams } from "@waifucave/moss-protocol";
import { daemonEndpoint } from "../src/main/protocol/client";
import { Pair } from "../src/main/pair/pair";
import { adoptHomeEngine, parseAutostartStatus, startEngineThroughOs, type DaemonLauncher } from "../src/main/pair/login";
import { appHello, readAppToken } from "../src/main/pair/start";
import { checkAndDownload, isOfflineError } from "../src/main/updater";
import { appRelease, behindFrom, createRelease, testUpdateOutcome, BringWatch, SWITCH_GIVE_UP_MS, SWITCH_START_MS, bundlePathOf, ReleaseCatchUp, recordPath, writeOwnRecord, type ReleaseNotice, type UpdateOutcome } from "../src/main/release";
import { readCalls, startFakeDaemon, type FakeDaemon } from "./fake-core/fake-daemon";

const homes: string[] = [];
const fakes: FakeDaemon[] = [];
const pairs: Pair[] = [];
const home = (): string => { const h = mkdtempSync(join(tmpdir(), "moss-rel-")); homes.push(h); return h; };
afterEach(async () => {
  for (const p of pairs.splice(0)) p.stop();
  for (const f of fakes.splice(0)) await f.close().catch(() => {});
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
const FAST = { firstStartWaitMs: 3000, pollMs: 25, reconnectMs: 25, kickAfterMs: 300, kickEveryMs: 1000, maxBackoffMs: 100, helloTimeoutMs: 2000 };
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 15)); }
}

describe("the app's record", () => {
  test("written whole under apps/ for the user alone, the bundle and release named", () => {
    const h = home();
    expect(writeOwnRecord(h, { program: "code", bundlePath: "/Applications/MOSS Code.app", release: "1.2.0", build: "9", now: 5 }, () => {})).toBe(true);
    const r = JSON.parse(readFileSync(recordPath(h, "code"), "utf8"));
    expect(r).toMatchObject({ record: 1, program: "code", bundlePath: "/Applications/MOSS Code.app", release: "1.2.0", build: "9", carries: { engine: true, host: true }, seenAt: 5 });
    if (process.platform !== "win32") expect(statSync(recordPath(h, "code")).mode & 0o077).toBe(0);
    expect(existsSync(join(h, "apps", `code.json.${process.pid}.tmp`))).toBe(false);
  });
  test("a bad release is not written, and says so in the log", () => {
    const h = home();
    const log: string[] = [];
    expect(writeOwnRecord(h, { program: "code", bundlePath: "/x", release: "nope" }, (l) => log.push(l))).toBe(false);
    expect(existsSync(recordPath(h, "code"))).toBe(false);
    expect(log[0]).toContain("not written");
  });
  test("the bundle an app runs from, and its release (a test build's stamp only when valid)", () => {
    expect(bundlePathOf("/Applications/MOSS Code.app/Contents/MacOS/MOSS Code", "darwin", {})).toBe("/Applications/MOSS Code.app");
    expect(bundlePathOf("/opt/moss/moss-code", "linux", {})).toBe("/opt/moss");
    expect(bundlePathOf("/tmp/.mount_x/moss-code", "linux", { APPIMAGE: "/home/u/MOSS.AppImage" })).toBe("/home/u/MOSS.AppImage");
    expect(appRelease("1.0.0", "2.0.0-rc.1")).toBe("2.0.0-rc.1");
    expect(appRelease("1.0.0", "garbage")).toBe("1.0.0");
    expect(appRelease("1.0.0", undefined)).toBe("1.0.0");
  });
  test("the hello names the app's release", () => {
    expect(appHello("t", "1.0.0", 1, "1.0.0").release).toBe("1.0.0");
    expect(appHello("t", "1.0.0", 1).release).toBeUndefined();
  });
});

describe("an app that is behind", () => {
  function catchUp(outcomes: UpdateOutcome[]) {
    const notices: (ReleaseNotice | undefined)[] = [];
    let checks = 0, installs = 0;
    const waits: (() => void)[] = [];
    const c = new ReleaseCatchUp({
      check: async () => outcomes[Math.min(checks++, outcomes.length - 1)]!,
      install: () => { installs++; return true; },
      notice: (n) => notices.push(n),
      after: (_ms, fn) => { waits.push(fn); },
      log: () => {},
    });
    return { c, notices, waits, get checks() { return checks; }, get installs() { return installs; } };
  }
  const settle = () => new Promise((r) => setTimeout(r, 5));

  test("checks, shows it is updating, installs when downloaded", async () => {
    const t = catchUp([{ kind: "ready", version: "2.0.0" }]);
    t.c.start("2.0.0");
    await settle();
    expect(t.notices.map((n) => (n?.kind === "updating" ? n.phase : n?.kind))).toEqual(["checking", "installing"]);
    expect(t.installs).toBe(1);
  });
  test("offline: says so plainly, does not install, and looks again later", async () => {
    const t = catchUp([{ kind: "offline" }, { kind: "ready", version: "2.0.0" }]);
    t.c.start("2.0.0");
    await settle();
    expect(t.notices.at(-1)).toEqual({ kind: "offline", needs: "2.0.0" });
    expect(t.installs).toBe(0);
    t.waits.shift()!();
    await settle();
    expect(t.installs).toBe(1);
  });
  test("a second start while one runs doesn't run a second loop", async () => {
    const t = catchUp([{ kind: "none" }]);
    t.c.start("2.0.0");
    t.c.start("2.1.0");
    await settle();
    expect(t.checks).toBe(1);
    expect(t.notices.at(-1)).toEqual({ kind: "cannot", needs: "2.0.0" });
    // The newer ask is what the next look is for.
    t.waits.shift()!();
    await settle();
    expect(t.notices.at(-1)).toEqual({ kind: "cannot", needs: "2.1.0" });
  });
  test("the updater: a found update is waited for, offline errors are told apart, nothing found is none", async () => {
    let downloaded = false;
    expect(await checkAndDownload({ checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: "2.0.0" }, downloadPromise: new Promise((r) => setTimeout(() => { downloaded = true; r(undefined); }, 10)) }) })).toEqual({ kind: "ready", version: "2.0.0" });
    expect(downloaded).toBe(true);
    expect(await checkAndDownload({ checkForUpdates: async () => ({ isUpdateAvailable: false }) })).toEqual({ kind: "none" });
    expect(await checkAndDownload({ checkForUpdates: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), { code: "ENOTFOUND" }); } })).toEqual({ kind: "offline" });
    expect((await checkAndDownload({ checkForUpdates: async () => { throw new Error("boom"); } })).kind).toBe("failed");
    expect(isOfflineError(new Error("net::ERR_INTERNET_DISCONNECTED"))).toBe(true);
    expect(isOfflineError(new Error("404"))).toBe(false);
  });
  test("a refused hello is read as behind, and nothing else is", () => {
    expect(behindFrom({ code: -32022, data: { standing: "behind", engine: "2.0.0", client: "1.0.0", needs: "2.0.0" } })).toEqual({ engine: "2.0.0", client: "1.0.0", needs: "2.0.0" });
    expect(behindFrom({ code: -32001, data: {} })).toBeUndefined();
    expect(behindFrom({ code: -32022 })).toBeUndefined();
  });

  test("the pair, against an engine that is newer: told what it needs, does not dial again until resumed", async () => {
    const h = home();
    fakes.push(await startFakeDaemon({ home: h, release: { engine: "2.0.0", mode: "behind" } }));
    const behind: string[] = [];
    const pair = new Pair({
      endpoint: daemonEndpoint(h),
      hello: (): MossHelloParams | undefined => { const t = readAppToken(h, {}); return t === undefined ? undefined : appHello(t, "1.0.0", 1, "1.0.0"); },
      timing: FAST,
      onBehind: (b) => behind.push(b.needs),
    });
    pairs.push(pair);
    await pair.start();
    expect(pair.state).toMatchObject({ kind: "behind", engine: "2.0.0", needs: "2.0.0" });
    expect(behind).toEqual(["2.0.0"]);
    const hellos = () => readCalls(h).filter((c) => c.event === "request" && c.method === "protocol.hello").length;
    const n = hellos();
    await new Promise((r) => setTimeout(r, 300));
    expect(hellos()).toBe(n);
  });
});

describe("an app that is ahead", () => {
  test("the pair says ahead, the release door is subscribed, release.bring is asked, and Switch now asks again with now", async () => {
    const h = home();
    fakes.push(await startFakeDaemon({ home: h, release: { engine: "1.0.0", mode: "ahead" } }));
    const notices: (ReleaseNotice | undefined)[] = [];
    let watch: BringWatch | undefined;
    const pair = new Pair({
      endpoint: daemonEndpoint(h),
      hello: (): MossHelloParams | undefined => { const t = readAppToken(h, {}); return t === undefined ? undefined : appHello(t, "2.0.0", 1, "2.0.0"); },
      timing: FAST,
      onAhead: async (client) => {
        await client.request("events.subscribe", { areas: ["release"] });
        watch = new BringWatch({ bring: (p) => client.request("release.bring", p), notice: (n) => notices.push(n), log: () => {} });
        await watch.start("2.0.0", "/Applications/MOSS Code.app");
      },
    });
    pairs.push(pair);
    await pair.start();
    expect(pair.state.kind).toBe("ahead");
    await until(() => notices.length > 0 && readCalls(h).some((c) => c.method === "release.bring"));
    expect(notices[0]).toEqual({ kind: "waiting", incoming: "2.0.0", turns: 0, agents: 0 });
    // The engine's counts reach the notice; "Switch now" asks with now.
    watch!.event({ state: "waiting", incoming: "2.0.0", waitingFor: { turns: 2, agents: 1 } });
    expect(notices.at(-1)).toEqual({ kind: "waiting", incoming: "2.0.0", turns: 2, agents: 1 });
    await watch!.switchNow();
    expect(readCalls(h).filter((c) => c.method === "release.bring").at(-1)).toMatchObject({ params: { release: "2.0.0", now: true } });
    expect(notices.at(-1)).toEqual({ kind: "switching", incoming: "2.0.0" });
    watch!.done();
    expect(notices.at(-1)).toBeUndefined();
  });
  test("a refused bring is told plainly, and nothing waits", async () => {
    const notices: (ReleaseNotice | undefined)[] = [];
    const w = new BringWatch({ bring: async () => { throw new Error("no"); }, notice: (n) => notices.push(n), log: () => {} });
    await w.start("2.0.0", "/x");
    expect(notices.at(-1)).toEqual({ kind: "cannot", needs: "2.0.0" });
  });
});

describe("through a switch: the notice stays, the new engine is started if nothing supervises it, and it says plainly when none answers (S2, S3)", () => {
  /** A manual clock for BringWatch's timers. */
  function clock() {
    const timers: Array<{ ms: number; fn: () => void; live: boolean }> = [];
    return { timers, after: (ms: number, fn: () => void) => { const t = { ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; }, live: () => timers.filter((t) => t.live), fire: (ms: number) => { for (const t of timers.filter((x) => x.live && x.ms === ms)) { t.live = false; t.fn(); } } };
  }

  test("the engine goes away mid-switch: the notice stays; the OS start comes after SWITCH_START_MS and the plain notice after SWITCH_GIVE_UP_MS; Try again starts it again; the new connection clears it", async () => {
    const h = home();
    fakes.push(await startFakeDaemon({ home: h, release: { engine: "1.0.0", mode: "ahead" } }));
    const notices: (ReleaseNotice | undefined)[] = [];
    const c = clock();
    let starts = 0;
    let watch!: BringWatch;
    const pair = new Pair({
      endpoint: daemonEndpoint(h),
      hello: (): MossHelloParams | undefined => { const t = readAppToken(h, {}); return t === undefined ? undefined : appHello(t, "2.0.0", 1, "2.0.0"); },
      timing: FAST,
      onAhead: async (client) => {
        await client.request("events.subscribe", { areas: ["release"] });
        await watch.start("2.0.0", "/Applications/MOSS Code.app");
      },
      onConnected: () => watch.done(),
      onState: (s) => watch.connection(s.kind === "connected" || s.kind === "ahead" || s.kind === "behind"),
    });
    watch = new BringWatch({ bring: (p) => pair.client!.request("release.bring", p), notice: (n) => notices.push(n), after: c.after, startEngine: async () => { starts++; }, log: () => {} });
    pairs.push(pair);
    await pair.start();
    await until(() => pair.state.kind === "ahead" && notices.length > 0);
    await watch.switchNow();
    expect(notices.at(-1)).toEqual({ kind: "switching", incoming: "2.0.0" });
    expect(c.live()).toHaveLength(0); // the connection is still up: nothing is timed yet

    // The old engine goes away, as a restart does. The notice stays up; the timers are set; nothing is started yet.
    await fakes.pop()!.close();
    await until(() => c.live().length === 2);
    expect(notices.at(-1)).toEqual({ kind: "switching", incoming: "2.0.0" });
    expect(starts).toBe(0);
    c.fire(SWITCH_START_MS);
    await until(() => starts === 1);
    expect(notices.at(-1)).toEqual({ kind: "switching", incoming: "2.0.0" });
    // Nothing answers by then: it says so plainly, and offers to try again.
    c.fire(SWITCH_GIVE_UP_MS);
    expect(notices.at(-1)).toEqual({ kind: "engine-down", incoming: "2.0.0" });
    await watch.retry();
    expect(notices.at(-1)).toEqual({ kind: "switching", incoming: "2.0.0" });
    c.fire(0);
    await until(() => starts === 2);

    // The new engine answers (same release): the app redials and connects; the notice clears at once and the timers are gone.
    fakes.push(await startFakeDaemon({ home: h }));
    await until(() => pair.state.kind === "connected");
    expect(notices.at(-1)).toBeUndefined();
    expect(c.live()).toHaveLength(0);
  });

  test("a connection that was never switching sets no timer, and a notice that isn't a switch's can't be retried", async () => {
    const c = clock();
    const w = new BringWatch({ bring: async () => ({ state: "waiting" }), notice: () => {}, after: c.after, startEngine: async () => { throw new Error("must not run"); }, log: () => {} });
    await w.start("2.0.0", "/x");
    w.connection(false);
    expect(c.live()).toHaveLength(0);
    await w.retry();
    expect(c.live()).toHaveLength(0);
  });

  test("a failed OS start is logged and the notice still says so at the give-up time", async () => {
    const c = clock();
    const notices: (ReleaseNotice | undefined)[] = [];
    const lines: string[] = [];
    const w = new BringWatch({ bring: async () => ({ state: "switching" }), notice: (n) => notices.push(n), after: c.after, startEngine: async () => { throw new Error("launchctl refused"); }, log: (l) => lines.push(l) });
    await w.start("2.0.0", "/x");
    expect(notices.at(-1)).toEqual({ kind: "switching", incoming: "2.0.0" });
    w.connection(false);
    c.fire(SWITCH_START_MS);
    await until(() => lines.some((l) => l.includes("launchctl refused")));
    c.fire(SWITCH_GIVE_UP_MS);
    expect(notices.at(-1)).toEqual({ kind: "engine-down", incoming: "2.0.0" });
  });

  test("a login item the person turned off stays off after a release switch, and the switch does what an ordinary launch does", async () => {
    // What `moss-core autostart status --json` really prints (cli/src/main.ts): "registered" is "installed", whether or not login start is on.
    const printed = {
      disabled: '{"state":"disabled","registered":true,"loginStart":false,"running":false,"label":"com.moss.core"}',
      enabled: '{"state":"enabled","registered":true,"loginStart":true,"running":false,"label":"com.moss.core"}',
      removed: '{"state":"not-installed","registered":false,"loginStart":false,"running":false,"label":"com.moss.core"}',
    };
    const mk = (out: string) => {
      const calls: string[] = [];
      const l: DaemonLauncher = {
        status: async () => { calls.push("status"); return parseAutostartStatus(out); },
        enable: async () => { calls.push("enable"); return { ok: true, code: 0, out: "" }; },
        start: async () => { calls.push("start"); return { ok: true, code: 0, out: "" }; },
      };
      return { calls, l };
    };
    for (const [name, out, registers] of [["disabled", printed.disabled, false], ["enabled", printed.enabled, false], ["removed", printed.removed, true]] as const) {
      // The release switch ...
      const sw = mk(out);
      await startEngineThroughOs("dist", sw.l, () => {});
      // ... and an ordinary launch with no engine answering (Pair.start): the same calls.
      const h = home();
      const launch = mk(out);
      const pair = new Pair({ endpoint: daemonEndpoint(h), hello: () => undefined, launcher: launch.l, timing: { ...FAST, firstStartWaitMs: 50, kickAfterMs: 10_000 } });
      pairs.push(pair);
      await pair.start();
      pair.stop();
      expect(sw.calls.includes("enable"), name).toBe(registers);
      expect(sw.calls, name).toEqual(launch.calls.slice(0, sw.calls.length));
      // The one it would not do is turn a disabled item on.
      if (name === "disabled") expect(sw.calls).toEqual(["status", "start"]);
    }
  });
  test("an engine nothing supervises: with no login item the app registers it, then asks the OS to start it; with one, it only starts; the dev profile registers nothing", async () => {
    const mk = (registered: boolean | undefined) => {
      const calls: string[] = [];
      const l: DaemonLauncher = {
        status: async () => (registered === undefined ? undefined : { registered }),
        enable: async () => { calls.push("enable"); return { ok: true, code: 0, out: "" }; },
        start: async () => { calls.push("start"); return { ok: true, code: 0, out: "" }; },
      };
      return { calls, l };
    };
    const a = mk(false);
    expect(await startEngineThroughOs("dist", a.l, () => {})).toBe(true);
    expect(a.calls).toEqual(["enable", "start"]);
    const b = mk(true);
    await startEngineThroughOs("dist", b.l, () => {});
    expect(b.calls).toEqual(["start"]);
    const unknown = mk(undefined);
    await startEngineThroughOs("dist", unknown.l, () => {});
    expect(unknown.calls).toEqual(["enable", "start"]);
    const dev = mk(false);
    await startEngineThroughOs("dev", dev.l, () => {});
    expect(dev.calls).toEqual(["start"]);
    // A launcher that throws never throws out.
    expect(await startEngineThroughOs("dist", { status: async () => { throw new Error("x"); }, enable: async () => ({ ok: false, code: 1, out: "" }), start: async () => ({ ok: false, code: 1, out: "" }) }, () => {})).toBe(false);
  });
});

describe("a test build's stand-ins", () => {
  test("the update outcome is read from the environment of a test build only", () => {
    expect(testUpdateOutcome(undefined)).toBeUndefined();
    expect(testUpdateOutcome("offline")).toEqual({ kind: "offline" });
    expect(testUpdateOutcome("ready:2.0.0")).toEqual({ kind: "ready", version: "2.0.0" });
  });
  test("a release build's catch-up goes to its updater, and its notice is held for the window", async () => {
    const changed: (ReleaseNotice | undefined)[] = [];
    let installs = 0;
    const r = createRelease({
      updater: () => ({ checkNow: async () => ({ kind: "ready", version: "2.0.0" }), install: () => { installs++; return true; } }),
      bring: async () => ({ state: "waiting" }),
      changed: (n) => changed.push(n),
      log: () => {},
    });
    r.catchUp.start("2.0.0");
    await new Promise((res) => setTimeout(res, 5));
    expect(installs).toBe(1);
    expect(r.notice()).toEqual({ kind: "updating", phase: "installing", needs: "2.0.0" });
  });
});

describe("the login item points at the home's engine", () => {
  const fakeLauncher = (registered: boolean) => {
    const l = { enabled: 0, binaries: [] as string[], async status() { return { registered }; }, async enable() { l.enabled++; return { ok: true, code: 0, out: "" }; }, async start() { return { ok: true, code: 0, out: "" }; } };
    return l;
  };
  const placed = (h: string) => async () => ({ installed: true, binary: join(h, "bin", "daemon", "moss-core"), release: "2.0.0" });

  test("an item already registered is registered again from the home's copy, run from that binary", async () => {
    const h = home();
    const l = fakeLauncher(true);
    const asked: string[] = [];
    const r = await adoptHomeEngine("dist", { install: placed(h), launcherFor: (b) => { asked.push(b); return l; }, log: () => {} });
    expect(r).toEqual({ binary: join(h, "bin", "daemon", "moss-core"), release: "2.0.0", reregistered: true });
    expect(asked).toEqual([join(h, "bin", "daemon", "moss-core")]);
    expect(l.enabled).toBe(1);
  });
  test("no item registered: nothing is registered here (the pair asks, through the same copy); the dev profile's item is left alone; no copy: nothing", async () => {
    const h = home();
    const none = fakeLauncher(false);
    expect((await adoptHomeEngine("dist", { install: placed(h), launcherFor: () => none, log: () => {} }))?.reregistered).toBe(false);
    expect(none.enabled).toBe(0);
    const dev = fakeLauncher(true);
    expect((await adoptHomeEngine("dev", { install: placed(h), launcherFor: () => dev, log: () => {} }))?.reregistered).toBe(false);
    expect(dev.enabled).toBe(0);
    expect(await adoptHomeEngine("dist", { install: async () => undefined, launcherFor: () => dev, log: () => {} })).toBeUndefined();
  });
  test("a launcher that throws leaves the app on the home's copy and says so", async () => {
    const h = home();
    const log: string[] = [];
    const r = await adoptHomeEngine("dist", { install: placed(h), launcherFor: () => ({ status: async () => { throw new Error("boom"); }, enable: async () => ({ ok: false, code: 1, out: "" }), start: async () => ({ ok: false, code: 1, out: "" }) }), log: (l) => log.push(l) });
    expect(r?.reregistered).toBe(false);
    expect(log[0]).toContain("not re-registered");
  });
});

describe("the way out", () => {
  test("a catch-up that can't get there names the command that takes the home's engine out", async () => {
    const notices: (ReleaseNotice | undefined)[] = [];
    const c = new ReleaseCatchUp({ check: async () => ({ kind: "none" }), install: () => true, notice: (n) => notices.push(n), after: () => {}, resetCommand: () => '"/App/moss-core" engine reset', log: () => {} });
    c.start("9.0.0");
    await new Promise((r) => setTimeout(r, 5));
    expect(notices.at(-1)).toEqual({ kind: "cannot", needs: "9.0.0", command: '"/App/moss-core" engine reset' });
  });
  test("a refused bring names it too", async () => {
    const notices: (ReleaseNotice | undefined)[] = [];
    const w = new BringWatch({ bring: async () => { throw new Error("loop"); }, notice: (n) => notices.push(n), resetCommand: () => "R", log: () => {} });
    await w.start("2.0.0", "/x");
    expect(notices.at(-1)).toEqual({ kind: "cannot", needs: "2.0.0", command: "R" });
  });
  test("an unsafe home copy is never taken", async () => {
    const { parseEngineInstall } = await import("../src/main/pair/login");
    expect(parseEngineInstall('{"installed":true,"binary":"/h/bin/daemon/moss-core","release":"1.0.0","unsafe":true}')).toMatchObject({ unsafe: true });
  });
});
