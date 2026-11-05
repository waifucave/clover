// Test fakes for the forwarder client: a fake hooks.waifucave.com (its HTTP API and its sockets) that seals
// real envelopes, and a manual clock.

import type { Clock, WebSocketLike } from "../src/client";
import { b64u, fromB64u, utf8 } from "../src/wire/bytes";
import { encodeRequestRecord, keyId, sealEnvelope, type EnvelopeRecipient } from "../src/wire/envelope";
import { encodeWebhookFrame } from "../src/wire/protocol";

type Listener = (event: { data?: unknown; code?: number }) => void;

export class FakeSocket implements WebSocketLike {
  binaryType = "blob";
  readyState = 0;
  readonly sent: string[] = [];
  closedBy: { code: number; reason: string } | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {}

  addEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket not open");
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.closedBy = { code, reason };
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", { code }));
  }

  // ---- what the server side does ----

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  receive(data: unknown): void {
    this.emit("message", { data });
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.emit("close", { code });
  }

  acks(): [number, string][] {
    return this.sent
      .filter((m) => m.startsWith("{"))
      .map((m) => JSON.parse(m) as { t: string; a: [number, string][] })
      .filter((f) => f.t === "ack")
      .flatMap((f) => f.a);
  }

  nacks(): [number, string][] {
    return this.sent
      .filter((m) => m.startsWith("{"))
      .map((m) => JSON.parse(m) as { t: string; a: [number, string][] })
      .filter((f) => f.t === "nack")
      .flatMap((f) => f.a);
  }

  private emit(type: string, event: { data?: unknown; code?: number }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export interface FakeCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

export class FakeService {
  readonly calls: FakeCall[] = [];
  readonly sockets: FakeSocket[] = [];
  encKey: Uint8Array | null = null;
  revoked = false;
  ticketFailures = 0;
  routines = new Map<string, { keyHash: string; device: string }>();
  private tickets = 0;
  private seq = 1_000;

  readonly fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    this.calls.push({ method, path: pathname, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (method === "PUT" && pathname === "/v1/devices/self") {
      if (this.revoked) return json({ error: "revoked" }, 403);
      this.encKey = fromB64u(String(body?.encKey));
      return json({ device: "pc", kid: b64u(await keyId(this.encKey)), tag: "T".repeat(24) });
    }
    if (method === "POST" && pathname === "/v1/tickets") {
      if (this.ticketFailures > 0) {
        this.ticketFailures -= 1;
        return json({ error: "unavailable" }, 503);
      }
      this.tickets += 1;
      return json({ ticket: `t${this.tickets}`, url: `wss://hooks.test/v1/connect?ticket=t${this.tickets}`, expiresAt: 0 });
    }
    const routine = /^\/v1\/routines\/([^/]+)$/.exec(pathname)?.[1];
    if (method === "PUT" && routine) {
      const held = this.routines.get(routine);
      if (held && held.device !== "pc" && body?.takeover !== true) return json({ error: "held_elsewhere", device: held.device }, 409);
      this.routines.set(routine, { keyHash: String(body?.keyHash), device: "pc" });
      return json({ routine, device: "pc", url: `https://hooks.test/${"T".repeat(24)}/${routine}` });
    }
    if (method === "DELETE" && routine) {
      this.routines.delete(routine);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && pathname === "/v1/routines") {
      return json({ routines: [...this.routines].map(([id, r]) => ({ id, device: r.device, held: 0 })) });
    }
    return json({ error: "not_found" }, 404);
  };

  readonly connect = (url: string): FakeSocket => {
    const socket = new FakeSocket(url);
    this.sockets.push(socket);
    return socket;
  };

  get socket(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error("no socket yet");
    return socket;
  }

  /** A webhook frame sealed to the registered key (or to `to`), as the Durable Object sends it. */
  async frame(routine: string, body: string, options: { to?: EnvelopeRecipient[]; seq?: number; receivedAt?: number } = {}): Promise<{ frame: ArrayBuffer; seq: number }> {
    if (!this.encKey && !options.to) throw new Error("no key registered");
    const recipients = options.to ?? [{ kid: await keyId(this.encKey!), publicKey: this.encKey! }];
    const envelope = await sealEnvelope({
      routineId: routine,
      receivedAt: options.receivedAt ?? 1_793_000_000_000,
      recipients,
      plaintext: encodeRequestRecord({ method: "POST", query: "", headers: [["content-type", "text/plain"]], body: utf8(body) }),
    });
    const seq = options.seq ?? (this.seq += 1);
    const bytes = encodeWebhookFrame(seq, envelope);
    return { frame: bytes.buffer, seq };
  }
}

export class FakeClock implements Clock {
  t = 1_000_000;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  pending(): number[] {
    return [...this.timers.values()].map((timer) => timer.at - this.t).sort((a, b) => a - b);
  }

  /** Moves time forward, running each timer that falls due, in order, and letting async work settle. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.timers) if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
      await settle();
    }
    this.t = target;
    await settle();
  }
}

/** Lets promise chains (fetch, WebCrypto) run to rest. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
