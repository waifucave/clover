// The shared clock (spec §6.4 "Messages are ordered by send order, on one shared clock"; contracts/clock.ts): every
// device stamps messages in the same time, so every device sees the same order.
//
// * **The reference** is the computer holding the lease (the main, or the takeover computer while the main is
//   offline). It keeps its time from public time servers, Cloudflare's and Google's, by SNTP (`SntpTimeSource`).
// * **Every other device** measures its offset from the reference over the persistent link, the way NTP does: four
//   timestamps per exchange (`link.clock.ping`), the offset `((t1 - t0) + (t2 - t3)) / 2` and the round trip
//   `(t3 - t0) - (t2 - t1)`. Of the last few samples the one with the shortest round trip wins, and the accuracy is half
//   that round trip: a few milliseconds on the same Wi-Fi, tens over the internet.
// * **Shared time never steps back** for a reader: a correction that would move it backwards holds it still until the
//   device's own time catches up, so stamps from one device stay in order. Durations and timers use the monotonic
//   clock, which corrections never touch.
// * With no reference known yet (no lease holder, no link to it), a device uses public time itself if it can reach a
//   server, and otherwise its own wall clock, with `synced: false`.
import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import type { ClockStatus, Clock, TimerHandle } from "../contracts/clock";
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { LinkTransport } from "../contracts/link-transport";

/** The link's own request a device measures the reference with (it never leaves the link). */
export const CLOCK_PING = "link.clock.ping";

/** A source of public time: one sample of this device's wall-clock offset from it. */
export interface TimeSource {
  sample(): Promise<{ offsetMs: number; rttMs: number }>;
}

export const PUBLIC_TIME_SERVERS = ["time.cloudflare.com", "time.google.com"] as const;

/** SNTP (RFC 4330) against public servers, each tried in turn. */
export class SntpTimeSource implements TimeSource {
  readonly #servers: readonly string[];
  readonly #timeoutMs: number;
  readonly #wall: () => number;

  constructor(o: { servers?: readonly string[]; timeoutMs?: number; wall?: () => number } = {}) {
    this.#servers = o.servers ?? PUBLIC_TIME_SERVERS;
    this.#timeoutMs = o.timeoutMs ?? 2_000;
    this.#wall = o.wall ?? Date.now;
  }

  async sample(): Promise<{ offsetMs: number; rttMs: number }> {
    let last: unknown;
    for (const host of this.#servers) {
      try {
        return await this.#ask(host);
      } catch (err) {
        last = err;
      }
    }
    throw last instanceof Error ? last : new ContractError("offline", "no public time server answered");
  }

  async #ask(host: string): Promise<{ offsetMs: number; rttMs: number }> {
    const { address, family } = await lookup(host);
    const sock = createSocket(family === 6 ? "udp6" : "udp4");
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new ContractError("timeout", `${host} didn't answer`)), this.#timeoutMs);
        const req = new Uint8Array(48);
        req[0] = 0x1b; // LI 0, version 3, mode 3 (client)
        const t0 = this.#wall();
        writeNtp(req, 40, t0);
        sock.on("message", (msg: Buffer) => {
          const t3 = this.#wall();
          clearTimeout(timer);
          if (msg.length < 48 || (msg[0]! & 0x07) !== 4) return reject(new ContractError("invalid", `${host} answered something that isn't SNTP`));
          const t1 = readNtp(msg, 32);
          const t2 = readNtp(msg, 40);
          resolve({ offsetMs: (t1 - t0 + (t2 - t3)) / 2, rttMs: Math.max(0, t3 - t0 - (t2 - t1)) });
        });
        sock.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        sock.send(req, 123, address);
      });
    } finally {
      sock.close();
    }
  }
}

/** Seconds between 1900 (NTP's epoch) and 1970. */
const NTP_UNIX = 2_208_988_800;

function writeNtp(buf: Uint8Array, at: number, ms: number): void {
  const v = new DataView(buf.buffer, buf.byteOffset);
  const secs = Math.floor(ms / 1000) + NTP_UNIX;
  v.setUint32(at, secs >>> 0, false);
  v.setUint32(at + 4, Math.floor(((ms % 1000) / 1000) * 2 ** 32) >>> 0, false);
}

function readNtp(buf: Uint8Array, at: number): number {
  const v = new DataView(buf.buffer, buf.byteOffset);
  return (v.getUint32(at, false) - NTP_UNIX) * 1000 + (v.getUint32(at + 4, false) / 2 ** 32) * 1000;
}

export interface SharedClockOptions {
  /** This device's id. */
  self: string;
  /** The device's own clocks: its wall clock, monotonic time and timers. */
  base: Clock;
  transport: Pick<LinkTransport, "connect" | "handle">;
  /** The device the clock follows: the lease's holder, or null while none is known. */
  reference(): string | null;
  /** Public time, for the reference itself (and a device with no reference). */
  publicTime?: TimeSource;
  /** How often a device measures its reference over the link. */
  everyMs?: number;
  /** How often the reference asks public time. */
  publicEveryMs?: number;
  /** Samples kept; the shortest round trip among them wins. */
  keep?: number;
  log?(line: string): void;
}

interface Sample {
  offsetMs: number;
  rttMs: number;
}

export class SharedClock implements Clock {
  readonly #o: SharedClockOptions;
  readonly #off: Unsubscribe;
  /** Samples against the current reference (a device id, or "public"). */
  #samples: Sample[] = [];
  #sampledRef: string | "public" | null = null;
  #offset = 0;
  #accuracy = 0;
  #synced = false;
  #last = Number.NEGATIVE_INFINITY;
  #timer: TimerHandle | undefined;
  #closed = false;
  #publicAt = Number.NEGATIVE_INFINITY;

  constructor(o: SharedClockOptions) {
    this.#o = o;
    // The reference answers with its shared time when the request arrived and when the answer leaves.
    this.#off = o.transport.handle(CLOCK_PING, () => {
      const t1 = this.now();
      return { t1, t2: this.now() };
    });
  }

  /** Starts measuring; call `referenceChanged` whenever the lease's holder changes. */
  start(): void {
    this.#schedule(0);
  }

  now(): number {
    const t = this.#o.base.now() + this.#offset;
    // Never backwards for a reader: a correction down holds time still until the wall clock catches up.
    if (t < this.#last) return this.#last;
    this.#last = t;
    return t;
  }

  monotonic(): number {
    return this.#o.base.monotonic();
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    return this.#o.base.setTimeout(fn, ms);
  }

  clearTimeout(handle: TimerHandle): void {
    this.#o.base.clearTimeout(handle);
  }

  status(): ClockStatus {
    const ref = this.#sampledRef ?? "public";
    return { reference: ref === this.#o.self ? "public" : ref, offsetMs: this.#offset, accuracyMs: this.#accuracy, synced: this.#synced };
  }

  /** The lease's holder changed: measure against the new reference now, with a few quick samples. */
  referenceChanged(): void {
    this.#schedule(0);
  }

  /** One measurement against the current reference; resolves with the sample, or undefined when none was had. */
  async measure(): Promise<Sample | undefined> {
    const holder = this.#o.reference();
    const ref: string | "public" = holder === null || holder === this.#o.self ? "public" : holder;
    if (ref !== this.#sampledRef) {
      this.#samples = [];
      this.#sampledRef = ref;
    }
    let s: Sample | undefined;
    try {
      if (ref === "public") {
        if (!this.#o.publicTime) return undefined;
        s = await this.#o.publicTime.sample();
        this.#publicAt = this.#o.base.monotonic();
      } else s = await this.#ping(ref);
    } catch (err) {
      this.#o.log?.(`[clock] measuring ${ref} failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    this.#samples.push(s);
    const keep = this.#o.keep ?? 8;
    if (this.#samples.length > keep) this.#samples.splice(0, this.#samples.length - keep);
    const best = this.#samples.reduce((a, b) => (b.rttMs < a.rttMs ? b : a));
    this.#offset = best.offsetMs;
    this.#accuracy = best.rttMs / 2;
    this.#synced = true;
    return s;
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) this.#o.base.clearTimeout(this.#timer);
    this.#off();
  }

  async #ping(peer: string): Promise<Sample> {
    const link = await this.#o.transport.connect(peer);
    const t0 = this.#o.base.now();
    const r = await link.request<{ t1: number; t2: number }>(CLOCK_PING, {}, { timeoutMs: 5_000 });
    const t3 = this.#o.base.now();
    if (typeof r?.t1 !== "number" || typeof r.t2 !== "number") throw new ContractError("invalid", "a bad clock answer");
    return { offsetMs: (r.t1 - t0 + (r.t2 - t3)) / 2, rttMs: Math.max(0, t3 - t0 - (r.t2 - r.t1)) };
  }

  #schedule(ms: number): void {
    if (this.#closed) return;
    if (this.#timer) this.#o.base.clearTimeout(this.#timer);
    this.#timer = this.#o.base.setTimeout(() => void this.#tick(), ms);
  }

  async #tick(): Promise<void> {
    if (this.#closed) return;
    const holder = this.#o.reference();
    const isPublic = holder === null || holder === this.#o.self;
    // Public servers are asked rarely (they're shared and polite use is every few minutes); the reference over the
    // link more often, quickly at first after a change.
    if (isPublic && this.#o.base.monotonic() - this.#publicAt < (this.#o.publicEveryMs ?? 10 * 60_000) && this.#sampledRef === "public") {
      this.#schedule(this.#o.publicEveryMs ?? 10 * 60_000);
      return;
    }
    await this.measure();
    const quick = this.#samples.length < 4;
    this.#schedule(quick ? 200 : isPublic ? (this.#o.publicEveryMs ?? 10 * 60_000) : (this.#o.everyMs ?? 30_000));
  }
}
