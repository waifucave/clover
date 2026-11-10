// The acceptance fixture's host half: one in-process MCP server, `echo`, with one tool, `Echo`, which answers
// `acceptance-echo-pong: <text>`. No network, no files, no other process.
interface McpServerTransport {
  start(): Promise<void>;
  send(message: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: Record<string, unknown>) => void;
  onclose?: () => void;
}

const TOOLS = [{
  name: "Echo",
  description: "Answers with the text it was given (the acceptance run's plugin tool).",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
}];

export async function start(): Promise<void> {}
export async function stop(): Promise<void> {}

export const mcp = {
  echo: async (transport: McpServerTransport): Promise<void> => {
    const reply = (id: unknown, body: Record<string, unknown>) => void transport.send({ jsonrpc: "2.0", id, ...body }).catch(() => {});
    transport.onmessage = (m) => {
      if (m.id === undefined) return;
      const params = (m.params ?? {}) as Record<string, unknown>;
      if (m.method === "initialize") {
        reply(m.id, { result: { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "acceptance-echo", version: "1" } } });
      } else if (m.method === "ping") {
        reply(m.id, { result: {} });
      } else if (m.method === "tools/list") {
        reply(m.id, { result: { tools: TOOLS } });
      } else if (m.method === "tools/call" && params.name === "Echo") {
        const text = String((params.arguments as { text?: unknown } | undefined)?.text ?? "");
        reply(m.id, { result: { content: [{ type: "text", text: `acceptance-echo-pong: ${text}` }] } });
      } else {
        reply(m.id, { error: { code: -32601, message: `unknown: ${String(m.method)}` } });
      }
    };
    await transport.start();
  },
};
