#!/usr/bin/env bun
// MCP stub over Streamable HTTP (legacy era: an `initialize` handshake, an
// `Mcp-Session-Id`, JSON responses, no server-sent stream). It logs every HTTP request it
// gets: method, path, headers (Authorization by hash only) and the JSON-RPC body.
//
// As a module: `startHttpStub(...)` (the probe runs it in-process). Standalone:
//   bun src/mcp/http-stub.ts --log /abs/mcp-http.ndjson [--port 8787]
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { handleMcp, type JsonRpcMessage, type StubConfig } from "./handler.ts";
import { Redactor, sha12 } from "../util/log.ts";

export interface HttpStubOptions {
  logFile: string;
  port?: number; // 0 or undefined: any free port
  expectedToken?: string; // the bearer token the probe passed in `headers`
  redactor?: Redactor;
}

export interface HttpStub {
  url: string;
  stop(): void;
}

export function startHttpStub(cfg: StubConfig, opts: HttpStubOptions): HttpStub {
  const redactor = opts.redactor ?? new Redactor();
  if (opts.expectedToken) redactor.add(opts.expectedToken, "bridge-token");
  const t0 = Date.now();
  const sessions = new Set<string>();
  const log = (record: Record<string, unknown>) =>
    appendFileSync(opts.logFile, JSON.stringify({ ms: Date.now() - t0, ...(redactor.scrub(record) as object) }) + "\n");

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      const headers = Object.fromEntries(req.headers.entries());
      const auth = req.headers.get("authorization");
      const authCheck = !auth
        ? "missing"
        : opts.expectedToken && auth === `Bearer ${opts.expectedToken}`
          ? "match"
          : `mismatch sha256=${sha12(auth)}`;
      const sid = req.headers.get("mcp-session-id");
      const base = {
        kind: "http",
        method: req.method,
        path: url.pathname,
        headers,
        authCheck,
        session: sid ? (sessions.has(sid) ? "known" : "unknown") : "none",
      };

      if (url.pathname !== "/mcp") {
        log({ ...base, status: 404 });
        return new Response("not found", { status: 404 });
      }
      if (req.method === "GET") {
        log({ ...base, status: 405 });
        return new Response("no server-sent stream", { status: 405, headers: { Allow: "POST, DELETE" } });
      }
      if (req.method === "DELETE") {
        if (sid) sessions.delete(sid);
        log({ ...base, status: 200 });
        return new Response(null, { status: 200 });
      }
      if (req.method !== "POST") {
        log({ ...base, status: 405 });
        return new Response("method not allowed", { status: 405 });
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        log({ ...base, status: 400, error: "bad json" });
        return new Response("bad json", { status: 400 });
      }
      const messages = (Array.isArray(body) ? body : [body]) as JsonRpcMessage[];
      const responses: JsonRpcMessage[] = [];
      const notes: string[] = [];
      let newSession: string | undefined;
      let legacyProbe = false;
      for (const m of messages) {
        const { response, note } = handleMcp(cfg, m);
        if (note) notes.push(note);
        if (m.method === "server/discover") legacyProbe = true;
        if (m.method === "initialize" && response && !response.error) newSession = randomUUID();
        if (response) responses.push(response);
      }
      if (legacyProbe) {
        // MCP 2026-07-28: a dual-era client falls back to `initialize` on a 4xx without a modern error body.
        log({ ...base, status: 400, notes, body });
        return Response.json(responses.length === 1 ? responses[0] : responses, { status: 400 });
      }
      if (newSession) sessions.add(newSession);
      const status = responses.length ? 200 : 202;
      log({ ...base, status, notes, body, newSession: newSession ? "issued" : undefined });
      if (!responses.length) return new Response(null, { status: 202 });
      const out = Array.isArray(body) ? responses : responses[0];
      return Response.json(out, { status: 200, headers: newSession ? { "Mcp-Session-Id": newSession } : {} });
    },
  });

  log({ kind: "start", server: cfg.serverName, url: `http://127.0.0.1:${server.port}/mcp` });
  return { url: `http://127.0.0.1:${server.port}/mcp`, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const argv = process.argv;
  const get = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const logFile = get("log");
  if (!logFile) {
    console.error("http-stub: missing --log");
    process.exit(2);
  }
  const stub = startHttpStub(
    {
      serverName: get("name") ?? "s5-http",
      toolName: get("tool") ?? "s5_http_echo",
      nonce: process.env.S5_NONCE ?? "no-nonce",
      instructionWord: process.env.S5_INSTRUCTION_WORD ?? "no-word",
    },
    { logFile, port: Number(get("port") ?? 0), expectedToken: process.env.S5_BRIDGE_TOKEN },
  );
  console.error(`http-stub listening on ${stub.url}`);
}
