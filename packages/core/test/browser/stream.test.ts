import { describe, expect, test } from "bun:test";
import type { LinkView } from "@waifucave/clover-protocol";
import type { Link, LinkPriority, LinkStream, LinkTransport } from "../../src/contracts/link-transport";
import { FakeLinkNetwork } from "../../src/contracts/fakes/link-transport";
import type { AppTabCommand, StreamChunk, TabView } from "../../src/browser/contract";
import type { AppTabPort } from "../../src/browser/service";
import {
  decodeStreamFrame, encodeStreamFrame, STREAM_LINK_LABEL, StreamFrameReader, TabStreams, type StreamLinkMeta,
} from "../../src/browser/stream";

/** A viewer's link stream whose writes resolve only when the test says so (a slow link), or at once. */
class SlowStream implements LinkStream {
  readonly id: string;
  readonly written: StreamChunk[] = [];
  readonly pending: (() => void)[] = [];
  auto = true;
  ended = false;
  aborted: string | undefined;
  private endFns = new Set<(error?: Error) => void>();

  constructor(readonly label: string, readonly priority: LinkPriority, readonly meta: unknown, n: number) {
    this.id = `ls_${n}`;
  }

  write(chunk: Uint8Array): Promise<void> {
    if (this.ended || this.aborted !== undefined) return Promise.reject(new Error("closed"));
    this.written.push(decodeStreamFrame(chunk));
    if (this.auto) return Promise.resolve();
    return new Promise((resolve) => this.pending.push(resolve));
  }

  /** The link takes what was written. */
  async drain(): Promise<void> {
    for (const r of this.pending.splice(0)) r();
    await flush();
  }

  end(): void {
    this.ended = true;
  }

  abort(reason?: string): void {
    this.aborted = reason ?? "aborted";
  }

  onData(): () => void {
    return () => {};
  }

  onEnd(fn: (error?: Error) => void): () => void {
    this.endFns.add(fn);
    return () => this.endFns.delete(fn);
  }

  /** The receiver went away. */
  cut(): void {
    for (const fn of this.endFns) fn(new Error("closed"));
  }

  kinds(): string[] {
    return this.written.map((c) => (c.kind === "frame" ? (c.key ? "key" : "delta") : c.kind));
  }
}

class FakeTransport implements Pick<LinkTransport, "connect" | "watch"> {
  readonly streams: SlowStream[] = [];
  private watchers = new Set<(v: LinkView) => void>();
  offline = new Set<string>();

  async connect(peer: string): Promise<Link> {
    if (this.offline.has(peer)) throw new Error(`${peer} can't be reached`);
    const streams = this.streams;
    return {
      peer,
      view: () => ({ peer, up: true }),
      request: async () => undefined as never,
      notify: () => {},
      openStream: (label: string, priority: LinkPriority, meta?: unknown) => {
        const s = new SlowStream(label, priority, meta, streams.length + 1);
        streams.push(s);
        return s;
      },
    };
  }

  watch(fn: (v: LinkView) => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  down(peer: string): void {
    for (const fn of this.watchers) fn({ peer, up: false });
  }
}

class FakeApp implements AppTabPort {
  readonly commands: { id: string; command: AppTabCommand }[] = [];
  fail?: Error;
  async open(): Promise<TabView> {
    throw new Error("not here");
  }
  async command(id: string, command: AppTabCommand): Promise<unknown> {
    this.commands.push({ id, command });
    if (this.fail) throw this.fail;
    return null;
  }
  async list(): Promise<TabView[]> {
    return [];
  }
  of(kind: AppTabCommand["kind"]): AppTabCommand[] {
    return this.commands.filter((c) => c.command.kind === kind).map((c) => c.command);
  }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const config: StreamChunk = { kind: "config", codec: "h264", width: 1280, height: 800, codecString: "avc1.42E028" };
const frame = (key: boolean, t: number, size = 1000): StreamChunk => ({ kind: "frame", key, timestamp: t * 33_333, data: new Uint8Array(size).fill(key ? 7 : 3) });

function setup(tuning: Record<string, number> = {}) {
  const transport = new FakeTransport();
  const app = new FakeApp();
  let now = 1_000_000;
  let n = 0;
  const ended: { stream: string; reason: string }[] = [];
  const streams = new TabStreams({
    computer: "Studio", transport, app: () => app, now: () => now, newId: () => `id_${++n}`,
    tuning: { highWaterBytes: 10_000, ...tuning }, ended: (e) => ended.push(e),
  });
  const appStream = (): string => {
    const c = app.of("stream").at(-1) as Extract<AppTabCommand, { kind: "stream" }>;
    return c.stream;
  };
  return { transport, app, streams, appStream, ended, tick: (ms: number) => { now += ms; } };
}

describe("the link stream's frame format", () => {
  test("every kind round-trips, the key flag and the timestamp included", () => {
    const chunks: StreamChunk[] = [
      config,
      { kind: "config", codec: "vp8", width: 1001, height: 77, codecString: "vp8" },
      { kind: "frame", key: true, timestamp: 0, data: new Uint8Array([0, 0, 0, 1, 0x67, 0x42]) },
      { kind: "frame", key: false, timestamp: 9_007_199_254_740, data: new Uint8Array(70_000).fill(9) },
      { kind: "frame", key: false, timestamp: 5, data: new Uint8Array(0) },
      { kind: "ended", reason: "stopped" },
      { kind: "ended", reason: "failed", message: "the encoder failed: no memory" },
    ];
    for (const c of chunks) expect(decodeStreamFrame(encodeStreamFrame(c))).toEqual(c);
  });

  test("the header is what the file documents", () => {
    const bytes = encodeStreamFrame({ kind: "frame", key: true, timestamp: 0x0102030405, data: new Uint8Array([0xaa, 0xbb]) });
    expect([...bytes]).toEqual([1, 2, 1, 0, 0, 0, 0, 0x01, 0x02, 0x03, 0x04, 0x05, 0, 0, 0, 2, 0xaa, 0xbb]);
    const cfg = encodeStreamFrame(config);
    expect(cfg[1]).toBe(1);
    expect(JSON.parse(new TextDecoder().decode(cfg.subarray(16)))).toEqual({ codec: "h264", width: 1280, height: 800, codecString: "avc1.42E028" });
  });

  test("bad bytes are refused", () => {
    const good = encodeStreamFrame(frame(true, 1));
    expect(() => decodeStreamFrame(good.subarray(0, 10))).toThrow();
    expect(() => decodeStreamFrame(good.subarray(0, good.length - 1))).toThrow(/length/);
    const v2 = good.slice();
    v2[0] = 2;
    expect(() => decodeStreamFrame(v2)).toThrow(/version/);
    const k9 = good.slice();
    k9[1] = 9;
    expect(() => decodeStreamFrame(k9)).toThrow(/kind/);
  });

  test("a reader splits frames that arrive as one run, cut anywhere", () => {
    const chunks = [config, frame(true, 0, 300), frame(false, 1, 20), { kind: "ended", reason: "closed" } as StreamChunk];
    const all = new Uint8Array(chunks.reduce((n, c) => n + encodeStreamFrame(c).length, 0));
    let at = 0;
    for (const c of chunks) {
      const b = encodeStreamFrame(c);
      all.set(b, at);
      at += b.length;
    }
    const reader = new StreamFrameReader();
    const out: StreamChunk[] = [];
    for (let i = 0; i < all.length; i += 7) out.push(...reader.push(all.subarray(i, i + 7)));
    expect(out).toEqual(chunks);
  });
});

describe("TabStreams", () => {
  test("a stream opens a low-priority link stream, asks the app, and starts with a config and a keyframe", async () => {
    const { transport, app, streams, appStream } = setup();
    const { stream } = await streams.start({ tab: "tab_1", device: "phone", maxKbps: 3000, codecs: ["h264"] });
    const link = transport.streams[0]!;
    expect(link.label).toBe(STREAM_LINK_LABEL);
    expect(link.priority).toBe("screenshots");
    expect(link.meta as StreamLinkMeta).toEqual({ v: 1, stream, tab: "tab_1", computer: "Studio" });
    expect(app.commands).toEqual([{ id: "tab_1", command: { kind: "stream", stream: appStream(), on: true, maxKbps: 3000, codecs: ["h264"] } }]);
    // Deltas before the first keyframe (or anything before the config) never reach the viewer.
    streams.data(appStream(), frame(false, 0));
    streams.data(appStream(), config);
    streams.data(appStream(), frame(false, 1));
    streams.data(appStream(), frame(true, 2));
    streams.data(appStream(), frame(false, 3));
    await flush();
    expect(link.kinds()).toEqual(["config", "key", "delta"]);
    expect(streams.list()[0]).toMatchObject({ stream, codec: "h264", kbps: 3000, waitingForKey: false, sent: 2 });
    // The same pair again answers the same stream.
    expect((await streams.start({ tab: "tab_1", device: "phone" })).stream).toBe(stream);
    expect(transport.streams.length).toBe(1);
  });

  test("falling behind drops deltas until a keyframe, asks for one and lowers the bitrate; keeping up raises it", async () => {
    const { transport, app, streams, appStream, tick } = setup();
    await streams.start({ tab: "tab_1", device: "phone", maxKbps: 2000 });
    const link = transport.streams[0]!;
    const s = appStream();
    streams.data(s, config);
    streams.data(s, frame(true, 0, 4000));
    await flush();
    link.auto = false; // the link slows down
    for (let i = 1; i <= 3; i++) streams.data(s, frame(false, i, 4000)); // 12 KB written, unanswered (high mark 10 KB)
    await flush();
    expect(link.kinds()).toEqual(["config", "key", "delta", "delta", "delta"]);
    tick(33);
    streams.data(s, frame(false, 5, 4000)); // over the mark: behind
    streams.data(s, frame(false, 6, 4000));
    await flush();
    expect(link.kinds().length).toBe(5); // both dropped
    expect(streams.list()[0]).toMatchObject({ waitingForKey: true, kbps: 1200, lowered: 1 });
    const controls = app.of("stream-control");
    expect(controls).toContainEqual({ kind: "stream-control", stream: s, kbps: 1200 });
    // A keyframe while the link is still full is dropped too: newest only.
    streams.data(s, frame(true, 7, 4000));
    await flush();
    expect(link.kinds().length).toBe(5);
    // The link catches up: a keyframe is asked for at once, and deltas still wait for it.
    await link.drain();
    expect(app.of("stream-control")).toContainEqual({ kind: "stream-control", stream: s, keyframe: true });
    link.auto = true;
    streams.data(s, frame(false, 8));
    streams.data(s, frame(true, 9));
    streams.data(s, frame(false, 10));
    await flush();
    expect(link.kinds().slice(5)).toEqual(["key", "delta"]);
    expect(streams.list()[0]).toMatchObject({ waitingForKey: false, kbps: 1200 });
    // Kept up for the while: raised, step by step, never past maxKbps.
    let t = 11;
    for (let k = 0; k < 6; k++) {
      tick(4100);
      streams.data(s, frame(false, t++));
    }
    await flush();
    const kbps = app.of("stream-control").flatMap((c) => (c.kind === "stream-control" && c.kbps !== undefined ? [c.kbps] : []));
    expect(kbps).toEqual([1200, 1500, 1875, 2000]);
    expect(streams.list()[0]).toMatchObject({ kbps: 2000, raised: 3 });
  });

  test("a lowering happens at most once a second, and never below the floor", async () => {
    const { transport, streams, appStream, tick } = setup({ minKbps: 500 });
    await streams.start({ tab: "tab_1", device: "phone", maxKbps: 1000 });
    const link = transport.streams[0]!;
    const s = appStream();
    streams.data(s, config);
    streams.data(s, frame(true, 0));
    link.auto = false;
    for (let i = 1; i < 40; i++) {
      tick(100);
      streams.data(s, frame(i % 10 === 0, i, 3000));
    }
    await flush();
    const info = streams.list()[0]!;
    expect(info.kbps).toBe(500);
    expect(info.lowered).toBe(2); // 1000 → 600 → 500, then the floor
    expect(info.waitingForKey).toBe(true);
  });

  test("a second device on the same tab shares the encoder, at the lower bitrate, with its own config and keyframe", async () => {
    const { transport, app, streams, appStream } = setup();
    await streams.start({ tab: "tab_1", device: "phone", maxKbps: 3000 });
    const s = appStream();
    streams.data(s, config);
    streams.data(s, frame(true, 0));
    await streams.start({ tab: "tab_1", device: "laptop", maxKbps: 800 });
    expect(app.of("stream").length).toBe(1);
    expect(app.of("stream-control")).toEqual([{ kind: "stream-control", stream: s, keyframe: true }, { kind: "stream-control", stream: s, kbps: 800 }]);
    streams.data(s, frame(false, 1));
    streams.data(s, frame(true, 2));
    await flush();
    expect(transport.streams[0]!.kinds()).toEqual(["config", "key", "delta", "key"]);
    expect(transport.streams[1]!.kinds()).toEqual(["config", "key"]);
    // A viewer that decodes only VP8 gets an encoder of its own.
    await streams.start({ tab: "tab_1", device: "tablet", codecs: ["vp8"] });
    expect(app.of("stream").length).toBe(2);
    // The first viewer stopping leaves the encoder to the second, at its own bitrate; the last one stops it.
    await streams.stop({ tab: "tab_1", device: "laptop" });
    expect(app.of("stream").length).toBe(2);
    await streams.stop({ tab: "tab_1", device: "phone" });
    expect(app.of("stream").at(-1)).toEqual({ kind: "stream", stream: s, on: false });
  });

  test("stop, the tab closing and the device going each end the stream; the app hears `off` only when it should", async () => {
    const { transport, app, streams, appStream, ended } = setup();
    // Stop: an `ended` frame, the link stream ended, the app's encoder off.
    await streams.start({ tab: "tab_1", device: "phone" });
    const s1 = appStream();
    streams.data(s1, config);
    await streams.stop({ tab: "tab_1", device: "phone" });
    await flush();
    expect(transport.streams[0]!.written.at(-1)).toEqual({ kind: "ended", reason: "stopped" });
    expect(transport.streams[0]!.ended).toBe(true);
    expect(app.of("stream").at(-1)).toEqual({ kind: "stream", stream: s1, on: false });
    // The tab closes: `ended` closed; nothing to stop in the app.
    await streams.start({ tab: "tab_2", device: "phone" });
    const s2 = appStream();
    const before = app.commands.length;
    streams.tabClosed("tab_2");
    await flush();
    expect(transport.streams[1]!.written.at(-1)).toEqual({ kind: "ended", reason: "closed" });
    expect(transport.streams[1]!.ended).toBe(true);
    expect(app.commands.length).toBe(before);
    streams.data(s2, frame(true, 1)); // late chunks go nowhere
    expect(transport.streams[1]!.written.length).toBe(1);
    // The device's link goes down: its streams go quietly, and the app's encoder stops.
    await streams.start({ tab: "tab_3", device: "phone" });
    const s3 = appStream();
    transport.down("phone");
    expect(transport.streams[2]!.aborted).toBeDefined();
    expect(app.of("stream").at(-1)).toEqual({ kind: "stream", stream: s3, on: false });
    // The receiver ends its side: the same.
    await streams.start({ tab: "tab_4", device: "phone" });
    const s4 = appStream();
    transport.streams[3]!.cut();
    expect(app.of("stream").at(-1)).toEqual({ kind: "stream", stream: s4, on: false });
    // The app's own `ended` (its encoder failed) goes to the viewer and ends the stream; nothing to stop.
    await streams.start({ tab: "tab_5", device: "phone" });
    const s5 = appStream();
    const n5 = app.commands.length;
    streams.data(s5, { kind: "ended", reason: "failed", message: "encoder error" });
    await flush();
    expect(transport.streams[4]!.written.at(-1)).toEqual({ kind: "ended", reason: "failed", message: "encoder error" });
    expect(app.commands.length).toBe(n5);
    expect(streams.list()).toEqual([]);
    // The app goes away (restarts): its encoders are gone, so its streams end, and there is nothing to stop.
    await streams.start({ tab: "tab_6", device: "phone" });
    const n6 = app.commands.length;
    streams.appGone();
    await flush();
    expect(transport.streams[5]!.written.at(-1)).toEqual({ kind: "ended", reason: "failed", message: "the Clover app stopped" });
    expect(transport.streams[5]!.ended).toBe(true);
    expect(app.commands.length).toBe(n6);
    expect(ended.map((e) => e.reason)).toEqual(["stopped", "closed", "gone", "gone", "failed", "failed"]);
  });

  test("an offline device, no app or an app that can't stream fail the start and leave nothing behind", async () => {
    const { transport, app, streams } = setup();
    transport.offline.add("phone");
    await expect(streams.start({ tab: "tab_1", device: "phone" })).rejects.toThrow(/reached/);
    transport.offline.clear();
    app.fail = new Error("this app doesn't stream tabs yet");
    await expect(streams.start({ tab: "tab_1", device: "phone" })).rejects.toMatchObject({ code: "app_failed" });
    expect(transport.streams[0]!.aborted).toBeDefined();
    expect(streams.list()).toEqual([]);
    const none = new TabStreams({ computer: "Studio", transport, app: () => undefined });
    await expect(none.start({ tab: "tab_1", device: "phone" })).rejects.toMatchObject({ code: "no_app" });
  });

  test("over the in-memory link network: the receiving device reads config, keyframe and deltas; a partition ends it", async () => {
    const net = new FakeLinkNetwork();
    const studio = net.endpoint("studio");
    const phone = net.endpoint("phone");
    const got: StreamChunk[] = [];
    let ended: Error | undefined | null = null;
    let meta: unknown;
    phone.onStream(STREAM_LINK_LABEL, (stream, m) => {
      meta = m;
      stream.onData((b) => got.push(decodeStreamFrame(b)));
      stream.onEnd((e) => { ended = e; });
    });
    const app = new FakeApp();
    const streams = new TabStreams({ computer: "Studio", transport: studio, app: () => app });
    const { stream } = await streams.start({ tab: "tab_1", device: "phone" });
    const s = (app.of("stream")[0] as Extract<AppTabCommand, { kind: "stream" }>).stream;
    streams.data(s, config);
    streams.data(s, frame(true, 0));
    streams.data(s, frame(false, 1));
    await flush();
    expect((meta as StreamLinkMeta).stream).toBe(stream);
    expect(got.map((c) => c.kind === "frame" ? (c.key ? "key" : "delta") : c.kind)).toEqual(["config", "key", "delta"]);
    net.partition("studio", "phone");
    await flush();
    expect(streams.list()).toEqual([]);
    expect(app.of("stream").at(-1)).toEqual({ kind: "stream", stream: s, on: false });
    expect(ended).not.toBeNull();
  });
});
