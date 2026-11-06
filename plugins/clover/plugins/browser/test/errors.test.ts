// What the browser API refuses (a held tab, a refused URL or method, a stalled tab) comes back as a tool error in plain
// words, never as a thrown error or a JSON-RPC error.

import { describe, expect, test } from "bun:test";

import { describeError, errorCode, HELD_SENTENCE, ToolFailure } from "../src/errors";
import { ALPHA, apiError, harness, tabView } from "./fakes";

const one = () => [tabView("t1", ALPHA)];

describe("API errors become tool errors", () => {
  test("a held tab: refused before anything is sent, except a look", async () => {
    const h = await harness([tabView("t1", ALPHA, { heldByUser: true })]);
    for (const args of [
      { verb: "click", ref: "e1" }, { verb: "type", text: "x" }, { verb: "navigate", url: "https://example.org" }, { verb: "read" },
      { verb: "key", key: "Enter" }, { verb: "scroll", direction: "down" }, { verb: "close", tab: "t1" }, { verb: "reload" },
    ]) {
      const r = await h.call(args);
      expect([args.verb, r.isError, r.content[0]!.text]).toEqual([args.verb, true, HELD_SENTENCE]);
    }
    expect(h.browser.cdpCalls).toEqual([]);
    expect((await h.call({ verb: "screenshot" })).isError).toBeUndefined();
  });

  test("a tab the person took after the tool looked: the core's refusal reads the same", async () => {
    const h = await harness(one());
    h.browser.failures.set("navigate", apiError("held", "the person is using this tab in the browser view"));
    const r = await h.call({ verb: "navigate", url: "https://example.org" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe(HELD_SENTENCE);
  });

  test("a stalled tab's screenshot", async () => {
    const h = await harness(one());
    h.browser.failures.set("screenshot", apiError("stalled", "the tab stopped drawing 12 s ago"));
    const r = await h.call({ verb: "screenshot" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("The tab has stopped drawing, so there's no fresh picture of it. Try again in a moment, or reload it.");
  });

  test("a refused URL, a refused method, the app gone", async () => {
    const h = await harness(one());
    h.browser.failures.set("open", apiError("url_refused", "the browser doesn't open that"));
    expect((await h.call({ verb: "open", url: "https://example.org" })).content[0]!.text).toContain("doesn't open that address");
    h.browser.failures.set("cdp:Page.reload", apiError("method_refused", "Page.reload isn't allowed"));
    expect((await h.call({ verb: "reload" })).content[0]!.text).toBe("The browser refused the reload: Page.reload isn't allowed");
    h.browser.failures.set("tabs", apiError("no_app", "the Clover app isn't running"));
    expect((await h.call({ verb: "tabs" })).content[0]!.text).toContain("The Clover app isn't running on this computer");
  });

  test("a code arriving as JSON-RPC error data, and an error with no code", async () => {
    const h = await harness(one());
    h.browser.failures.set("cdp:Page.reload", Object.assign(new Error("refused"), { code: -32000, data: { code: "point_stale" } }));
    expect((await h.call({ verb: "reload" })).content[0]!.text).toContain("Take a new screenshot");
    h.browser.failures.set("cdp:Page.reload", new Error("socket hung up"));
    expect((await h.call({ verb: "reload" })).content[0]!.text).toBe("The browser couldn't reload: socket hung up");
    h.browser.failures.set("cdp:Page.reload", "a bare string");
    expect((await h.call({ verb: "reload" })).content[0]!.text).toBe("The browser couldn't reload: a bare string");
  });

  test("whatever is thrown, the server answers the request with a result", async () => {
    const h = await harness(one());
    h.browser.failures.set("tabs", { weird: "object" });
    h.as("whatever", { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "alpha" });
    const res = await h.transport.request("tools/call", { name: "Browser", arguments: { verb: "read" } }, "whatever");
    expect(res.error).toBeUndefined();
    expect((res.result as { isError: boolean }).isError).toBe(true);
  });
});

describe("the wording", () => {
  test("errorCode reads a string code or data.code, nothing else", () => {
    expect(errorCode(apiError("held"))).toBe("held");
    expect(errorCode({ code: 5, data: { code: "stalled" } })).toBe("stalled");
    expect(errorCode({ code: 5 })).toBeUndefined();
    expect(errorCode("held")).toBeUndefined();
  });

  test("the tool's own refusals pass through as they are", () => {
    expect(describeError(new ToolFailure("Exactly this."), "click")).toBe("Exactly this.");
  });
});
