// clover/plugin-builder's host half: one MCP server, `builder`, with PluginNew (src/tools.ts), on the in-process
// transport the plugin host hands it. JSON-RPC 2.0: initialize, ping, tools/list, tools/call; a tool's own failure is a
// result with `isError`, an unknown method or tool a JSON-RPC error. It reaches no network and no file.
import type { HostModule, McpServerTransport } from "@waifucave/clover-plugin-sdk";
import { runTool, TOOLS } from "../src/tools";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export function serveBuilder(transport: McpServerTransport): Promise<void> {
  const reply = (id: string | number, body: Record<string, unknown>) => void transport.send({ jsonrpc: "2.0", id, ...body }).catch(() => {});
  transport.onmessage = (m) => {
    const id = m.id;
    if (typeof id !== "string" && typeof id !== "number") return; // a notification: nothing to answer
    const params = (m.params !== null && typeof m.params === "object" ? m.params : {}) as Record<string, unknown>;
    switch (m.method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" && PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0];
        reply(id, { result: { protocolVersion: asked, capabilities: { tools: {} }, serverInfo: { name: "builder", version: "1.0.0" } } });
        return;
      }
      case "ping":
        reply(id, { result: {} });
        return;
      case "tools/list":
        reply(id, { result: { tools: TOOLS } });
        return;
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        if (!TOOLS.some((t) => t.name === name)) { reply(id, { error: { code: -32602, message: `unknown tool ${name}` } }); return; }
        void runTool(name, params.arguments).then(
          (result) => reply(id, { result }),
          (err: unknown) => reply(id, { result: { content: [{ type: "text", text: `${name} failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true } }),
        );
        return;
      }
      default:
        reply(id, { error: { code: -32601, message: `unknown method ${String(m.method)}` } });
    }
  };
  return transport.start();
}

export const mcp: HostModule["mcp"] = {
  builder: (transport: McpServerTransport) => serveBuilder(transport),
};
