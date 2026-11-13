// The child's host half: one MCP server (`tools`, one tool, `kids_ping`) and the handler of its command, which sends a
// bot's conversation a message as this plugin (a turn that is the plugin's, never the user's).
let api;
export function start(a) { api = a; }

const TOOLS = [{ name: "kids_ping", title: "Ping", description: "Answers from the child plugin.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }];

export const mcp = {
  tools: async (transport) => {
    const reply = (id, body) => void transport.send({ jsonrpc: "2.0", id, ...body }).catch(() => undefined);
    transport.onmessage = (m) => {
      if (typeof m.id !== "number" && typeof m.id !== "string") return;
      const params = m.params ?? {};
      switch (m.method) {
        case "initialize": return reply(m.id, { result: { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "kids", version: "1.0.0" } } });
        case "ping": return reply(m.id, { result: {} });
        case "tools/list": return reply(m.id, { result: { tools: TOOLS } });
        case "tools/call": return reply(m.id, { result: { content: [{ type: "text", text: "kids-pong" }] } });
        default: return reply(m.id, { error: { code: -32601, message: `unknown method: ${String(m.method).slice(0, 64)}` } });
      }
    };
    await transport.start();
  },
};

export const nudge = async (args) => {
  await api.conversation.send(String(args.session), "A nudge from the child plugin.");
  return { sent: true };
};
