// A minimal legacy-era MCP client, used by the fake agent and the stub self-test: connect,
// initialize, list tools, call the first tool once, disconnect.
import { spawn } from "node:child_process";

export interface McpProbeResult {
  instructions?: string;
  tools: string[];
  callText?: string;
  protocolVersion?: string;
}

type StdioServer = { name: string; command: string; args: string[]; env?: { name: string; value: string }[] };
type HttpServer = { name: string; url: string; headers: { name: string; value: string }[] };

const INIT = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "s5-mini-client", version: "0.0.1" } },
});

export async function probeStdio(server: StdioServer, text: string, timeoutMs = 10_000): Promise<McpProbeResult> {
  const env = { ...(process.env as Record<string, string>), ...Object.fromEntries((server.env ?? []).map((e) => [e.name, e.value])) };
  const child = spawn(server.command, server.args, { env, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<number, (m: any) => void>();
  let buf = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (s: string) => {
    buf += s;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    }
  });
  const send = (m: any) => child.stdin!.write(JSON.stringify(m) + "\n");
  const call = (m: any) =>
    new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`stdio ${m.method}: timeout`)), timeoutMs);
      pending.set(m.id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
      send(m);
    });
  try {
    const init = await call(INIT(1));
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools: string[] = list.result.tools.map((t: any) => t.name);
    const res = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tools[0], arguments: { text } } });
    return {
      instructions: init.result.instructions,
      protocolVersion: init.result.protocolVersion,
      tools,
      callText: res.result?.content?.[0]?.text,
    };
  } finally {
    child.stdin!.end();
    child.kill();
  }
}

export async function probeHttp(server: HttpServer, text: string, timeoutMs = 10_000): Promise<McpProbeResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
  };
  const post = async (body: any, sid?: string) => {
    const r = await fetch(server.url, {
      method: "POST",
      headers: sid ? { ...headers, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" } : headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: r.status, sid: r.headers.get("mcp-session-id") ?? undefined, json: r.status === 200 ? await r.json() : undefined };
  };
  const init = await post(INIT(1));
  const sid = init.sid;
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sid);
  const tools: string[] = (list.json as any).result.tools.map((t: any) => t.name);
  const res = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tools[0], arguments: { text } } }, sid);
  await fetch(server.url, { method: "DELETE", headers: sid ? { ...headers, "mcp-session-id": sid } : headers }).catch(() => {});
  return {
    instructions: (init.json as any).result.instructions,
    protocolVersion: (init.json as any).result.protocolVersion,
    tools,
    callText: (res.json as any)?.result?.content?.[0]?.text,
  };
}
