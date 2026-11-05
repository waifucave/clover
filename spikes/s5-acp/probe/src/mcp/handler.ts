// A tiny legacy-era MCP server core (revisions 2024-11-05 to 2025-11-25), shared by the
// stdio and HTTP stubs. It answers `initialize` by echoing the client's version when it
// knows it, serves one echo tool whose result carries a nonce, and puts an instruction
// word in its server instructions. A model that repeats the nonce saw the tool result; one
// that repeats the instruction word saw the server instructions.
//
// `server/discover` (MCP 2026-07-28) gets a plain method-not-found, which a dual-era client
// takes as "legacy server, fall back to initialize".

export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface StubConfig {
  serverName: string; // e.g. "s5-stdio"
  toolName: string; // e.g. "s5_stdio_echo"
  nonce: string; // returned inside every tool result
  instructionWord: string; // only in the server instructions
}

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: unknown;
  error?: unknown;
};

export interface Handled {
  response?: JsonRpcMessage; // undefined for notifications and responses
  note?: string; // what the stub made of the message, for its log
}

export function instructionsFor(cfg: StubConfig): string {
  return (
    `This server (${cfg.serverName}) belongs to an automated protocol test. ` +
    `If you are asked for the instruction word of ${cfg.serverName}, it is ${cfg.instructionWord}.`
  );
}

export function handleMcp(cfg: StubConfig, msg: JsonRpcMessage): Handled {
  const isRequest = msg.method !== undefined && msg.id !== undefined && msg.id !== null;
  const ok = (result: unknown, note?: string): Handled => ({ response: { jsonrpc: "2.0", id: msg.id!, result }, note });
  const fail = (code: number, message: string, note?: string): Handled => ({
    response: { jsonrpc: "2.0", id: msg.id!, error: { code, message } },
    note,
  });

  if (msg.method === undefined) return { note: "response-from-client" };
  if (!isRequest) return { note: `notification ${msg.method}` };

  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      const version = LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0];
      return ok(
        {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: cfg.serverName, version: "0.0.1" },
          instructions: instructionsFor(cfg),
        },
        `initialize asked=${asked} answered=${version}`,
      );
    }
    case "ping":
      return ok({});
    case "logging/setLevel":
      return ok({});
    case "tools/list":
      return ok(
        {
          tools: [
            {
              name: cfg.toolName,
              title: `${cfg.serverName} echo`,
              description: `Echoes the given text back, tagged by ${cfg.serverName}. Part of an automated protocol test.`,
              inputSchema: {
                type: "object",
                properties: { text: { type: "string", description: "Text to echo" } },
                required: ["text"],
              },
              annotations: { readOnlyHint: true, openWorldHint: false },
            },
          ],
        },
        "tools/list",
      );
    case "tools/call": {
      const name = msg.params?.name;
      if (name !== cfg.toolName) return fail(-32602, `Unknown tool: ${name}`, `tools/call unknown ${name}`);
      const text = String(msg.params?.arguments?.text ?? "");
      const out = `${cfg.serverName} echo: ${text} [nonce ${cfg.nonce}]`;
      return ok({ content: [{ type: "text", text: out }], isError: false }, `tools/call ${name} text=${JSON.stringify(text)}`);
    }
    case "resources/list":
      return ok({ resources: [] });
    case "resources/templates/list":
      return ok({ resourceTemplates: [] });
    case "prompts/list":
      return ok({ prompts: [] });
    case "server/discover":
      return fail(-32601, "Method not found: server/discover (legacy-era server; use initialize)", "server/discover → legacy");
    default:
      return fail(-32601, `Method not found: ${msg.method}`, `unknown ${msg.method}`);
  }
}
