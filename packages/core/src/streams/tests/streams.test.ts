// Streams (§5.4 "Streams"): the hub's order and back-pressure; both directions; each way a stream ends (the writer's end,
// either side's cancel, either side's watch going, a host half or a plugin stopping, the daemon closing) with the other
// side told why and one log line each way; the bounds; a stream refused across plugins; and, through the real host
// runtime and the router, a host half's `open` and `accept` (the Web streams the SDK makes) and `points.stream` from a
// handler that returns bytes, an async iterable, a ReadableStream, something else, or fails; the caller leaving stops
// the handler's pump.
import { describe, expect, test } from "bun:test";
import { acceptStreams, catalogPointDecl, fromLayerWire, openStream, pointStream, toLayerWire, STREAM_BUFFER_MAX, STREAM_CHUNK_MAX, STREAM_META_MAX_BYTES, STREAM_WINDOW_MAX, STREAM_ACCEPTORS_PER_PLUGIN, STREAMS_OPEN_PER_PLUGIN, type Manifest, type StreamsTransport } from "@waifucave/moss-plugin-sdk";
import type { Caller } from "@waifucave/moss-protocol";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakePluginRegistry } from "../../contracts/fakes/plugin-registry";
import { ContractError, isContractError } from "../../contracts/common";
import type { HandlerContext } from "../../contracts/sdk-types";
import { createApiRouter, handlerOf, type ApiHandlers } from "../../plugin-host/api/router";
import { pointsApi } from "../../plugin-host/api/points";
import { defaultAssetUrl } from "../../plugin-host/daemon-host";
import { LoopbackPluginHost } from "../../plugin-host/loopback";
import { streamsApi } from "../api";
import { StreamHub, type StreamEvent } from "../hub";

const USER: Caller = { kind: "user", client: "app" };
const ui = (pluginId: string) => ({ pluginId, side: "ui" as const });
const host = (pluginId: string) => ({ pluginId, side: "shared" as const });
const piece = (n: number, fill = 0) => new Uint8Array(n).fill(fill);

function rig() {
  const lines: string[] = [];
  const hub = new StreamHub({ log: (l) => lines.push(l) });
  /** An acceptor that records what it hears; `ids` are the streams opened to it. */
  const accepting = (who: { pluginId: string; side: "ui" | "shared" }, name: string) => {
    const events: StreamEvent[] = [];
    const off = hub.accept(who, name, (e) => events.push(e));
    return { events, off, id: () => (events.find((e) => e.type === "opened") as { id: string } | undefined)?.id, chunks: () => events.filter((e) => e.type === "chunk") as Extract<StreamEvent, { type: "chunk" }>[] };
  };
  const opening = (who: { pluginId: string; side: "ui" | "shared" }, name: string, meta?: unknown) => {
    const events: StreamEvent[] = [];
    const stop = hub.open(who, name, meta, (e) => events.push(e));
    return { events, stop, id: (events.find((e) => e.type === "open") as { id: string }).id };
  };
  return { hub, lines, accepting, opening };
}

const code = async (p: unknown) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ContractError ? e.code : String(e);
  }
};
const message = async (p: unknown) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("streams: the hub", () => {
  test("pieces arrive in order with the meta; the end comes after the last piece; one log line opens and one ends the stream", async () => {
    const { hub, lines, accepting, opening } = rig();
    const reader = accepting(host("tarot"), "deck");
    const w = opening(ui("tarot"), "deck", { kind: "pcm" });
    expect(reader.events[0]).toMatchObject({ type: "opened", meta: { kind: "pcm" } });
    expect(w.events).toEqual([{ type: "open", id: w.id }]);
    for (let i = 0; i < 3; i++) await hub.write(w.id, ui("tarot"), piece(100, i + 1));
    expect(reader.chunks().map((c) => [c.data.length, c.data[0]])).toEqual([[100, 1], [100, 2], [100, 3]]);
    expect(reader.events.some((e) => e.type === "end")).toBe(false);
    hub.end(w.id, ui("tarot"));
    expect(reader.events.at(-1)).toEqual({ type: "end", id: w.id });
    expect(hub.size).toBe(0);
    // One line opened it and one ended it, whatever the number of pieces.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^streams: deck \(\w+\) opened, tarot \(a component\) writing to tarot \(its host half, process shared\)$/);
    expect(lines[1]).toMatch(/^streams: deck \(\w+\) ended by its writer \(done\): 300 bytes in /);
    // The writer's watch ending after its end isn't a loss: the reader heard end, nothing more.
    w.stop();
    expect(reader.events.filter((e) => e.type === "aborted")).toEqual([]);
    // What the reader acknowledges after the end is nothing.
    expect(() => hub.ack(w.id, host("tarot"), 300)).not.toThrow();
  });

  test("both directions: a component to its host half and a host half to its component; the newest acceptor on the other side takes it", () => {
    const { hub, accepting, opening } = rig();
    const hostReader = accepting(host("tarot"), "in");
    const uiOld = accepting(ui("tarot"), "out");
    const uiNew = accepting(ui("tarot"), "out");
    const elsewhere = accepting(ui("tarot"), "other");
    const toHost = opening(ui("tarot"), "in");
    const toUi = opening(host("tarot"), "out");
    expect(hostReader.id()).toBe(toHost.id);
    expect(uiNew.id()).toBe(toUi.id);
    expect(uiOld.id()).toBeUndefined();
    expect(elsewhere.id()).toBeUndefined();
    expect(hub.size).toBe(2);
  });

  test("back-pressure: a write waits while the reader doesn't acknowledge, and the pieces keep their order", async () => {
    const { hub, accepting, opening } = rig();
    const reader = accepting(host("tarot"), "deck");
    const w = opening(ui("tarot"), "deck");
    // The window sends 6 pieces, the buffer holds 8 more; the 15th write waits.
    const total = STREAM_WINDOW_MAX / STREAM_CHUNK_MAX + STREAM_BUFFER_MAX / STREAM_CHUNK_MAX;
    for (let i = 0; i < total; i++) await hub.write(w.id, ui("tarot"), piece(STREAM_CHUNK_MAX, i));
    expect(reader.chunks()).toHaveLength(STREAM_WINDOW_MAX / STREAM_CHUNK_MAX);
    let resolved = false;
    const waiting = hub.write(w.id, ui("tarot"), piece(STREAM_CHUNK_MAX, total)).then(() => (resolved = true));
    await Promise.resolve();
    expect(resolved).toBe(false);
    // One write at a time on a stream.
    expect(await code(Promise.resolve().then(() => hub.write(w.id, ui("tarot"), piece(1))))).toBe("refused");
    // The reader consumed a piece: one more goes out, the buffer has room, the waiting write is let in.
    hub.ack(w.id, host("tarot"), STREAM_CHUNK_MAX);
    await waiting;
    expect(resolved).toBe(true);
    for (let i = 0; i <= total; i++) {
      hub.ack(w.id, host("tarot"), STREAM_CHUNK_MAX);
    }
    expect(reader.chunks().map((c) => c.data[0])).toEqual(Array.from({ length: total + 1 }, (_, i) => i));
  });

  test("the end waits for the last piece to go: the reader hears it only after every piece", () => {
    const { hub, accepting, opening } = rig();
    const reader = accepting(host("tarot"), "deck");
    const w = opening(ui("tarot"), "deck");
    const pieces = STREAM_WINDOW_MAX / STREAM_CHUNK_MAX + 2;
    for (let i = 0; i < pieces; i++) void hub.write(w.id, ui("tarot"), piece(STREAM_CHUNK_MAX, i));
    hub.end(w.id, ui("tarot"));
    expect(reader.chunks()).toHaveLength(STREAM_WINDOW_MAX / STREAM_CHUNK_MAX);
    expect(reader.events.some((e) => e.type === "end")).toBe(false);
    hub.ack(w.id, host("tarot"), STREAM_CHUNK_MAX * 2);
    expect(reader.chunks()).toHaveLength(pieces);
    expect(reader.events.at(-1)).toEqual({ type: "end", id: w.id });
    // The writer may not write after its end.
    expect(hub.size).toBe(0);
  });

  test("the reader cancels: the writer's waiting write fails and the writer is told why; the reader, who knows, is not", async () => {
    const { hub, lines, accepting, opening } = rig();
    const reader = accepting(host("tarot"), "deck");
    const w = opening(ui("tarot"), "deck");
    const total = STREAM_WINDOW_MAX / STREAM_CHUNK_MAX + STREAM_BUFFER_MAX / STREAM_CHUNK_MAX;
    for (let i = 0; i < total; i++) await hub.write(w.id, ui("tarot"), piece(STREAM_CHUNK_MAX));
    const waiting = message(hub.write(w.id, ui("tarot"), piece(STREAM_CHUNK_MAX)));
    hub.cancel(w.id, host("tarot"), "enough");
    expect(await waiting).toBe("the stream ended: the reader cancelled: enough");
    expect(w.events.at(-1)).toEqual({ type: "aborted", id: w.id, reason: "the reader cancelled: enough" });
    expect(reader.events.some((e) => e.type === "aborted")).toBe(false);
    expect(hub.size).toBe(0);
    expect(lines.at(-1)).toMatch(/ended \(the reader cancelled: enough\): \d+ bytes written, \d+ sent, in /);
    // A write after it hears why; a cancel or an ack after it is nothing.
    expect(await message(Promise.resolve().then(() => hub.write(w.id, ui("tarot"), piece(1))))).toBe(`stream ${w.id} ended: the reader cancelled: enough`);
    expect(() => hub.cancel(w.id, host("tarot"))).not.toThrow();
    expect(() => hub.ack(w.id, host("tarot"), 1)).not.toThrow();
  });

  test("the writer cancels: the reader is told why", () => {
    const { hub, accepting, opening } = rig();
    const reader = accepting(host("tarot"), "deck");
    const w = opening(ui("tarot"), "deck");
    hub.cancel(w.id, ui("tarot"), "changed my mind");
    expect(reader.events.at(-1)).toEqual({ type: "aborted", id: w.id, reason: "the writer cancelled: changed my mind" });
    expect(w.events.some((e) => e.type === "aborted")).toBe(false);
  });

  test("the writer's watch ends (its frame is gone, its process exited): the reader is told once; the reader's watch ends: the writer is", async () => {
    const { hub, lines, accepting, opening } = rig();
    const reader = accepting(host("tarot"), "deck");
    const w = opening(ui("tarot"), "deck");
    w.stop();
    w.stop();
    expect(reader.events.filter((e) => e.type === "aborted")).toEqual([{ type: "aborted", id: w.id, reason: "the writer went: its half's watch ended (a frame gone, its host process exited, or the app quit)" }]);
    expect(lines.at(-1)).toContain("the writer went");
    // Now the other way: a frame accepting, its host half writing; the frame goes.
    const frame = accepting(ui("tarot"), "audio");
    const hw = opening(host("tarot"), "audio");
    frame.off();
    expect(hw.events.at(-1)).toEqual({ type: "aborted", id: hw.id, reason: "the reader went: it stopped accepting, or its watch ended" });
    expect(await message(Promise.resolve().then(() => hub.write(hw.id, host("tarot"), piece(1))))).toContain("the reader went");
    expect(hub.size).toBe(0);
    // An acceptor that stopped takes no more streams.
    expect(await code(Promise.resolve().then(() => opening(host("tarot"), "audio")))).toBe("not_found");
  });

  test("a host half stopping ends the streams its process wrote or read, and only those; a plugin stopping ends them all", () => {
    const { hub, accepting, opening } = rig();
    const frame = accepting(ui("tarot"), "audio");
    const hostReader = accepting(host("tarot"), "mic");
    const fromHost = opening(host("tarot"), "audio");
    const fromFrame = opening(ui("tarot"), "mic");
    hub.endPlugin("tarot", "its host half is stopped", (side) => side !== "ui");
    expect(frame.events.at(-1)).toEqual({ type: "aborted", id: fromHost.id, reason: "the writer went: its host half is stopped" });
    expect(fromFrame.events.at(-1)).toEqual({ type: "aborted", id: fromFrame.id, reason: "the reader went: its host half is stopped" });
    expect(hostReader.id()).toBe(fromFrame.id);
    expect(hub.size).toBe(0);
    // The host half's acceptors went with it, the frame's stayed.
    expect(hub.acceptors).toBe(1);
    const again = opening(host("tarot"), "audio");
    hub.endPlugin("tarot", "its plugin is off");
    expect(frame.events.at(-1)).toEqual({ type: "aborted", id: again.id, reason: "the writer and reader went: its plugin is off" });
    expect(hub.acceptors).toBe(0);
  });

  test("the daemon closing ends every stream, telling each end", () => {
    const { hub, accepting, opening } = rig();
    const reader = accepting(host("tarot"), "deck");
    const w = opening(ui("tarot"), "deck");
    hub.close();
    expect(reader.events.at(-1)).toEqual({ type: "aborted", id: w.id, reason: "MOSS's plugins closed" });
    expect(w.events.at(-1)).toEqual({ type: "aborted", id: w.id, reason: "MOSS's plugins closed" });
    expect(hub.size).toBe(0);
    expect(hub.acceptors).toBe(0);
  });

  test("the bounds: a piece, a write at a time, streams open, names accepted, a meta, a name", async () => {
    const { hub, accepting, opening } = rig();
    accepting(host("tarot"), "deck");
    const w = opening(ui("tarot"), "deck");
    expect(await code(Promise.resolve().then(() => hub.write(w.id, ui("tarot"), piece(STREAM_CHUNK_MAX + 1))))).toBe("invalid");
    expect(await code(Promise.resolve().then(() => hub.write(w.id, ui("tarot"), "text")))).toBe("invalid");
    // Streams open at once per plugin.
    const open = [w];
    for (let i = 1; i < STREAMS_OPEN_PER_PLUGIN; i++) open.push(opening(ui("tarot"), "deck"));
    expect(hub.size).toBe(STREAMS_OPEN_PER_PLUGIN);
    expect(await message(Promise.resolve().then(() => opening(ui("tarot"), "deck")))).toContain(`${STREAMS_OPEN_PER_PLUGIN} streams open`);
    hub.cancel(open[0]!.id, ui("tarot"));
    expect(() => opening(ui("tarot"), "deck")).not.toThrow();
    // Names accepted per plugin.
    const more = rig();
    for (let i = 0; i < STREAM_ACCEPTORS_PER_PLUGIN; i++) more.accepting(host("tarot"), `n${i}`);
    expect(await code(Promise.resolve().then(() => more.accepting(host("tarot"), "one-more")))).toBe("refused");
    // A meta and a name.
    expect(await code(Promise.resolve().then(() => opening(ui("tarot"), "deck", { big: "x".repeat(STREAM_META_MAX_BYTES) })))).toBe("invalid");
    expect(await code(Promise.resolve().then(() => opening(ui("tarot"), "deck", [1])))).toBe("invalid");
    expect(await code(Promise.resolve().then(() => opening(ui("tarot"), "bad name")))).toBe("invalid");
    expect(await code(Promise.resolve().then(() => opening(ui("tarot"), "")))).toBe("invalid");
  });

  test("a points stream counts toward its caller's cap only: callers can't fill a contributor's", async () => {
    const { hub, accepting, opening } = rig();
    // Many callers each read a stream of the same contributor's handler: it has none of its own open.
    for (let i = 0; i < STREAMS_OPEN_PER_PLUGIN; i++) hub.openPoint({ pluginId: `caller${i}`, side: "shared", listener: () => {} }, { pluginId: "voicebox", onAbort: () => {} }, `p${i}`);
    accepting(host("voicebox"), "own");
    expect(() => opening(ui("voicebox"), "own")).not.toThrow();
    // A caller's own cap still holds.
    for (let i = 1; i < STREAMS_OPEN_PER_PLUGIN; i++) hub.openPoint({ pluginId: "caller0", side: "shared", listener: () => {} }, { pluginId: "voicebox", onAbort: () => {} }, `q${i}`);
    expect(await message(Promise.resolve().then(() => hub.openPoint({ pluginId: "caller0", side: "shared", listener: () => {} }, { pluginId: "voicebox", onAbort: () => {} }, "one-more")))).toContain(`${STREAMS_OPEN_PER_PLUGIN} streams open`);
  });

  test("a cancel's reason reaches the log line and the other end with its control characters, separators and bidi overrides each run to one space", () => {
    const { hub, lines, accepting, opening } = rig();
    const reader = accepting(host("tarot"), "deck");
    const w = opening(ui("tarot"), "deck");
    hub.cancel(w.id, ui("tarot"), "\u0007 bad\u001b[31m\u2028line\u202e\u2066x\u0085y\u007f ");
    expect(reader.events.at(-1)).toEqual({ type: "aborted", id: w.id, reason: "the writer cancelled: bad [31m line x y" });
    expect(lines.at(-1)).toContain("ended (the writer cancelled: bad [31m line x y)");
  });

  test("a stream connects one plugin's own halves: no acceptor on the other side is a refusal naming why; another plugin can't open, write, acknowledge or cancel", async () => {
    const { hub, accepting, opening } = rig();
    accepting(host("tarot"), "deck");
    const w = opening(ui("tarot"), "deck");
    // No half of `cards` accepts, whatever tarot's does; a same-side acceptor doesn't count either.
    const none = await message(Promise.resolve().then(() => opening(ui("cards"), "deck")));
    expect(none).toBe('cards has no host half accepting a stream named "deck" (the other half calls streams.accept("deck", …) first)');
    accepting(ui("tarot"), "mine");
    expect(await code(Promise.resolve().then(() => opening(ui("tarot"), "mine")))).toBe("not_found");
    // Another plugin holding the id: not its stream.
    expect(await code(Promise.resolve().then(() => hub.write(w.id, ui("cards"), piece(1))))).toBe("refused");
    expect(await code(Promise.resolve().then(() => hub.write(w.id, host("cards"), piece(1))))).toBe("refused");
    expect(await code(Promise.resolve().then(() => hub.end(w.id, host("cards"))))).toBe("refused");
    expect(await code(Promise.resolve().then(() => hub.ack(w.id, host("cards"), 1)))).toBe("refused");
    expect(await code(Promise.resolve().then(() => hub.cancel(w.id, host("cards"))))).toBe("not_found");
    // Within the plugin: the reader doesn't write, the writer doesn't acknowledge.
    expect(await code(Promise.resolve().then(() => hub.write(w.id, host("tarot"), piece(1))))).toBe("refused");
    expect(await code(Promise.resolve().then(() => hub.ack(w.id, ui("tarot"), 1)))).toBe("refused");
    expect(hub.has(w.id)).toBe(true);
  });
});

// ---- through the real host runtime and the router ----

const API = "^1.0.0";
const manifest = (m: Partial<Manifest>): Manifest => ({ manifest: 1, name: "P", engines: { moss: API }, ...m }) as Manifest;

const until = async (cond: () => boolean, what: string, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(2);
  }
};

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    parts.push(r.value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const pattern = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);

function setup() {
  const lines: string[] = [];
  const hub = new StreamHub({ log: (l) => lines.push(l) });
  const registry = new FakePluginRegistry({
    catalog: catalogPointDecl,
    plugins: [
      {
        id: "luna",
        manifest: manifest({
          id: "luna", name: "Luna",
          host: { entry: "host/index.js", declares: { "luna.sounds": { shape: "list", fields: { type: "object", properties: { id: { type: "string" }, make: { type: "string", format: "handler" }, title: { type: "string" } } } } } },
        } as Partial<Manifest>),
      },
      {
        id: "tarot",
        manifest: manifest({
          id: "tarot", name: "Tarot", host: { entry: "host/index.js" },
          contributes: {
            "luna.sounds": ["bytes", "iterable", "readable", "text", "throws", "endless", "big"].map((id) => ({ id, make: `make_${id}`, title: id })),
          },
        } as Partial<Manifest>),
      },
      { id: "cards", manifest: manifest({ id: "cards", name: "Cards", host: { entry: "host/index.js" } }) },
    ],
  });
  const plugins = new LoopbackPluginHost({ clock: new FakeClock({ start: 1_000_000 }) });
  const handlers: ApiHandlers[] = [pointsApi({ registry, host: plugins, assetUrl: defaultAssetUrl, streams: hub }), streamsApi({ hub })];
  plugins.serveApi(createApiRouter({ registry, handlers }));
  const apis = new Map<string, HandlerContext["api"]>();
  const state = { endlessReturned: false, endlessYielded: 0 };
  for (const id of ["luna", "cards"]) plugins.define(id, { start: async (api: HandlerContext["api"]) => void apis.set(id, api), ping: async () => "pong" });
  plugins.define("tarot", {
    start: async (api: HandlerContext["api"]) => void apis.set("tarot", api),
    ping: async () => "pong",
    make_bytes: async () => pattern(70_000),
    make_iterable: async () => (async function* () {
      for (let i = 0; i < 5; i++) yield pattern(1000 + i);
    })(),
    make_readable: async () => new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(pattern(10));
        c.enqueue(pattern(20));
        c.close();
      },
    }),
    make_text: async () => "not a stream",
    make_throws: async () => {
      throw new Error("the tarot ran out");
    },
    make_endless: async () => (async function* () {
      try {
        for (;;) {
          state.endlessYielded++;
          yield piece(STREAM_CHUNK_MAX, 1);
          await Bun.sleep(1);
        }
      } finally {
        state.endlessReturned = true;
      }
    })(),
    make_big: async () => (async function* () {
      for (let i = 0; i < 40; i++) yield pattern(STREAM_CHUNK_MAX);
    })(),
  });
  const start = async () => {
    for (const id of ["luna", "tarot", "cards"]) await plugins.invoke({ pluginId: id, handler: "ping", args: null, caller: USER });
    return { luna: apis.get("luna")!, tarot: apis.get("tarot")!, cards: apis.get("cards")! };
  };
  return { hub, lines, plugins, registry, handlers, start, state };
}

/** A frame's writing end through the hub: an opener whose `open` event gives the stream's id. */
function frameWriter(hub: StreamHub, pluginId: string, name: string, meta?: unknown) {
  const events: StreamEvent[] = [];
  const stop = hub.open(ui(pluginId), name, meta, (e) => events.push(e));
  const id = (events.find((e) => e.type === "open") as { id: string }).id;
  return { events, stop, id, write: (b: Uint8Array) => hub.write(id, ui(pluginId), b), end: () => hub.end(id, ui(pluginId)) };
}

describe("streams: a host half's open and accept, through the host runtime and the router", () => {
  test("a host half writes a megabyte to its frame: the frame hears every byte in order, then the end; the writer is held while the frame doesn't read", async () => {
    const { hub, start } = setup();
    const { tarot } = await start();
    const heard: StreamEvent[] = [];
    let held = 0;
    hub.accept(ui("tarot"), "audio", (e) => {
      heard.push(e);
      if (e.type === "chunk") held += e.data.length;
    });
    const writable = await tarot.streams.open("audio", { meta: { rate: 16000 } });
    expect(heard[0]).toMatchObject({ type: "opened", meta: { rate: 16000 } });
    const id = (heard[0] as { id: string }).id;
    const data = pattern(1_000_000);
    const writer = writable.getWriter();
    let written = false;
    const writing = writer.write(data).then(() => (written = true));
    // The frame hasn't read a byte: the writer is held at the window plus the buffer.
    await until(() => held >= STREAM_WINDOW_MAX, "the window to fill");
    await Bun.sleep(30);
    expect(written).toBe(false);
    expect(held).toBe(STREAM_WINDOW_MAX);
    // The frame reads: it acknowledges what it was sent until the writer is done.
    let acked = 0;
    const reading = (async () => {
      while (!written || acked < held) {
        if (acked < held) {
          const n = held - acked;
          acked += n;
          hub.ack(id, ui("tarot"), n);
        }
        await Bun.sleep(1);
      }
    })();
    await Promise.all([writing, reading]);
    await writer.close();
    await until(() => heard.some((e) => e.type === "end"), "the end");
    const bytes = Buffer.concat((heard.filter((e) => e.type === "chunk") as { data: Uint8Array }[]).map((e) => e.data));
    expect(Buffer.compare(bytes, Buffer.from(data))).toBe(0);
    expect(hub.size).toBe(0);
  });

  test("a frame writes to its host half's accept: a Web stream with the bytes in order, acknowledged as they are read, and the meta", async () => {
    const { hub, start } = setup();
    const { tarot } = await start();
    const got: { stream: ReadableStream<Uint8Array>; meta: unknown }[] = [];
    const handle = tarot.streams.accept("mic", (stream, meta) => got.push({ stream, meta }));
    await handle.opened;
    const frame = frameWriter(hub, "tarot", "mic", { n: 1 });
    await until(() => got.length === 1, "the stream");
    expect(got[0]!.meta).toEqual({ n: 1 });
    const data = pattern(600_000);
    const reading = readAll(got[0]!.stream);
    // Written at the pace the host half reads: each write waits on the credit its reads give.
    for (let at = 0; at < data.length; at += STREAM_CHUNK_MAX) await frame.write(data.subarray(at, at + STREAM_CHUNK_MAX));
    frame.end();
    const bytes = await reading;
    expect(Buffer.compare(Buffer.from(bytes), Buffer.from(data))).toBe(0);
    expect(hub.size).toBe(0);
  });

  test("each end of a host half's stream: close ends it (the frame hears end, not a loss), abort cancels it, the reader's cancel and the frame's cancel are told", async () => {
    const { hub, start } = setup();
    const { tarot } = await start();
    const frame = { events: [] as StreamEvent[] };
    hub.accept(ui("tarot"), "audio", (e) => frame.events.push(e));
    // close
    const w1 = await tarot.streams.open("audio");
    const a = w1.getWriter();
    await a.write(piece(10));
    await a.close();
    await until(() => frame.events.some((e) => e.type === "end"), "the end");
    expect(frame.events.some((e) => e.type === "aborted")).toBe(false);
    // abort: the frame is told why
    frame.events.length = 0;
    const w2 = await tarot.streams.open("audio");
    await w2.getWriter().abort("stop talking");
    await until(() => frame.events.some((e) => e.type === "aborted"), "the abort");
    expect(frame.events.at(-1)).toMatchObject({ type: "aborted", reason: "the writer cancelled: stop talking" });
    // the frame cancels: the writable errors with why, and a write fails
    frame.events.length = 0;
    const w3 = await tarot.streams.open("audio");
    const id3 = (frame.events[0] as { id: string }).id;
    hub.cancel(id3, ui("tarot"), "too loud");
    const writer3 = w3.getWriter();
    await until(() => writer3.desiredSize === null, "the writable to error");
    expect(await message(writer3.write(piece(1)))).toBe("the reader cancelled: too loud");
    // the frame goes (its watch ends): the writable errors with why
    const off = hub.accept(ui("tarot"), "gone", () => undefined);
    const w4 = await tarot.streams.open("gone");
    off();
    const writer4 = w4.getWriter();
    await until(() => writer4.desiredSize === null, "the writable to error");
    expect(await message(writer4.write(piece(1)))).toContain("the reader went");
  });

  test("accept's readable: its cancel tells the writer; the acceptor's stop errors the readable with why; a host half's process stopping errors it too", async () => {
    const { hub, start } = setup();
    const { tarot } = await start();
    const got: ReadableStream<Uint8Array>[] = [];
    const handle = tarot.streams.accept("in", (s) => got.push(s));
    await handle.opened;
    // the host half's reader cancels: the frame's writer hears it
    const f1 = frameWriter(hub, "tarot", "in");
    await until(() => got.length === 1, "the stream");
    await got[0]!.cancel("not interested");
    await until(() => f1.events.some((e) => e.type === "aborted"), "the cancel");
    expect(f1.events.at(-1)).toMatchObject({ type: "aborted", reason: "the reader cancelled: not interested" });
    // the writer cancels: the readable errors with why
    const f2 = frameWriter(hub, "tarot", "in");
    await until(() => got.length === 2, "the second stream");
    const reading = message(readAll(got[1]!));
    hub.cancel(f2.id, ui("tarot"), "my mistake");
    expect(await reading).toBe("the writer cancelled: my mistake");
    // the daemon says the host half's process stopped
    const f3 = frameWriter(hub, "tarot", "in");
    await until(() => got.length === 3, "the third stream");
    const reading3 = message(readAll(got[2]!));
    hub.endPlugin("tarot", "its plugin is off");
    expect(await reading3).toBe("the writer and reader went: its plugin is off");
    void f3;
  });

  test("an open with no acceptor on the other side is refused with why; a host half has no stream to another plugin's", async () => {
    const { hub, start } = setup();
    const { tarot, cards } = await start();
    const refused = await tarot.streams.open("nothing").then(() => undefined, (e: unknown) => e as Error);
    expect(isContractError(refused, "not_found")).toBe(true);
    expect(refused!.message).toBe('tarot has no component accepting a stream named "nothing" (the other half calls streams.accept("nothing", …) first)');
    // Another plugin's host half holds a stream id it was never given: not its stream.
    const heard: StreamEvent[] = [];
    hub.accept(ui("tarot"), "audio", (e) => heard.push(e));
    await tarot.streams.open("audio");
    const id = (heard[0] as { id: string }).id;
    expect(isContractError(await cards.streams.write(id, piece(1)).then(() => undefined, (e: unknown) => e), "refused")).toBe(true);
    expect(isContractError(await cards.streams.end(id).then(() => undefined, (e: unknown) => e), "refused")).toBe(true);
    expect(isContractError(await cards.streams.cancel(id, "mine now").then(() => undefined, (e: unknown) => e), "not_found")).toBe(true);
    expect(hub.has(id)).toBe(true);
  });
});

describe("streams: points.stream, a handler another plugin calls through a point answering with a stream", () => {
  const entry = (id: string) => ({ pluginId: "tarot", entryId: id });

  test("a handler's bytes, async iterable and ReadableStream reach the caller as they come, in order; the stream's log line names the point and the field", async () => {
    const { hub, lines, start } = setup();
    const { luna } = await start();
    const bytes = await readAll(await luna.points.stream("luna.sounds", entry("bytes"), "make"));
    expect(Buffer.compare(Buffer.from(bytes), Buffer.from(pattern(70_000)))).toBe(0);
    const iter = await readAll(await luna.points.stream("luna.sounds", entry("iterable"), "make", { any: "args" }));
    expect(Buffer.compare(Buffer.from(iter), Buffer.concat([0, 1, 2, 3, 4].map((i) => Buffer.from(pattern(1000 + i)))))).toBe(0);
    const readable = await readAll(await luna.points.stream("luna.sounds", entry("readable"), "make"));
    expect(Buffer.compare(Buffer.from(readable), Buffer.concat([Buffer.from(pattern(10)), Buffer.from(pattern(20))]))).toBe(0);
    await until(() => hub.size === 0, "the streams to end");
    expect(lines.filter((l) => l.includes("luna.sounds/make") && l.includes("opened, tarot (its host half) writing to luna (its host half, process shared)"))).toHaveLength(3);
    expect(lines.filter((l) => /ended by its writer \(done\)/.test(l))).toHaveLength(3);
  });

  test("a megabyte through a handler's iterable, back-pressured the whole way, arrives whole", async () => {
    const { hub, start } = setup();
    const { luna } = await start();
    const bytes = await readAll(await luna.points.stream("luna.sounds", entry("big"), "make"));
    expect(bytes.length).toBe(40 * STREAM_CHUNK_MAX);
    for (let i = 0; i < 40; i++) expect(Buffer.compare(Buffer.from(bytes.subarray(i * STREAM_CHUNK_MAX, (i + 1) * STREAM_CHUNK_MAX)), Buffer.from(pattern(STREAM_CHUNK_MAX)))).toBe(0);
    await until(() => hub.size === 0, "the stream to end");
  });

  test("an answer that isn't bytes, and a handler that throws, error the stream with why", async () => {
    const { hub, start } = setup();
    const { luna } = await start();
    const text = await message(readAll(await luna.points.stream("luna.sounds", entry("text"), "make")));
    expect(text).toContain("tarot.make_text answered a points.stream call with string, not bytes");
    const thrown = await message(readAll(await luna.points.stream("luna.sounds", entry("throws"), "make")));
    expect(thrown).toContain("the handler failed: the tarot ran out");
    await until(() => hub.size === 0, "the streams to end");
  });

  test("the same checks as points.call: the field must be a handler field, the caller must declare the point, the entry must exist", async () => {
    const { start } = setup();
    const { luna, tarot } = await start();
    const err = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as Error);
    const notHandler = await err(luna.points.stream("luna.sounds", entry("bytes"), "title"));
    expect(isContractError(notHandler, "refused")).toBe(true);
    expect(notHandler!.message).toBe("title isn't a handler field of luna.sounds");
    expect(isContractError(await err(tarot.points.stream("luna.sounds", entry("bytes"), "make")), "refused")).toBe(true);
    expect(isContractError(await err(luna.points.stream("luna.sounds", entry("nothing"), "make")), "not_installed")).toBe(true);
  });

  test("the caller leaving (its stream cancelled, or its signal aborted) ends the stream and stops the handler's pump; an unread stream holds the handler at the buffer", async () => {
    const { hub, lines, start, state } = setup();
    const { luna } = await start();
    // Not read at all: the handler is held by the daemon's credit, a few dozen pieces at most.
    const unread = await luna.points.stream("luna.sounds", entry("endless"), "make");
    await until(() => state.endlessYielded >= 10, "the handler to run");
    await Bun.sleep(50);
    const held = state.endlessYielded;
    expect(held).toBeLessThanOrEqual((STREAM_WINDOW_MAX + STREAM_BUFFER_MAX) / STREAM_CHUNK_MAX + 3);
    // The reader cancels: the stream ends, the handler's call is cancelled and its generator let go.
    const reader = unread.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel("enough");
    await until(() => state.endlessReturned, "the pump to stop");
    await until(() => hub.size === 0, "the stream to end");
    expect(lines.some((l) => l.includes("ended (the reader cancelled: enough)"))).toBe(true);
    // An abort signal does the same.
    state.endlessReturned = false;
    const ctl = new AbortController();
    const second = await luna.points.stream("luna.sounds", entry("endless"), "make", undefined, { signal: ctl.signal });
    const reader2 = second.getReader();
    expect((await reader2.read()).done).toBe(false);
    ctl.abort();
    await until(() => state.endlessReturned, "the second pump to stop");
    expect(await reader2.read().then(() => "read", (e: Error) => e.message)).toContain("aborted");
    await until(() => hub.size === 0, "the second stream to end");
  });
});

/** What a component's connection does between the SDK and the daemon: a call or a watch as the "ui" side of the plugin,
 *  its arguments and each value crossing as the layer's wire carries them (bytes as base64), each value arriving later. */
function layerLike(handlers: readonly ApiHandlers[], registry: FakePluginRegistry, pluginId: string): StreamsTransport {
  const ctx = (path: string) => ({ pluginId, process: "ui" as const, caller: { kind: "plugin", pluginId } as Caller, record: registry.get(pluginId)!, path: path as never });
  const handle = async (path: string, args: unknown[], listener?: { at: number; fn: (v: unknown) => void }) => {
    const fn = handlerOf(handlers, path as never);
    if (fn === undefined) throw new ContractError("refused", `${path} is not served`);
    const wire = fromLayerWire(toLayerWire(args.map((a, i) => (i === listener?.at ? null : a)))) as unknown[];
    if (listener !== undefined) wire[listener.at] = listener.fn;
    return await fn(ctx(path), wire);
  };
  return {
    call: async (path, args) => fromLayerWire(toLayerWire(await handle(path, args))),
    watch: (path, args, at) => {
      const listener = args[at] as (v: unknown) => void;
      const deliver = (v: unknown) => {
        const wire = toLayerWire(v);
        queueMicrotask(() => listener(fromLayerWire(wire)));
      };
      let stop: (() => void) | undefined;
      let stopped = false;
      const opened = handle(path, args, { at, fn: deliver }).then((fn) => {
        stop = fn as () => void;
        if (stopped) stop();
      });
      return { stop: () => { stopped = true; stop?.(); }, opened, ended: new Promise<string>(() => {}) };
    },
  };
}

describe("streams: a component's open, accept and points.stream (the SDK's Web streams over a layer-like connection)", () => {
  test("a component writes megabytes to its host half and reads them from it, bytes crossing as the layer's wire carries them", async () => {
    const { hub, handlers, registry, start } = setup();
    const { tarot } = await start();
    const frame = layerLike(handlers, registry, "tarot");
    // component -> host half
    const incoming: { stream: ReadableStream<Uint8Array>; meta: unknown }[] = [];
    const handle = tarot.streams.accept("mic", (stream, meta) => incoming.push({ stream, meta }));
    await handle.opened;
    const writable = await openStream(frame, "mic", { meta: { rate: 16000 } });
    await until(() => incoming.length === 1, "the host half's stream");
    expect(incoming[0]!.meta).toEqual({ rate: 16000 });
    const data = pattern(700_000);
    const reading = readAll(incoming[0]!.stream);
    const writer = writable.getWriter();
    await writer.write(data);
    await writer.close();
    expect(Buffer.compare(Buffer.from(await reading), Buffer.from(data))).toBe(0);
    // host half -> component
    const got: { stream: ReadableStream<Uint8Array>; meta: unknown }[] = [];
    const accepting = acceptStreams(frame, "audio", (stream, meta) => got.push({ stream, meta }));
    await accepting.opened;
    const out = await tarot.streams.open("audio", { meta: { n: 2 } });
    await until(() => got.length === 1, "the component's stream");
    expect(got[0]!.meta).toEqual({ n: 2 });
    const back = pattern(300_000);
    const reading2 = readAll(got[0]!.stream);
    const w2 = out.getWriter();
    await w2.write(back);
    await w2.close();
    expect(Buffer.compare(Buffer.from(await reading2), Buffer.from(back))).toBe(0);
    await until(() => hub.size === 0, "the streams to end");
    accepting();
    expect(hub.acceptors).toBe(1);
  });

  test("each way a component's stream ends is told to the writable or the readable: cancel by the reader, abort by the writer, the acceptor stopping, a refused open", async () => {
    const { hub, handlers, registry, start } = setup();
    const { tarot } = await start();
    const frame = layerLike(handlers, registry, "tarot");
    const incoming: ReadableStream<Uint8Array>[] = [];
    await tarot.streams.accept("mic", (s) => incoming.push(s)).opened;
    // the writer aborts: the readable errors with why
    const w1 = await openStream(frame, "mic");
    await until(() => incoming.length === 1, "the first stream");
    const read1 = message(readAll(incoming[0]!));
    await w1.getWriter().abort("never mind");
    expect(await read1).toBe("the writer cancelled: never mind");
    // the host half's reader cancels: the component's writable errors with why
    const w2 = await openStream(frame, "mic");
    await until(() => incoming.length === 2, "the second stream");
    await incoming[1]!.cancel("full");
    const writer2 = w2.getWriter();
    await until(() => writer2.desiredSize === null, "the writable to error");
    expect(await message(writer2.write(piece(4)))).toBe("the reader cancelled: full");
    // an open with an abort signal already aborted, and one aborted while it opens
    const ctl = new AbortController();
    ctl.abort(new Error("changed my mind"));
    expect(await message(openStream(frame, "mic", { signal: ctl.signal }))).toBe("changed my mind");
    // a refused open rejects with why
    expect(await message(openStream(frame, "nobody-accepts"))).toContain('has no host half accepting a stream named "nobody-accepts"');
    // the component stops accepting: its readable errors, the host half's writer is told
    const got: ReadableStream<Uint8Array>[] = [];
    const accepting = acceptStreams(frame, "audio", (s) => got.push(s));
    await accepting.opened;
    const out = await tarot.streams.open("audio");
    await until(() => got.length === 1, "the component's stream");
    const readOut = message(readAll(got[0]!));
    accepting();
    expect(await readOut).toBe("this half stopped accepting");
    const writerOut = out.getWriter();
    await until(() => writerOut.desiredSize === null, "the host half's writable to error");
    expect(await message(writerOut.write(piece(1)))).toContain("the reader went");
    expect(hub.size).toBe(0);
  });

  test("a component's points.stream reads a contributor's handler's stream; leaving it cancels the handler's pump", async () => {
    const { hub, handlers, registry, start, state } = setup();
    await start();
    const frame = layerLike(handlers, registry, "luna");
    const bytes = await readAll(await pointStream(frame, "luna.sounds", { pluginId: "tarot", entryId: "bytes" }, "make", undefined));
    expect(Buffer.compare(Buffer.from(bytes), Buffer.from(pattern(70_000)))).toBe(0);
    const events: string[] = [];
    const stream = await pointStream(frame, "luna.sounds", { pluginId: "tarot", entryId: "endless" }, "make", undefined, undefined, (e) => events.push(e.type));
    const reader = stream.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel("enough");
    await until(() => state.endlessReturned, "the pump to stop");
    await until(() => hub.size === 0, "the stream to end");
    expect(events[0]).toBe("opened");
    // a refusal rejects
    expect(await message(pointStream(frame, "luna.sounds", { pluginId: "tarot", entryId: "bytes" }, "title", undefined))).toBe("title isn't a handler field of luna.sounds");
  });
});
