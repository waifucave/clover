import { describe, expect, test } from "bun:test";
import type { Caller } from "@waifucave/moss-protocol";
import { BrowserService } from "../../src/browser";
import { browserApiHandlers, TOOL_CDP_METHODS } from "../../src/browser/api-handlers";
import type { ApiCallContext, ApiHandler } from "../../src/plugin-host/api/router";
import { noteCheckedHost } from "../../src/browser/checked-hosts";
import { createApiRouter } from "../../src/plugin-host/api/router";
import { FakeApp } from "./fakes";

const alpha: Caller = { kind: "session", sessionId: "s-alpha", sessionKind: "bot", bot: "alpha" };
const luna: Caller = { kind: "session", sessionId: "s-luna", sessionKind: "bot", bot: "luna" };

function setup() {
  const app = new FakeApp();
  const service = new BrowserService({ computer: "Studio", app: () => app });
  const h = browserApiHandlers(() => service);
  const call = (path: keyof typeof h, caller: Caller, ...args: unknown[]) => {
    const ctx = { pluginId: "moss/browser", process: "moss", caller, record: { source: "bundled" }, path } as unknown as ApiCallContext;
    return Promise.resolve().then(() => (h[path] as ApiHandler)(ctx, args)) as Promise<any>;
  };
  /** A call from the panel's own component: it reaches the api as its plugin's caller, and acts for the person. */
  const panel = (path: keyof typeof h, args: unknown[] = [], over: Partial<{ pluginId: string; process: string; caller: Caller; record: unknown }> = {}) => {
    const ctx = { pluginId: "moss/browser-view", process: "ui", caller: { kind: "plugin", pluginId: "moss/browser-view" }, record: { source: "bundled" }, path, ...over } as unknown as ApiCallContext;
    return Promise.resolve().then(() => (h[path] as ApiHandler)(ctx, args)) as Promise<any>;
  };
  return { app, service, call, panel };
}

describe("the Browser tool's browser.* calls", () => {
  test("only a session the core bound to the tool call gets anything: a plugin, the core, the user and a peer are refused", async () => {
    const { call } = setup();
    for (const caller of [{ kind: "plugin", pluginId: "moss/browser" }, { kind: "core" }, { kind: "user", client: "app" }, { kind: "peer", device: "a".repeat(20) }] as Caller[]) {
      for (const path of ["browser.toolCaller", "browser.tabs", "browser.open"] as const) await expect(call(path, caller)).rejects.toThrow(/session whose tool call/);
    }
  });

  test("browser.toolCaller hands over the site the approval check judged, once", async () => {
    const { call } = setup();
    noteCheckedHost("s-alpha", "example.com");
    expect(await call("browser.toolCaller", alpha)).toMatchObject({ checkedHost: "example.com" });
    expect(await call("browser.toolCaller", alpha)).not.toHaveProperty("checkedHost");
  });

  test("browser.toolCaller says the session, its kind and its bot", async () => {
    const { call } = setup();
    expect(await call("browser.toolCaller", alpha)).toEqual({ kind: "session", sessionId: "s-alpha", sessionKind: "bot", bot: "alpha" });
  });

  test("a bot's session opens its bot's tab, sees only its own, and a second open is refused with the tab's id", async () => {
    const { call } = setup();
    const tab = await call("browser.open", alpha, { url: "https://example.com/" });
    expect(tab.owner).toEqual({ kind: "bot", bot: "alpha" });
    expect((await call("browser.tabs", alpha)).map((t: { id: string }) => t.id)).toEqual([tab.id]);
    expect(await call("browser.tabs", luna)).toEqual([]);
    await expect(call("browser.open", alpha, {})).rejects.toThrow(new RegExp(`${tab.id}`));
  });

  test("another bot's tab can't be driven, and neither can the person's own browser or another owner by naming it", async () => {
    const { call } = setup();
    const tab = await call("browser.open", alpha, { url: "https://example.com/" });
    await expect(call("browser.navigate", luna, tab.id, "https://example.org/")).rejects.toThrow();
    await expect(call("browser.screenshot", luna, tab.id)).rejects.toThrow();
    await expect(call("browser.close", luna, tab.id)).rejects.toThrow();
    await expect(call("browser.open", alpha, { owner: { kind: "user" } })).rejects.toThrow(/own tabs only/);
    await expect(call("browser.tabs", alpha, { owner: { kind: "bot", bot: "luna" } })).rejects.toThrow(/own tabs only/);
    await expect(call("browser.open", luna, { owner: { kind: "bot", bot: "alpha" } })).rejects.toThrow(/own tabs only/);
  });

  test("a tab on another computer, or shown in a view, isn't the tool's to ask for", async () => {
    const { call } = setup();
    await expect(call("browser.open", alpha, { computer: "Other" })).rejects.toThrow(/this computer/);
    await expect(call("browser.tabs", alpha, { computer: "Other" })).rejects.toThrow(/this computer/);
    // This computer, named as the tool names it, is where it opens.
    expect(await call("browser.open", alpha, { computer: "Studio" })).toMatchObject({ computer: "Studio" });
    await expect(call("browser.open", alpha, { show: { view: "x", viewport: { width: 10, height: 10 } } })).rejects.toThrow(/out of sight/);
  });

  test("DevTools passes only the tool's nine methods; cookies, fetch interception and scripts on every page are refused", async () => {
    const { call, app } = setup();
    const tab = await call("browser.open", alpha, { url: "https://example.com/" });
    for (const method of ["Network.getAllCookies", "Network.getCookies", "Network.setCookie", "Network.deleteCookies", "Network.getResponseBody", "Network.setExtraHTTPHeaders", "Fetch.enable", "IO.read", "Page.addScriptToEvaluateOnNewDocument", "Page.setBypassCSP", "Page.navigate", "DOM.getDocument"]) {
      await expect(call("browser.cdp", alpha, tab.id, method, {})).rejects.toThrow(/isn't one the Browser uses/);
    }
    expect(app.commands.filter((c) => c.command.kind === "cdp")).toEqual([]);
    for (const method of TOOL_CDP_METHODS) await call("browser.cdp", alpha, tab.id, method, {});
    expect(app.commands.filter((c) => c.command.kind === "cdp").map((c) => (c.command as { method: string }).method)).toEqual([...TOOL_CDP_METHODS]);
    await expect(call("browser.cdp", luna, tab.id, "Runtime.evaluate", {})).rejects.toThrow();
  });

  test("a session without a bot has a tab of its own, and a refusal carries the browser's own code", async () => {
    const { call } = setup();
    const coding: Caller = { kind: "session", sessionId: "s-code", sessionKind: "coding" };
    const tab = await call("browser.open", coding, {});
    expect(tab.owner).toEqual({ kind: "session", session: "s-code" });
    await expect(call("browser.navigate", coding, tab.id, "file:///etc/passwd")).rejects.toMatchObject({ detail: { code: "url_refused" } });
  });
});

describe("a live view's browser.* calls (the person, in a component of a plugin holding browser)", () => {
  test("the panel lists any owner's tabs, places one in its view and takes it back, and opens one for the owner it shows", async () => {
    const { call, panel } = setup();
    const botTab = await call("browser.open", alpha, { url: "https://example.com/" });
    expect((await panel("browser.tabs", [{ owner: { kind: "bot", bot: "alpha" } }])).map((t: { id: string }) => t.id)).toEqual([botTab.id]);
    const shown = await panel("browser.show", [botTab.id, "browser", { width: 800, height: 600 }]);
    expect(shown).toMatchObject({ place: "shown", view: "browser", viewport: { width: 800, height: 600 } });
    expect(await panel("browser.hide", [botTab.id])).toMatchObject({ place: "headless" });
    // A second tab for the same bot is the person's to open (the one-tab rule is the bot's own tool's).
    const opened = await panel("browser.open", [{ owner: { kind: "bot", bot: "alpha" }, url: "https://example.org/", show: { view: "browser", viewport: { width: 700, height: 500 } } }]);
    expect(opened).toMatchObject({ owner: { kind: "bot", bot: "alpha" }, place: "shown" });
  });

  test("browser.onCdpEvent: the panel hears a followed tab's page events (Page.*) and nothing else, until it stops; a host half is refused, any component holding browser hears", async () => {
    const { app, service, call, panel } = setup();
    const botTab = await call("browser.open", alpha, { url: "https://example.com/" });
    const other = await call("browser.open", luna, { url: "https://example.org/" });
    const heard: { method: string; params: unknown }[] = [];
    const stop = await panel("browser.onCdpEvent", [botTab.id, (e: { method: string; params: unknown }) => heard.push(e)]);
    expect(typeof stop).toBe("function");
    service.report([
      { kind: "cdp", id: botTab.id, method: "Page.loadEventFired", params: { timestamp: 1 } },
      { kind: "cdp", id: other.id, method: "Page.loadEventFired", params: { timestamp: 2 } },
      { kind: "cdp", id: botTab.id, method: "Network.requestWillBeSent", params: { request: { headers: { Authorization: "secret" } } } },
      { kind: "cdp", id: botTab.id, method: "Runtime.consoleAPICalled", params: {} },
      { kind: "cdp", id: botTab.id, method: "Target.attachedToTarget", params: {} },
    ]);
    expect(heard).toEqual([{ method: "Page.loadEventFired", params: { timestamp: 1 } }]);
    stop();
    service.report([{ kind: "cdp", id: botTab.id, method: "Page.frameNavigated", params: {} }]);
    expect(heard).toHaveLength(1);
    void app;
    // Only a component (F5: any plugin's that holds browser, which the router checks): never a host half's call; and a
    // missing listener or tab.
    await expect(call("browser.onCdpEvent", alpha, botTab.id, () => undefined)).rejects.toThrow(/the person's/);
    let third = 0;
    await panel("browser.onCdpEvent", [botTab.id, () => { third++; }], { pluginId: "acme/panel", caller: { kind: "plugin", pluginId: "acme/panel" }, record: { source: "user" } });
    service.report([{ kind: "cdp", id: botTab.id, method: "Page.frameNavigated", params: {} }]);
    expect(third).toBe(1);
    await expect(panel("browser.onCdpEvent", [botTab.id, () => undefined], { process: "moss" })).rejects.toThrow(/has no tabs here/);
    await expect(panel("browser.onCdpEvent", [botTab.id, "not a function"])).rejects.toThrow(/takes a listener/);
    await expect(panel("browser.onCdpEvent", ["tab_none", () => undefined])).rejects.toThrow();
  });

  test("F5: any component of a plugin holding browser acts for the person (a live view); a host half acts only for the session it serves", async () => {
    const { call, panel } = setup();
    const tab = await call("browser.open", alpha, {});
    // The tool draws out of sight: where a tab shows is the person's.
    await expect(call("browser.show", alpha, tab.id, "browser", { width: 800, height: 600 })).rejects.toThrow(/the person's/);
    // A third party's component: the person's tabs, every owner's, and it may show one.
    const acme = { pluginId: "acme/panel", caller: { kind: "plugin", pluginId: "acme/panel" } as Caller, record: { source: "user" } };
    expect((await panel("browser.tabs", [{}], acme)).map((t: { id: string }) => t.id)).toEqual([tab.id]);
    expect(await panel("browser.show", [tab.id, "browser", { width: 800, height: 600 }], acme)).toMatchObject({ place: "shown" });
    // A host half's call made as anything but the session it serves has no tabs.
    await expect(panel("browser.tabs", [{}], { process: "moss" })).rejects.toThrow(/has no tabs here/);
    // A component's call made as another caller (a session, another plugin, the core, the user) is refused.
    for (const caller of [alpha, { kind: "plugin", pluginId: "acme/panel" }, { kind: "core" }, { kind: "user", client: "app" }] as Caller[]) await expect(panel("browser.tabs", [{}], { caller })).rejects.toThrow(/its own plugin's call/);
    // A third party's host half serving a session: that session's own tab, as the bundled tool's.
    const ctx = { pluginId: "acme/tool", process: "moss", caller: alpha, record: { source: "user" }, path: "browser.tabs" } as unknown as ApiCallContext;
    const svc = new BrowserService({ computer: "Studio", app: () => new FakeApp() });
    expect(await Promise.resolve().then(() => (browserApiHandlers(() => svc)["browser.tabs"] as ApiHandler)(ctx, [{}]))).toEqual([]);
  });

  test("DevTools from the panel passes the same nine methods", async () => {
    const { call, panel } = setup();
    const tab = await call("browser.open", alpha, {});
    await expect(panel("browser.cdp", [tab.id, "Network.getAllCookies"])).rejects.toMatchObject({ detail: { code: "method_refused" } });
  });
});

describe("through the plugin API's router (the component's `plugin.layer.api` entry)", () => {
  const records: Record<string, unknown> = {
    "moss/browser-view": { id: "moss/browser-view", enabled: true, state: "running", source: "bundled", granted: ["browser"] },
    "acme/panel": { id: "acme/panel", enabled: true, state: "running", source: "user", granted: ["browser"] },
    "acme/bare": { id: "acme/bare", enabled: true, state: "running", source: "user", granted: [] },
  };
  const route = () => {
    const app = new FakeApp();
    const service = new BrowserService({ computer: "Studio", app: () => app });
    return createApiRouter({ registry: { get: (id: string) => records[id] as never }, handlers: [browserApiHandlers(() => service)] });
  };

  test("F5: a component holding browser, bundled or third-party, lists; one without the grant is refused by the router", async () => {
    const router = route();
    const ask = (pluginId: string, path: string, args: unknown[]) => router({ pluginId, process: "ui", caller: { kind: "plugin", pluginId }, path, args } as never) as Promise<any>;
    expect(await ask("moss/browser-view", "browser.tabs", [{}])).toEqual([]);
    expect(await ask("acme/panel", "browser.tabs", [{}])).toEqual([]);
    await expect(ask("acme/bare", "browser.tabs", [{}])).rejects.toThrow();
    await expect(ask("moss/browser-view", "browser.watch", [() => {}])).rejects.toThrow(/events|isn't available|not served/);
  });
});

describe("browser-press 3: a host half's call after its tool call has ended", () => {
  test("a third party's host half reaches the session's tab inside the tool call; on a later tick, with the ended call's id or none, it is refused", async () => {
    const { apiChannel } = await import("../../src/plugin-host/api-channel");
    const { InvocationTable } = await import("../../src/plugin-host/invocations");
    const records: Record<string, unknown> = { "acme/surf": { id: "acme/surf", enabled: true, state: "running", source: "user", granted: ["browser"] } };
    const service = new BrowserService({ computer: "Studio", app: () => new FakeApp() });
    const invocations = new InvocationTable();
    const ch = apiChannel({ process: "shared", router: createApiRouter({ registry: { get: (id: string) => records[id] as never }, handlers: [browserApiHandlers(() => service)] }), invocations, deliver: () => {} });
    const api = ch.methods["pluginHost.api"]!;
    const ctx = { caller: { kind: "core" } as Caller };
    const ask = (call: string, args: unknown[], invocation?: string) => api({ pluginId: "acme/surf", callId: `c_${Math.random()}`, call, args, ...(invocation !== undefined ? { invocation } : {}) }, ctx) as Promise<{ result: any }>;
    const end = invocations.open("tool_1", { pluginId: "acme/surf", caller: alpha, session: "s-alpha" });
    const opened = (await ask("browser.open", [{ owner: { kind: "bot", bot: "alpha" } }], "tool_1")).result;
    expect(opened.owner).toEqual({ kind: "bot", bot: "alpha" });
    end();
    // A timer the plugin left behind: the ended call's id is refused, and with none it acts as itself (no tabs).
    const later = await new Promise<string[]>((resolve) => setTimeout(() => void Promise.all([
      ask("browser.tabs", [{}], "tool_1").then(() => "ran", (e: Error) => e.message),
      ask("browser.navigate", [opened.id, "https://example.org/"], "tool_1").then(() => "ran", (e: Error) => e.message),
      ask("browser.tabs", [{}]).then(() => "ran", (e: Error) => e.message),
      ask("browser.toolCaller", []).then(() => "ran", (e: Error) => e.message),
    ]).then(resolve), 5));
    expect(later[0]).toContain("has ended");
    expect(later[1]).toContain("has ended");
    expect(later[2]).toContain("has no tabs here");
    expect(later[3]).toMatch(/has no tabs here|the session whose tool call/);
  });
});
