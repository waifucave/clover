// A small MCP server on lane B's in-process transport (`HostModule.mcp`): JSON-RPC 2.0 with `initialize`,
// `notifications/initialized`, `ping`, `tools/list`, `tools/call`, and `notifications/cancelled` to stop a call. A
// tool's own failure is a result with `isError`; only a malformed request, an unknown method or an unknown tool gets
// a JSON-RPC error.
import type { ToolResult } from "./tools";

/** Lane B's `McpServerTransport` (the plugin SDK's), as this server uses it. */
export interface McpServerTransport {
  start(): Promise<void>;
  send(message: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: Record<string, unknown>) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export interface ServeOptions {
  name: string;
  version: string;
  instructions?: string;
  tools: readonly { name: string; description: string; inputSchema: unknown; annotations?: unknown }[];
  call(name: string, args: unknown, signal: AbortSignal): Promise<ToolResult>;
}

type Id = string | number;
const isId = (v: unknown): v is Id => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

export async function serveMcp(transport: McpServerTransport, o: ServeOptions): Promise<{ close(): Promise<void>; closed: Promise<void> }> {
  const inflight = new Map<string, AbortController>();
  let markClosed!: () => void;
  const closed = new Promise<void>((r) => { markClosed = r; });
  const reply = (id: Id, body: { result: unknown } | { error: { code: number; message: string } }) => void transport.send({ jsonrpc: "2.0", id, ...body }).catch(() => {});
  transport.onclose = () => {
    for (const c of inflight.values()) c.abort();
    inflight.clear();
    markClosed();
  };
  transport.onmessage = (m) => {
    const method = typeof m.method === "string" ? m.method : undefined;
    const params = (m.params !== null && typeof m.params === "object" ? m.params : {}) as Record<string, unknown>;
    if (!isId(m.id)) {
      if (method === "notifications/cancelled" && isId(params.requestId)) inflight.get(`${typeof params.requestId}:${params.requestId}`)?.abort();
      return;
    }
    const id = m.id;
    switch (method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
        const version = asked !== undefined && (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        reply(id, { result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: o.name, version: o.version }, ...(o.instructions === undefined ? {} : { instructions: o.instructions }) } });
        return;
      }
      case "ping":
        reply(id, { result: {} });
        return;
      case "tools/list":
        reply(id, { result: { tools: o.tools } });
        return;
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        if (!o.tools.some((t) => t.name === name)) {
          reply(id, { error: { code: -32602, message: `unknown tool: ${name}` } });
          return;
        }
        const ac = new AbortController();
        const key = `${typeof id}:${id}`;
        inflight.set(key, ac);
        void o.call(name, params.arguments ?? {}, ac.signal).then(
          (result) => reply(id, { result }),
          (err: unknown) => reply(id, { result: { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true } }),
        ).finally(() => inflight.delete(key));
        return;
      }
      default:
        reply(id, { error: { code: -32601, message: `unknown method: ${method ?? "(none)"}` } });
    }
  };
  await transport.start();
  return {
    closed,
    async close() {
      for (const c of inflight.values()) c.abort();
      await transport.close().catch(() => {});
      markClosed();
    },
  };
}
