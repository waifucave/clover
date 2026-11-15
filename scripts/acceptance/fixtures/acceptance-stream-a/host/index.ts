// The streams clause's fixture, host half (§5.4 "Streams"). Three streams, each counted and checksummed (FNV-1a over the
// bytes) by both ends, from bytes both ends generate the same way (`gen`):
// * `down`: this host half opens "down" to its page and writes `bytes` of seed 1; the page reports what it read.
// * `up`: its page opens "up" to this host half (`accept`) and writes `bytes` of seed 2; this half reports what it read.
// * `point`: acceptance-stream-b's point handler answers with a stream of seed 3 (`points.stream`); this half reads it.
// `report` gives the run what the page said and what this half counted.

type Counted = { count: number; sum: number };
type Api = {
  streams: {
    open(name: string, o?: { meta?: Record<string, unknown> }): Promise<WritableStream<Uint8Array>>;
    accept(name: string, onStream: (s: ReadableStream<Uint8Array>, meta: Record<string, unknown>) => void): { opened: Promise<void> };
  };
  points: { stream(point: string, entry: { pluginId: string; entryId: string }, field: string, args?: unknown): Promise<ReadableStream<Uint8Array>> };
  ui: { send(event: string, data?: unknown): void };
};
let api: Api | undefined;
const page: Record<string, unknown> = {};
let upRead: Counted | undefined;
/** What each command's work counted, or why it failed: a command answers at once (its call has 10 seconds), the work runs on. */
const results: Record<string, unknown> = {};
const background = (what: string, work: () => Promise<Counted>): { started: string } => {
  delete results[what];
  void work().then((r) => (results[what] = r), (e: unknown) => (results[what] = { error: e instanceof Error ? e.message : String(e) }));
  return { started: what };
};
let ready = false;

const need = (): Api => {
  if (api === undefined) throw new Error("not started");
  return api;
};

/** Bytes `from`..`from + n` of the stream of `seed`: the same function in every half. */
export function gen(seed: number, from: number, n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const k = from + i;
    b[i] = (k * 131 + (k >>> 8) * 7 + seed * 13) & 255;
  }
  return b;
}
const fnv = (h: number, bytes: Uint8Array): number => {
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193) >>> 0;
  return h;
};

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Counted> {
  let count = 0;
  let sum = 0x811c9dc5;
  const reader = stream.getReader();
  for (;;) {
    const r = await reader.read();
    if (r.done) return { count, sum };
    count += r.value.length;
    sum = fnv(sum, r.value);
  }
}

export function start(a: Api): void {
  api = a;
  a.streams.accept("up", (stream) => {
    void readAll(stream).then((r) => (upRead = r), () => undefined);
  });
}

const waitFor = async <T>(what: string, get: () => T | undefined, ms = 120_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
};

export function down(args: { bytes?: number } | null): { started: string } {
  return background("down", () => downWork(args));
}

async function downWork(args: { bytes?: number } | null): Promise<Counted> {
  const bytes = typeof args?.bytes === "number" ? args.bytes : 4_000_000;
  await waitFor("its page to be ready", () => (ready ? true : undefined));
  const w = (await need().streams.open("down", { meta: { bytes } })).getWriter();
  let sum = 0x811c9dc5;
  for (let at = 0; at < bytes; at += 65_536) {
    const piece = gen(1, at, Math.min(65_536, bytes - at));
    sum = fnv(sum, piece);
    await w.write(piece);
  }
  await w.close();
  return { count: bytes, sum };
}

export function up(args: { bytes?: number } | null): { started: string } {
  return background("up", () => upWork(args));
}

async function upWork(args: { bytes?: number } | null): Promise<Counted> {
  const bytes = typeof args?.bytes === "number" ? args.bytes : 3_000_000;
  await waitFor("its page to be ready", () => (ready ? true : undefined));
  upRead = undefined;
  need().ui.send("go-up", { bytes });
  return await waitFor("the stream its page opens", () => upRead);
}

export function point(args: { bytes?: number } | null): { started: string } {
  return background("point", () => pointWork(args));
}

async function pointWork(args: { bytes?: number } | null): Promise<Counted> {
  const bytes = typeof args?.bytes === "number" ? args.bytes : 2_000_000;
  const stream = await need().points.stream("acceptance-stream-a.sounds", { pluginId: "acceptance-stream-b", entryId: "tone" }, "make", { bytes });
  return await readAll(stream);
}

export function report(): Record<string, unknown> {
  return { ready, page, results };
}

/** What its page may call (`host.call`). */
export const ui = {
  pageReady: async () => {
    ready = true;
    return "ok";
  },
  pageReport: async (args: Record<string, unknown>) => {
    page[String(args.kind)] = args;
    return "kept";
  },
};
