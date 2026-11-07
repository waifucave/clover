import { describe, expect, test } from "bun:test";
import {
  AGENT_VIEWPORT, BrowserError, BrowserService, browserCallerOf, isBrowserUrlAllowed, partitionFor, type PersonsBrowserCard, type PersonsBrowserGrants,
  type AppTabCommand, type AppTabPort, type BrowserEvent, type BrowserNetworkConfig, type TabOwner, type TabPlace, type TabView,
} from "../../src/browser";
import { FakeApp, FakeGrants } from "./fakes";

function setup(opts: { app?: FakeApp | null; grants?: FakeGrants } = {}) {
  const app = opts.app === null ? undefined : (opts.app ?? new FakeApp());
  const events: BrowserEvent[] = [];
  let n = 0;
  let now = 1_000_000;
  const service = new BrowserService({
    computer: "Studio",
    app: () => app,
    emit: (e) => events.push(e),
    newId: () => `tab_${++n}`,
    now: () => now,
    ...(opts.grants !== undefined ? { grants: opts.grants } : {}),
  });
  return { app: app as FakeApp, service, events, advance: (ms: number) => { now += ms; } };
}

const alpha = { kind: "bot", bot: "alpha" } as const;
const luna = { kind: "bot", bot: "luna" } as const;
const user = { kind: "user" } as const;
const asAlpha = { kind: "agent", bot: "alpha" } as const;
const asLuna = { kind: "agent", bot: "luna" } as const;
const person = { kind: "user" } as const;

async function code(p: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return e instanceof BrowserError ? e.code : `not a BrowserError: ${String(e)}`;
  }
  return undefined;
}

describe("partitions", () => {
  test("one per bot, one for the user, never per site; a child bot's slash can't collide", () => {
    expect(partitionFor(alpha)).toBe("persist:bot-alpha");
    expect(partitionFor({ kind: "bot", bot: "pack/luna" })).toBe("persist:bot-pack--luna");
    expect(partitionFor(user)).toBe("persist:user");
    expect(partitionFor({ kind: "plugin", plugin: "clover/browser-view" })).toBe("persist:plugin-clover--browser-view");
    expect(() => partitionFor({ kind: "plugin", plugin: "../x" })).toThrow(BrowserError);
    // A session without a bot: its own, named by a hash of its id (no id ever spells a folder name).
    const own = partitionFor({ kind: "session", session: "sess_1" });
    expect(own).toMatch(/^persist:session-[0-9a-f]{32}$/);
    expect(partitionFor({ kind: "session", session: "sess_2" })).not.toBe(own);
    expect(() => partitionFor({ kind: "session", session: "../x y" })).toThrow(BrowserError);
    expect(() => partitionFor({ kind: "bot", bot: "../evil" })).toThrow(BrowserError);
    expect(() => partitionFor({ kind: "bot", bot: "A" })).toThrow(BrowserError);
  });
});

describe("the URL rule", () => {
  test("web pages and about:blank open; files, the browser's own pages and Clover's schemes never do", () => {
    // The URL rule is about schemes. Which addresses a tab may reach (no loopback or private address from a bot's tab,
    // R13) is checked when each connection is made, after DNS, in the app (`apps/desktop/src/main/browser/network.ts`).
    for (const ok of ["https://example.com/", "http://example.com:8080/x", "about:blank", "about:srcdoc", "data:text/html,hi"]) expect(isBrowserUrlAllowed(ok)).toBe(true);
    for (const no of ["file:///etc/passwd", "chrome://settings", "devtools://x", "view-source:https://a.b", "clover-plugin://x/y", "cloverui://a", "about:config", "not a url"]) expect(isBrowserUrlAllowed(no)).toBe(false);
  });
});

describe("opening and owning tabs", () => {
  test("a bot opens a tab in its own partition, headless at 1280×800, and the core says so", async () => {
    const { app, service, events } = setup();
    const tab = await service.open(asAlpha, { owner: alpha, url: "https://example.com/" });
    expect(tab).toMatchObject({ id: "tab_1", owner: alpha, partition: "persist:bot-alpha", place: "headless", viewport: AGENT_VIEWPORT, heldByUser: false, computer: "Studio" });
    expect(app.tabs.get("tab_1")?.place).toBe("headless");
    expect(events.at(-1)).toMatchObject({ type: "tab_changed", tab: { id: "tab_1" } });
  });

  test("a bot's session can't open or touch another bot's tabs, nor see them", async () => {
    const { service } = setup();
    expect(await code(service.open(asLuna, { owner: alpha }))).toBe("not_yours");
    const tab = await service.open(asAlpha, { owner: alpha });
    expect(service.tabs(asLuna)).toEqual([]);
    expect(await code(service.navigate(asLuna, tab.id, "https://a.example/"))).toBe("no_tab");
    expect(await code(service.cdp(asLuna, tab.id, "Page.reload"))).toBe("no_tab");
    expect(service.tabs(asAlpha).map((t) => t.id)).toEqual([tab.id]);
    expect(service.tabs(person).map((t) => t.id)).toEqual([tab.id]);
  });

  test("a session without a bot uses tabs of its own, never another session's (R10)", async () => {
    const { service } = setup();
    const coding = { kind: "agent", session: "sess_code" } as const;
    const other = { kind: "agent", session: "sess_other" } as const;
    const mine = { kind: "session", session: "sess_code" } as const;
    expect(await code(service.open(coding, { owner: alpha }))).toBe("not_yours");
    expect(await code(service.open(coding, { owner: { kind: "session", session: "sess_other" } }))).toBe("not_yours");
    const tab = await service.open(coding, { owner: mine });
    expect(tab.partition).toBe(partitionFor(mine));
    expect(service.tabs(other)).toEqual([]);
    expect(await code(service.navigate(other, tab.id, "https://a.example/"))).toBe("no_tab");
    // A session with neither a bot nor an id has no tabs at all.
    expect(await code(service.open({ kind: "agent" }, { owner: mine }))).toBe("not_yours");
  });

  test("the person's own browser only after their yes on a card for that session, from lane D's grants (R10)", async () => {
    const grants = new FakeGrants();
    const { service } = setup({ grants });
    const theirs = await service.open(person, { owner: user });
    const coding = { kind: "agent", session: "sess_code" } as const;
    const bots = { kind: "agent", bot: "alpha", session: "sess_alpha" } as const;
    // No yes: the card is asked, the answer is no, and nothing of theirs is reached.
    expect(await code(service.open(coding, { owner: user }))).toBe("needs_ok");
    expect(grants.asked).toHaveLength(1);
    expect(grants.asked[0]).toMatchObject({ session: "sess_code", card: { computers: ["Studio"], effect: "screen" } });
    expect(service.tabs(coding)).toEqual([]);
    expect(await code(service.navigate(coding, theirs.id, "https://a.example/"))).toBe("no_tab");
    // A yes: for that session alone.
    grants.answer = true;
    expect((await service.open(coding, { owner: user })).partition).toBe("persist:user");
    expect(service.tabs(coding).map((t) => t.id)).toContain(theirs.id);
    expect(await code(service.navigate(coding, theirs.id, "https://a.example/"))).toBeUndefined();
    grants.answer = false;
    expect(await code(service.open(bots, { owner: user }))).toBe("needs_ok");
    expect(service.tabs(bots).map((t) => t.id)).not.toContain(theirs.id);
  });

  test("without lane D's grants, no session ever drives the person's own browser", async () => {
    const { service } = setup();
    await service.open(person, { owner: user });
    expect(await code(service.open({ kind: "agent", session: "sess_code" }, { owner: user }))).toBe("needs_ok");
    expect(service.tabs({ kind: "agent", session: "sess_code" })).toEqual([]);
  });

  test("a plugin acting as itself opens and touches tabs only in its own partition (B-M1's contract review S1)", async () => {
    const { service } = setup();
    const plugin = { kind: "plugin", pluginId: "acme/tool" } as const;
    const botTab = await service.open(asAlpha, { owner: alpha });
    for (const owner of [alpha, user, { kind: "session", session: "s1" }, { kind: "plugin", plugin: "other" }] as const) {
      expect(await code(service.open(plugin, { owner }))).toBe("not_yours");
    }
    const own = await service.open(plugin, { owner: { kind: "plugin", plugin: "acme/tool" } });
    expect(own.partition).toBe("persist:plugin-acme--tool");
    expect(service.tabs(plugin).map((t) => t.id)).toEqual([own.id]);
    expect(await code(service.navigate(plugin, botTab.id, "https://a.example/"))).toBe("no_tab");
    // No session reaches a plugin's tabs either; the person sees them all.
    expect(service.tabs(asAlpha).map((t) => t.id)).toEqual([botTab.id]);
    expect(service.tabs(person).map((t) => t.id).sort()).toEqual([botTab.id, own.id].sort());
  });

  test("a plugin's call while it serves a tool call is that session's, never the plugin's (R7)", () => {
    const plugin = { kind: "plugin", pluginId: "clover/browser" } as const;
    expect(browserCallerOf(plugin)).toEqual({ kind: "plugin", pluginId: "clover/browser" });
    expect(browserCallerOf(plugin, { kind: "session", sessionId: "s1", bot: "alpha" })).toEqual({ kind: "agent", bot: "alpha", session: "s1" });
    expect(browserCallerOf(plugin, { kind: "session", sessionId: "s2" })).toEqual({ kind: "agent", session: "s2" });
    expect(browserCallerOf({ kind: "peer", device: "d1", sessionId: "s3", bot: "luna" })).toEqual({ kind: "agent", bot: "luna", session: "s3" });
    expect(browserCallerOf({ kind: "user" })).toEqual({ kind: "user" });
    expect(browserCallerOf({ kind: "core" })).toEqual({ kind: "core" });
  });

  test("refused URLs never reach the app, at open or navigate", async () => {
    const { app, service } = setup();
    expect(await code(service.open(asAlpha, { owner: alpha, url: "file:///Users/someone/.ssh/id_ed25519" }))).toBe("url_refused");
    expect(app.tabs.size).toBe(0);
    const tab = await service.open(asAlpha, { owner: alpha });
    expect(await code(service.navigate(asAlpha, tab.id, "chrome://settings"))).toBe("url_refused");
    expect(app.commands).toEqual([]);
  });

  test("no app on this computer: a plain error, not a hang", async () => {
    const { service } = setup({ app: null });
    expect(await code(service.open(asAlpha, { owner: alpha }))).toBe("no_app");
  });

  test("without links to other computers, another computer's tabs are refused (no_computer); this one's list stays its own", async () => {
    const { service } = setup();
    expect(await code(service.open(asAlpha, { owner: alpha, computer: "Laptop" }))).toBe("no_computer");
    expect(await code(service.list(asAlpha, { computer: "Laptop" }))).toBe("no_computer");
    expect(service.tabs(person, { computer: "Laptop" })).toEqual([]);
  });

  test("the app failing is an app_failed error with its words", async () => {
    const app = new FakeApp();
    const { service } = setup({ app });
    const tab = await service.open(asAlpha, { owner: alpha });
    app.fail = new Error("the tab's renderer crashed");
    const e = await service.navigate(asAlpha, tab.id, "https://a.example/").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BrowserError);
    expect((e as BrowserError).code).toBe("app_failed");
    expect((e as BrowserError).message).toContain("renderer crashed");
  });
});

describe("showing and hiding", () => {
  test("show lays the tab out at the view's size; hide brings back 1280×800 and lets go of a hold", async () => {
    const { app, service } = setup();
    const tab = await service.open(asAlpha, { owner: alpha });
    const shown = await service.show(person, tab.id, "browser", { width: 900, height: 640 });
    expect(shown).toMatchObject({ place: "shown", viewport: { width: 900, height: 640 } });
    expect(app.commands.at(-1)).toEqual({ id: tab.id, command: { kind: "place", place: "shown", view: "browser", viewport: { width: 900, height: 640 } } });
    service.hold(tab.id, true);
    const hidden = await service.hide(person, tab.id);
    expect(hidden).toMatchObject({ place: "headless", viewport: AGENT_VIEWPORT, heldByUser: false });
    expect(app.commands.at(-1)?.command).toEqual({ kind: "place", place: "headless", viewport: AGENT_VIEWPORT });
  });

  test("a viewport is whole pixels within bounds", async () => {
    const { service } = setup();
    const tab = await service.open(asAlpha, { owner: alpha });
    expect(await code(service.show(person, tab.id, "browser", { width: 0, height: 10 }))).toBe("bad_viewport");
    expect(await code(service.show(person, tab.id, "browser", { width: 10.5, height: 10 }))).toBe("bad_viewport");
    expect(await code(service.show(person, tab.id, "browser", { width: 20_000, height: 10 }))).toBe("bad_viewport");
  });
});

describe("the person holding a tab", () => {
  test("refuses an agent's commands, lets it look, and never stops the person", async () => {
    const { service, app } = setup();
    const tab = await service.open(asAlpha, { owner: alpha });
    service.hold(tab.id, true);
    expect(service.tabs(asAlpha)[0]?.heldByUser).toBe(true);
    for (const p of [
      service.navigate(asAlpha, tab.id, "https://a.example/"),
      service.cdp(asAlpha, tab.id, "Input.dispatchKeyEvent", { type: "keyDown" }),
      service.close(asAlpha, tab.id),
      service.hide(asAlpha, tab.id),
    ]) expect(await code(p)).toBe("held");
    app.answers.screenshot = { format: "png", data: "", width: 1280, height: 800, takenAt: 1 };
    expect(await code(service.screenshot(asAlpha, tab.id))).toBeUndefined();
    expect(await code(service.navigate(person, tab.id, "https://b.example/"))).toBeUndefined();
    // Only the person passes a hold (B-M1's contract review S1): a plugin's own code and the core are refused too.
    expect(await code(service.cdp({ kind: "plugin", pluginId: "clover/browser-view" }, tab.id, "Page.getNavigationHistory"))).toBe("no_tab");
    expect(await code(service.navigate({ kind: "core" }, tab.id, "https://d.example/"))).toBe("held");
    expect(await code(service.screenshot({ kind: "core" }, tab.id))).toBeUndefined();
    service.hold(tab.id, false);
    expect(await code(service.navigate(asAlpha, tab.id, "https://c.example/"))).toBeUndefined();
  });

  test("a tab the app made is adopted only as the owner of a tab the core holds, never on the app's word (review S1)", async () => {
    const { app, service } = setup();
    const opener = await service.open(asAlpha, { owner: alpha });
    // A window the page opened, which the app keeps as a tab of the opener's owner, says it is held: it isn't.
    const popup: TabView = { ...opener, id: "tab_pop", url: "https://pop.example/", heldByUser: true };
    service.report([{ kind: "changed", tab: popup }]);
    expect(service.tabs(asAlpha).find((t) => t.id === "tab_pop")).toMatchObject({ owner: alpha, partition: "persist:bot-alpha", heldByUser: false });
    // One that claims an owner the core holds no tab for, or a partition that isn't that owner's, is refused and closed.
    service.report([{ kind: "changed", tab: { ...opener, id: "tab_luna", owner: luna, partition: "persist:bot-luna" } }]);
    service.report([{ kind: "changed", tab: { ...opener, id: "tab_odd", partition: "persist:user" } }]);
    expect(service.tabs(person).map((t) => t.id).sort()).toEqual([opener.id, "tab_pop"].sort());
    await Promise.resolve();
    expect(app.commands.filter((c) => c.command.kind === "close").map((c) => c.id).sort()).toEqual(["tab_luna", "tab_odd"]);
  });

  test("after the core restarted, the app's tabs it can't place are closed, not taken on the app's word", async () => {
    const app = new FakeApp();
    const first = setup({ app }).service;
    await first.open(asAlpha, { owner: alpha, url: "https://a.example/" });
    const { service } = setup({ app }); // the core came back with nothing
    expect(await service.reconnect()).toEqual([]);
    expect(service.tabs(person)).toEqual([]);
    expect(app.commands.at(-1)?.command).toEqual({ kind: "close" });
  });

  test("an app report doesn't undo the core's hold or owner", async () => {
    const { service } = setup();
    const tab = await service.open(asAlpha, { owner: alpha });
    service.hold(tab.id, true);
    service.report([{ kind: "changed", tab: { ...tab, title: "Loaded", heldByUser: false, owner: user, partition: "persist:user" } }]);
    expect(service.tabs(person)[0]).toMatchObject({ title: "Loaded", heldByUser: true, owner: alpha, partition: "persist:bot-alpha" });
  });
});

describe("DevTools calls", () => {
  test("only allowlisted domains, and not the methods that reach outside the page", async () => {
    const { service, app } = setup();
    const tab = await service.open(asAlpha, { owner: alpha });
    for (const m of ["Target.createTarget", "Browser.close", "Storage.clearDataForOrigin", "SystemInfo.getInfo", "Tracing.start", "DOM.setFileInputFiles", "Page.setDownloadBehavior", "Emulation.setDeviceMetricsOverride", "Network.setCookies"]) {
      expect(await code(service.cdp(asAlpha, tab.id, m))).toBe("method_refused");
    }
    app.answers.cdp = { result: { value: 2 } };
    expect(await service.cdp(asAlpha, tab.id, "Runtime.evaluate", { expression: "1+1" })).toEqual({ result: { value: 2 } });
    expect(app.commands.at(-1)?.command).toEqual({ kind: "cdp", method: "Runtime.evaluate", params: { expression: "1+1" } });
  });

  test("a point from a picture at another size is refused; one at the tab's size passes", async () => {
    const { service } = setup();
    const tab = await service.open(asAlpha, { owner: alpha });
    const click = { type: "mousePressed", x: 10, y: 10, button: "left", clickCount: 1 };
    expect(await code(service.cdp(asAlpha, tab.id, "Input.dispatchMouseEvent", click, { viewport: { width: 900, height: 640 } }))).toBe("point_stale");
    expect(await code(service.cdp(asAlpha, tab.id, "Input.dispatchMouseEvent", click, { viewport: { ...AGENT_VIEWPORT } }))).toBeUndefined();
    // Methods without a point ignore the viewport.
    expect(await code(service.cdp(asAlpha, tab.id, "Page.reload", {}, { viewport: { width: 900, height: 640 } }))).toBeUndefined();
  });

  test("events reach a tab's listeners, never another tab's, and only allowlisted ones", async () => {
    const { service } = setup();
    const a = await service.open(asAlpha, { owner: alpha });
    const b = await service.open(asAlpha, { owner: alpha });
    const seen: string[] = [];
    const off = service.onCdpEvent(asAlpha, a.id, (m) => seen.push(m));
    service.report([
      { kind: "cdp", id: a.id, method: "Page.loadEventFired", params: {} },
      { kind: "cdp", id: b.id, method: "Page.frameNavigated", params: {} },
      { kind: "cdp", id: a.id, method: "Target.attachedToTarget", params: {} },
    ]);
    off();
    service.report([{ kind: "cdp", id: a.id, method: "Page.domContentEventFired", params: {} }]);
    expect(seen).toEqual(["Page.loadEventFired"]);
  });
});

describe("screenshots", () => {
  test("a tab that stopped drawing gives an error, never an old picture; its next change clears it", async () => {
    const { service, app, advance } = setup();
    const tab = await service.open(asAlpha, { owner: alpha });
    app.answers.screenshot = { format: "jpeg", data: "AA==", width: 1280, height: 800, takenAt: 5, contentAgeMs: 30 };
    service.report([{ kind: "stalled", id: tab.id, sinceMs: 1500 }]);
    advance(500);
    const e = await service.screenshot(asAlpha, tab.id).catch((x: unknown) => x);
    expect((e as BrowserError).code).toBe("stalled");
    expect((e as BrowserError).message).toContain("2 s ago");
    service.report([{ kind: "changed", tab: { ...tab, title: "back" } }]);
    expect(await service.screenshot(asAlpha, tab.id, { format: "jpeg", quality: 70 })).toMatchObject({ format: "jpeg", width: 1280 });
    expect(app.commands.at(-1)?.command).toEqual({ kind: "screenshot", format: "jpeg", quality: 70 });
  });
});

describe("the app's reports and restarts", () => {
  test("a closed report drops the tab and says so; a closed tab refuses further calls", async () => {
    const { service, events } = setup();
    const tab = await service.open(asAlpha, { owner: alpha });
    service.report([{ kind: "closed", id: tab.id, by: "page" }]);
    expect(events.at(-1)).toEqual({ type: "tab_closed", id: tab.id, computer: "Studio" });
    expect(await code(service.navigate(asAlpha, tab.id, "https://a.example/"))).toBe("no_tab");
  });

  test("closing a tab sends close and forgets it", async () => {
    const { service, app } = setup();
    const tab = await service.open(asAlpha, { owner: alpha });
    await service.close(asAlpha, tab.id);
    expect(app.commands.at(-1)).toEqual({ id: tab.id, command: { kind: "close" } });
    expect(service.tabs(person)).toEqual([]);
  });

  test("after the app crashed and came back, the tabs it lost are opened again at their last address", async () => {
    const app = new FakeApp();
    const { service } = setup({ app });
    const a = await service.open(asAlpha, { owner: alpha, url: "https://a.example/" });
    service.report([{ kind: "changed", tab: { ...a, url: "https://a.example/page2", loading: false } }]);
    const b = await service.open(asLuna, { owner: luna, url: "https://b.example/" });
    app.tabs.clear(); // the crash
    app.tabs.set(b.id, { ...b }); // say one survived (a restore)
    const reopened = await service.reconnect();
    expect(reopened).toEqual([a.id]);
    expect(app.tabs.get(a.id)).toMatchObject({ url: "https://a.example/page2", owner: alpha, place: "headless" });
    expect(service.tabs(person).map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
  });
});
