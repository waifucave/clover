// The card fixture's host half: one MCP server with one tool, `ask_card`, which is on neither the contained nor the
// read-only list, so every call raises an approval card for the bot's session. It answers "asked-ok" once approved.
import type { HostModule, McpServerTransport } from "@waifucave/clover-plugin-sdk";

const TOOLS = [
  { name: "ask_card", title: "Ask", description: "Does one harmless thing, after the user says yes.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
];

export const mcp: HostModule["mcp"] = {
  cards: async (transport: McpServerTransport) => {
    const reply = (id: unknown, body: Record<string, unknown>) => void transport.send({ jsonrpc: "2.0", id, ...body }).catch(() => undefined);
    transport.onmessage = (m) => {
      if (typeof m.id !== "number" && typeof m.id !== "string") return;
      const params = (m.params ?? {}) as Record<string, unknown>;
      switch (m.method) {
        case "initialize":
          return reply(m.id, { result: { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cards", version: "1.0.0" } } });
        case "ping":
          return reply(m.id, { result: {} });
        case "tools/list":
          return reply(m.id, { result: { tools: TOOLS } });
        case "tools/call":
          return reply(m.id, { result: { content: [{ type: "text", text: "asked-ok" }] } });
        default:
          return reply(m.id, { error: { code: -32601, message: `unknown method: ${String(m.method).slice(0, 64)}` } });
      }
    };
    await transport.start();
  },
};
