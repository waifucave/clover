// The MCP server on lane B's in-process transport: the handshake, the tool list and its schema, the JSON-RPC errors,
// and calls that never throw out of the server.

import { describe, expect, test } from "bun:test";

import { mcp, start, stop } from "../host/index";
import { DESCRIPTION, INPUT_SCHEMA, TOOL_NAME, VERBS } from "../src/schema";
import { serveBrowser } from "../src/serve";
import { JSONRPC_ERRORS, LATEST_PROTOCOL_VERSION, serveMcp } from "../src/server";
import { ALPHA, FakeBrowser, FakeTransport, harness, tabView } from "./fakes";

describe("the handshake", () => {
  test("initialize answers with 2025-06-18, the tools capability and the server's name", async () => {
    const h = await harness();
    expect(h.transport.started).toBe(true);
    const res = await h.transport.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "clover-core", version: "1.0.0" },
    });
    expect(res.jsonrpc).toBe("2.0");
    expect(res.result).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "clover-browser", title: "Clover Browser", version: "0.0.0" },
    });
  });

  test("over the plugin host's API (every property a callable proxy), initialize still answers, with a plain version", async () => {
    // The worker's API as runtime.ts builds it: any property, at any depth, is a function that calls the daemon.
    const proxy = (): unknown => new Proxy(() => {}, { get: (_t, prop) => (prop === "then" ? undefined : proxy()), apply: () => Promise.resolve(undefined) });
    const transport = new FakeTransport();
    await serveBrowser(transport, proxy() as never);
    const res = await transport.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } });
    expect((res.result as { serverInfo: unknown }).serverInfo).toEqual({ name: "clover-browser", title: "Clover Browser", version: "0.0.0" });
    // What the plugin host's channel does to every message (`structuredClone`): it must go.
    expect(() => structuredClone(res)).not.toThrow();
    const list = await transport.request("tools/list");
    expect(() => structuredClone(list)).not.toThrow();
  });

  test("an older version the server speaks is kept; one it doesn't gets the latest", async () => {
    const h = await harness();
    const older = await h.transport.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } });
    expect((older.result as { protocolVersion: string }).protocolVersion).toBe("2025-03-26");
    const unknown = await h.transport.request("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "c", version: "1" } });
    expect((unknown.result as { protocolVersion: string }).protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  test("notifications/initialized gets no answer; ping gets an empty result", async () => {
    const h = await harness();
    h.transport.deliver({ jsonrpc: "2.0", method: "notifications/initialized" });
    await Bun.sleep(1);
    expect(h.transport.sent).toEqual([]);
    const pong = await h.transport.request("ping");
    expect(pong).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });
});

describe("tools/list", () => {
  test("lists the one Browser tool, with one schema whose verb names every verb", async () => {
    const h = await harness();
    const res = await h.transport.request("tools/list", {});
    const tools = (res.result as { tools: { name: string; description: string; inputSchema: typeof INPUT_SCHEMA; annotations: Record<string, unknown> }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual([TOOL_NAME]);
    const tool = tools[0]!;
    expect(tool.description).toBe(DESCRIPTION);
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.required).toEqual(["verb"]);
    expect(tool.inputSchema.properties.verb.enum).toEqual([...VERBS]);
    expect([...VERBS].sort()).toEqual(
      ["back", "click", "close", "forward", "key", "navigate", "open", "read", "reload", "screenshot", "scroll", "select", "tabs", "type", "wait"],
    );
    for (const field of ["tab", "url", "ref", "x", "y", "double", "text", "key", "repeat", "direction", "amount", "option", "selector", "timeoutMs"]) {
      expect(Object.keys(tool.inputSchema.properties)).toContain(field);
    }
    expect(tool.annotations.openWorldHint).toBe(true);
  });

  test("the description names every verb and stays short", () => {
    for (const verb of VERBS) expect(DESCRIPTION).toContain(verb);
    expect(DESCRIPTION.length).toBeLessThan(2500);
  });
});

describe("JSON-RPC errors", () => {
  test("an unknown method gets -32601", async () => {
    const h = await harness();
    const res = await h.transport.request("resources/list", {});
    expect((res.error as { code: number }).code).toBe(JSONRPC_ERRORS.METHOD_NOT_FOUND);
  });

  test("an unknown tool gets -32602, and a call with no name too", async () => {
    const h = await harness();
    const res = await h.transport.request("tools/call", { name: "Bash", arguments: {} });
    expect(res.error).toEqual({ code: JSONRPC_ERRORS.INVALID_PARAMS, message: "Unknown tool: Bash" });
    const nameless = await h.transport.request("tools/call", { arguments: {} });
    expect((nameless.error as { code: number }).code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
  });

  test("a request without jsonrpc 2.0, or with params that aren't an object, is refused", async () => {
    const h = await harness();
    h.transport.deliver({ jsonrpc: "1.0", id: 7, method: "ping" });
    h.transport.deliver({ jsonrpc: "2.0", id: 8, method: "ping", params: [1, 2] });
    h.transport.deliver([{ jsonrpc: "2.0", id: 9, method: "ping" }]);
    await Bun.sleep(1);
    expect(h.transport.sent).toEqual([
      { jsonrpc: "2.0", id: 7, error: { code: JSONRPC_ERRORS.INVALID_REQUEST, message: 'Invalid request: jsonrpc must be "2.0"' } },
      { jsonrpc: "2.0", id: 8, error: { code: JSONRPC_ERRORS.INVALID_PARAMS, message: "params must be an object" } },
      { jsonrpc: "2.0", id: null, error: { code: JSONRPC_ERRORS.INVALID_REQUEST, message: "Batches aren't supported" } },
    ]);
  });

  test("a response from the client is ignored", async () => {
    const h = await harness();
    h.transport.deliver({ jsonrpc: "2.0", id: 3, result: {} });
    await Bun.sleep(1);
    expect(h.transport.sent).toEqual([]);
  });
});

describe("tools/call never throws out of the server", () => {
  test("bad arguments are a tool error the model can fix", async () => {
    const h = await harness([tabView("t1", ALPHA)]);
    const r = await h.call({ verb: "fly" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("verb must be one of");
    const r2 = await h.call({ verb: "click", x: 3 });
    expect(r2.isError).toBe(true);
    expect(r2.content[0]!.text).toBe("x and y go together: give both, or neither.");
  });

  test("a tool that throws something odd still answers with isError", async () => {
    const transport = new FakeTransport();
    await serveMcp(transport, {
      info: { name: "x", version: "1" },
      tools: [{ name: "T", description: "t", inputSchema: { type: "object" } }],
      call: async () => {
        throw new Error("boom");
      },
    });
    const res = await transport.request("tools/call", { name: "T", arguments: {} });
    expect(res.result).toEqual({ content: [{ type: "text", text: "The T tool failed: boom" }], isError: true });
  });

  test("a plugin without the browser capability gets a plain refusal", async () => {
    const h = await harness([], {}, { browser: undefined });
    const r = await h.call({ verb: "tabs" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("needs the browser capability");
  });
});

describe("cancelling and closing", () => {
  test("notifications/cancelled stops a wait, and the cancelled request gets no answer", async () => {
    const h = await harness([tabView("t1", ALPHA)], { pollMs: 5 });
    h.browser.page.probe = () => ({ readyState: "complete", url: "https://example.com/", title: "x", hasText: false });
    h.as(42, { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "alpha" });
    h.transport.deliver({
      jsonrpc: "2.0", id: 42, method: "tools/call",
      params: { name: "Browser", arguments: { verb: "wait", text: "never", timeoutMs: 30_000 } },
    });
    await Bun.sleep(20);
    const probesBefore = h.browser.ops().filter((o) => o === "probe").length;
    expect(probesBefore).toBeGreaterThan(0);
    h.transport.deliver({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 42, reason: "user stopped" } });
    await Bun.sleep(30);
    const probesAfter = h.browser.ops().filter((o) => o === "probe").length;
    await Bun.sleep(30);
    expect(h.browser.ops().filter((o) => o === "probe").length).toBe(probesAfter);
    expect(h.transport.sent.some((m) => m.id === 42)).toBe(false);
  });

  test("the host half serves on a transport, and stop closes it", async () => {
    const transport = new FakeTransport();
    await start({});
    await mcp.browser!(transport, { plugin: { id: "clover/browser", namespace: "clover", version: "0.0.0", computer: "Studio" }, browser: new FakeBrowser() });
    expect(transport.started).toBe(true);
    const res = await transport.request("tools/list", {});
    expect((res.result as { tools: { name: string }[] }).tools[0]!.name).toBe("Browser");
    await stop("stop");
    expect(transport.closed).toBe(true);
  });
});
