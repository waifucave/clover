// L-M2 in the core: the network settings sent to whoever runs the tabs (R13's per-bot LAN, R14's proxy), B-M1's
// `open({ show })` and `TabView.view` (R8), lane D's grants behind the person's browser (R10), and the `computer`
// field across computers, two daemons joined by the fake link.
import { describe, expect, test } from "bun:test";
import type { Level } from "@waifucave/clover-protocol";
import { FakeLinkNetwork } from "../../src/contracts/fakes/link-transport";
import {
  BrowserError, BrowserService, browserCallerOf, startBrowser, personsBrowserGrants, serveBrowserPeers, USER_BROWSER_PARTITION_GRANT, type BrowserEvent,
  STREAM_LINK_LABEL, StreamFrameReader, type BrowserPeers, type PersonsBrowserCard, type SessionGrantsPort, type StreamChunk,
} from "../../src/browser";
import { FakeApp } from "./fakes";

const alpha = { kind: "bot", bot: "alpha" } as const;
const asAlpha = { kind: "agent", bot: "alpha", session: "sess_a" } as const;
const asLuna = { kind: "agent", bot: "luna", session: "sess_l" } as const;
const person = { kind: "user" } as const;

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof BrowserError ? e.code : `not a BrowserError: ${String(e)}`;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("the network settings", () => {
  test("sent whole to the app, kept while none runs, sent again first on reconnect; a bad one is refused", async () => {
    let app: FakeApp | undefined;
    const service = new BrowserService({ computer: "Studio", app: () => app, network: { proxy: { mode: "system" }, lanBots: ["alpha"] } });
    expect(service.networkConfig).toEqual({ proxy: { mode: "system" }, lanBots: ["alpha"] });
    // No app: kept.
    await service.configure({ proxy: { mode: "explicit", url: "socks5://proxy.test:1080" }, lanBots: ["alpha", "alpha", "pack/luna"] });
    app = new FakeApp();
    const order: string[] = [];
    const list = app.list.bind(app);
    app.list = async () => { order.push("list"); return list(); };
    const configure = app.configure.bind(app);
    app.configure = async (c) => { order.push("configure"); return configure(c); };
    await service.reconnect();
    expect(order).toEqual(["configure", "list"]);
    expect(app.configs).toEqual([{ proxy: { mode: "explicit", url: "socks5://proxy.test:1080" }, lanBots: ["alpha", "pack/luna"] }]);
    await service.configure({ proxy: { mode: "off" }, lanBots: [] });
    expect(app.configs.at(-1)).toEqual({ proxy: { mode: "off" }, lanBots: [] });
    for (const bad of [
      { proxy: { mode: "explicit", url: "http://user:pw@proxy.test:1" }, lanBots: [] },
      { proxy: { mode: "auto" }, lanBots: [] },
      { proxy: { mode: "off" }, lanBots: ["../etc"] },
    ]) {
      expect(await code(service.configure(bad as never))).toMatch(/bad_setting|bad_owner/);
    }
    expect(app.configs.length).toBe(2);
  });
});

describe("B-M1's open({ show }) and the live view's name (R8)", () => {
  test("a tab opened into a view is shown there at once, its view named; the view's other tab goes back; hide clears it", async () => {
    const app = new FakeApp();
    let n = 0;
    const events: BrowserEvent[] = [];
    const service = new BrowserService({ computer: "Studio", app: () => app, newId: () => `tab_${++n}`, emit: (e) => events.push(e) });
    const first = await service.open(person, { owner: alpha, show: { view: "browser", viewport: { width: 800, height: 600 } } });
    expect(first).toMatchObject({ place: "shown", view: "browser", viewport: { width: 800, height: 600 } });
    expect(app.commands.at(-1)).toEqual({ id: "tab_1", command: { kind: "place", place: "shown", view: "browser", viewport: { width: 800, height: 600 } } });
    const second = await service.open(person, { owner: alpha, show: { view: "browser", viewport: { width: 800, height: 600 } } });
    expect(second.view).toBe("browser");
    expect(service.tabs(person).find((t) => t.id === "tab_1")).toMatchObject({ place: "headless", viewport: { width: 1280, height: 800 } });
    expect(service.tabs(person).find((t) => t.id === "tab_1")?.view).toBeUndefined();
    const hidden = await service.hide(person, "tab_2");
    expect(hidden.view).toBeUndefined();
    expect(await code(service.open(person, { owner: alpha, show: { view: "", viewport: { width: 1, height: 1 } } }))).toBe("bad_viewport");
    // M1's boolean still opens headless.
    expect((await service.open(person, { owner: alpha, show: true })).place).toBe("headless");
  });
});

describe("the app's reports (the second review's minor)", () => {
  test("in one batch, a change after a tab's close doesn't bring it back", async () => {
    const app = new FakeApp();
    const service = new BrowserService({ computer: "Studio", app: () => app, newId: () => "tab_1" });
    const tab = await service.open(person, { owner: alpha });
    service.report([{ kind: "closed", id: tab.id, by: "page" }, { kind: "changed", tab: { ...tab, title: "Late" } }]);
    expect(service.tabs(person)).toEqual([]);
  });

  test("a report about a tab still opening never closes it as a stranger's (the headless shell reports before open answers)", async () => {
    const app = new FakeApp();
    let service!: BrowserService;
    const open = app.open.bind(app);
    app.open = async (args) => {
      const view = await open(args);
      service.report([{ kind: "changed", tab: { ...view, title: "Early" } }]);
      return view;
    };
    service = new BrowserService({ computer: "Studio", app: () => app, newId: () => "tab_1" });
    const tab = await service.open(person, { owner: alpha, url: "https://example.com/" });
    expect(app.commands.filter((c) => c.command.kind === "close")).toEqual([]);
    expect(service.tabs(person).map((t) => t.id)).toEqual([tab.id]);
  });
});

describe("lane D's grants behind the person's own browser (R10)", () => {
  function grants(decision: { allowed: boolean; by?: string }) {
    const held = new Set<string>();
    const asked: { session: string; key: string; card: PersonsBrowserCard }[] = [];
    const port: SessionGrantsPort = {
      has: (s, key) => held.has(`${s}/${key}`),
      ensure: async (session, key, card) => {
        asked.push({ session, key, card });
        if (decision.allowed && decision.by === "card") held.add(`${session}/${key}`);
        return decision;
      },
    };
    return { port, asked, held };
  }

  test("the person's yes on the card opens their browser for that session alone", async () => {
    const g = grants({ allowed: true, by: "card" });
    const service = new BrowserService({ computer: "Studio", app: () => new FakeApp(), grants: personsBrowserGrants(g.port) });
    const coding = { kind: "agent", session: "sess_code" } as const;
    const tab = await service.open(coding, { owner: { kind: "user" } });
    expect(g.asked).toHaveLength(1);
    expect(g.asked[0]).toMatchObject({ session: "sess_code", key: USER_BROWSER_PARTITION_GRANT, card: { effect: "screen", computers: ["Studio"] } });
    expect("kind" in g.asked[0]!.card).toBe(false);
    expect(service.tabs(coding).map((t) => t.id)).toEqual([tab.id]);
    expect(service.tabs({ kind: "agent", session: "sess_other" })).toEqual([]);
  });

  test("a yes that didn't come from the card (a level, a saved rule) opens nothing", async () => {
    for (const by of ["level", "rule", undefined]) {
      const g = grants({ allowed: true, ...(by !== undefined ? { by } : {}) });
      const service = new BrowserService({ computer: "Studio", app: () => new FakeApp(), grants: personsBrowserGrants(g.port) });
      expect(await code(service.open({ kind: "agent", session: "sess_code" }, { owner: { kind: "user" } }))).toBe("needs_ok");
    }
  });
});

describe("the computer field, across computers", () => {
  function twoComputers(opts: { mayCall?: (device: string) => boolean; level?: Level; grants?: SessionGrantsPort } = {}) {
    const net = new FakeLinkNetwork();
    const studio = net.endpoint("dev-studio");
    const laptop = net.endpoint("dev-laptop");
    const names: Record<string, string> = { Studio: "dev-studio", Laptop: "dev-laptop" };
    const peersOf = (transport: typeof studio): BrowserPeers => ({
      transport,
      computer: (name) => (names[name] !== undefined && names[name] !== transport.self ? { device: names[name]!, online: net.reachable(transport.self, names[name]!) } : undefined),
      mayCall: opts.mayCall ?? (() => true),
      level: () => opts.level ?? "automatic",
    });
    const laptopApp = new FakeApp();
    let n = 0;
    const here = new BrowserService({ computer: "Studio", app: () => new FakeApp(), peers: peersOf(studio), newId: () => `tab_s${++n}` });
    const events: BrowserEvent[] = [];
    here.onEvent((e) => events.push(e));
    const there = new BrowserService({ computer: "Laptop", app: () => laptopApp, peers: peersOf(laptop), newId: () => `tab_l${++n}`, ...(opts.grants !== undefined ? { grants: personsBrowserGrants(opts.grants) } : {}) });
    serveBrowserPeers({ service: there, peers: peersOf(laptop) });
    return { net, here, there, laptopApp, events };
  }

  test("a bot's session opens and drives a tab on another computer, which that computer's browser holds", async () => {
    const { here, there, laptopApp, events } = twoComputers();
    const tab = await here.open(asAlpha, { owner: alpha, url: "https://example.com/", computer: "Laptop" });
    expect(tab).toMatchObject({ computer: "Laptop", owner: alpha, partition: "persist:bot-alpha" });
    expect(there.tabs(person).map((t) => t.id)).toEqual([tab.id]);
    expect(events.some((e) => e.type === "tab_changed" && e.tab.id === tab.id)).toBe(true);
    await here.navigate(asAlpha, tab.id, "https://example.org/");
    expect(laptopApp.commands.at(-1)).toEqual({ id: tab.id, command: { kind: "navigate", url: "https://example.org/" } });
    laptopApp.answers.screenshot = { format: "png", data: "iVBORw0K", width: 1280, height: 800, takenAt: 1 };
    expect(await here.screenshot(asAlpha, tab.id)).toMatchObject({ width: 1280, height: 800 });
    await here.cdp(asAlpha, tab.id, "Runtime.evaluate", { expression: "1" });
    expect(laptopApp.commands.at(-1)?.command).toEqual({ kind: "cdp", method: "Runtime.evaluate", params: { expression: "1" } });
    // Refused here before anything goes: a denied domain, a refused scheme.
    const sent = laptopApp.commands.length;
    expect(await code(here.cdp(asAlpha, tab.id, "Target.getTargets"))).toBe("method_refused");
    expect(await code(here.navigate(asAlpha, tab.id, "file:///etc/passwd"))).toBe("url_refused");
    expect(laptopApp.commands.length).toBe(sent);
    // Listing that computer's tabs.
    expect((await here.list(asAlpha, { computer: "Laptop" })).map((t) => t.id)).toEqual([tab.id]);
    // The holder's own report reaches the caller as an event.
    there.report([{ kind: "changed", tab: { ...there.tabs(person)[0]!, title: "Changed there" } }]);
    await tick();
    expect(events.some((e) => e.type === "tab_changed" && e.tab.title === "Changed there")).toBe(true);
    await here.close(asAlpha, tab.id);
    expect(there.tabs(person)).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "tab_closed", id: tab.id, computer: "Laptop" });
  });

  test("the holder's rules: another bot's session can't use it, nobody shows it here, the person's tabs there are refused", async () => {
    const { here } = twoComputers();
    const tab = await here.open(asAlpha, { owner: alpha, computer: "Laptop" });
    expect(await code(here.navigate(asLuna, tab.id, "https://example.org/"))).toBe("no_tab");
    expect(await code(here.screenshot(asLuna, tab.id))).toBe("no_tab");
    expect(await code(here.open(asLuna, { owner: alpha, computer: "Laptop" }))).toBe("not_yours");
    expect(await code(here.show(asAlpha, tab.id, "browser", { width: 800, height: 600 }))).toBe("not_yours");
    expect(await code(here.open(asAlpha, { owner: alpha, computer: "Laptop", show: { view: "browser", viewport: { width: 10, height: 10 } } }))).toBe("not_yours");
    // The person's own browser on another computer: no grant there for a session of this one.
    expect(await code(here.open({ kind: "agent", session: "sess_code" }, { owner: { kind: "user" }, computer: "Laptop" }))).toBe("needs_ok");
    // Only sessions reach other computers' tabs.
    expect(await code(here.open(person, { owner: alpha, computer: "Laptop" }))).toBe("not_yours");
    expect(await code(here.open({ kind: "plugin", pluginId: "acme/tool" }, { owner: { kind: "plugin", plugin: "acme/tool" }, computer: "Laptop" }))).toBe("not_yours");
  });

  test("DevTools events from another computer's tab reach the caller's listener; unsubscribing stops them", async () => {
    const { here, there } = twoComputers();
    const tab = await here.open(asAlpha, { owner: alpha, computer: "Laptop" });
    const got: string[] = [];
    const off = await here.watchCdp(asAlpha, tab.id, (method) => got.push(method));
    there.report([{ kind: "cdp", id: tab.id, method: "Page.loadEventFired", params: {} }, { kind: "cdp", id: tab.id, method: "Target.attachedToTarget", params: {} }]);
    await tick();
    expect(got).toEqual(["Page.loadEventFired"]);
    off();
    await tick();
    there.report([{ kind: "cdp", id: tab.id, method: "Page.loadEventFired", params: {} }]);
    await tick();
    expect(got).toEqual(["Page.loadEventFired"]);
  });

  test("a peer is the device of its link: it never reaches the person's tabs, even naming a local session that holds the grant, nor a local session's tabs of the same id", async () => {
    const held = new Set(["sess_code/browser.partition.user"]);
    const grants: SessionGrantsPort = { has: (s, k) => held.has(`${s}/${k}`), ensure: async () => ({ allowed: true, by: "grant" }) };
    const { here, there } = twoComputers({ grants });
    const local = { kind: "agent", session: "sess_code" } as const;
    // Here, on the laptop, the local session holds the person's OK.
    const own = await there.open(local, { owner: { kind: "user" } });
    const localTab = await there.open(local, { owner: { kind: "session", session: "sess_code" } });
    // Another computer's session of the same id: needs_ok for the person's tabs, and none of the local session's.
    expect(await code(here.open(local, { owner: { kind: "user" }, computer: "Laptop" }))).toBe("needs_ok");
    const theirs = await here.open(local, { owner: { kind: "session", session: "sess_code" }, computer: "Laptop" });
    expect(theirs.partition).not.toBe(localTab.partition);
    const listed = (await here.list(local, { computer: "Laptop" })).map((t) => t.id);
    expect(listed).toEqual([theirs.id]);
    expect(listed).not.toContain(own.id);
    // browserCallerOf keeps the peer's device.
    expect(browserCallerOf({ kind: "peer", device: "dev-studio", sessionId: "sess_code" })).toEqual({ kind: "agent", device: "dev-studio", session: "sess_code" });
  });

  test("the receiving computer's own level judges the call: read-only only looks, ask refuses acting with needs_ok", async () => {
    for (const level of ["read-only", "ask"] as const) {
      const { here, there, laptopApp } = twoComputers({ level });
      const want = level === "read-only" ? "read_only" : "needs_ok";
      expect(await code(here.open(asAlpha, { owner: alpha, computer: "Laptop" }))).toBe(want);
      // A tab the laptop's own bot opened there: another computer may look at it, not act on it.
      const tab = await there.open({ kind: "agent", bot: "alpha" }, { owner: alpha, url: "https://example.com/" });
      expect((await here.list(asAlpha, { computer: "Laptop" })).map((t) => t.id)).toEqual([tab.id]);
      laptopApp.answers.screenshot = { format: "png", data: "iVBORw0K", width: 1280, height: 800, takenAt: 1 };
      expect(await here.screenshot(asAlpha, tab.id)).toMatchObject({ width: 1280 });
      await here.cdp(asAlpha, tab.id, "Page.getNavigationHistory");
      const sent = laptopApp.commands.length;
      expect(await code(here.navigate(asAlpha, tab.id, "https://example.org/"))).toBe(want);
      expect(await code(here.cdp(asAlpha, tab.id, "Runtime.evaluate", { expression: "1" }))).toBe(want);
      expect(await code(here.close(asAlpha, tab.id))).toBe(want);
      expect(laptopApp.commands.length).toBe(sent);
    }
  });

  test("a failed DevTools call doesn't make the device follow the tab", async () => {
    const { here, there, events } = twoComputers();
    const tab = await there.open({ kind: "agent", bot: "luna" }, { owner: { kind: "bot", bot: "luna" } });
    await here.list(asLuna, { computer: "Laptop" });
    expect(await code(here.cdp(asAlpha, tab.id, "Page.reload"))).toBe("no_tab");
    there.report([{ kind: "changed", tab: { ...there.tabs(person)[0]!, title: "Not for you" } }]);
    await tick();
    expect(events.some((e) => e.type === "tab_changed" && e.tab.title === "Not for you")).toBe(false);
  });

  test("an offline computer answers at once; an unknown one is no_computer; an unpaired caller is refused", async () => {
    const { net, here } = twoComputers();
    const tab = await here.open(asAlpha, { owner: alpha, computer: "Laptop" });
    net.partition("dev-studio", "dev-laptop");
    expect(await code(here.screenshot(asAlpha, tab.id))).toBe("computer_offline");
    expect(await code(here.open(asAlpha, { owner: alpha, computer: "Laptop" }))).toBe("computer_offline");
    expect(await code(here.open(asAlpha, { owner: alpha, computer: "Nowhere" }))).toBe("no_computer");
    const refused = twoComputers({ mayCall: () => false });
    expect(await code(refused.here.open(asAlpha, { owner: alpha, computer: "Laptop" }))).toBe("app_failed");
  });
});

describe("browser.stream through the service", () => {
  test("the person's phone gets a tab as video: the app is told to stream, its chunks reach the phone, a close ends it; a session that can't use the tab can't stream it", async () => {
    const net = new FakeLinkNetwork();
    const studio = net.endpoint("dev-studio");
    const phone = net.endpoint("dev-phone");
    const app = new FakeApp();
    const service = new BrowserService({ computer: "Studio", app: () => app, newId: () => "tab_1", streams: { transport: studio } });
    const got: StreamChunk[] = [];
    let ended: Error | undefined | "no";
    ended = "no";
    phone.onStream(STREAM_LINK_LABEL, (stream) => {
      const reader = new StreamFrameReader();
      stream.onData((bytes) => got.push(...reader.push(bytes)));
      stream.onEnd((e) => { ended = e; });
    });
    const tab = await service.open(person, { owner: alpha });
    expect(await code(service.stream(asLuna, tab.id, { on: true }, "dev-phone"))).toBe("no_tab");
    const { stream } = await service.stream(person, tab.id, { on: true, maxKbps: 1000 }, "dev-phone");
    expect(stream).toBeDefined();
    // The app encodes under its own stream id (one encoder may serve several viewers); the viewer's is the link's.
    const cmd = app.commands.at(-1)!;
    expect(cmd).toMatchObject({ id: tab.id, command: { kind: "stream", on: true, maxKbps: 1000 } });
    const encoder = (cmd.command as { stream: string }).stream;
    service.streamData(encoder, { kind: "config", codec: "vp8", codecString: "vp8", width: 1280, height: 800 });
    service.streamData(encoder, { kind: "frame", key: true, timestamp: 1, data: new Uint8Array([1, 2, 3]) });
    await tick();
    expect(got.map((c) => c.kind)).toEqual(["config", "frame"]);
    service.report([{ kind: "closed", id: tab.id, by: "page" }]);
    await tick();
    expect(ended).not.toBe("no");
    expect(await code(service.stream(person, "tab_1", { on: true }, "dev-phone"))).toBe("no_tab");
  });
});

describe("the review's fixes", () => {
  test("a tab the app closes while its open is pending is dropped, answered closed, and never reopened", async () => {
    const app = new FakeApp();
    let service!: BrowserService;
    const open = app.open.bind(app);
    app.open = async (args) => {
      const view = await open(args);
      service.report([{ kind: "closed", id: args.id, by: "crash" }]);
      return view;
    };
    service = new BrowserService({ computer: "Studio", app: () => app, newId: () => "tab_1" });
    expect(await code(service.open(person, { owner: alpha }))).toBe("tab_closed");
    expect(service.tabs(person)).toEqual([]);
    app.open = open;
    expect(await service.reconnect()).toEqual([]);
  });

  test("a revoked device loses its streams at once, its link still up", async () => {
    const net = new FakeLinkNetwork();
    const studio = net.endpoint("dev-studio");
    net.endpoint("dev-phone").onStream(STREAM_LINK_LABEL, () => undefined);
    const app = new FakeApp();
    let revoke!: (id: string) => void;
    const devices = { watch: (fn: (c: { type: "revoked"; id: string }) => void) => { revoke = (id) => fn({ type: "revoked", id }); return () => undefined; } };
    const service = new BrowserService({ computer: "Studio", app: () => app, newId: () => "tab_1", streams: { transport: studio }, devices: devices as never });
    const tab = await service.open(person, { owner: alpha });
    await service.stream(person, tab.id, { on: true }, "dev-phone");
    const before = app.commands.length;
    revoke("dev-phone");
    await tick();
    expect(app.commands.slice(before)).toContainEqual(expect.objectContaining({ command: expect.objectContaining({ kind: "stream", on: false }) }));
  });
  test("an open the app rejects leaves no trace of a close it reported meanwhile: the same id opens afterwards", async () => {
    const app = new FakeApp();
    let service!: BrowserService;
    const open = app.open.bind(app);
    app.open = async (args) => {
      service.report([{ kind: "closed", id: args.id, by: "crash" }]);
      throw new Error("the page crashed on start");
    };
    service = new BrowserService({ computer: "Studio", app: () => app, newId: () => "tab_1" });
    expect(await code(service.open(person, { owner: alpha }))).toBe("app_failed");
    app.open = open;
    // A stale mark would make this open answer "closed" for a tab that never closed.
    expect((await service.open(person, { owner: alpha })).id).toBe("tab_1");
  });

  test("another computer's session streams to its own device only", async () => {
    const net = new FakeLinkNetwork();
    const studio = net.endpoint("dev-studio");
    net.endpoint("dev-phone").onStream(STREAM_LINK_LABEL, () => undefined);
    net.endpoint("dev-other").onStream(STREAM_LINK_LABEL, () => undefined);
    const app = new FakeApp();
    const service = new BrowserService({ computer: "Studio", app: () => app, newId: () => "tab_1", streams: { transport: studio } });
    const peer = browserCallerOf({ kind: "peer", device: "dev-phone", sessionId: "sess_code", bot: "alpha" });
    const tab = await service.open(peer, { owner: alpha });
    expect(await code(service.stream(peer, tab.id, { on: true }, "dev-other"))).toBe("not_yours");
    expect(await code(service.stream(peer, tab.id, { on: false }, "dev-other"))).toBe("not_yours");
    expect(app.commands.some((c) => c.command.kind === "stream")).toBe(false);
    expect((await service.stream(peer, tab.id, { on: true }, "dev-phone")).stream).toBeDefined();
    // This computer's own callers name the device they stream to (the person's phone, say).
    expect((await service.stream(person, tab.id, { on: true }, "dev-other")).stream).toBeDefined();
  });

  test("startBrowser hands the device registry to the service (a revoked device's streams end) and the peers' level through", async () => {
    const net = new FakeLinkNetwork();
    const studio = net.endpoint("dev-studio");
    net.endpoint("dev-phone").onStream(STREAM_LINK_LABEL, () => undefined);
    const app = new FakeApp();
    let revoke!: (id: string) => void;
    const devices = { watch: (fn: (c: { type: "revoked"; id: string }) => void) => { revoke = (id) => fn({ type: "revoked", id }); return () => undefined; } };
    let asked = 0;
    const peers = { transport: studio, level: () => { asked++; return "ask" as Level; } } as unknown as BrowserPeers;
    const browser = startBrowser({ computer: "Studio", home: "/unused", headless: false, app: () => app, peers, devices: devices as never });
    try {
      const tab = await browser.service.open(person, { owner: alpha });
      await browser.service.stream(person, tab.id, { on: true }, "dev-phone");
      const before = app.commands.length;
      revoke("dev-phone");
      await tick();
      expect(app.commands.slice(before)).toContainEqual(expect.objectContaining({ command: expect.objectContaining({ kind: "stream", on: false }) }));
      // The level is the caller's: nothing in the daemon's browser replaces it (it is asked when another computer's call comes).
      expect(asked).toBe(0);
    } finally {
      await browser.shutdown();
    }
  });
});
