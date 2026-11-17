// The acceptance fixture for the activity feed and a tool's live picture: `Show` (server `cam`, which declares a picture)
// publishes one frame of its own and leaves the picture up; `FeedProbe` (server `feed`, which declares none) answers
// `acceptance-feed-pong k=v ...` with what the feed and the picture list gave, and what was refused. No network, no files, no sound.
interface McpServerTransport {
  start(): Promise<void>;
  send(message: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: Record<string, unknown>) => void;
  onclose?: () => void;
}
type Api = Record<string, any>;

const WIDTH = 64;
const HEIGHT = 48;
/** A frame the engine reads the size of from its own header: a JPEG start, a frame header of WIDTH by HEIGHT, filler. */
const FRAME = (() => {
  const body = new Uint8Array(120);
  body.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, HEIGHT >> 8, HEIGHT & 0xff, WIDTH >> 8, WIDTH & 0xff, 0x03]);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
})();
const FRAME_BYTES = FRAME.length - 4;

/** The line the host half logs once the engine holds its watch of the bots' feed (the run waits for it before the first turn). */
const WATCHING = "acceptance-feed: following the bots' feed";

let api: Api | undefined;
/** The states each bot went through, as the feed told this plugin (one entry per change), and the keys its views carried. */
const seen = new Map<string, string[]>();
const keys = new Set<string>();
const tools = new Set<string>();
let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;

export async function start(a: Api): Promise<void> {
  api = a;
  // The call is answered once the engine holds the watch; the line below tells the run the feed is being followed.
  await a.activity.watch("bots", (v: Record<string, unknown>) => {
    for (const k of Object.keys(v)) keys.add(k);
    const id = String((v.subject as { id?: unknown })?.id ?? "?");
    const list = seen.get(id) ?? [];
    if (list.at(-1) !== v.state) list.push(String(v.state));
    seen.set(id, list);
    if (typeof v.tool === "string") tools.add(v.tool);
  });
  console.log(WATCHING);
}

const word = (v: string) => v.replace(/\s+/g, "_").slice(0, 80);
const within = <T = any>(p: Promise<T> | T, ms = 10_000): Promise<T> => Promise.race([Promise.resolve(p), new Promise<T>((_, no) => setTimeout(() => no(new Error("no answer in 10 s")), ms))]);
const failed = (e: unknown) => `refused:${word(String((e as { code?: unknown })?.code ?? (e as Error)?.message ?? e))}`;

async function show(a: Api): Promise<string> {
  writer = (await within(a.pictures.publish({ format: "jpeg", width: WIDTH, height: HEIGHT }))).getWriter();
  await within(writer!.write(FRAME));
  return "acceptance-feed-pong shown";
}

/** The first frame of a picture's stream: its length and the bytes' first two. */
async function firstFrame(a: Api, id: string): Promise<string> {
  const ctl = new AbortController();
  const stream: ReadableStream<Uint8Array> = await within(a.pictures.open(id, { maxFps: 10, signal: ctl.signal }));
  const reader = stream.getReader();
  try {
    let buf = new Uint8Array(0);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const got = await within(reader.read(), 8_000);
      if (got.done) return "ended-early";
      const next = new Uint8Array(buf.length + got.value.length);
      next.set(buf);
      next.set(got.value, buf.length);
      buf = next;
      if (buf.length >= 4) {
        const n = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
        if (buf.length >= 4 + n) return `frame:${n}:${buf[4]!.toString(16)}${buf[5]!.toString(16)}`;
      }
    }
    return "no-frame";
  } finally {
    ctl.abort();
    reader.cancel().catch(() => {});
  }
}

async function probe(a: Api): Promise<string> {
  const out: string[] = [];
  const at = async (name: string, f: () => Promise<string>) => {
    try { out.push(`${name}=${await f()}`); } catch (e) { out.push(`${name}=${failed(e)}`); }
  };
  await at("states", async () => [...seen.entries()].map(([id, l]) => `${word(id)}/${l.join(">")}`).join(",") || "none");
  await at("keys", async () => [...keys].sort().join(","));
  await at("tool", async () => [...tools].some((t) => t.endsWith("Show")) ? "show" : `none:${[...tools].join(",")}`);
  await at("list", async () => `bots:${(await within(a.activity.list("bots"))).length}`);
  await at("other-activity", async () => `read:${(await within(a.activity.list("sessions"))).length}`);
  let id: string | undefined;
  await at("pictures", async () => {
    const list: { id: string; publisher: string; tool?: string; width: number; height: number; screen: boolean; session: string }[] = await within(a.pictures.list("bots"));
    const mine = list.find((p) => p.publisher === "acceptance-feed");
    if (mine === undefined) return `none:${list.length}`;
    id = mine.id;
    return `${mine.publisher}:${mine.tool?.endsWith("Show") === true ? "show" : "other"}:${mine.width}x${mine.height}:screen-${mine.screen}:session-${mine.session.length > 0 ? "set" : "none"}`;
  });
  await at("stream", async () => (id === undefined ? "no-picture" : firstFrame(a, id)));
  await at("other-pictures", async () => `read:${(await within(a.pictures.list("sessions"))).length}`);
  // A picture from a tool of a server that declares none, and one that names a session of its own: both refused.
  await at("no-declare", async () => `made:${typeof (await within(a.pictures.publish({ format: "jpeg", width: 8, height: 8 }))).getWriter}`);
  await at("made-up-session", async () => `made:${typeof (await within(a.pictures.publish({ format: "jpeg", width: 8, height: 8, session: "s_made_up" }))).getWriter}`);
  return `acceptance-feed-pong ${out.join(" ")} frame-bytes=${FRAME_BYTES}`;
}

const TOOLS: Record<string, { name: string; description: string; run: (a: Api) => Promise<string> }[]> = {
  cam: [{ name: "Show", description: "Publishes one frame of a live picture and leaves it up (the acceptance run's).", run: show }],
  feed: [{ name: "FeedProbe", description: "Says what the activity feed and the pictures gave, and what was refused (the acceptance run's).", run: probe }],
};

function server(name: string) {
  return async (transport: McpServerTransport): Promise<void> => {
    const list = TOOLS[name]!;
    const reply = (id: unknown, body: Record<string, unknown>) => void transport.send({ jsonrpc: "2.0", id, ...body }).catch(() => {});
    transport.onmessage = (m) => {
      if (m.id === undefined) return;
      const params = (m.params ?? {}) as Record<string, unknown>;
      if (m.method === "initialize") {
        reply(m.id, { result: { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `acceptance-feed-${name}`, version: "1" } } });
      } else if (m.method === "ping") {
        reply(m.id, { result: {} });
      } else if (m.method === "tools/list") {
        reply(m.id, { result: { tools: list.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: "object", properties: {}, additionalProperties: false } })) } });
      } else if (m.method === "tools/call" && list.some((t) => t.name === params.name)) {
        const tool = list.find((t) => t.name === params.name)!;
        void (api === undefined ? Promise.resolve("acceptance-feed-pong no-api") : tool.run(api)).then(
          (text) => reply(m.id, { result: { content: [{ type: "text", text }] } }),
          (e) => reply(m.id, { result: { content: [{ type: "text", text: `acceptance-feed-pong error=${failed(e)}` }], isError: true } }),
        );
      } else {
        reply(m.id, { error: { code: -32601, message: `unknown: ${String(m.method)}` } });
      }
    };
    await transport.start();
  };
}

export const mcp = { cam: server("cam"), feed: server("feed") };
