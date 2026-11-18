// One release for everything, from MOSS's side (src/main/release.ts over the apps' shared release code; lane PK), against the
// fake engine: a MOSS newer than the engine is served the release door only, asks `release.bring` from its own bundle, says it
// waits for work to finish and can switch now, and connects once the new engine answers; a MOSS behind the engine updates
// itself before it connects (a stand-in outcome: nothing is fetched); through a switch whose engine never answers, it says so
// and offers Try again. No real engine, no network, no window.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BringWatch, createRelease, type ReleaseNotice } from "@waifucave/moss-app-release/release";
import { EngineConnection, type ConnectionState } from "../src/main/connection";
import { daemonEndpoint } from "../src/main/client";
import { InstallGate } from "@waifucave/moss-app-release/updater";
import { asksAgain, mossInstallGateDeps, releaseBanner, releaseChoice } from "../src/main/release";
import { startFakeEngine, type FakeEngine } from "./fake-engine/engine";

const homes: string[] = [];
const engines: FakeEngine[] = [];
function home(): string {
  const h = mkdtempSync(join(tmpdir(), "pk-rel-"));
  homes.push(h);
  return h;
}
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => undefined);
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
const until = async (ok: () => boolean, ms = 3_000): Promise<void> => {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error("not within the time");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** MOSS's connection and its release, wired as index.ts wires them. */
function mossOn(h: string, release: string, o: { after?: (ms: number, fn: () => void) => () => void; startEngine?: () => Promise<unknown>; outcome?: string } = {}) {
  const notices: (ReleaseNotice | undefined)[] = [];
  const states: ConnectionState[] = [];
  const lines: string[] = [];
  let connection: EngineConnection;
  const { catchUp, bringWatch } = createRelease({
    ...(o.outcome !== undefined ? { stand: { outcome: o.outcome, retryMs: "20" } } : {}),
    updater: () => undefined,
    bring: async (p) => await connection.client!.request<{ state: "waiting" | "switching" }>("release.bring", p, 2_000),
    ...(o.startEngine ? { startEngine: o.startEngine } : {}),
    ...(o.after ? { after: o.after } : {}),
    changed: (n) => notices.push(n),
    log: (l) => lines.push(l),
  });
  connection = new EngineConnection({
    endpoint: daemonEndpoint(h),
    token: () => { try { return readFileSync(join(h, "run", "app.token"), "utf8").trim(); } catch { return undefined; } },
    release, pid: process.pid, sleep: () => new Promise((r) => setTimeout(r, 10)),
    onState: (s) => {
      states.push(s);
      bringWatch.connection(s.kind === "connected" || s.kind === "ahead" || s.kind === "behind");
      if (s.kind === "behind") catchUp.start(s.needs);
    },
    onConnected: () => bringWatch.done(),
    onAhead: async (client) => {
      await client.request("events.subscribe", { areas: ["release"] });
      await bringWatch.start(release, "/Applications/MOSS.app");
    },
  });
  return { connection, notices, states, lines, bringWatch, catchUp };
}

describe("a MOSS newer than the engine (ahead)", () => {
  test("is served the release door only, asks release.bring from its own bundle and says it waits; Switch now asks at once", async () => {
    const h = home();
    const e = await startFakeEngine({ home: h, release: "0.124.0" });
    engines.push(e);
    const m = mossOn(h, "0.125.0");
    await m.connection.start();
    expect(m.connection.state.kind).toBe("ahead");
    // Never the connected path: the window's pieces are not asked for.
    expect(m.states.some((s) => s.kind === "connected")).toBe(false);
    await until(() => e.calls().some((c) => c.method === "release.bring"));
    expect(e.calls().find((c) => c.method === "release.bring")?.params).toEqual({ release: "0.125.0", bundlePath: "/Applications/MOSS.app" });
    expect(e.calls().some((c) => c.method === "bot.records")).toBe(false);
    expect(m.notices.at(-1)).toEqual({ kind: "waiting", incoming: "0.125.0", turns: 0, agents: 0 });
    // The engine's counts reach the notice.
    m.connection.onNotification((method, params) => { if (method === "core.event") m.bringWatch.event(params as never); });
    e.releaseChanged({ state: "waiting", incoming: "0.125.0", waitingFor: { turns: 1, agents: 2 } });
    await until(() => m.notices.at(-1)?.kind === "waiting" && (m.notices.at(-1) as { turns: number }).turns === 1);
    expect(releaseBanner(m.notices.at(-1)!).reason).toContain("waiting for work to finish (1 turn and 2 agents running)");
    expect(releaseChoice(m.notices.at(-1))?.buttons).toEqual(["Switch now", "Keep waiting"]);
    await m.bringWatch.switchNow();
    expect(e.calls().filter((c) => c.method === "release.bring").at(-1)?.params).toEqual({ release: "0.125.0", bundlePath: "/Applications/MOSS.app", now: true });
    expect(m.notices.at(-1)).toEqual({ kind: "switching", incoming: "0.125.0" });
    m.connection.stop();
  });

  test("through the switch the old engine goes, the new one (MOSS's release) answers, and MOSS connects with no notice left", async () => {
    const h = home();
    const old = await startFakeEngine({ home: h, release: "0.124.0", bring: () => "switching" });
    const m = mossOn(h, "0.125.0");
    await m.connection.start();
    await until(() => m.notices.at(-1)?.kind === "switching");
    // The engine stops for the swap; the new engine, on MOSS's release, comes up on the same home.
    old.dropAll();
    await old.close();
    await until(() => m.states.at(-1)?.kind === "reconnecting");
    const fresh = await startFakeEngine({ home: h, release: "0.125.0" });
    engines.push(fresh);
    await until(() => m.connection.state.kind === "connected", 5_000);
    expect(m.notices.at(-1)).toBeUndefined();
    m.connection.stop();
  });

  test("a new engine that never answers is said plainly, with Try again, which starts the engine through the OS again", async () => {
    const h = home();
    const old = await startFakeEngine({ home: h, release: "0.124.0", bring: () => "switching" });
    const timers: { ms: number; fn: () => void }[] = [];
    let starts = 0;
    const m = mossOn(h, "0.125.0", { after: (ms, fn) => { timers.push({ ms, fn }); return () => { const i = timers.findIndex((t) => t.fn === fn); if (i >= 0) timers.splice(i, 1); }; }, startEngine: async () => { starts++; return true; } });
    await m.connection.start();
    await until(() => m.notices.at(-1)?.kind === "switching");
    old.dropAll();
    await old.close();
    await until(() => timers.length === 2);
    // After SWITCH_START_MS MOSS starts the engine through the OS; after SWITCH_GIVE_UP_MS it says the engine isn't answering.
    for (const t of timers.splice(0).sort((a, b) => a.ms - b.ms)) t.fn();
    expect(starts).toBe(1);
    expect(m.notices.at(-1)).toEqual({ kind: "engine-down", incoming: "0.125.0" });
    expect(releaseBanner(m.notices.at(-1)!)).toEqual({ kind: "unavailable", reason: "The engine hasn't answered since it switched to release 0.125.0." });
    expect(releaseChoice(m.notices.at(-1))?.buttons).toEqual(["Try again", "Not now"]);
    await m.bringWatch.retry();
    expect(m.notices.at(-1)).toEqual({ kind: "switching", incoming: "0.125.0" });
    for (const t of timers.splice(0).filter((x) => x.ms === 0)) t.fn();
    expect(starts).toBe(2);
    m.connection.stop();
  });
});

describe("a MOSS older than the engine (behind)", () => {
  test("is refused, says it is updating, and installs the update before it connects; nothing dials again", async () => {
    const h = home();
    const e = await startFakeEngine({ home: h, release: "0.125.0" });
    engines.push(e);
    const m = mossOn(h, "0.124.0", { outcome: "ready:0.125.0" });
    await m.connection.start();
    expect(m.connection.state).toEqual({ kind: "behind", needs: "0.125.0" });
    await until(() => m.notices.some((n) => n?.kind === "updating" && n.phase === "installing"));
    expect(releaseBanner({ kind: "updating", phase: "installing", needs: "0.125.0" }).reason).toBe("Installing the MOSS update (release 0.125.0). MOSS opens again by itself.");
    expect(e.calls().filter((c) => c.method === "protocol.hello").length).toBe(1);
    m.connection.stop();
  });

  test("offline, it says plainly it can't reach the update server and connects once it has updated", async () => {
    const h = home();
    const e = await startFakeEngine({ home: h, release: "0.125.0" });
    engines.push(e);
    const m = mossOn(h, "0.124.0", { outcome: "offline" });
    await m.connection.start();
    await until(() => m.notices.filter((n) => n?.kind === "offline").length >= 2);
    expect(releaseBanner(m.notices.find((n) => n?.kind === "offline")!).reason).toContain("can't reach the update server");
    expect(e.calls().filter((c) => c.method === "protocol.hello").length).toBe(1);
    m.connection.stop();
  });
});

describe("the words and the choices", () => {
  test("each notice has MOSS's words and the kind its banner shows", () => {
    expect(releaseBanner({ kind: "cannot", needs: "1.2.0", command: '"/x/moss-core" engine reset' }).reason).toBe('MOSS needs release 1.2.0 to talk to the engine and couldn\'t update itself. To start over with this copy\'s engine, quit MOSS and MOSS Code, then run: "/x/moss-core" engine reset');
    expect(releaseBanner({ kind: "waiting", incoming: "1.2.0", turns: 0, agents: 0 }).reason).toBe("This MOSS (release 1.2.0) is newer than the engine: it is waiting for work to finish before the engine switches to it.");
    expect(releaseBanner({ kind: "switching", incoming: "1.2.0" }).kind).toBe("starting-engine");
    expect(releaseChoice({ kind: "switching", incoming: "1.2.0" })).toBeUndefined();
    expect(releaseChoice(undefined)).toBeUndefined();
  });

  test("the sheet asks again only for a new choice: not when the waiting counts change", () => {
    const w = (turns: number, incoming = "1.2.0"): ReleaseNotice => ({ kind: "waiting", incoming, turns, agents: 0 });
    expect(asksAgain(undefined, w(0))).toBe(true);
    expect(asksAgain(w(0), w(3))).toBe(false);
    expect(asksAgain(w(0), w(0, "1.3.0"))).toBe(true);
    expect(asksAgain(w(0), { kind: "switching", incoming: "1.2.0" })).toBe(false);
    expect(asksAgain({ kind: "switching", incoming: "1.2.0" }, { kind: "engine-down", incoming: "1.2.0" })).toBe(true);
    expect(asksAgain({ kind: "engine-down", incoming: "1.2.0" }, { kind: "engine-down", incoming: "1.2.0" })).toBe(false);
  });

  test("BringWatch is the apps' one class (MOSS and MOSS Code import it from the shared package)", async () => {
    const desktop = await import("../../desktop/src/main/release");
    expect(desktop.BringWatch).toBe(BringWatch);
  });
});

describe("MOSS's own update installs through the idle gate (it may be the bundle the host runs from)", () => {
  test("a downloaded update waits while the engine is busy, then asks the engine, leaves, waits for it to go, and installs with relaunch", async () => {
    const h = home();
    let idle = false;
    const e = await startFakeEngine({ home: h, release: "0.124.0", updateIdle: () => idle });
    engines.push(e);
    const m = mossOn(h, "0.124.0");
    await m.connection.start();
    expect(m.connection.state.kind).toBe("connected");
    const steps: string[] = [];
    const installs = new InstallGate(mossInstallGateDeps({
      client: () => m.connection.client,
      stopApp: () => { steps.push("stop"); m.connection.stop(); },
      engineGone: async () => { steps.push("engine gone"); },
      install: (relaunch) => { steps.push(`install relaunch=${relaunch}`); return true; },
      recover: (_r, why) => steps.push(`recover ${why}`),
      after: () => {},
      every: () => () => {},
      log: () => {},
    }));
    await installs.downloaded("0.125.0");
    // Busy: nothing installs, nothing stops; the engine was only asked.
    expect(steps).toEqual([]);
    expect(e.calls().map((c) => c.method).filter((x) => x.startsWith("update.") || x === "pair.exiting")).toEqual(["update.status"]);
    idle = true;
    await installs.check();
    expect(e.calls().map((c) => c.method).filter((x) => x.startsWith("update.") || x === "pair.exiting")).toEqual(["update.status", "update.status", "update.apply", "pair.exiting"]);
    expect(e.calls().find((c) => c.method === "pair.exiting")?.params).toEqual({ reason: "update" });
    expect(steps).toEqual(["stop", "engine gone", "install relaunch=true"]);
  });

  test("an engine that refuses the update's exit (busy again) keeps MOSS connected, and nothing installs", async () => {
    const h = home();
    let n = 0;
    // Idle for the status and the apply, busy by the exit.
    const e = await startFakeEngine({ home: h, release: "0.124.0", updateIdle: () => ++n <= 2 });
    engines.push(e);
    const m = mossOn(h, "0.124.0");
    await m.connection.start();
    const steps: string[] = [];
    const installs = new InstallGate(mossInstallGateDeps({
      client: () => m.connection.client, stopApp: () => steps.push("stop"), engineGone: async () => {}, install: () => { steps.push("install"); return true; },
      recover: () => {}, after: () => {}, every: () => () => {}, log: () => {},
    }));
    await installs.downloaded("0.125.0");
    expect(steps).toEqual([]);
    expect(m.connection.state.kind).toBe("connected");
    m.connection.stop();
  });
});
