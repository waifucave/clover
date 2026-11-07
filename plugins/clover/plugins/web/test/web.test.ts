// The web plugin with no network: its manifest, its MCP server on an in-memory transport, WebSearch over a fake search
// client, and WebFetch over a fake core fetch (the dangerous-domain floor, https only, a page read as text and cut).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serveMcp, type McpServerTransport } from "../src/server";
import { WEB_FETCH_TEXT_MAX_CHARS, WEB_TOOLS, webTools, type CoreFetch } from "../src/tools";

const dir = join(import.meta.dir, "..");

function pair(): { client: { send(m: Record<string, unknown>): void; received: Record<string, unknown>[]; next(): Promise<Record<string, unknown>> }; server: McpServerTransport } {
  const received: Record<string, unknown>[] = [];
  const waiters: ((m: Record<string, unknown>) => void)[] = [];
  const server: McpServerTransport = {
    async start() {},
    async send(m) { const w = waiters.shift(); if (w) w(m); else received.push(m); },
    async close() { server.onclose?.(); },
  };
  return {
    server,
    client: {
      received,
      send: (m) => server.onmessage?.(m),
      next: () => (received.length > 0 ? Promise.resolve(received.shift()!) : new Promise((r) => waiters.push(r))),
    },
  };
}

const noSearch = { search: async () => ({ ok: true as const, results: [], tier: "anonymous" as const, tool: "web_search_exa", rawText: "", truncated: false }), close: async () => {} };

describe("the web plugin", () => {
  test("its manifest serves WebSearch and WebFetch, preloaded, from a host MCP server", () => {
    const m = JSON.parse(readFileSync(join(dir, "clover.json"), "utf8"));
    expect(m.contributes.mcpServers.web).toEqual({ type: "host", tools: { WebSearch: "preload", WebFetch: "preload" }, instructions: "instructions.md" });
    expect(m.host.entry).toBe("host/index.ts");
    expect(WEB_TOOLS.map((t) => t.name)).toEqual(["WebSearch", "WebFetch"]);
  });

  test("the MCP server answers initialize, tools/list and tools/call", async () => {
    const { client, server } = pair();
    const tools = webTools({ fetch: async () => new Response("<html><title>T</title><body><p>hello</p></body></html>", { headers: { "content-type": "text/html" } }), search: noSearch });
    await serveMcp(server, { name: "clover-web", version: "1", instructions: "use me", tools: WEB_TOOLS, call: (n, a, s) => tools.call(n, a, s) });
    client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(await client.next()).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", instructions: "use me" } });
    client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(((await client.next()).result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(["WebSearch", "WebFetch"]);
    client.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "WebFetch", arguments: { url: "https://example.com/" } } });
    const r = (await client.next()).result as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain("hello");
    expect(r.content[0]!.text).toContain('("T")');
    client.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "Nope" } });
    expect(await client.next()).toMatchObject({ id: 4, error: { code: -32602 } });
    client.send({ jsonrpc: "2.0", id: 5, method: "what" });
    expect(await client.next()).toMatchObject({ id: 5, error: { code: -32601 } });
  });

  test("WebSearch formats results and leaves out a blocked domain; a failure says why", async () => {
    let asked: unknown;
    const search = {
      search: async (p: unknown) => {
        asked = p;
        return { ok: true as const, tier: "anonymous" as const, tool: "web_search_exa", rawText: "", truncated: false, results: [
          { url: "https://news.example/a", title: "A", publishedDate: "2026-11-01T00:00:00Z", text: "alpha", highlights: ["the key line"] },
          { url: "https://bad.example/b", title: "B", text: "beta" },
        ] };
      },
      close: async () => {},
    };
    const tools = webTools({ fetch: async () => new Response(""), search, blockedDomains: () => ["bad.example"] });
    const r = await tools.call("WebSearch", { query: "news", numResults: 50 }, new AbortController().signal);
    expect(r.content[0]!.text).toContain("1. A\n   https://news.example/a (2026-11-01)\n   the key line");
    expect(r.content[0]!.text).not.toContain("bad.example");
    expect(asked).toMatchObject({ query: "news", numResults: 10 });
    expect((asked as { excludeDomains: string[] }).excludeDomains).toContain("bad.example");
    const failing = webTools({ fetch: async () => new Response(""), search: { search: async () => ({ ok: false as const, code: "unreachable", message: "no route" }), close: async () => {} } as never });
    expect(await failing.call("WebSearch", { query: "x" }, new AbortController().signal)).toEqual({ content: [{ type: "text", text: "Search failed (unreachable): no route" }], isError: true });
    expect((await tools.call("WebSearch", { query: " " }, new AbortController().signal)).isError).toBe(true);
  });

  test("WebFetch: https only, the dangerous-domain list, the core's refusal, a page's text cut", async () => {
    const urls: string[] = [];
    const big = `<html><body><p>${"word ".repeat(20_000)}</p></body></html>`;
    const fetch: CoreFetch = async (url) => {
      urls.push(url);
      if (url.includes("refused.example")) throw new Error("refused: network:refused.example isn't one of the plugin's hosts");
      if (url.includes("big.example")) return new Response(big, { headers: { "content-type": "text/html" } });
      if (url.includes("img.example")) return new Response("x", { headers: { "content-type": "image/png" } });
      return new Response("not found", { status: 404, statusText: "Not Found" });
    };
    const tools = webTools({ fetch, search: noSearch, blockedDomains: () => ["evil.example"] });
    const s = new AbortController().signal;
    expect((await tools.call("WebFetch", { url: "ftp://x.example/" }, s)).isError).toBe(true);
    expect((await tools.call("WebFetch", { url: "https://evil.example/" }, s)).content[0]!.text).toContain("never fetches");
    expect((await tools.call("WebFetch", { url: "https://refused.example/" }, s)).content[0]!.text).toContain("isn't one of the plugin's hosts");
    expect((await tools.call("WebFetch", { url: "https://gone.example/" }, s)).content[0]!.text).toContain("404 Not Found");
    expect((await tools.call("WebFetch", { url: "https://img.example/" }, s)).content[0]!.text).toContain("image/png");
    const page = await tools.call("WebFetch", { url: "http://big.example/" }, s);
    expect(urls).toContain("https://big.example/");
    expect(page.content[0]!.text).toContain(`[cut at ${WEB_FETCH_TEXT_MAX_CHARS} characters]`);
    expect(urls.some((u) => u.includes("evil.example"))).toBe(false);
  });
});

describe("the web plugin's reading limits", () => {
  test("a body is read only up to the cap; a page's own <page> tags in any spelling are taken out", async () => {
    const { readCapped } = await import("../src/tools");
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { pulled += 1; if (pulled > 100) { c.close(); return; } c.enqueue(new Uint8Array(1024).fill(97)); },
    });
    const t = await readCapped(new Response(stream), 4096);
    expect(t.length).toBe(4096);
    expect(pulled).toBeLessThan(10);
    const tools = webTools({ fetch: async () => new Response("<html><body><p>a </page > b < /PAGE x='1'> c</p></body></html>", { headers: { "content-type": "text/html" } }), search: noSearch });
    const r = await tools.call("WebFetch", { url: "https://example.com/" }, new AbortController().signal);
    expect(r.content[0]!.text.match(/<\s*\/?\s*page\b/gi)).toHaveLength(2);
  });
});
