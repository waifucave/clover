// The forwarder's client, on each computer: it registers this computer's forwarder key and its webhook
// routines with hooks.waifucave.com, keeps one outbound WebSocket to the account's Durable Object (used only
// for webhooks), opens what arrives with this computer's key, hands it on, and acknowledges it once taken.
// The key's private half stays with the core (keys.ts): the client only asks the core to open each envelope.
//
// Delivery is at least once. A webhook handed on but not acknowledged, or acknowledged on a socket that
// dropped before the acknowledgement arrived, comes again on the next connection; deliveries carry the
// payload id (`id`), stable across redeliveries, for whoever takes them to ignore a repeat.
//
// Web-standard APIs only (fetch, WebSocket, WebCrypto), so the same code runs in the plugin host (Bun),
// inside workerd for the service's tests, and in Node.

import type { ForwarderKeys } from "./keys";
import { b64u } from "./wire/bytes";
import { decodeRequestRecord, keyId, openEnvelope, readEnvelopeHeader, type EnvelopeOpener, type WebhookRequest } from "./wire/envelope";
import {
  CLOSE_REAUTH,
  CLOSE_REPLACED,
  CLOSE_REVOKED,
  decodeWebhookFrame,
  hookKeyHash,
  MAX_ACKS_PER_FRAME,
  PING,
  PONG,
  type AckRef,
  type DeviceRegistered,
  type DropCount,
  type RoutineInfo,
  type RoutineRegistered,
  type ServiceFrame,
  type Ticket,
} from "./wire/protocol";

/** The parts of a WebSocket the client uses (the standard API, as Bun, workerd and browsers have it). */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown; code?: number }) => void): void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * "signed-out": the core has no waifucave account signed in (its keyed fetch fails with no_account); the
 * client tries again rarely. "elsewhere": another process connects as this computer (a cloned machine, say)
 * and keeps replacing this one's connection; the client stops rather than fight it.
 */
export type ClientState = "stopped" | "registering" | "connecting" | "open" | "waiting" | "signed-out" | "elsewhere" | "revoked";

export interface Delivery {
  seq: number;
  /** The payload id: the same on every redelivery of this webhook. */
  id: string;
  routine: string;
  /** When hooks.waifucave.com received it (ms since the epoch); the routine's missed-run rule reads this. */
  receivedAt: number;
  request: WebhookRequest;
  /** Taken: the service deletes it. */
  ack(): void;
  /** Refused by this computer (the routine's own decision): the service deletes it too. */
  drop(): void;
  /** Let go without settling (its routine left this computer): a redelivery is handed on again. */
  release(): void;
}

export interface ForwarderClientOptions {
  /** https://hooks.waifucave.com, or a local emulator's origin. */
  origin: string;
  /**
   * The core's keyed fetch: it adds this computer's waifucave account token. With no account signed in it
   * rejects with an error whose `code` is "no_account".
   */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** This computer's forwarder key, held by the core. */
  keys: ForwarderKeys;
  onDelivery: (delivery: Delivery) => void;
  deviceName?: string;
  connect?: (url: string) => WebSocketLike;
  onState?: (state: ClientState) => void;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  clock?: Clock;
  random?: () => number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** How long one HTTP request may take before it is abandoned. */
  requestTimeoutMs?: number;
  /** How long to wait after another process replaced this computer's connection (plus up to half again). */
  replacedWaitMs?: number;
  /** How often to look again while no account is signed in. */
  signedOutRetryMs?: number;
}

export class RoutineHeldElsewhere extends Error {
  constructor(readonly device: string) {
    super(`routine is held by ${device}`);
  }
}

export class ForwarderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`forwarder: ${status} ${code}`);
  }
}

const RECENT_LIMIT = 2048;
/** Replacements by another process within this window, this many times, and the client stops. */
const REPLACED_WINDOW_MS = 10 * 60_000;
const REPLACED_LIMIT = 3;

function isNoAccount(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "no_account";
}

export class ForwarderClient {
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly connectSocket: (url: string) => WebSocketLike;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly backoffMinMs: number;
  private readonly backoffMaxMs: number;
  private readonly requestTimeoutMs: number;
  private readonly replacedWaitMs: number;
  private readonly signedOutRetryMs: number;

  private status: ClientState = "stopped";
  private opener: EnvelopeOpener | null = null;
  private publicKey: Uint8Array | null = null;
  private registration: Promise<void> | null = null;
  /** When another process replaced this computer's connection, lately. */
  private replacedAt: number[] = [];
  /** A bye frame's reason for the current socket, read when it closes. */
  private bye: string | null = null;
  /** Drops the service reported in its hello, until listRoutines reports them. */
  private readonly drops = new Map<string, DropCount>();
  /** Whether "no account is signed in" has been logged since the last successful registration. */
  private signedOut = false;
  private socket: WebSocketLike | null = null;
  private attempt = 0;
  private reconnectTimer: unknown = null;
  private pingTimer: unknown = null;
  private pongTimer: unknown = null;
  private incoming: Promise<void> = Promise.resolve();
  /** Handed on, not yet acknowledged: payload id -> seq. */
  private readonly pending = new Map<string, number>();
  /** Acknowledged lately (oldest first): payload id -> seq, so a redelivery is acknowledged again, not handed on. */
  private readonly recent = new Map<string, number>();
  private readonly outbox: { kind: "ack" | "nack" | "unreadable"; ref: AckRef }[] = [];
  private flushQueued = false;

  /** This account's hook tag, once registered. */
  tag: string | null = null;

  constructor(private readonly options: ForwarderClientOptions) {
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    this.connectSocket = options.connect ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.pingIntervalMs = options.pingIntervalMs ?? 30_000;
    this.pongTimeoutMs = options.pongTimeoutMs ?? 10_000;
    this.backoffMinMs = options.backoffMinMs ?? 1_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 60_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.replacedWaitMs = options.replacedWaitMs ?? 60_000;
    this.signedOutRetryMs = options.signedOutRetryMs ?? 5 * 60_000;
  }

  get state(): ClientState {
    return this.status;
  }

  /** Starts the connection loop; returns once this computer's key is registered (or registration failed). */
  async start(): Promise<void> {
    if (this.status !== "stopped") return;
    this.setState("registering");
    try {
      await this.registered();
    } catch (err) {
      if (this.isDone()) return;
      this.failed("registration failed", err);
      return;
    }
    this.connectAfter(0);
  }

  async stop(): Promise<void> {
    this.setState("stopped");
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "stopping");
  }

  /** Registers a webhook routine this computer holds, by its key; returns its webhook URL. */
  async registerRoutine(routine: string, key: string, options: { takeover?: boolean; allowGet?: boolean } = {}): Promise<{ url: string }> {
    return this.registerRoutineHash(routine, await hookKeyHash(key), options);
  }

  /** The same, by the key's hash (protocol.ts hookKeyHash), so the key itself need not reach this plugin. */
  async registerRoutineHash(
    routine: string,
    keyHash: Uint8Array,
    options: { takeover?: boolean; allowGet?: boolean } = {},
  ): Promise<{ url: string }> {
    const body = { keyHash: b64u(keyHash), takeover: options.takeover === true, allowGet: options.allowGet === true };
    for (let attempt = 0; ; attempt++) {
      await this.registered();
      const response = await this.call("PUT", `/v1/routines/${encodeURIComponent(routine)}`, body);
      if (response.status === 409) {
        const conflict = (await response.json().catch(() => ({}))) as { error?: string; device?: string };
        if (conflict.error === "held_elsewhere") throw new RoutineHeldElsewhere(conflict.device ?? "");
        // The service has forgotten this computer's key (revoked and restored, say): register it again, once.
        if (conflict.error === "device_not_registered" && attempt === 0) {
          this.registration = null;
          continue;
        }
        throw new ForwarderError(409, conflict.error ?? "conflict");
      }
      await this.expectOk(response);
      return { url: ((await response.json()) as RoutineRegistered).url };
    }
  }

  /** Stops receiving a routine's webhooks here. Throws RoutineHeldElsewhere when another computer holds it. */
  async unregisterRoutine(routine: string): Promise<void> {
    await this.registered();
    const response = await this.call("DELETE", `/v1/routines/${encodeURIComponent(routine)}`);
    if (response.status === 409) {
      const conflict = (await response.json().catch(() => ({}))) as { error?: string; device?: string };
      if (conflict.error === "held_elsewhere") throw new RoutineHeldElsewhere(conflict.device ?? "");
    }
    await this.expectOk(response);
  }

  /**
   * The account's routines. Drops on this computer's routines (from the service's list, or from its hello on
   * connecting) are reported here once, then forgotten.
   */
  async listRoutines(): Promise<RoutineInfo[]> {
    await this.registered();
    const response = await this.call("GET", "/v1/routines");
    await this.expectOk(response);
    const routines = ((await response.json()) as { routines: RoutineInfo[] }).routines;
    for (const routine of routines) {
      const local = this.drops.get(routine.id);
      if (!local) continue;
      const told = routine.dropped;
      routine.dropped = told
        ? { count: told.count + local.count, reason: told.at >= local.at ? told.reason : local.reason, at: Math.max(told.at, local.at) }
        : local;
    }
    this.drops.clear();
    return routines;
  }

  // ---- registration ----

  private registered(): Promise<void> {
    if (!this.registration) {
      this.registration = this.register().catch((err: unknown) => {
        this.registration = null;
        throw err;
      });
    }
    return this.registration;
  }

  private async register(): Promise<void> {
    // The core makes the key on first use and throws while its store is unavailable: a key is never made here.
    const publicKey = await this.loadKey();
    const response = await this.call("PUT", "/v1/devices/self", {
      encKey: b64u(publicKey),
      ...(this.options.deviceName ? { name: this.options.deviceName } : {}),
    });
    if (response.status === 403) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (body.error === "revoked") this.revoked();
      throw new ForwarderError(403, body.error ?? "forbidden");
    }
    await this.expectOk(response);
    this.tag = ((await response.json()) as DeviceRegistered).tag;
    this.signedOut = false;
  }

  private async loadKey(): Promise<Uint8Array> {
    if (this.publicKey) return this.publicKey;
    const publicKey = await this.options.keys.publicKey();
    if (publicKey.length !== 32) throw new Error("the core's forwarder key is not an X25519 public key");
    const kid = await keyId(publicKey);
    this.opener = { kid, open: (input) => this.options.keys.open(input) };
    this.publicKey = publicKey;
    return publicKey;
  }

  // ---- the connection ----

  private connectAfter(ms: number, state: ClientState = "waiting"): void {
    if (this.isDone()) return;
    this.clock.clearTimeout(this.reconnectTimer);
    if (ms > 0) this.setState(state);
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, ms);
  }

  private retry(): void {
    this.attempt += 1;
    const ceiling = Math.min(this.backoffMaxMs, this.backoffMinMs * 2 ** (this.attempt - 1));
    this.connectAfter(Math.round(ceiling / 2 + (this.random() * ceiling) / 2));
  }

  /** After a failed step: rarely while no account is signed in, otherwise with backoff. */
  private failed(what: string, err: unknown): void {
    if (isNoAccount(err)) {
      if (!this.signedOut) this.log("info", "no waifucave account is signed in; webhooks wait until one is");
      this.signedOut = true;
      this.registration = null;
      this.connectAfter(this.signedOutRetryMs, "signed-out");
      return;
    }
    this.log("warn", `${what}: ${describe(err)}`);
    this.retry();
  }

  /** The socket URL a ticket may name: this origin's host, over wss (ws only for a local http emulator). */
  private socketUrlAllowed(url: string): boolean {
    let target: URL;
    let origin: URL;
    try {
      target = new URL(url);
      origin = new URL(this.options.origin);
    } catch {
      return false;
    }
    const scheme = origin.protocol === "https:" ? "wss:" : origin.protocol === "http:" ? "ws:" : null;
    return scheme !== null && target.protocol === scheme && target.host === origin.host && target.pathname === "/v1/connect";
  }

  private async connect(): Promise<void> {
    if (this.isDone()) return;
    this.setState("connecting");
    let ticket: Ticket;
    try {
      await this.registered();
      const response = await this.call("POST", "/v1/tickets");
      await this.expectOk(response);
      ticket = (await response.json()) as Ticket;
    } catch (err) {
      if (this.isDone()) return;
      this.failed("could not get a connection ticket", err);
      return;
    }
    if (this.isDone()) return;
    if (!this.socketUrlAllowed(ticket.url)) {
      this.log("error", "the service named a connection address outside its own origin; not connecting");
      this.retry();
      return;
    }
    let socket: WebSocketLike;
    try {
      socket = this.connectSocket(ticket.url);
    } catch (err) {
      this.log("warn", `could not open the connection: ${describe(err)}`);
      this.retry();
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.bye = null;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.setState("open");
      this.schedulePing(socket);
      this.flush();
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      const data = event.data;
      this.incoming = this.incoming.then(() => this.onMessage(socket, data)).catch((err: unknown) => {
        this.log("error", `could not handle a frame: ${describe(err)}`);
      });
    });
    socket.addEventListener("close", (event) => this.onClose(socket, event.code ?? 1006));
    socket.addEventListener("error", () => {
      // A close event follows.
    });
  }

  private onClose(socket: WebSocketLike, code: number): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.clearPing();
    if (this.isDone()) return;
    const bye = this.bye;
    this.bye = null;
    if (code === CLOSE_REVOKED || bye === "revoked") {
      this.revoked();
      return;
    }
    if (code === CLOSE_REPLACED || bye === "replaced") {
      this.replaced();
      return;
    }
    if (code === CLOSE_REAUTH || bye === "reauth") {
      // The token the connection was opened with expired: a new ticket brings a fresh one.
      this.connectAfter(this.backoffMinMs);
      return;
    }
    // Connections that keep failing before they open may mean the service no longer knows this computer
    // (it answers the upgrade 403, which a socket cannot report): register again, which says if it was revoked.
    if (this.attempt >= 2) this.registration = null;
    this.retry();
  }

  /**
   * Another process connected as this computer. Two copies would otherwise replace each other every second;
   * this one waits a minute or more, and after three replacements in ten minutes it stops.
   */
  private replaced(): void {
    const now = this.clock.now();
    this.replacedAt = [...this.replacedAt.filter((at) => now - at < REPLACED_WINDOW_MS), now];
    if (this.replacedAt.length >= REPLACED_LIMIT) {
      this.log("error", "this computer is connected to the forwarder from somewhere else as well; stopping here");
      this.clearTimers();
      this.setState("elsewhere");
      return;
    }
    this.log("warn", "another connection replaced this one; waiting before connecting again");
    this.connectAfter(Math.round(this.replacedWaitMs * (1 + this.random() / 2)));
  }

  private schedulePing(socket: WebSocketLike): void {
    this.pingTimer = this.clock.setTimeout(() => {
      if (this.socket !== socket) return;
      try {
        socket.send(PING);
      } catch {
        return this.abandon(socket, "keep-alive failed");
      }
      this.pongTimer = this.clock.setTimeout(() => this.abandon(socket, "no keep-alive answer"), this.pongTimeoutMs);
      this.schedulePing(socket);
    }, this.pingIntervalMs);
  }

  /** Gives up on a socket that stopped answering, without waiting for its close event. */
  private abandon(socket: WebSocketLike, why: string): void {
    if (this.socket !== socket) return;
    this.log("warn", `reconnecting: ${why}`);
    this.socket = null;
    this.clearPing();
    try {
      socket.close(4000, why);
    } catch {
      // Already closed.
    }
    this.retry();
  }

  private async onMessage(socket: WebSocketLike, data: unknown): Promise<void> {
    if (typeof data === "string") {
      if (data === PONG) {
        this.clock.clearTimeout(this.pongTimer);
        this.pongTimer = null;
        return;
      }
      let frame: ServiceFrame;
      try {
        frame = JSON.parse(data) as ServiceFrame;
      } catch {
        return;
      }
      if (frame.t === "hello") {
        this.log("info", `connected; ${frame.pending} webhook(s) waiting`);
        for (const report of frame.dropped ?? []) this.noteDrop(report.routine, report);
      }
      if (frame.t === "bye") {
        if (frame.reason === "revoked") this.revoked();
        else if (socket === this.socket) this.bye = frame.reason;
      }
      return;
    }
    const bytes = await toBytes(data);
    const { seq, envelope } = decodeWebhookFrame(bytes);
    const header = readEnvelopeHeader(envelope);
    const id = b64u(header.pid);
    if (this.recent.has(id)) {
      this.enqueue("ack", [seq, id]); // taken before; the acknowledgement was lost
      return;
    }
    if (this.pending.has(id)) return; // handed on already; waiting for it to be taken
    await this.loadKey();
    let request: WebhookRequest;
    try {
      const opened = await openEnvelope(envelope, this.opener!);
      request = decodeRequestRecord(opened.plaintext);
    } catch (err) {
      // Sealed before this computer's key registered, say: the service counts it as a drop for the routine.
      this.log("warn", `dropping a webhook this computer cannot open: ${describe(err)}`);
      this.noteDrop(header.routineId, { count: 1, reason: "unreadable", at: this.clock.now() });
      this.enqueue("unreadable", [seq, id]);
      return;
    }
    if (socket !== this.socket && this.socket !== null) return;
    this.pending.set(id, seq);
    const delivery: Delivery = {
      seq,
      id,
      routine: header.routineId,
      receivedAt: header.receivedAt,
      request,
      ack: () => this.settle(id, "ack"),
      drop: () => this.settle(id, "nack"),
      release: () => {
        this.pending.delete(id);
      },
    };
    try {
      this.options.onDelivery(delivery);
    } catch (err) {
      this.log("error", `the webhook's consumer failed: ${describe(err)}`);
    }
  }

  private settle(id: string, kind: "ack" | "nack"): void {
    const seq = this.pending.get(id);
    if (seq === undefined) return;
    this.pending.delete(id);
    this.recent.set(id, seq);
    while (this.recent.size > RECENT_LIMIT) this.recent.delete(this.recent.keys().next().value!);
    this.enqueue(kind, [seq, id]);
  }

  private noteDrop(routine: string, drop: DropCount): void {
    const known = this.drops.get(routine);
    this.drops.set(
      routine,
      known
        ? { count: known.count + drop.count, reason: drop.at >= known.at ? drop.reason : known.reason, at: Math.max(known.at, drop.at) }
        : { count: drop.count, reason: drop.reason, at: drop.at },
    );
  }

  private enqueue(kind: "ack" | "nack" | "unreadable", ref: AckRef): void {
    this.outbox.push({ kind, ref });
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  /** Sends queued acknowledgements; with no open socket they are dropped, and redelivery brings them back. */
  private flush(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      this.outbox.length = 0;
      return;
    }
    for (const kind of ["ack", "nack", "unreadable"] as const) {
      const refs = this.outbox.filter((entry) => entry.kind === kind).map((entry) => entry.ref);
      for (let i = 0; i < refs.length; i += MAX_ACKS_PER_FRAME) {
        const a = refs.slice(i, i + MAX_ACKS_PER_FRAME);
        socket.send(JSON.stringify(kind === "unreadable" ? { t: "nack", a, reason: "unreadable" } : { t: kind, a }));
      }
    }
    this.outbox.length = 0;
  }

  // ---- plumbing ----

  private revoked(): void {
    this.log("warn", "this computer was revoked; the forwarder stops");
    this.setState("revoked");
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "revoked");
  }

  /** Read through a method, so checks after an await see the state as it is now. */
  private isDone(): boolean {
    return this.status === "stopped" || this.status === "revoked" || this.status === "elsewhere";
  }

  private clearPing(): void {
    this.clock.clearTimeout(this.pingTimer);
    this.clock.clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  private clearTimers(): void {
    this.clearPing();
    this.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setState(state: ClientState): void {
    if (this.status === state) return;
    if ((this.status === "revoked" || this.status === "elsewhere") && state !== "stopped") return;
    this.status = state;
    this.options.onState?.(state);
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.options.log?.(level, message);
  }

  private call(method: string, path: string, body?: unknown): Promise<Response> {
    // A request that never finishes must not hold the client up.
    const init: RequestInit = { method, signal: AbortSignal.timeout(this.requestTimeoutMs) };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    return this.options.fetch(`${this.options.origin}${path}`, init);
  }

  private async expectOk(response: Response): Promise<void> {
    if (response.ok) return;
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ForwarderError(response.status, body.error ?? "error");
  }
}

async function toBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== "undefined" && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  throw new TypeError("unsupported frame");
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
