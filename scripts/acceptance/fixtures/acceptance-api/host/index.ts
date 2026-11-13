// The acceptance fixture for the plugin API's served areas (lane A, try 15's gate): one in-process MCP server, `api`,
// with one tool, `ApiProbe`, which calls one member of each area from inside the bot's tool call and answers
// `acceptance-api-pong` with `<area>=<what it gave>` pairs. No network, no files of the user's, no sound (its clip is
// empty: the app is handed only the utterance's final piece).
interface McpServerTransport {
  start(): Promise<void>;
  send(message: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: Record<string, unknown>) => void;
  onclose?: () => void;
}
type Api = Record<string, any>;

let api: Api | undefined;
export async function start(a: Api): Promise<void> {
  api = a;
}
export async function ping(_args: unknown, ctx: { caller?: { kind?: unknown } }): Promise<{ text: string }> {
  return { text: `pong by ${String(ctx?.caller?.kind ?? "nobody")}` };
}

const TOOLS = [{
  name: "ApiProbe",
  description: "Calls one member of each served plugin-API area and says what each gave (the acceptance run's).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
}];

const word = (v: string) => v.replace(/\s+/g, "_").slice(0, 80);
const failed = (e: unknown) => `refused:${word(String((e as { code?: unknown })?.code ?? (e as Error)?.message ?? e))}`;

async function probe(a: Api): Promise<string> {
  const out: string[] = [];
  const at = async (name: string, f: () => Promise<string>) => {
    try { out.push(`${name}=${await f()}`); } catch (e) { out.push(`${name}=${failed(e)}`); }
  };
  const mark = `acceptance-api-mark-${Date.now()}`;
  console.log(mark);
  await at("own-log", async () => {
    for (let i = 0; i < 40; i++) {
      const lines: string[] = await a.logs.read({ plugin: "acceptance-api" }, { lines: 50 });
      if (lines.some((l) => l.includes(mark))) return "read";
      await new Promise((r) => setTimeout(r, 100));
    }
    return "missing";
  });
  await at("core-log", async () => `read:${(await a.logs.read("core", { lines: 1 })).length}`);
  await at("usage", async () => `rows:${(await a.usage.rows({ since: 0, limit: 1000 })).rows.length}`);
  await at("memory", async () => `alpha:${(await a.memory.list("alpha")).length}`);
  await at("routines", async () => `listed:${(await a.routines.list({})).length}`);
  await at("own-command", async () => word((await a.commands.run("acceptance-api.ping", {})).text));
  await at("other-command", async () => `ran:${word(JSON.stringify(await a.commands.run("acceptance-echo.say", { text: "x" })))}`);
  await at("audio-play", async () => {
    const h = await a.audio.play({ format: "pcm16-24k", data: new Uint8Array(0) }, { bot: "alpha" });
    await h.done;
    return "handed";
  });
  await at("audio-listen", async () => {
    const off = a.audio.onRecording(() => {});
    off();
    return "watched";
  });
  await at("keys", async () => `made:${(await a.keys.publicKey("x")).length}`);
  return `acceptance-api-pong ${out.join(" ")}`;
}

export const mcp = {
  api: async (transport: McpServerTransport): Promise<void> => {
    const reply = (id: unknown, body: Record<string, unknown>) => void transport.send({ jsonrpc: "2.0", id, ...body }).catch(() => {});
    transport.onmessage = (m) => {
      if (m.id === undefined) return;
      const params = (m.params ?? {}) as Record<string, unknown>;
      if (m.method === "initialize") {
        reply(m.id, { result: { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "acceptance-api", version: "1" } } });
      } else if (m.method === "ping") {
        reply(m.id, { result: {} });
      } else if (m.method === "tools/list") {
        reply(m.id, { result: { tools: TOOLS } });
      } else if (m.method === "tools/call" && params.name === "ApiProbe") {
        void (api === undefined ? Promise.resolve("acceptance-api-pong no-api") : probe(api)).then(
          (text) => reply(m.id, { result: { content: [{ type: "text", text }] } }),
          (e) => reply(m.id, { result: { content: [{ type: "text", text: `acceptance-api-pong error=${failed(e)}` }], isError: true } }),
        );
      } else {
        reply(m.id, { error: { code: -32601, message: `unknown: ${String(m.method)}` } });
      }
    };
    await transport.start();
  },
};
