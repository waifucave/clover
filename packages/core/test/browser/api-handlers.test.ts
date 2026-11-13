import { describe, expect, test } from "bun:test";
import type { Caller } from "@waifucave/clover-protocol";
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
    const ctx = { pluginId: "clover/browser", process: "clover", caller, record: { source: "bundled" }, path } as unknown as ApiCallContext;
    return Promise.resolve().then(() => (h[path] as ApiHandler)(ctx, args)) as Promise<any>;
  };
  /** A call from the panel's own component: it reaches the api as its plugin's caller, and acts for the person. */
  const panel = (path: keyof typeof h, args: unknown[] = [], over: Partial<{ pluginId: string; process: string; caller: Caller; record: unknown }> = {}) => {
    const ctx = { pluginId: "clover/browser-view", process: "ui", caller: { kind: "plugin", pluginId: "clover/browser-view" }, record: { source: "bundled" }, path, ...over } as unknown as ApiCallContext;
    return Promise.resolve().then(() => (h[path] as ApiHandler)(ctx, args)) as Promise<any>;
  };
  return { app, service, call, panel };
}

describe("the Browser tool's browser.* calls", () => {
  test("only a session the core bound to the tool call gets anything: a plugin, the core, the user and a peer are refused", async () => {
    const { call } = setup();
    for (const caller of [{ kind: "plugin", pluginId: "clover/browser" }, { kind: "core" }, { kind: "user", client: "app" }, { kind: "peer", device: "a".repeat(20) }] as Caller[]) {
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

describe("the Clover Browser panel's browser.* calls (the person, in the panel's component)", () => {
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

  test("browser.onCdpEvent: the panel hears a followed tab's page events (Page.*) and nothing else, until it stops; the tool and every other plugin are refused", async () => {
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
    // Only the panel: the tool, another plugin, a host half, another caller; and a missing listener or tab.
    await expect(call("browser.onCdpEvent", alpha, botTab.id, () => undefined)).rejects.toThrow(/the person's|panel only/);
    await expect(panel("browser.onCdpEvent", [botTab.id, () => undefined], { pluginId: "acme/panel" })).rejects.toThrow(/panel only/);
    await expect(panel("browser.onCdpEvent", [botTab.id, () => undefined], { process: "clover" })).rejects.toThrow(/Browser tool only/);
    await expect(panel("browser.onCdpEvent", [botTab.id, () => undefined], { record: { source: "user" } })).rejects.toThrow(/panel only/);
    await expect(panel("browser.onCdpEvent", [botTab.id, "not a function"])).rejects.toThrow(/takes a listener/);
    await expect(panel("browser.onCdpEvent", ["tab_none", () => undefined])).rejects.toThrow();
  });

  test("only the bundled panel's component, for the person: not the tool, another plugin, a host half or another caller", async () => {
    const { call, panel } = setup();
    const tab = await call("browser.open", alpha, {});
    // The tool draws out of sight: where a tab shows is the person's.
    await expect(call("browser.show", alpha, tab.id, "browser", { width: 800, height: 600 })).rejects.toThrow(/the person's/);
    await expect(panel("browser.show", [tab.id, "browser", { width: 800, height: 600 }], { pluginId: "acme/panel" })).rejects.toThrow(/panel only/);
    await expect(panel("browser.tabs", [{}], { pluginId: "acme/panel" })).rejects.toThrow(/panel only/);
    await expect(panel("browser.tabs", [{}], { process: "clover" })).rejects.toThrow(/Browser tool only/);
    // A third-party component that claims the panel's id, a core caller, a session: refused. So is the panel's id from a non-bundled record.
    await expect(panel("browser.tabs", [{}], { record: { source: "user" } })).rejects.toThrow(/panel only/);
    for (const caller of [alpha, { kind: "plugin", pluginId: "acme/panel" }, { kind: "core" }, { kind: "user", client: "app" }] as Caller[]) await expect(panel("browser.tabs", [{}], { caller })).rejects.toThrow(/panel's own call/);
    // The tool's own call from a plugin that isn't the tool is refused too.
    const ctx = { pluginId: "acme/tool", process: "clover", caller: alpha, record: { source: "bundled" }, path: "browser.tabs" } as unknown as ApiCallContext;
    await expect(Promise.resolve().then(() => (browserApiHandlers(() => undefined)["browser.tabs"] as ApiHandler)(ctx, [{}]))).rejects.toThrow(/Browser tool only/);
  });

  test("DevTools from the panel passes the same nine methods", async () => {
    const { call, panel } = setup();
    const tab = await call("browser.open", alpha, {});
    await expect(panel("browser.cdp", [tab.id, "Network.getAllCookies"])).rejects.toMatchObject({ detail: { code: "method_refused" } });
  });
});

describe("through the plugin API's router (the component's `plugin.layer.api` entry)", () => {
  const records: Record<string, unknown> = {
    "clover/browser-view": { id: "clover/browser-view", enabled: true, state: "running", source: "bundled", granted: ["browser"] },
    "acme/panel": { id: "acme/panel", enabled: true, state: "running", source: "user", granted: ["browser"] },
  };
  const route = () => {
    const app = new FakeApp();
    const service = new BrowserService({ computer: "Studio", app: () => app });
    return createApiRouter({ registry: { get: (id: string) => records[id] as never }, handlers: [browserApiHandlers(() => service)] });
  };

  test("the bundled panel's component, which arrives as its plugin's caller, lists and shows; a third-party component with the same grant does not", async () => {
    const router = route();
    const ask = (pluginId: string, path: string, args: unknown[]) => router({ pluginId, process: "ui", caller: { kind: "plugin", pluginId }, path, args } as never) as Promise<any>;
    expect(await ask("clover/browser-view", "browser.tabs", [{}])).toEqual([]);
    await expect(ask("acme/panel", "browser.tabs", [{}])).rejects.toThrow(/panel only/);
    await expect(ask("clover/browser-view", "browser.watch", [() => {}])).rejects.toThrow(/events|isn't available|not served/);
  });
});
