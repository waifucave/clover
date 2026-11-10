// The acceptance run's search backend: Exa's MCP server as the bundled web plugin's WebSearch speaks to it
// (`@waifucave/clover-web`'s `createExaMcpHttpTransport`: JSON-RPC 2.0 over Streamable HTTP, POSTs to /mcp with JSON
// replies, `initialize`, `notifications/initialized`, `tools/call` of `web_search_exa`, a `DELETE` to close). It
// runs inside the daemon, behind the plugins' keyed fetch's test seam (`startDaemon`'s `pluginFetch`), so nothing
// leaves the machine: the seam serves only `mcp.exa.ai`, from here, and refuses every other host.
import type { PinnedFetchSeam } from "../../packages/core/src/plugin-host/pinned-fetch";

/** What the fake answers a search with: one result whose text the run looks for. */
export const FAKE_SEARCH_HIT = "ACCEPTANCE-SEARCH-HIT";
export const FAKE_SEARCH_HOST = "mcp.exa.ai";
export const FAKE_PAGE_TEXT = "ACCEPTANCE-PAGE-TEXT";
/** A public website for WebFetch (`network:public`): one article, served by the seam. */
export const FAKE_PUBLIC_SITE = "news.acceptance-site.com";
export const FAKE_ARTICLE_TEXT = "ACCEPTANCE-ARTICLE-TEXT";
/** A name that resolves to a private address: the pinned fetch refuses it before any request. */
export const FAKE_PRIVATE_SITE = "intranet.acceptance-site.com";

export interface FakeExa {
  /** The tool calls it answered, by tool name. */
  readonly calls: string[];
  handle(req: Request): Promise<Response>;
}

export function fakeExa(): FakeExa {
  const calls: string[] = [];
  return {
    calls,
    async handle(req) {
      if (req.method === "DELETE") return new Response(null, { status: 204 });
      // A page for WebFetch (the web plugin reaches only its `network:` host, this one).
      if (req.method === "GET" && new URL(req.url).pathname === "/acceptance-page") {
        calls.push("GET /acceptance-page");
        return new Response(`<html><head><title>Acceptance page</title></head><body><p>${FAKE_PAGE_TEXT}</p></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (req.method !== "POST" || new URL(req.url).pathname !== "/mcp") return new Response("not here", { status: 404 });
      let m: { id?: unknown; method?: unknown; params?: { name?: unknown } };
      try {
        m = (await req.json()) as typeof m;
      } catch {
        return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
      }
      const headers = { "mcp-session-id": "acceptance-session" };
      if (m.id === undefined) return new Response(null, { status: 202, headers });
      if (m.method === "initialize") return Response.json({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-exa", version: "1" } } }, { headers });
      if (m.method === "tools/call") {
        calls.push(String(m.params?.name ?? ""));
        const text = JSON.stringify({ results: [{ title: "The acceptance result", url: "https://example.com/acceptance", publishedDate: "2026-11-10", highlights: [`${FAKE_SEARCH_HIT}: what the run looked for`] }] });
        return Response.json({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }] } }, { headers });
      }
      return Response.json({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `unknown method ${String(m.method)}` } }, { headers });
    },
  };
}

/** The keyed fetch's test seam for a run: `mcp.exa.ai` answered by `exa`, the fake public site's article answered
 *  here, every other host refused and reported (the run fails on any). The resolver answers every name with one public
 *  address that nothing connects to, so each request reaches the seam's fetch, which decides by the name; the private
 *  site's name resolves to a private address, which the pinned fetch refuses before the seam is asked. */
export function searchOnlySeam(exa: FakeExa, refused: (host: string) => void): PinnedFetchSeam {
  return {
    resolve: async (name) => (name === FAKE_PRIVATE_SITE ? ["10.0.0.5"] : ["93.184.216.34"]),
    fetch: async (url, init) => {
      const host = (new Headers(init.headers).get("host") ?? new URL(url).host).toLowerCase();
      if (host === FAKE_PUBLIC_SITE) {
        const path = new URL(url).pathname;
        return path === "/article"
          ? new Response(`<html><head><title>Acceptance article</title></head><body><p>${FAKE_ARTICLE_TEXT}</p></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } })
          : new Response("not here", { status: 404 });
      }
      if (host !== FAKE_SEARCH_HOST) {
        refused(host);
        throw new Error(`the acceptance run reaches no network: ${host}`);
      }
      const target = new URL(url);
      target.host = FAKE_SEARCH_HOST;
      target.protocol = "https:";
      return exa.handle(new Request(target, { method: init.method, headers: init.headers, body: init.body ?? null, ...(init.body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit));
    },
  };
}
