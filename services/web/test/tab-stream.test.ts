// A computer's tab streamed to the page (`browser.stream`): the frames lane L's sender writes, split and decoded. The
// golden bytes below are what L's `encodeStreamFrame` (packages/core/src/browser/stream.ts) wrote for these chunks.

import { describe, expect, test } from "bun:test";

import { decodeStreamFrame, STREAM_MAX_PAYLOAD, StreamFrameReader, StreamFormatError, type StreamChunk } from "../protocol/browser-stream";
import type { LinkStream } from "../protocol/rtc-link";
import { decodableCodecs, receiveTabStreams, type TabPicture, type TabStreamDecoders, TabStreamView } from "../src/tab-stream";

const hex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const GOLDEN = {
  jpegConfig: hex("0101000000000000000000000000003f7b22636f646563223a226a706567222c227769647468223a313238302c22686569676874223a3830302c22636f646563537472696e67223a226a706567227d"),
  jpegKey: hex("01020100000642fc026c8a4000000004ffd8ffd9"),
  delta: hex("010200000000000000008235000000050000000141"),
  ended: hex("0103000000000000000000000000002e7b22726561736f6e223a22636c6f736564222c226d657373616765223a227468652074616220636c6f736564227d"),
};

function frame(kind: 1 | 2 | 3, payload: Uint8Array, opts: { key?: boolean; ts?: number } = {}): Uint8Array {
  const out = new Uint8Array(16 + payload.byteLength);
  const v = new DataView(out.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, kind);
  v.setUint8(2, opts.key ? 1 : 0);
  v.setBigInt64(4, BigInt(opts.ts ?? 0));
  v.setUint32(12, payload.byteLength);
  out.set(payload, 16);
  return out;
}
const config = (codec: string, codecString: string) => frame(1, new TextEncoder().encode(JSON.stringify({ codec, width: 640, height: 400, codecString })));
const pic = (n: number, key = true, ts = n) => frame(2, new Uint8Array([n]), { key, ts });

describe("the stream's frames", () => {
  test("lane L's encoder's bytes decode to its chunks", () => {
    expect(decodeStreamFrame(GOLDEN.jpegConfig)).toEqual({ kind: "config", codec: "jpeg", width: 1280, height: 800, codecString: "jpeg" });
    expect(decodeStreamFrame(GOLDEN.jpegKey)).toEqual({ kind: "frame", key: true, timestamp: 1_762_500_000_123_456, data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) });
    expect(decodeStreamFrame(GOLDEN.delta)).toEqual({ kind: "frame", key: false, timestamp: 33_333, data: new Uint8Array([0, 0, 0, 1, 0x41]) });
    expect(decodeStreamFrame(GOLDEN.ended)).toEqual({ kind: "ended", reason: "closed", message: "the tab closed" });
  });

  test("a run of bytes splits into frames however it arrives", () => {
    const run = new Uint8Array([...GOLDEN.jpegConfig, ...GOLDEN.jpegKey, ...GOLDEN.delta, ...GOLDEN.ended]);
    const reader = new StreamFrameReader();
    const got: StreamChunk[] = [];
    for (const b of run) got.push(...reader.push(new Uint8Array([b])));
    expect(got.map((c) => c.kind)).toEqual(["config", "frame", "frame", "ended"]);
    expect(new StreamFrameReader().push(run)).toEqual(got);
  });

  test("a header claiming more than any picture is refused before anything is buffered", () => {
    const head = new Uint8Array(16);
    const v = new DataView(head.buffer);
    v.setUint8(0, 1);
    v.setUint8(1, 2);
    v.setUint32(12, STREAM_MAX_PAYLOAD + 1);
    expect(() => new StreamFrameReader().push(head)).toThrow(StreamFormatError);
    expect(() => decodeStreamFrame(frame(1, new TextEncoder().encode("[]")))).toThrow(StreamFormatError);
    expect(() => decodeStreamFrame(frame(1, new TextEncoder().encode(JSON.stringify({ codec: "av1", width: 1, height: 1, codecString: "av01" }))))).toThrow(StreamFormatError);
    const v2 = GOLDEN.delta.slice();
    v2[0] = 2;
    expect(() => decodeStreamFrame(v2)).toThrow(StreamFormatError);
  });
});

/** JPEG decodes that finish when the test says. */
function images() {
  const pending: { bytes: number; resolve: () => void; reject: () => void }[] = [];
  const closed: number[] = [];
  const decoders: TabStreamDecoders = {
    decodeImage: (jpeg) =>
      new Promise<TabPicture>((resolve, reject) => {
        const n = jpeg[0]!;
        pending.push({ bytes: n, resolve: () => resolve({ image: {} as CanvasImageSource, width: 640, height: n, close: () => closed.push(n) }), reject });
      }),
  };
  return { decoders, pending, closed };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("a JPEG stream (a headless computer's)", () => {
  test("each frame is a picture; while one decodes only the newest waits", async () => {
    const im = images();
    const shown: number[] = [];
    const view = new TabStreamView({ decoders: im.decoders, onPicture: (p) => shown.push(p.height) });
    view.push(new Uint8Array([...config("jpeg", "jpeg"), ...pic(1), ...pic(2), ...pic(3)]));
    expect(im.pending.map((p) => p.bytes)).toEqual([1]);
    im.pending[0]!.resolve();
    await tick();
    expect(shown).toEqual([1]);
    expect(im.pending.map((p) => p.bytes)).toEqual([1, 3]); // 2 was overtaken by 3
    im.pending[1]!.resolve();
    await tick();
    expect(shown).toEqual([1, 3]);
  });

  test("works with no video decoder at all, and a bad picture is skipped", async () => {
    const im = images();
    const shown: number[] = [];
    const errors: string[] = [];
    const view = new TabStreamView({ decoders: im.decoders, onPicture: (p) => shown.push(p.height), onError: (m) => errors.push(m) });
    view.push(GOLDEN.jpegConfig);
    view.push(pic(7));
    im.pending[0]!.reject();
    await tick();
    view.push(pic(8));
    im.pending[1]!.resolve();
    await tick();
    expect(shown).toEqual([8]);
    expect(errors).toEqual([]);
  });

  test("a picture that finishes after the stream ended is closed, not shown; the ended frame is reported", async () => {
    const im = images();
    const shown: number[] = [];
    const ended: unknown[] = [];
    const view = new TabStreamView({ decoders: im.decoders, onPicture: (p) => shown.push(p.height), onEnded: (e) => ended.push(e) });
    view.push(new Uint8Array([...config("jpeg", "jpeg"), ...pic(4), ...GOLDEN.ended]));
    im.pending[0]!.resolve();
    await tick();
    expect(shown).toEqual([]);
    expect(im.closed).toEqual([4]);
    expect(ended).toEqual([{ reason: "closed", message: "the tab closed" }]);
    expect(view.ended).toBe(true);
  });
});

/** A WebCodecs stand-in: records configures and decodes, and can err. */
function video(supported: string[] = ["avc1.42E033", "vp8"]) {
  const log: string[] = [];
  const instances: FakeDecoder[] = [];
  class FakeDecoder {
    state: CodecState = "unconfigured";
    constructor(readonly init: VideoDecoderInit) {
      instances.push(this);
    }
    configure(c: VideoDecoderConfig) {
      this.state = "configured";
      log.push(`configure ${c.codec} ${c.codedWidth}x${c.codedHeight} ${c.optimizeForLatency}`);
    }
    decode(chunk: { type: string; timestamp: number; data: Uint8Array }) {
      log.push(`decode ${chunk.type} ${chunk.timestamp}`);
      this.init.output({ displayWidth: 640, displayHeight: chunk.timestamp, close: () => log.push(`close frame ${chunk.timestamp}`) } as unknown as VideoFrame);
    }
    close() {
      this.state = "closed";
      log.push("close decoder");
    }
    fail() {
      this.state = "closed";
      this.init.error(new DOMException("bad"));
    }
    static async isConfigSupported(c: VideoDecoderConfig) {
      return { supported: supported.includes(c.codec), config: c };
    }
  }
  class FakeChunk {
    constructor(init: { type: string; timestamp: number; data: Uint8Array }) {
      Object.assign(this, init);
    }
  }
  const decoders: TabStreamDecoders = {
    decodeImage: () => Promise.reject(new Error("not here")),
    VideoDecoder: FakeDecoder as unknown as typeof VideoDecoder,
    EncodedVideoChunk: FakeChunk as unknown as typeof EncodedVideoChunk,
  };
  return { decoders, log, instances };
}

describe("an H.264 or VP8 stream", () => {
  test("configured from the config, deltas before the first keyframe dropped", () => {
    const v = video();
    const shown: number[] = [];
    const view = new TabStreamView({ decoders: v.decoders, onPicture: (p) => shown.push(p.height) });
    view.push(new Uint8Array([...config("h264", "avc1.42E01F"), ...pic(1, false, 10), ...pic(2, true, 20), ...pic(3, false, 30)]));
    expect(v.log).toEqual(["configure avc1.42E01F 640x400 true", "decode key 20", "decode delta 30"]);
    expect(shown).toEqual([20, 30]);
  });

  test("a decoder error waits for the next keyframe on a new decoder; a new config replaces the decoder", () => {
    const v = video();
    const view = new TabStreamView({ decoders: v.decoders, onPicture: (p) => p.close() });
    view.push(new Uint8Array([...config("vp8", "vp8"), ...pic(1, true, 1)]));
    v.instances[0]!.fail();
    view.push(new Uint8Array([...pic(2, false, 2), ...pic(3, true, 3)]));
    expect(v.instances).toHaveLength(2);
    view.push(config("h264", "avc1.42E028"));
    view.push(pic(4, false, 4));
    expect(v.log).toEqual([
      "configure vp8 640x400 true", "decode key 1", "close frame 1",
      "configure vp8 640x400 true", "decode key 3", "close frame 3",
      "close decoder", "configure avc1.42E028 640x400 true",
    ]);
  });

  test("a browser without WebCodecs says it can't, and the view gives up", () => {
    const errors: string[] = [];
    const view = new TabStreamView({ decoders: images().decoders, onPicture: () => {}, onError: (m) => errors.push(m) });
    view.push(config("h264", "avc1.42E01F"));
    expect(errors).toEqual(["this browser can't decode h264 video"]);
    expect(view.closed).toBe(true);
    expect(view.ended).toBe(false);
  });

  test("decodableCodecs asks the browser, best first, and always offers JPEG", async () => {
    expect(await decodableCodecs(video().decoders)).toEqual(["h264", "vp8", "jpeg"]);
    expect(await decodableCodecs(video(["vp8"]).decoders)).toEqual(["vp8", "jpeg"]);
    expect(await decodableCodecs(images().decoders)).toEqual(["jpeg"]);
  });
});

describe("the link's browser.stream streams", () => {
  function fakeStream() {
    let data: ((b: Uint8Array) => void) | undefined;
    let end: ((e?: Error) => void) | undefined;
    const aborted: string[] = [];
    const stream = {
      id: "s1", label: "browser.stream", priority: "screenshots",
      write: async () => {}, end: () => {},
      abort: (r?: string) => aborted.push(r ?? ""),
      onData: (fn: (b: Uint8Array) => void) => ((data = fn), () => (data = undefined)),
      onEnd: (fn: (e?: Error) => void) => ((end = fn), () => (end = undefined)),
    } as unknown as LinkStream;
    return { stream, aborted, send: (b: Uint8Array) => data?.(b), finish: () => end?.() };
  }

  test("each goes to its view by meta; a malformed one is refused; a broken frame aborts it", () => {
    let handler: ((s: LinkStream, meta: unknown) => void) | undefined;
    const link = { onStream: (label: string, fn: (s: LinkStream, meta: unknown) => void) => (expect(label).toBe("browser.stream"), (handler = fn), () => {}) };
    const opened: string[] = [];
    receiveTabStreams(link, (meta) => (opened.push(`${meta.computer}/${meta.tab}/${meta.stream}`), new TabStreamView({ decoders: images().decoders, onPicture: () => {} })));

    const bad = fakeStream();
    handler!(bad.stream, { v: 2, stream: "x", tab: "t", computer: "c" });
    expect(bad.aborted).toEqual(["not a stream this reads"]);

    const good = fakeStream();
    handler!(good.stream, { v: 1, stream: "st_1", tab: "tab_1", computer: "Studio" });
    expect(opened).toEqual(["Studio/tab_1/st_1"]);
    good.send(GOLDEN.jpegConfig);
    good.send(GOLDEN.ended);
    expect(good.aborted).toEqual([]); // the computer ended it: nothing to abort

    const broken = fakeStream();
    handler!(broken.stream, { v: 1, stream: "st_2", tab: "tab_1", computer: "Studio" });
    broken.send(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 0, 0, 0, 0]));
    expect(broken.aborted).toEqual(["can't show it"]);
  });
});
