import { describe, expect, test } from "bun:test";
import type { Caller } from "@waifucave/clover-protocol";
import { BrowserService } from "../../src/browser";
import { browserApiHandlers, TOOL_CDP_METHODS } from "../../src/browser/api-handlers";
import type { ApiCallContext, ApiHandler } from "../../src/plugin-host/api/router";
import { FakeApp } from "./fakes";

const alpha: Caller = { kind: "session", sessionId: "s-alpha", sessionKind: "bot", bot: "alpha" };
const luna: Caller = { kind: "session", sessionId: "s-luna", sessionKind: "bot", bot: "luna" };

function setup() {
  const app = new FakeApp();
  const service = new BrowserService({ computer: "Studio", app: () => app });
  const h = browserApiHandlers(() => service);
  const call = (path: keyof typeof h, caller: Caller, ...args: unknown[]) => {
    const ctx = { pluginId: "clover/browser", process: "clover", caller, record: {}, path } as unknown as ApiCallContext;
    return Promise.resolve().then(() => (h[path] as ApiHandler)(ctx, args)) as Promise<any>;
  };
  return { app, service, call };
}

describe("the Browser tool's browser.* calls", () => {
  test("only a session the core bound to the tool call gets anything: a plugin, the core, the user and a peer are refused", async () => {
    const { call } = setup();
    for (const caller of [{ kind: "plugin", pluginId: "clover/browser" }, { kind: "core" }, { kind: "user", client: "app" }, { kind: "peer", device: "a".repeat(20) }] as Caller[]) {
      for (const path of ["browser.toolCaller", "browser.tabs", "browser.open"] as const) await expect(call(path, caller)).rejects.toThrow(/session whose tool call/);
    }
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
      await expect(call("browser.cdp", alpha, tab.id, method, {})).rejects.toThrow(/isn't one the Browser tool uses/);
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
