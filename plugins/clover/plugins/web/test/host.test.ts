// The host half (host/index.ts) over the plugin API as the daemon serves it: every call answers later, and a setting
// the daemon can't read rejects. The server still answers `initialize` and `tools/list` and nothing rejects unawaited
// (an unhandled rejection ends the worker, a crash, which took the server down at every boot); the setting, a string
// of domains, applies before each call.
import { afterEach, describe, expect, test } from "bun:test";
import { domainList, mcp, stop } from "../host/index";
import type { McpServerTransport } from "../src/server";

afterEach(() => stop("stop"));

function pair(): { transport: McpServerTransport; ask(m: Record<string, unknown>): Promise<Record<string, unknown>> } {
  const waiting = new Map<unknown, (m: Record<string, unknown>) => void>();
  const transport: McpServerTransport = {
    start: async () => {},
    close: async () => { transport.onclose?.(); },
    send: async (m) => { waiting.get(m.id)?.(m); },
  };
  return {
    transport,
    ask: (m) => new Promise((resolve) => {
      waiting.set(m.id, resolve);
      transport.onmessage?.(m);
    }),
  };
}

const unhandled: unknown[] = [];
process.on("unhandledRejection", (e) => void unhandled.push(e));

describe("the web plugin's host half", () => {
  test("a settings read the daemon refuses: the server answers initialize and tools/list, and nothing rejects unawaited", async () => {
    unhandled.length = 0;
    const { transport, ask } = pair();
    const api = {
      net: { fetch: async () => new Response("") },
      settings: { get: () => Promise.reject(Object.assign(new Error("clover/web has no setting blockedDomains"), { code: "not_found" })) },
    };
    await mcp.web(transport, api);
    const init = await ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe("clover-web");
    const list = await ask({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((list.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort()).toEqual(["WebFetch", "WebSearch"]);
    const call = await ask({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "WebFetch", arguments: { url: "https://mcp.exa.ai/x", prompt: "x" } } });
    expect(call.result).toBeDefined();
    await Bun.sleep(10);
    expect(unhandled).toEqual([]);
  });

  test("the setting's domains (a string) are blocked before each call, read again each time", async () => {
    const { transport, ask } = pair();
    let value: unknown = "";
    const fetched: string[] = [];
    const api = {
      net: { fetch: async (url: string) => { fetched.push(url); return new Response("<html><body>ok</body></html>", { headers: { "content-type": "text/html" } }); } },
      settings: { get: async () => value },
    };
    await mcp.web(transport, api);
    value = "Evil.example, other.example";
    const call = await ask({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "WebFetch", arguments: { url: "https://evil.example/page", prompt: "x" } } });
    const r = call.result as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("evil.example");
    expect(fetched).toEqual([]);
  });

  test("domainList: a string at commas or spaces, or a list; lower case, no empties", () => {
    expect(domainList("a.example,  B.example\nc.example")).toEqual(["a.example", "b.example", "c.example"]);
    expect(domainList(["x.example", 3, ""])).toEqual(["x.example"]);
    expect(domainList(undefined)).toEqual([]);
    expect(domainList("")).toEqual([]);
  });
});
