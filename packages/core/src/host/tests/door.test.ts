// The engine's host door (lane HS): only the host's program calls the host's methods, its close is the supervisor's
// exit, "quit everything" warns first, and the browser's views and frames keep to their owners (the coordinator's points
// 4 and 5, the ruling on `host.tab.frame`).
import { describe, expect, test } from "bun:test";
import type { AppInstallRecord, TabView } from "@waifucave/moss-protocol";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakeHostWorld } from "../../contracts/fakes/host-supervisor";
import type { MossConn } from "../../ipc/moss";
import { hostDoor } from "../door";
import { EngineHostSupervisor } from "../supervisor";
import { EngineTabFrames, pagesOwner } from "../tab-frames";
import { APP_BROWSER_FEATURE } from "../../browser/app-port";

const app: AppInstallRecord = { record: 1, program: "code", bundlePath: "/Applications/MOSS Code.app", release: "1.111.1", carries: { engine: true, host: true }, seenAt: 1 };

let nextId = 1;
function conn(surface: "host" | "code" | "moss", opts: { features?: string[]; role?: MossConn["role"] } = {}) {
  const notes: { method: string; params: unknown }[] = [];
  const c: MossConn = {
    connId: nextId++, role: opts.role ?? "app", caller: { kind: "user", client: "app" } as MossConn["caller"], features: opts.features ?? [], clientName: surface,
    surface, program: surface, areas: new Set(), follows: new Map(),
    send: () => "1", notify: (method, params) => { notes.push({ method, params }); },
  };
  return { c, notes };
}

/** A JPEG header the engine's reader takes: SOI, then a SOF0 naming the size. */
function jpeg(width: number, height: number): string {
  const b = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  return Buffer.from(b).toString("base64");
}

function tab(id: string, owner: TabView["owner"]): TabView {
  return { id, computer: "c", owner, partition: "p", url: "about:blank", title: "", place: "headless", viewport: { width: 1280, height: 800 }, loading: false, heldByUser: false };
}

function setup() {
  const clock = new FakeClock();
  const world = new FakeHostWorld();
  world.app = app;
  const supervisor = new EngineHostSupervisor({ clock, world });
  const conns: MossConn[] = [];
  const asked: { conn: number; method: string; params: unknown }[] = [];
  const ask = async (c: MossConn, method: string, params: unknown) => { asked.push({ conn: c.connId, method, params }); return { ok: true }; };
  const tabs = new Map<string, TabView>([
    ["bot-tab", tab("bot-tab", { kind: "bot", bot: "b_1" } as TabView["owner"])],
    ["code-tab", tab("code-tab", { kind: "session", session: "s_1" } as TabView["owner"])],
    ["own-tab", tab("own-tab", { kind: "user" })],
  ]);
  let now = 1_000;
  const frames = new EngineTabFrames({ connections: () => conns, ask, viewport: (id) => tabs.get(id)?.viewport, now: () => now });
  const events: { state: string }[] = [];
  let midWork = { turns: 0, agents: 0, routines: 0 };
  let quits = 0;
  const opened: string[] = [];
  const door = hostDoor({
    supervisor, frames, ask, now: () => now, lockPid: () => 4321,
    emit: (e) => events.push(e), midWork: () => midWork, openApp: async (p) => { opened.push(p); }, quitEverything: () => { quits++; }, tab: (id) => tabs.get(id),
  });
  const call = (c: MossConn, method: string, params: unknown) => Promise.resolve().then(() => door.handlers[method]!(c, params));
  return {
    clock, world, supervisor, conns, asked, frames, events, door, call, opened,
    setMidWork: (m: typeof midWork) => { midWork = m; }, quits: () => quits, advance: (ms: number) => { now += ms; },
  };
}

const ready = { release: "1.111.1", bundlePath: app.bundlePath, safeMode: false, parts: { surfaces: 2, background: 1, tabs: [] } };

describe("the host door", () => {
  test("host.ready, host.exiting and host.menu are the host program's alone", async () => {
    const t = setup();
    for (const surface of ["code", "moss"] as const) {
      const w = conn(surface);
      await expect(t.call(w.c, "host.ready", ready)).rejects.toThrow("background host's alone");
      await expect(t.call(w.c, "host.exiting", { reason: "update" })).rejects.toThrow("background host's alone");
      await expect(t.call(w.c, "host.menu", { action: "quit-everything", confirmed: true })).rejects.toThrow("background host's alone");
    }
    // The program is the connection's signed one (lane RT's door), never the surface the hello named.
    const forged = conn("host");
    (forged.c as { program?: string }).program = "code";
    await expect(t.call(forged.c, "host.ready", ready)).rejects.toThrow("background host's alone");
    expect(t.quits()).toBe(0);
  });

  test("the host's close is a crash unless it said it was leaving; host_changed follows the state", async () => {
    const t = setup();
    await t.supervisor.boot();
    const h = conn("host");
    await t.call(h.c, "host.ready", ready);
    expect(t.supervisor.status()).toMatchObject({ state: "running", pid: 4321 });
    expect(t.door.hostConn()?.connId).toBe(h.c.connId);
    t.door.closed(h.c);
    expect(t.supervisor.status()).toMatchObject({ state: "restarting", crashes: 1 });
    expect(t.door.hostConn()).toBeUndefined();
    t.clock.advance(500);
    const h2 = conn("host");
    await t.call(h2.c, "host.ready", ready);
    await t.call(h2.c, "host.exiting", { reason: "update" });
    t.door.closed(h2.c);
    expect(t.supervisor.status().state).toBe("stopped");
    expect(t.events.map((e) => e.state)).toContain("restarting");
    expect(t.events.at(-1)!.state).toBe("stopped");
  });

  test("a second host connection is turned away while the first is live", async () => {
    const t = setup();
    await t.supervisor.boot();
    await t.call(conn("host").c, "host.ready", ready);
    await expect(t.call(conn("host").c, "host.ready", ready)).rejects.toThrow("still live");
  });

  test("quit everything warns when something is mid-work, and acts when asked again", async () => {
    const t = setup();
    const h = conn("host");
    t.setMidWork({ turns: 1, agents: 0, routines: 0 });
    expect(await t.call(h.c, "host.menu", { action: "quit-everything" })).toEqual({ done: false, working: { turns: 1, agents: 0, routines: 0 } });
    await new Promise((r) => setTimeout(r, 5));
    expect(t.quits()).toBe(0);
    expect(await t.call(h.c, "host.menu", { action: "quit-everything", confirmed: true })).toEqual({ done: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(t.quits()).toBe(1);
    expect(await t.call(h.c, "host.menu", { action: "open-code" })).toEqual({ done: true });
    expect(t.opened).toEqual(["code"]);
  });
});

describe("the browser's views and frames", () => {
  function withHost() {
    const t = setup();
    const h = conn("host", { features: ["browser"] });
    const code = conn("code", { features: ["browser"] });
    const moss = conn("moss");
    t.conns.push(h.c, code.c, moss.c);
    return { ...t, h, code, moss };
  }

  test("the pages' owner is the host when it runs them, else today's app, never MOSS's window", () => {
    const h = conn("host", { features: ["browser"] }).c;
    const code = conn("code", { features: ["browser"] }).c;
    const moss = conn("moss", { features: ["browser"] }).c;
    expect(pagesOwner([moss, code, h])?.connId).toBe(h.connId);
    expect(pagesOwner([moss, code])?.connId).toBe(code.connId);
    expect(pagesOwner([moss])).toBeUndefined();
    // The feature the owner lists is the app port's own (tab-frames keeps a copy to avoid an import cycle).
    expect(pagesOwner([conn("code", { features: [APP_BROWSER_FEATURE] }).c])).toBeDefined();
  });

  test("MOSS's window sees only bots' tabs; MOSS Code's sees no bot's tab", async () => {
    const t = withHost();
    await t.supervisor.boot();
    await t.call(t.h.c, "host.ready", ready);
    const vp = { viewport: { width: 640, height: 400 } };
    expect(await t.call(t.moss.c, "browser.view.open", { tab: "bot-tab", ...vp })).toMatchObject({ stream: expect.any(String) });
    await expect(t.call(t.moss.c, "browser.view.open", { tab: "code-tab", ...vp })).rejects.toThrow("only bots' tabs");
    await expect(t.call(t.code.c, "browser.view.open", { tab: "bot-tab", ...vp })).rejects.toThrow("no bot's tab");
    expect(await t.call(t.code.c, "browser.view.open", { tab: "own-tab", ...vp })).toMatchObject({ stream: expect.any(String) });
    await expect(t.call(t.h.c, "browser.view.open", { tab: "own-tab", ...vp })).rejects.toThrow("a window's");
  });

  test("input goes only from MOSS Code's window, on its own view, to a code session's tab or the person's own", async () => {
    const t = withHost();
    await t.supervisor.boot();
    await t.call(t.h.c, "host.ready", ready);
    const vp = { viewport: { width: 640, height: 400 } };
    const events = [{ kind: "mouse", type: "down", x: 1, y: 1, button: "left" }];
    const mossView = (await t.call(t.moss.c, "browser.view.open", { tab: "bot-tab", ...vp })) as { stream: string };
    // MOSS is watch only, on its own view too.
    await expect(t.call(t.moss.c, "browser.view.input", { stream: mossView.stream, events })).rejects.toThrow("watch only");
    // MOSS Code can't press into another window's view (a bot's tab, MOSS's view).
    await expect(t.call(t.code.c, "browser.view.input", { stream: mossView.stream, events })).rejects.toThrow("a view this window opened");
    const codeView = (await t.call(t.code.c, "browser.view.open", { tab: "code-tab", ...vp })) as { stream: string };
    await t.call(t.code.c, "browser.view.input", { stream: codeView.stream, events });
    expect(t.asked.filter((a) => a.method === "host.tab.input")).toEqual([{ conn: t.h.c.connId, method: "host.tab.input", params: { id: "code-tab", events } }]);
    // A second MOSS Code connection can't use the first one's stream.
    const other = conn("code");
    await expect(t.call(other.c, "browser.view.input", { stream: codeView.stream, events })).rejects.toThrow("a view this window opened");
  });

  test("a frame counts only from the pages' owner, as a real jpeg, png or webp within the stream's size, and too many are dropped", async () => {
    const t = withHost();
    await t.supervisor.boot();
    await t.call(t.h.c, "host.ready", ready);
    const view = (await t.call(t.code.c, "browser.view.open", { tab: "own-tab", viewport: { width: 640, height: 400 } })) as { stream: string };
    const start = t.asked.find((a) => a.method === "app.tab.command")!;
    expect(start.conn).toBe(t.h.c.connId);
    const tabStream = (start.params as { command: { stream: string; codecs: string[] } }).command;
    expect(tabStream.codecs).toEqual(["jpeg"]);
    const frame = (w: number, h: number, data = jpeg(w, h)) => ({ stream: tabStream.stream, seq: 1, format: "jpeg", width: w, height: h, data, at: 1 });
    await expect(t.call(t.moss.c, "host.tab.frame", frame(100, 80))).rejects.toThrow("program that runs the pages");
    // Today's app is not the owner while the host runs the pages.
    await expect(t.call(t.code.c, "host.tab.frame", frame(100, 80))).rejects.toThrow("frame refused");
    // Not an image by its header, or a header that says another size, or larger than the tab's viewport.
    await expect(t.call(t.h.c, "host.tab.frame", frame(100, 80, Buffer.from("not an image at all!").toString("base64")))).rejects.toThrow("frame refused");
    await expect(t.call(t.h.c, "host.tab.frame", { ...frame(100, 80), width: 99 })).rejects.toThrow("frame refused");
    await expect(t.call(t.h.c, "host.tab.frame", frame(1281, 800))).rejects.toThrow("frame refused");
    await t.call(t.h.c, "host.tab.frame", frame(100, 80));
    const pictures = t.code.notes.filter((n) => n.method === "picture.frame");
    expect(pictures).toHaveLength(1);
    expect(pictures[0]!.params).toMatchObject({ stream: view.stream, width: 100, height: 80, format: "jpeg" });
    // A second frame at once is over the rate: answered, dropped, never queued.
    await t.call(t.h.c, "host.tab.frame", frame(100, 80));
    expect(t.code.notes.filter((n) => n.method === "picture.frame")).toHaveLength(1);
    t.advance(100);
    await t.call(t.h.c, "host.tab.frame", frame(100, 80));
    expect(t.code.notes.filter((n) => n.method === "picture.frame")).toHaveLength(2);
    expect(t.frames.latest("own-tab")?.seq).toBe(2);
    // A window that goes takes its views with it; one that is still open closes its own.
    t.door.closed(conn("code").c);
    expect(t.asked.filter((a) => a.method === "app.tab.command").at(-1)!.params).toMatchObject({ command: { kind: "stream", on: true } });
    // The view closes: the last reader is gone, so the tab's stream stops at the host.
    await t.call(t.code.c, "browser.view.close", { stream: view.stream });
    expect(t.asked.filter((a) => a.method === "app.tab.command").at(-1)!.params).toMatchObject({ command: { kind: "stream", on: false } });
  });
});

describe("the reviewer's part one (S2, S4, S6)", () => {
  test("host.status answers the state now, as host_changed says it, to a window that just connected", async () => {
    const t = setup();
    await t.supervisor.boot();
    const w = conn("code");
    expect(await t.call(w.c, "host.status", {})).toMatchObject({ state: "starting", crashes: 0 });
  });

  test("while a host owns the screen and isn't connected, the window is no pages' owner; with no host at all it is", () => {
    const host = conn("host", { features: ["browser"] }).c;
    const win = conn("code", { features: ["browser"] }).c;
    expect(pagesOwner([win], { hostOwnsScreen: true })).toBeUndefined();
    expect(pagesOwner([win], { hostOwnsScreen: false })?.connId).toBe(win.connId);
    expect(pagesOwner([win, host], { hostOwnsScreen: true })?.connId).toBe(host.connId);
  });

  test("an open view's stream moves to the new pages' owner when the host says ready (its pictures never freeze)", async () => {
    const t = setup();
    let owns = false;
    const asked: { conn: number; params: { command: { on: boolean; stream: string } } }[] = [];
    const frames = new EngineTabFrames({ connections: () => t.conns, ask: async (c, _m, p) => { asked.push({ conn: c.connId, params: p as never }); return { ok: true }; }, viewport: () => ({ width: 1280, height: 800 }), hostOwnsScreen: () => owns });
    const win = conn("code", { features: ["browser"] }).c;
    t.conns.push(win);
    const got: number[] = [];
    frames.subscribe("own-tab", (f) => got.push(f.seq));
    expect(asked.at(-1)).toMatchObject({ conn: win.connId, params: { command: { on: true } } });
    const first = asked.at(-1)!.params.command.stream;
    const host = conn("host", { features: ["browser"] }).c;
    t.conns.push(host);
    owns = true;
    frames.reown();
    expect(asked.slice(-2)).toMatchObject([{ conn: win.connId, params: { command: { on: false, stream: first } } }, { conn: host.connId, params: { command: { on: true } } }]);
    const second = asked.at(-1)!.params.command.stream;
    // The window's late frame is refused; the host's is taken.
    expect(frames.accept(win, { stream: first, seq: 1, format: "jpeg", width: 64, height: 32, data: jpeg(64, 32), at: 1 })).toBe("refused");
    expect(frames.accept(host, { stream: second, seq: 1, format: "jpeg", width: 64, height: 32, data: jpeg(64, 32), at: 1 })).toBe("taken");
    expect(got).toEqual([1]);
  });
});

test("browser.report and browser.hold are the pages' owner's alone; with the host owning the screen and gone, the tool hears it", async () => {
  const { browserAppHandlers, appTabPort } = await import("../../browser/app-port");
  const held: string[] = [];
  const service = { report: () => undefined, hold: (id: string) => { held.push(id); } } as never;
  const host = conn("host", { features: ["browser"] }).c;
  const win = conn("code", { features: ["browser"] }).c;
  const h = browserAppHandlers(() => service, (c) => c.connId === host.connId);
  await expect(Promise.resolve().then(() => h["browser.hold"](win, { id: "t1", held: true }))).rejects.toThrow(/runs the browser's pages/);
  await h["browser.hold"](host, { id: "t1", held: true });
  expect(held).toEqual(["t1"]);
  const port = appTabPort({ connections: () => [win], ask: async () => ({}), hostOwnsScreen: () => true })();
  await expect(port!.list()).rejects.toThrow(/background host that runs the browser's pages isn't running; it starts again by itself/);
});
