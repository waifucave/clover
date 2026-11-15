// The recorder in the clover shell (layer/clover/listen.ts): the audio source is a seam, so none of this opens a microphone or
// raises a system prompt. A fake source yields a generated clip (a tone made here; nothing from anyone's files).
import { describe, expect, test } from "bun:test";
import { Downsampler, FLUSH_BYTES, LISTEN_RATE, PIECE_BYTES, Recorder, clipSource, floatToPcm16, splitPieces, toBase64, type PcmHandle, type PcmSink, type PcmSource } from "../src/layer/clover/listen";

const tone = (seconds: number, rate: number, hz = 440): Float32Array => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate) * 0.5);
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

describe("the audio's shape", () => {
  test("float samples become 16-bit little-endian PCM, clamped", () => {
    const pcm = floatToPcm16(Float32Array.of(0, 0.5, -0.5, 1, -1, 2, -2));
    const v = new DataView(pcm.buffer);
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => v.getInt16(i * 2, true))).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768]);
    expect(pcm.length).toBe(14);
  });

  test("48 kHz and 44.1 kHz input come out at 16 kHz with the tone's level and about the right length, and 16 kHz passes through", () => {
    for (const rate of [48_000, 44_100, 32_000, 16_000]) {
      const d = new Downsampler(rate);
      const input = tone(1, rate);
      // In pieces of 4096, as the processor hands them over, so the position must carry across calls.
      const out: number[] = [];
      for (let at = 0; at < input.length; at += 4096) out.push(...d.push(input.subarray(at, at + 4096)));
      expect(Math.abs(out.length - LISTEN_RATE)).toBeLessThanOrEqual(1);
      const peak = Math.max(...out.slice(100).map(Math.abs));
      expect(peak).toBeGreaterThan(0.4);
      expect(peak).toBeLessThanOrEqual(0.51);
    }
    const same = Float32Array.of(0.1, 0.2, 0.3);
    expect([...new Downsampler(16_000).push(same)].map((x) => Math.round(x * 10))).toEqual([1, 2, 3]);
  });

  test("a rate below 16 kHz is refused (it could only be stretched)", () => {
    expect(() => new Downsampler(8_000)).toThrow("below 16 kHz");
  });

  test("a clip is cut into pieces that end on whole samples, in order, none over the size", () => {
    const bytes = new Uint8Array(1_000).map((_, i) => i % 251);
    for (const max of [100, 101, 3, 1_000, 5_000]) {
      const parts = splitPieces(bytes, max);
      expect(parts.every((p) => p.length % 2 === 0 || p === parts.at(-1))).toBe(true);
      expect(parts.every((p) => p.length <= Math.max(2, max - (max % 2)))).toBe(true);
      expect(Buffer.concat(parts)).toEqual(Buffer.from(bytes));
    }
    expect(splitPieces(new Uint8Array(0))).toEqual([]);
    expect(PIECE_BYTES % 2).toBe(0);
    // The default is the method's own limit: a piece's base64 never passes 2,000,000 characters.
    expect(toBase64(new Uint8Array(PIECE_BYTES)).length).toBeLessThanOrEqual(2_000_000);
    expect(unb64(toBase64(bytes))).toEqual(bytes);
  });
});

/** A source the test drives by hand: `emit` is the microphone producing audio. */
function fakeSource() {
  let sink!: PcmSink;
  const state = { opened: 0, stopped: 0 };
  const source: PcmSource = async (s) => {
    sink = s;
    state.opened++;
    return { stop: () => { state.stopped++; } } satisfies PcmHandle;
  };
  return { source, state, emit: (bytes: number) => sink.chunk(new Uint8Array(bytes).fill(1)), end: () => sink.end() };
}

function setup(over: { flushBytes?: number; maxMs?: number; send?: (p: { audio: string; final: boolean; problem?: true }) => Promise<unknown>; source?: PcmSource } = {}) {
  const fake = fakeSource();
  const sent: { bytes: number; final: boolean; problem?: true }[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const recorder = new Recorder({
    source: over.source ?? fake.source,
    maxMs: over.maxMs ?? 60_000,
    ...(over.flushBytes === undefined ? {} : { flushBytes: over.flushBytes }),
    send: over.send ?? (async (p) => { sent.push({ bytes: unb64(p.audio).length, final: p.final, ...(p.problem ? { problem: p.problem } : {}) }); return {}; }),
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimeout: (h) => { (h as { live: boolean }).live = false; },
  });
  return { recorder, fake, sent, timers };
}

describe("a recording: the seam's clip reaches the core as numbered pieces", () => {
  test("audio gathers into pieces of about half a second while it is made, and what is left goes as the last, marked final", async () => {
    const t = setup();
    await t.recorder.start();
    // A 1.2 s clip in 100 ms chunks of 3,200 bytes.
    for (let i = 0; i < 12; i++) t.fake.emit(3_200);
    await t.recorder.stop();
    expect(t.sent).toEqual([{ bytes: 16_000, final: false }, { bytes: 16_000, final: false }, { bytes: 6_400, final: true }]);
    expect(t.sent.reduce((a, p) => a + p.bytes, 0)).toBe(38_400);
    expect(t.recorder.pieces).toBe(3);
    expect(t.recorder.bytes).toBe(38_400);
    expect(FLUSH_BYTES).toBe(16_000);
    // The source was opened once and closed once.
    expect(t.fake.state).toEqual({ opened: 1, stopped: 1 });
  });

  test("the pieces are sent one at a time, in order: the next waits for the one before", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let n = 0;
    const t = setup({ send: async (p) => { const i = n++; order.push(`begin ${i}`); if (i === 0) await gate; order.push(`end ${i}`); return p; } });
    await t.recorder.start();
    t.fake.emit(16_000);
    t.fake.emit(16_000);
    const stopped = t.recorder.stop();
    await Promise.resolve();
    expect(order).toEqual(["begin 0"]);
    release();
    await stopped;
    // Two full pieces while it was made, then the (empty) last: never two in flight.
    expect(order).toEqual(["begin 0", "end 0", "begin 1", "end 1", "begin 2", "end 2"]);
  });

  test("a hold that is let go at once, or twice, sends one last piece and closes the source once", async () => {
    const t = setup();
    await t.recorder.start();
    await Promise.all([t.recorder.stop(), t.recorder.stop()]);
    await t.recorder.stop();
    expect(t.sent).toEqual([{ bytes: 0, final: true }]);
    expect(t.fake.state.stopped).toBe(1);
    // Audio after the end is dropped.
    t.fake.emit(3_200);
    expect(t.sent.length).toBe(1);
  });

  test("let go before the source is open: it is closed as soon as it opens, and nothing it makes is sent", async () => {
    let open!: (h: PcmHandle) => void;
    const closed: number[] = [];
    const t = setup({ source: () => new Promise((r) => { open = r; }) });
    const started = t.recorder.start();
    const stopped = t.recorder.stop();
    open({ stop: () => closed.push(1) });
    await Promise.all([started, stopped]);
    expect(closed).toEqual([1]);
    expect(t.sent).toEqual([{ bytes: 0, final: true }]);
  });

  test("a source that can't open ends the recording with a last, empty piece that says so", async () => {
    const t = setup({ source: async () => { throw new Error("NotAllowedError"); } });
    await t.recorder.start();
    expect(t.sent).toEqual([{ bytes: 0, final: true, problem: true }]);
    await t.recorder.stop();
    expect(t.sent.length).toBe(1);
  });

  test("a source that ends by itself (the device went away) ends the recording; the cap ends it too", async () => {
    const a = setup();
    await a.recorder.start();
    a.fake.emit(3_200);
    a.fake.end();
    await a.recorder.stop();
    expect(a.sent).toEqual([{ bytes: 3_200, final: true }]);
    const b = setup({ maxMs: 5_000 });
    await b.recorder.start();
    expect(b.timers.map((x) => x.ms)).toEqual([5_000]);
    b.fake.emit(3_200);
    b.timers[0]!.fn();
    await b.recorder.stop();
    expect(b.sent).toEqual([{ bytes: 3_200, final: true }]);
    expect(b.timers[0]!.live).toBe(false);
  });

  test("a piece that fails to send doesn't stop the ones after it, and is said", async () => {
    const warned: string[] = [];
    let n = 0;
    const sent: boolean[] = [];
    const fake = fakeSource();
    const recorder = new Recorder({ source: fake.source, maxMs: 1_000, send: async (p) => { if (n++ === 0) throw new Error("refused"); sent.push(p.final); return {}; }, warn: (w) => warned.push(w) });
    await recorder.start();
    fake.emit(16_000);
    fake.emit(100);
    await recorder.stop();
    expect(sent).toEqual([true]);
    expect(warned).toEqual(["a piece wasn't taken: refused"]);
  });

  test("a giant chunk is split below the piece size", async () => {
    const t = setup({ flushBytes: 10 });
    await t.recorder.start();
    t.fake.emit(PIECE_BYTES * 2 + 10);
    await t.recorder.stop();
    // Cut on whole samples within the method's size; the end is a last piece of its own (empty audio is allowed on the last).
    expect(t.sent.map((p) => p.bytes)).toEqual([PIECE_BYTES, PIECE_BYTES, 10, 0]);
    expect(t.sent.map((p) => p.final)).toEqual([false, false, false, true]);
  });
});

describe("the generated clip the test and acceptance builds use in place of a microphone", () => {
  test("it makes the same 1.2 s of tone every time, whatever the hold's length, and stops when closed", async () => {
    const chunks: number[] = [];
    const handle = await clipSource({ everyMs: 1 })({ chunk: (p) => chunks.push(p.length), end: () => undefined });
    await new Promise((r) => setTimeout(r, 60));
    handle.stop();
    expect(chunks.reduce((a, b) => a + b, 0)).toBe(38_400);
    expect(chunks.length).toBe(12);
    const after = chunks.length;
    await new Promise((r) => setTimeout(r, 10));
    expect(chunks.length).toBe(after);
  });
});
