// A small MCP server on the plugin SDK's in-process transport (`HostModule.mcp`): JSON-RPC 2.0 with `initialize`,
// `notifications/initialized`, `ping`, `tools/list` and `tools/call`. A tool's own failure is a result with
// `isError`; only a malformed request, an unknown method or an unknown tool gets a JSON-RPC error.
import type { ToolDef, ToolResult } from "./tools";

/** The SDK's `McpServerTransport`, as this server uses it. */
export interface McpServerTransport {
  start(): Promise<void>;
  send(message: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: Record<string, unknown>) => void;
  onclose?: () => void;
}

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

type Id = string | number;
const isId = (v: unknown): v is Id => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

export async function serveMcp(transport: McpServerTransport, o: { name: string; version: string; instructions?: string; tools: readonly ToolDef[]; call(name: string, args: unknown): Promise<ToolResult> }): Promise<void> {
  const reply = (id: Id, body: { result: unknown } | { error: { code: number; message: string } }) => void transport.send({ jsonrpc: "2.0", id, ...body }).catch(() => {});
  transport.onmessage = (m) => {
    const method = typeof m.method === "string" ? m.method : undefined;
    const params = (m.params !== null && typeof m.params === "object" ? m.params : {}) as Record<string, unknown>;
    if (!isId(m.id)) return;
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
          reply(id, { error: { code: -32602, message: `unknown tool: ${name.slice(0, 64)}` } });
          return;
        }
        void o.call(name, params.arguments ?? {}).then(
          (result) => reply(id, { result }),
          (err: unknown) => reply(id, { result: { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true } }),
        );
        return;
      }
      default:
        reply(id, { error: { code: -32601, message: `unknown method: ${(method ?? "(none)").slice(0, 64)}` } });
    }
  };
  await transport.start();
}
