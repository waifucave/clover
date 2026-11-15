// The acceptance window fixture's host half: an MCP server `tools` with one read-only tool, `Window`, which answers
// `acceptance-window-pong: <text>`; a `pill.target` handler (`target.send`) that keeps the user's words from the Dispatch
// pill; and a command `report` that says them back. No network, no files, no other process.
interface McpServerTransport {
  start(): Promise<void>;
  send(message: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: Record<string, unknown>) => void;
  onclose?: () => void;
}

const TOOLS = [{
  name: "Window",
  description: "Answers with the text it was given (the acceptance run's window plugin).",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
}];

const sent: string[] = [];

export async function start(): Promise<void> {}
export async function stop(): Promise<void> {}

/** The Dispatch pill's handler for the `pill.target` entry: the user's words come here. */
export const target = {
  async send(args: { text?: unknown }): Promise<void> {
    sent.push(String(args?.text ?? ""));
  },
};

/** The command `report`: every word the target was sent, in order. */
export async function report(): Promise<{ text: string }> {
  return { text: `acceptance-window-sent: ${JSON.stringify(sent)}` };
}

export const mcp = {
  tools: async (transport: McpServerTransport): Promise<void> => {
    const reply = (id: unknown, body: Record<string, unknown>) => void transport.send({ jsonrpc: "2.0", id, ...body }).catch(() => {});
    transport.onmessage = (m) => {
      if (m.id === undefined) return;
      const params = (m.params ?? {}) as Record<string, unknown>;
      if (m.method === "initialize") {
        reply(m.id, { result: { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "acceptance-window", version: "1" } } });
      } else if (m.method === "ping") {
        reply(m.id, { result: {} });
      } else if (m.method === "tools/list") {
        reply(m.id, { result: { tools: TOOLS } });
      } else if (m.method === "tools/call" && params.name === "Window") {
        const text = String((params.arguments as { text?: unknown } | undefined)?.text ?? "");
        reply(m.id, { result: { content: [{ type: "text", text: `acceptance-window-pong: ${text}` }] } });
      } else {
        reply(m.id, { error: { code: -32601, message: `unknown: ${String(m.method)}` } });
      }
    };
    await transport.start();
  },
};
