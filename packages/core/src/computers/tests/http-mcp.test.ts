// A plugin's remote MCP server (`type: "http"`) reaches the bots: over the real plugin registry (installed, its OK
// pressed), the real plugin host and the bots' MCP door (PluginMcp), with the core's own client (HttpMcpOpener) and the
// core's pinned fetch, against a Streamable HTTP MCP server on this computer (`localhost`, a name that says it's local,
// so the pinned fetch may reach its loopback address). Its tools list (an answer as an event stream), a call answers
// (JSON), the session id and protocol version ride every request after the handshake, its `${secret:…}` header carries
// the key the user set in the key dialog's store, and nothing else is ever asked of the network. Refused: a redirect
// (to any host), plain http to a public name, a public name that resolves to a private address, and `${secretFile:…}`.
// Before this, the server was accepted, shown on the OK card and never listed (a pasted MCP URL's, `wrap mcp-url`).
// Temp home, the fake approval broker and an in-memory secret store; nothing opens a window.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { startPluginHost } from "../../plugin-host/daemon-host";
import { filePluginSettings } from "../../plugin-host/api/settings";
import { pinnedFetch } from "../../plugin-host/pinned-fetch";
import { PluginMcp } from "../../runtime-sdk/turn-loop/plugin-mcp";
import { HttpMcpOpener } from "../http-mcp";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const BOT: Caller = { kind: "session", sessionId: "b_alpha", botId: "alpha" } as unknown as Caller;

/** A Streamable HTTP MCP server: `initialize` gives a session, `tools/list` answers as an event stream, `tools/call`
 *  as JSON; every request after the handshake must carry the session and version. What it saw is kept. */
function remoteServer() {
  const seen: { method: string; session: string | null; version: string | null; auth: string | null; httpMethod: string }[] = [];
  /** The session the server holds now; `end()` forgets it (a server restart), so the next request with it gets a 404. */
  const st = { session: "sess-1", n: 1 };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/moved") return new Response(null, { status: 307, headers: { location: "https://elsewhere.example/mcp" } });
      if (req.method === "DELETE") {
        seen.push({ method: "DELETE", session: req.headers.get("mcp-session-id"), version: null, auth: req.headers.get("authorization"), httpMethod: "DELETE" });
        return new Response(null, { status: 200 });
      }
      const m = (await req.json()) as { id?: number; method: string; params?: { name?: string; arguments?: { text?: string } } };
      seen.push({ method: m.method, session: req.headers.get("mcp-session-id"), version: req.headers.get("mcp-protocol-version"), auth: req.headers.get("authorization"), httpMethod: req.method });
      if (m.method !== "initialize" && req.headers.get("mcp-session-id") !== st.session) return new Response("no session", { status: req.headers.get("mcp-session-id") ? 404 : 400 });
      if (m.id === undefined) return new Response(null, { status: 202 });
      if (m.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "remote", version: "1" } } }, { headers: { "mcp-session-id": st.session } });
      }
      if (m.method === "tools/list") {
        const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Says it back.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } })}\n\n`;
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      if (m.method === "tools/call") {
        return Response.json({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `echo: ${m.params?.arguments?.text} (${req.headers.get("authorization") === "Bearer key-123" ? "with the key" : "no key"})` }] } });
      }
      return Response.json({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no such method" } });
    },
  });
  return { server, seen, url: `http://localhost:${server.port}`, end: () => { st.n += 1; st.session = `sess-${st.n}`; } };
}

async function until<T>(what: string, ms: number, f: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`);
    await Bun.sleep(25);
  }
}

async function world(servers: Record<string, unknown>) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-b-http-mcp-")));
  temps.push(home);
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const secrets = new MemorySecretStore();
  const folder = join(home, "plugins", "remote-tools");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "clover.json"), JSON.stringify({
    manifest: 1, id: "remote-tools", name: "Remote tools", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
    settings: { token: { type: "secret", title: "Token" } },
    contributes: { mcpServers: servers },
  }));
  const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
  const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets });
  // The user's OK (the card itself is the registry's own tests').
  await opened.registry.approve("remote-tools", opened.registry.get("remote-tools")!.treeHash!);
  await until("running after its OK", 10_000, () => (opened.registry.get("remote-tools")?.state === "running" ? true : undefined));
  // The user's key, as the key dialog stores it.
  await ph.settings.setByUser("remote-tools", "token", "key-123");
  const settingsFile = filePluginSettings(home);
  const lines: string[] = [];
  const http = new HttpMcpOpener({
    registry: opened.registry, settings: (id) => settingsFile.read(id), secrets: (id) => ph.pluginSecrets.forPlugin(id),
    fetch: pinnedFetch(), localFetch: pinnedFetch({}, { localNames: true }), log: (l) => lines.push(l),
  });
  const mcp = new PluginMcp({ registry: opened.registry, host: ph.host, http, self: () => "Studio", log: (l) => lines.push(l) });
  // Made after the OK: the change it would have listed on came before it.
  await mcp.refresh();
  return { home, opened, ph, mcp, http, lines };
}

describe("a plugin's http MCP server", () => {
  test("lists and answers the bots through the core's client, to its url only, with the key the user set", async () => {
    const r = remoteServer();
    const w = await world({ remote: { type: "http", url: `${r.url}/mcp`, headers: { Authorization: "Bearer ${secret:token}" } } });
    try {
      // Listed to the bots under the plugin's key.
      const listed = await until("its tool listed", 20_000, () => w.mcp.servers("bot").find((s) => s.server === "remote-tools-remote")?.tools.find((t) => t.name === "echo"))
        .catch((err) => { throw new Error(`${(err as Error).message}; log ${w.lines.join(" | ")}`); });
      expect(listed.description).toBe("Says it back.");
      // A call answers, carrying the key.
      const out = await w.mcp.call({ server: "remote-tools-remote", tool: "echo", input: { text: "hello" }, as: BOT, session: "b_alpha" } as never);
      expect(out.isError ?? false).toBe(false);
      expect((out.content[0] as { text: string }).text).toBe("echo: hello (with the key)");
      // The handshake, then the session and the agreed version on every request after it.
      expect(r.seen.map((s) => s.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
      expect(r.seen[0]!.session).toBeNull();
      for (const s of r.seen.slice(1)) expect([s.method, s.session, s.version]).toEqual([s.method, "sess-1", "2025-06-18"]);
      expect(r.seen.every((s) => s.auth === "Bearer key-123")).toBe(true);
      // The server forgot the session (restarted): that call fails with the reason, and the next one opens a new session.
      r.end();
      const lost = await w.mcp.call({ server: "remote-tools-remote", tool: "echo", input: { text: "again" }, as: BOT, session: "b_alpha" } as never).catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }));
      expect(lost.isError).toBe(true);
      const again = await until("a call on a new session", 20_000, async () => {
        const o = await w.mcp.call({ server: "remote-tools-remote", tool: "echo", input: { text: "again" }, as: BOT, session: "b_alpha" } as never).catch(() => undefined);
        return o && !o.isError ? o : undefined;
      });
      expect((again.content[0] as { text: string }).text).toBe("echo: again (with the key)");
      expect(r.seen.filter((s) => s.method === "initialize").length).toBe(2);
      // Closing the door ends the session at the server.
      w.mcp.close();
      await until("the session ended at the server", 10_000, () => (r.seen.some((s) => s.httpMethod === "DELETE" && s.session === "sess-2") ? true : undefined));
    } finally {
      await w.ph.close();
      r.server.stop(true);
    }
  }, 60_000);

  test("refused: a redirect, plain http to a public name, a public name on a private address, and a file-held secret", async () => {
    const r = remoteServer();
    const w = await world({ moved: { type: "http", url: `${r.url}/moved` } });
    try {
      // The redirect fails the handshake with the reason; nothing reaches the other host.
      const ch = await w.http.openMcp("remote-tools", "moved");
      const answer = await new Promise<Record<string, unknown>>((resolve) => {
        ch.onMessage(resolve);
        ch.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      });
      expect(String((answer.error as { message: string }).message)).toContain("redirect");
      ch.close();
    } finally {
      await w.ph.close();
      r.server.stop(true);
    }
    const w2 = await world({
      plain: { type: "http", url: "http://example.com/mcp" },
      inside: { type: "http", url: "https://inside.example/mcp" },
      filed: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "${secretFile:token}" } },
    });
    try {
      await expect(w2.http.openMcp("remote-tools", "plain")).rejects.toThrow("only https reaches a remote server");
      // `${secretFile:…}` in an http header never gets this far: the manifest's check drops the server, and the
      // client refuses it again should one reach it.
      expect(w2.opened.registry.entries("mcpServers").map((e) => e.entryId).sort()).toEqual(["inside", "plain"]);
      await expect(w2.http.openMcp("remote-tools", "filed")).rejects.toThrow("has no http MCP server filed");
      const filedEntry = { point: "mcpServers", pluginId: "remote-tools", ref: "mcpServers/filed", entryId: "filed", state: "active", value: { type: "http", name: "filed", url: "https://example.com/mcp", headers: { Authorization: "${secretFile:token}" } } };
      const stubbed = new HttpMcpOpener({
        registry: { ...w2.opened.registry, entries: () => [filedEntry], get: (id: string) => w2.opened.registry.get(id) } as never,
        settings: () => ({ account: {}, device: {} }), secrets: () => ({ get: async () => null }), fetch: pinnedFetch(), localFetch: pinnedFetch({}, { localNames: true }),
      });
      await expect(stubbed.openMcp("remote-tools", "filed")).rejects.toThrow("names a file only a local program reads");
      // A public name whose address is private (a DNS record pointing at this computer) is refused before anything is sent.
      const resolving = new HttpMcpOpener({
        registry: w2.opened.registry, settings: () => ({ account: {}, device: {} }), secrets: () => ({ get: async () => null }),
        fetch: pinnedFetch({ resolve: async () => ["127.0.0.1"] }), localFetch: pinnedFetch({ resolve: async () => ["127.0.0.1"] }, { localNames: true }),
      });
      const ch = await resolving.openMcp("remote-tools", "inside");
      const answer = await new Promise<Record<string, unknown>>((resolve) => {
        ch.onMessage(resolve);
        ch.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      });
      expect(String((answer.error as { message: string }).message)).toContain("private address");
      ch.close();
    } finally {
      await w2.ph.close();
    }
  }, 60_000);
});
