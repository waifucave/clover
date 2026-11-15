// The acceptance run's remote MCP server (row 50: a pasted MCP URL reaches the bots): a Streamable HTTP MCP server on
// this computer's loopback, reached as `http://localhost:<port>/mcp` (a name that says it's local, so the core's pinned
// fetch may reach it). `initialize` gives a session; every request after it must carry the session. One tool,
// `HttpEcho`, answers with a mark and what it was given; the run checks the server saw the calls.

export const HTTP_MCP_MARK = "acceptance-http-mcp-pong";

export interface HttpMcpFixture {
  url: string;
  /** The JSON-RPC methods it was asked, in order (a DELETE as "DELETE"). */
  seen: string[];
  stop(): void;
}

export function httpMcpFixture(): HttpMcpFixture {
  const seen: string[] = [];
  const session = `acc-${crypto.randomUUID()}`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/mcp") return new Response("not here", { status: 404 });
      if (req.method === "DELETE") {
        seen.push("DELETE");
        return new Response(null, { status: 200 });
      }
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const m = (await req.json().catch(() => ({}))) as { id?: number | string; method?: string; params?: { arguments?: { text?: unknown } } };
      seen.push(String(m.method));
      if (m.method !== "initialize" && req.headers.get("mcp-session-id") !== session) return new Response("no session", { status: req.headers.get("mcp-session-id") ? 404 : 400 });
      if (m.id === undefined) return new Response(null, { status: 202 });
      if (m.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "acceptance-http", version: "1" } } }, { headers: { "mcp-session-id": session } });
      }
      if (m.method === "tools/list") {
        // As an event stream, as many remote servers answer.
        const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "HttpEcho", description: "Says the text back (the acceptance run's remote MCP server).", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } })}\n\n`;
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      if (m.method === "tools/call") {
        return Response.json({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `${HTTP_MCP_MARK} text=${String(m.params?.arguments?.text ?? "")}` }] } });
      }
      return Response.json({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no such method" } });
    },
  });
  return { url: `http://localhost:${server.port}/mcp`, seen, stop: () => server.stop(true) };
}
