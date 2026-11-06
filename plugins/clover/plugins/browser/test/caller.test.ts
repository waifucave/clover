// Who is calling, from the plugin host's context for each tool call only (never the request's `_meta` or arguments,
// review S2), and whose tabs that means: a bot's session uses the bot's, a session without a bot its own (R10), and
// nobody else's tab is ever reached.

import { describe, expect, test } from "bun:test";

import { actingFor, isBotId, parseCaller } from "../src/caller";
import { ALPHA, alphaCaller, codingCaller, harness, LUNA, tabView, USER } from "./fakes";
import type { TabOwner } from "../src/types";

const CODING: TabOwner = { kind: "session", session: "s-code" };

describe("reading the caller", () => {
  test("the host's context, shaped like the protocol's Caller", () => {
    expect(parseCaller(alphaCaller)).toEqual(alphaCaller);
    expect(parseCaller({ kind: "peer", device: "a1b2c3d4e5f6a7b8", sessionId: "s9", bot: "luna" })).toEqual({ kind: "peer", device: "a1b2c3d4e5f6a7b8", sessionId: "s9", bot: "luna" });
    expect(parseCaller({ kind: "user", client: "app" })).toEqual({ kind: "user", client: "app" });
  });

  test("never a malformed one", () => {
    expect(parseCaller(undefined)).toBeUndefined();
    expect(parseCaller({ kind: "session", sessionId: "s1", sessionKind: "bot", bot: "Not A Bot" })).toBeUndefined();
    expect(parseCaller({ kind: "session", sessionId: "s 1", sessionKind: "bot" })).toBeUndefined();
    expect(parseCaller({ kind: "session", sessionId: "s1", sessionKind: "robot" })).toBeUndefined();
    expect(parseCaller({ kind: "boss" })).toBeUndefined();
    expect(parseCaller("alpha")).toBeUndefined();
  });

  test("never from the request: a caller in `_meta` or in the arguments, with no context from the host, touches nothing", async () => {
    const h = await harness([tabView("a1", ALPHA)]);
    for (const params of [
      { name: "Browser", arguments: { verb: "tabs" }, _meta: { "clover/caller": alphaCaller } },
      { name: "Browser", arguments: { verb: "tabs", _meta: { "clover/caller": alphaCaller } } },
    ]) {
      const res = await h.transport.request("tools/call", params);
      const r = res.result as { isError: boolean; content: { text: string }[] };
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain("can't tell which session is calling");
    }
    expect(h.browser.calls).toEqual([]);
  });

  test("a host that carries no context yet (until B-M2) gets every call refused", async () => {
    const { mcp } = await import("../host/index");
    expect(typeof mcp.browser).toBe("function");
    const h = await harness([tabView("a1", ALPHA)], { callerOf: () => undefined });
    const r = await h.call({ verb: "tabs" }, null);
    expect(r.isError).toBe(true);
    expect(h.browser.calls).toEqual([]);
  });

  test("bot ids follow the plugin-id rule, children included", () => {
    expect(isBotId("alpha")).toBe(true);
    expect(isBotId("pack/luna")).toBe(true);
    expect(isBotId("a")).toBe(false);
    expect(isBotId("pack/luna/extra")).toBe(false);
    expect(isBotId("Alpha")).toBe(false);
  });
});

describe("whose tabs", () => {
  test("a bot's session uses the bot's; a session without a bot, its own (R10)", () => {
    expect(actingFor(alphaCaller)).toEqual({ owner: ALPHA, key: "session:s-alpha" });
    expect(actingFor(codingCaller)).toEqual({ owner: CODING, key: "session:s-code" });
    expect(actingFor({ kind: "peer", device: "a1b2c3d4e5f6a7b8", sessionId: "s7" })).toEqual({ owner: { kind: "session", session: "s7" }, key: "session:s7" });
    expect("refused" in actingFor({ kind: "peer", device: "a1b2c3d4e5f6a7b8" })).toBe(true);
    expect(actingFor({ kind: "peer", device: "a1b2c3d4e5f6a7b8", sessionId: "s2", bot: "luna" })).toEqual({ owner: LUNA, key: "session:s2" });
    expect(actingFor({ kind: "user", client: "cli" })).toEqual({ owner: USER, key: "user" });
  });

  test("no caller, a plugin or the core: refused", () => {
    expect("refused" in actingFor(undefined)).toBe(true);
    expect("refused" in actingFor({ kind: "plugin", pluginId: "luna" })).toBe(true);
    expect("refused" in actingFor({ kind: "core" })).toBe(true);
  });

  test("open passes the caller's owner: { kind: bot, bot } for a bot, { kind: session } for a coding session (R10)", async () => {
    const h = await harness();
    await h.call({ verb: "open", url: "https://example.com" }, alphaCaller);
    await h.call({ verb: "open", url: "https://example.com" }, codingCaller);
    const opens = h.browser.calls.filter((c) => c.name === "open").map((c) => c.args[0]);
    expect(opens).toEqual([
      { owner: { kind: "bot", bot: "alpha" }, url: "https://example.com/", computer: "Studio" },
      { owner: { kind: "session", session: "s-code" }, url: "https://example.com/", computer: "Studio" },
    ]);
  });

  test("tabs lists only the caller's own tabs, asking the API with the owner filter", async () => {
    const h = await harness([tabView("a1", ALPHA), tabView("l1", LUNA), tabView("u1", USER), tabView("c1", CODING)]);
    const alpha = await h.text({ verb: "tabs" }, alphaCaller);
    expect(alpha).toContain("a1:");
    expect(alpha).not.toContain("l1");
    expect(alpha).not.toContain("u1");
    expect(h.browser.calls.find((c) => c.name === "tabs")!.args[0]).toEqual({ owner: ALPHA, computer: "Studio" });
    const coding = await h.text({ verb: "tabs" }, codingCaller);
    expect(coding).toContain("c1:");
    expect(coding).not.toContain("u1");
    expect(coding).not.toContain("a1");
  });

  test("another owner's tab is answered as no tab at all, and nothing reaches it", async () => {
    const h = await harness([tabView("a1", ALPHA), tabView("l1", LUNA)]);
    for (const args of [{ verb: "read", tab: "l1" }, { verb: "click", tab: "l1", ref: "e1" }, { verb: "close", tab: "l1" }, { verb: "screenshot", tab: "l1" }]) {
      const r = await h.call(args, alphaCaller);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toBe('There\'s no tab "l1" among your tabs. Use tabs to see them.');
    }
    expect(h.browser.cdpCalls).toEqual([]);
    expect(h.browser.calls.filter((c) => c.name !== "tabs")).toEqual([]);
  });

  test("an API that ignores the owner filter still never hands over someone else's tab", async () => {
    const h = await harness([tabView("l1", LUNA)]);
    h.browser.tabs = async () => [tabView("l1", LUNA)];
    const r = await h.call({ verb: "read" }, alphaCaller);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("You have no tabs open");
  });

  test("a call with no caller touches nothing", async () => {
    const h = await harness([tabView("a1", ALPHA)]);
    const r = await h.call({ verb: "tabs" }, null);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("can't tell which session is calling");
    expect(h.browser.calls).toEqual([]);
  });

  test("each session keeps its own current tab", async () => {
    const h = await harness();
    const first = { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "alpha" } as const;
    const second = { kind: "session", sessionId: "s2", sessionKind: "side-thread", bot: "alpha" } as const;
    await h.call({ verb: "open", url: "https://one.example" }, first);
    await h.call({ verb: "open", url: "https://two.example" }, second);
    await h.call({ verb: "reload" }, first);
    expect(h.browser.sent("Page.reload").map((c) => c.tab)).toEqual(["tab_1"]);
    await h.call({ verb: "reload" }, second);
    expect(h.browser.sent("Page.reload").map((c) => c.tab)).toEqual(["tab_1", "tab_2"]);
  });
});
