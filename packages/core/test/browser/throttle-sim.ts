// A throttled link for the stream's sender (`TabStreams`), in virtual time: a wire with a bandwidth that changes over
// a scenario, in front of a FakeLinkNetwork's in-memory link, an encoder that follows the sender's bitrate and
// keyframe requests, and the receiving device's view of what arrived. `write()` resolves once the wire has taken the
// bytes (less `sndbufBytes`, the slack a real socket or QUIC stream has), as lane H confirmed it does, so the sender's
// backpressure here is the backpressure it gets from a real link. Used by `stream-throttle.test.ts` and
// `stream-measure.ts` (which sweeps the thresholds). Nothing here is part of the product.
import type { LinkView } from "@waifucave/clover-protocol";
import { FakeLinkNetwork } from "../../src/contracts/fakes/link-transport";
import type { Link, LinkPriority, LinkStream } from "../../src/contracts/link-transport";
import type { AppTabCommand, StreamChunk, TabView } from "../../src/browser/contract";
import type { AppTabPort } from "../../src/browser/service";
import { decodeStreamFrame, encodeStreamAck, DEFAULT_STREAM_TUNING, STREAM_LINK_LABEL, TabStreams, type StreamTuning } from "../../src/browser/stream";

export interface Scenario {
  name: string;
  durationMs: number;
  /** The wire's capacity at `t` ms, in kbit/s. */
  capacityKbps(t: number): number;
  /** What the viewer asks for at most (the sender's `maxKbps`). */
  maxKbps?: number;
}

export interface SimOptions {
  tuning?: Partial<StreamTuning>;
  /** What the wire has taken without the receiver having it yet: a socket's buffer. 0 = resolves when sent. */
  sndbufBytes?: number;
  /** One-way delay of the link, ms. */
  latencyMs?: number;
  /** The app's reaction time to a `stream-control`, ms. */
  controlMs?: number;
  /** Frames per second the encoder makes. */
  fps?: number;
  /** How many times larger a keyframe is than the average delta frame. */
  keyRatio?: number;
  seed?: number;
  /** The receiver acknowledges each frame (the format's acks), over a reverse path of one `latencyMs` delay. */
  acks?: boolean;
}

export interface Metrics {
  scenario: string;
  /** Frames the receiver got, and the share of frames the encoder made that never arrived (dropped by the sender). */
  delivered: number;
  made: number;
  droppedShare: number;
  /** Seconds in which the picture stood still for more than half a second (the gaps beyond 500 ms, summed). */
  frozenSec: number;
  /** Seconds the picture was more than half a second behind (by the frames that arrived). */
  laggingSec: number;
  latencyP50: number;
  latencyP95: number;
  latencyMax: number;
  /** Delivered bits over what the wire could carry (up to the asked maximum): how much of the link it used. */
  utilization: number;
  /** The mean bitrate asked of the encoder, over the capacity (or the maximum if lower). 1 = asking just what fits. */
  askRatio: number;
  keyframes: number;
  lowered: number;
  raised: number;
  /** The sum the sweep ranks by (lower is better). */
  score: number;
}

class Lcg {
  constructor(private s: number) {}
  next(): number {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 0x100000000;
  }
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

interface Held {
  bytes: number;
  cumEnd: number;
  chunk: Uint8Array;
  inner: LinkStream;
  resolve(): void;
  reject(e: Error): void;
  resolved: boolean;
  deliverAt?: number;
}

/** The wire: bytes leave at the capacity of the moment; a write resolves when all but `sndbuf` of it has left, and the
 *  receiver has it a one-way delay after the last byte left. */
class Wire {
  private sent = 0;
  private queued = 0;
  private readonly held: Held[] = [];
  constructor(private readonly capacity: (t: number) => number, private readonly sndbuf: number, private readonly latency: number) {}

  enqueue(chunk: Uint8Array, inner: LinkStream): Promise<void> {
    this.queued += chunk.byteLength;
    return new Promise<void>((resolve, reject) => {
      this.held.push({ bytes: chunk.byteLength, cumEnd: this.queued, chunk, inner, resolve, reject, resolved: false });
    });
  }

  /** The bytes written and not yet taken (what the sender's own backlog counts, plus the buffer). */
  get inFlight(): number {
    return this.queued - this.sent;
  }

  step(t: number, dtMs: number): void {
    const room = this.queued - this.sent;
    this.sent += Math.min(room, (this.capacity(t) * 125 * dtMs) / 1000);
    for (const h of this.held) {
      if (!h.resolved && this.sent >= h.cumEnd - this.sndbuf) {
        h.resolved = true;
        h.resolve();
      }
      if (h.deliverAt === undefined && this.sent >= h.cumEnd) h.deliverAt = t + this.latency;
    }
    while (this.held.length > 0 && this.held[0]!.deliverAt !== undefined && this.held[0]!.deliverAt <= t) {
      const h = this.held.shift()!;
      void h.inner.write(h.chunk).catch(() => undefined);
    }
  }
}

class ThrottledTransport {
  constructor(private readonly wire: Wire, private readonly inner: ReturnType<FakeLinkNetwork["endpoint"]>) {}
  async connect(peer: string): Promise<Link> {
    const link = await this.inner.connect(peer);
    const wire = this.wire;
    return {
      peer: link.peer,
      view: () => link.view(),
      request: (m, p, o) => link.request(m, p, o),
      notify: (m, p, o) => link.notify(m, p, o),
      openStream: (label: string, priority: LinkPriority, meta?: unknown): LinkStream => {
        const inner = link.openStream(label, priority, meta);
        return {
          id: inner.id,
          label: inner.label,
          priority: inner.priority,
          write: (chunk) => wire.enqueue(chunk.slice(), inner),
          end: () => inner.end(),
          abort: (r) => inner.abort(r),
          onData: (fn) => inner.onData(fn),
          onEnd: (fn) => inner.onEnd(fn),
        };
      },
    };
  }
  watch(fn: (v: LinkView) => void): () => void {
    return this.inner.watch(fn);
  }
}

class SimApp implements AppTabPort {
  stream = "";
  kbps = 0;
  keyframeAt: number | undefined;
  private pending: { at: number; kbps?: number; keyframe?: boolean }[] = [];
  constructor(private readonly now: () => number, private readonly controlMs: number) {}
  async configure(): Promise<void> {}
  async open(): Promise<TabView> {
    throw new Error("not here");
  }
  async list(): Promise<TabView[]> {
    return [];
  }
  async command(_id: string, c: AppTabCommand): Promise<unknown> {
    if (c.kind === "stream" && c.on) {
      this.stream = c.stream;
      this.kbps = c.maxKbps ?? 0;
    } else if (c.kind === "stream-control") {
      this.pending.push({ at: this.now() + this.controlMs, ...(c.kbps !== undefined ? { kbps: c.kbps } : {}), ...(c.keyframe ? { keyframe: true } : {}) });
    }
    return null;
  }
  /** Controls whose delay has passed. */
  apply(t: number): { key: boolean } {
    let key = false;
    for (const p of this.pending.filter((x) => x.at <= t)) {
      if (p.kbps !== undefined) this.kbps = p.kbps;
      if (p.keyframe) key = true;
    }
    this.pending = this.pending.filter((x) => x.at > t);
    return { key };
  }
}

export async function simulate(scenario: Scenario, opts: SimOptions = {}): Promise<Metrics> {
  const latency = opts.latencyMs ?? 20;
  const fps = opts.fps ?? 30;
  const keyRatio = opts.keyRatio ?? 5;
  const rng = new Lcg(opts.seed ?? 7);
  let T = 0;
  const now = () => 1_000_000 + T;
  const net = new FakeLinkNetwork();
  const wire = new Wire((t) => scenario.capacityKbps(t), opts.sndbufBytes ?? 0, latency);
  const transport = new ThrottledTransport(wire, net.endpoint("studio"));
  const app = new SimApp(now, opts.controlMs ?? 50);
  let n = 0;
  const streams = new TabStreams({
    computer: "Studio", transport: transport as never, app: () => app, now, newId: () => `id_${++n}`,
    tuning: opts.tuning ?? {},
  });
  const capturedAt = new Map<number, number>();
  const arrivals: { capture: number; arrival: number; bytes: number; key: boolean }[] = [];
  const dueAcks: { at: number; ts: number }[] = [];
  let reverse: LinkStream | undefined;
  net.endpoint("phone").onStream(STREAM_LINK_LABEL, (stream) => {
    reverse = stream;
    stream.onData((b) => {
      const c = decodeStreamFrame(b);
      if (c.kind === "frame") {
        arrivals.push({ capture: capturedAt.get(c.timestamp) ?? 0, arrival: T, bytes: c.data.byteLength, key: c.key });
        if (opts.acks) dueAcks.push({ at: T + (opts.latencyMs ?? 0), ts: c.timestamp });
      }
    });
  });
  const maxKbps = scenario.maxKbps ?? DEFAULT_STREAM_TUNING.defaultKbps;
  await streams.start({ tab: "tab_1", device: "phone", maxKbps, codecs: ["h264"] });
  await tick();

  const dt = 5;
  const frameEvery = 1000 / fps;
  let nextFrame = 0;
  let made = 0;
  let keyframes = 0;
  let needKey = true;
  let configSent = false;
  let askSum = 0;
  let capSum = 0;
  let samples = 0;
  for (T = 0; T <= scenario.durationMs; T += dt) {
    wire.step(T, dt);
    while (dueAcks.length > 0 && dueAcks[0]!.at <= T) void reverse?.write(encodeStreamAck(dueAcks.shift()!.ts));
    await tick();
    while (T >= nextFrame) {
      const { key } = app.apply(now());
      needKey ||= key;
      if (!configSent) {
        streams.data(app.stream, { kind: "config", codec: "h264", width: 1280, height: 800, codecString: "avc1.42E028" });
        configSent = true;
      }
      const average = (app.kbps * 125) / fps;
      const noise = 0.75 + rng.next() * 0.5;
      const bytes = Math.max(40, Math.round(average * noise * (needKey ? keyRatio : 1)));
      const timestamp = Math.round(nextFrame * 1000);
      capturedAt.set(timestamp, nextFrame);
      const chunk: StreamChunk = { kind: "frame", key: needKey, timestamp, data: new Uint8Array(bytes) };
      if (needKey) keyframes++;
      needKey = false;
      made++;
      streams.data(app.stream, chunk);
      nextFrame += frameEvery;
    }
    if (T % 250 === 0 && T >= 2000) {
      askSum += app.kbps / Math.min(scenario.capacityKbps(T), maxKbps);
      capSum += Math.min(scenario.capacityKbps(T), maxKbps);
      samples++;
    }
  }
  const info = streams.list()[0];
  streams.close();

  const warm = 2000;
  const seen = arrivals.filter((a) => a.arrival >= warm);
  const lat = seen.map((a) => a.arrival - a.capture).sort((a, b) => a - b);
  const pct = (p: number) => (lat.length === 0 ? Infinity : lat[Math.min(lat.length - 1, Math.floor(lat.length * p))]!);
  let frozen = 0;
  let lagging = 0;
  let prev = warm;
  for (const a of seen) {
    const gap = a.arrival - prev;
    if (gap > 500) frozen += gap - 500;
    if (a.arrival - a.capture > 500) lagging += a.arrival - prev;
    prev = a.arrival;
  }
  if (scenario.durationMs - prev > 500) frozen += scenario.durationMs - prev - 500;
  const bits = seen.reduce((s, a) => s + a.bytes * 8, 0);
  let carry = 0;
  for (let t = warm; t < scenario.durationMs; t += 250) carry += Math.min(scenario.capacityKbps(t), maxKbps) * 0.25 * 1000;
  const utilization = carry === 0 ? 0 : bits / carry;
  const frozenSec = frozen / 1000;
  const laggingSec = lagging / 1000;
  const durationSec = scenario.durationMs / 1000;
  const metrics: Metrics = {
    scenario: scenario.name,
    delivered: arrivals.length,
    made,
    droppedShare: made === 0 ? 0 : 1 - arrivals.length / made,
    frozenSec,
    laggingSec,
    latencyP50: pct(0.5),
    latencyP95: pct(0.95),
    latencyMax: lat.at(-1) ?? Infinity,
    utilization,
    askRatio: samples === 0 ? 0 : askSum / samples,
    keyframes,
    lowered: info?.lowered ?? 0,
    raised: info?.raised ?? 0,
    score: 0,
  };
  // What matters, in order: a picture that stands still, one that is behind, one that is poor on a link with room,
  // and a bitrate that keeps changing.
  metrics.score = frozenSec * 4 + laggingSec * 2 + Math.max(0, 0.9 - utilization) * durationSec * 0.5 + (metrics.lowered + metrics.raised) * 0.05;
  return metrics;
}

const step = (...segments: [number, number][]) => (t: number): number => {
  let at = 0;
  for (const [ms, kbps] of segments) {
    at += ms;
    if (t < at) return kbps;
  }
  return segments.at(-1)![1];
};

export const SCENARIOS: Scenario[] = [
  { name: "roomy 10 Mbit", durationMs: 60_000, capacityKbps: () => 10_000 },
  { name: "tight 1 Mbit", durationMs: 60_000, capacityKbps: () => 1000 },
  { name: "slow 250 kbit", durationMs: 60_000, capacityKbps: () => 250 },
  { name: "drop 6 Mbit to 600 kbit and back", durationMs: 75_000, capacityKbps: step([15_000, 6000], [25_000, 600], [35_000, 6000]) },
  { name: "flapping 3 Mbit / 700 kbit every 5 s", durationMs: 60_000, capacityKbps: (t) => (Math.floor(t / 5000) % 2 === 0 ? 3000 : 700) },
  {
    name: "mobile: 400 kbit to 3 Mbit, changing every 1-3 s",
    durationMs: 60_000,
    capacityKbps: (() => {
      const r = new Lcg(99);
      const segs: [number, number][] = [];
      for (let at = 0; at < 61_000;) {
        const len = 1000 + Math.round(r.next() * 2000);
        segs.push([len, 400 + Math.round(r.next() * 2600)]);
        at += len;
      }
      return step(...segs);
    })(),
  },
];
