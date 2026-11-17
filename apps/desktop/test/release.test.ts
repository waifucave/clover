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
import { appHello, readAppToken } from "../src/main/pair/start";
import { checkAndDownload, isOfflineError } from "../src/main/updater";
import { appRelease, behindFrom, BringWatch, bundlePathOf, ReleaseCatchUp, recordPath, writeOwnRecord, type ReleaseNotice, type UpdateOutcome } from "../src/main/release";
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
