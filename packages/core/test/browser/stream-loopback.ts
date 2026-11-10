// The stream's sender over a real throttled link, in real time: TabStreams writes to a link stream that is a TCP
// connection on loopback, through a relay that forwards at the scenario's bandwidth (and stops reading when its queue
// is full, so the sender's kernel buffers fill and `write()` really does wait, as it would on a slow link). The receiver
// reads frames with `encodeStreamAck, StreamFrameReader` and times them. This measures what the in-memory simulation (`throttle-sim.ts`)
// can't: the slack a real socket adds before backpressure shows. Used by `stream-loopback.test.ts` and
// `stream-measure.ts loopback`. Nothing here is part of the product.
import { connect, createServer, type Server, type Socket } from "node:net";
import type { LinkView } from "@waifucave/clover-protocol";
import type { Link, LinkPriority, LinkStream } from "../../src/contracts/link-transport";
import type { AppTabCommand, StreamChunk, TabView } from "../../src/browser/contract";
import type { AppTabPort } from "../../src/browser/service";
import { encodeStreamAck, StreamFrameReader, TabStreams, type StreamTuning } from "../../src/browser/stream";

export interface LoopbackScenario {
  name: string;
  durationMs: number;
  capacityKbps(t: number): number;
  maxKbps: number;
}

export interface LoopbackResult {
  scenario: string;
  delivered: number;
  made: number;
  latencyP50: number;
  latencyP95: number;
  latencyMax: number;
  /** The longest the picture stood still after the first two seconds. */
  longestGapMs: number;
  utilization: number;
  askRatio: number;
  lowered: number;
  raised: number;
  /** Highest bytes the sender counted as unsent, and the highest the relay held, for the slack figure. */
  peakBacklog: number;
  peakRelayQueue: number;
}

class TcpStream implements LinkStream {
  readonly id = "tcp_1";
  readonly label = "browser.stream";
  readonly priority: LinkPriority = "screenshots";
  private ends: ((e?: Error) => void)[] = [];
  constructor(private readonly socket: Socket) {
    socket.on("close", () => this.ends.splice(0).forEach((f) => f()));
    socket.on("error", () => undefined);
  }
  write(chunk: Uint8Array): Promise<void> {
    if (this.socket.destroyed) return Promise.reject(new Error("closed"));
    return new Promise((resolve, reject) => this.socket.write(chunk, (e) => (e ? reject(e) : resolve())));
  }
  end(): void { this.socket.end(); }
  abort(): void { this.socket.destroy(); }
  onData(fn: (b: Uint8Array) => void): () => void {
    const on = (b: Buffer) => fn(new Uint8Array(b));
    this.socket.on("data", on);
    return () => void this.socket.off("data", on);
  }
  onEnd(fn: (error?: Error) => void): () => void { this.ends.push(fn); return () => undefined; }
}

class App implements AppTabPort {
  stream = "";
  kbps = 0;
  keyNext = true;
  async configure(): Promise<void> {}
  async open(): Promise<TabView> { throw new Error("not here"); }
  async list(): Promise<TabView[]> { return []; }
  async command(_id: string, c: AppTabCommand): Promise<unknown> {
    if (c.kind === "stream" && c.on) { this.stream = c.stream; this.kbps = c.maxKbps ?? 0; }
    else if (c.kind === "stream-control") { if (c.kbps !== undefined) this.kbps = c.kbps; if (c.keyframe) this.keyNext = true; }
    return null;
  }
}

const listen = (server: Server): Promise<number> => new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)));

export async function runLoopback(scenario: LoopbackScenario, opts: { tuning?: Partial<StreamTuning>; fps?: number; keyRatio?: number; acks?: boolean } = {}): Promise<LoopbackResult> {
  const fps = opts.fps ?? 30;
  const keyRatio = opts.keyRatio ?? 5;
  const t0 = Date.now();
  const arrivals: { capture: number; arrival: number; bytes: number }[] = [];
  const reader = new StreamFrameReader();
  const sockets: Socket[] = [];
  const receiver = createServer((s) => {
    sockets.push(s);
    s.on("data", (b: Buffer) => {
      for (const c of reader.push(b)) {
        if (c.kind !== "frame") continue;
        arrivals.push({ capture: c.timestamp / 1000, arrival: Date.now() - t0, bytes: c.data.byteLength });
        if (opts.acks) s.write(encodeStreamAck(c.timestamp));
      }
    });
    s.on("error", () => undefined);
  });
  const receiverPort = await listen(receiver);
  // The relay: the sender's bytes queue here and leave at the scenario's rate every 10 ms; past 32 KiB queued it stops
  // reading from the sender.
  let peakRelayQueue = 0;
  const relay = createServer((from) => {
    sockets.push(from);
    const to = connect(receiverPort, "127.0.0.1");
    sockets.push(to);
    to.on("error", () => from.destroy());
    to.on("data", (b: Buffer) => from.write(b)); // the acks, back the way the frames came
    from.on("error", () => to.destroy());
    const queue: Buffer[] = [];
    let queued = 0;
    from.on("data", (b: Buffer) => {
      queue.push(b);
      queued += b.length;
      peakRelayQueue = Math.max(peakRelayQueue, queued);
      if (queued > 32 * 1024) from.pause();
    });
    from.on("end", () => to.end());
    let credit = 0;
    const timer = setInterval(() => {
      credit += (scenario.capacityKbps(Date.now() - t0) * 125) / 100;
      while (queue.length > 0 && credit > 0) {
        const head = queue[0]!;
        const take = Math.min(head.length, Math.floor(credit));
        if (take <= 0) break;
        to.write(head.subarray(0, take));
        credit -= take;
        queued -= take;
        if (take === head.length) queue.shift();
        else queue[0] = head.subarray(take);
      }
      if (queue.length === 0) credit = Math.min(credit, (scenario.capacityKbps(Date.now() - t0) * 125) / 100);
      if (queued < 16 * 1024) from.resume();
    }, 10);
    from.on("close", () => clearInterval(timer));
  });
  const relayPort = await listen(relay);
  const sender = connect(relayPort, "127.0.0.1");
  sockets.push(sender);
  await new Promise<void>((r) => sender.once("connect", () => r()));
  sender.setNoDelay(true);
  const stream = new TcpStream(sender);
  const link: Link = {
    peer: "phone", view: () => ({ peer: "phone", up: true }), request: async () => undefined as never, notify: () => undefined,
    openStream: () => stream,
  };
  const transport = { connect: async () => link, watch: (_fn: (v: LinkView) => void) => () => undefined };
  const app = new App();
  const streams = new TabStreams({ computer: "Studio", transport: transport as never, app: () => app, tuning: opts.tuning ?? {} });
  await streams.start({ tab: "tab_1", device: "phone", maxKbps: scenario.maxKbps, codecs: ["h264"] });

  let made = 0;
  let configSent = false;
  let askSum = 0;
  let capSum = 0;
  let samples = 0;
  let peakBacklog = 0;
  let seed = 7;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const ticker = setInterval(() => {
    const t = Date.now() - t0;
    if (!configSent) {
      streams.data(app.stream, { kind: "config", codec: "h264", width: 1280, height: 800, codecString: "avc1.42E028" });
      configSent = true;
    }
    const key = app.keyNext;
    app.keyNext = false;
    const bytes = Math.max(40, Math.round(((app.kbps * 125) / fps) * (0.75 + rand() * 0.5) * (key ? keyRatio : 1)));
    made++;
    const chunk: StreamChunk = { kind: "frame", key, timestamp: t * 1000, data: new Uint8Array(bytes) };
    streams.data(app.stream, chunk);
    peakBacklog = Math.max(peakBacklog, streams.list()[0]?.backlogBytes ?? 0);
    if (t >= 2000 && made % 8 === 0) {
      const cap = Math.min(scenario.capacityKbps(t), scenario.maxKbps);
      askSum += app.kbps / cap;
      capSum += cap;
      samples++;
    }
  }, 1000 / fps);
  await new Promise((r) => setTimeout(r, scenario.durationMs));
  clearInterval(ticker);
  const info = streams.list()[0];
  streams.close();
  for (const s of sockets) s.destroy();
  receiver.close();
  relay.close();

  const seen = arrivals.filter((a) => a.arrival >= 2000);
  const lat = seen.map((a) => a.arrival - a.capture).sort((a, b) => a - b);
  const pct = (p: number) => (lat.length === 0 ? Infinity : lat[Math.min(lat.length - 1, Math.floor(lat.length * p))]!);
  let longest = 0;
  let prev = 2000;
  for (const a of seen) { longest = Math.max(longest, a.arrival - prev); prev = a.arrival; }
  longest = Math.max(longest, scenario.durationMs - prev);
  let carry = 0;
  for (let t = 2000; t < scenario.durationMs; t += 100) carry += Math.min(scenario.capacityKbps(t), scenario.maxKbps) * 0.1 * 1000;
  return {
    scenario: scenario.name, delivered: arrivals.length, made, latencyP50: pct(0.5), latencyP95: pct(0.95), latencyMax: lat.at(-1) ?? Infinity,
    longestGapMs: longest, utilization: carry === 0 ? 0 : seen.reduce((s, a) => s + a.bytes * 8, 0) / carry, askRatio: samples === 0 ? 0 : askSum / samples,
    lowered: info?.lowered ?? 0, raised: info?.raised ?? 0, peakBacklog, peakRelayQueue,
  };
}

export const LOOPBACK_SCENARIOS: LoopbackScenario[] = [
  { name: "tight 1 Mbit", durationMs: 30_000, capacityKbps: () => 1000, maxKbps: 2500 },
  { name: "slow 250 kbit", durationMs: 30_000, capacityKbps: () => 250, maxKbps: 2500 },
  { name: "drop 6 Mbit to 600 kbit and back", durationMs: 45_000, capacityKbps: (t) => (t < 10_000 ? 6000 : t < 28_000 ? 600 : 6000), maxKbps: 2500 },
];
