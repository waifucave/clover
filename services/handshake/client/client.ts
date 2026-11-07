// A client for the waifucave handshake (PROTOCOL.md), on fetch, WebSocket and WebCrypto alone, so the same code runs
// in the web companion, in Bun on a computer, and in the service's own tests. Lane H's link layer can use it as is or
// as the reference for its own.

import { b64u, sha256 } from "../../shared/encoding";
import type { Signer } from "./signer";
import {
  authorizationHeader,
  type Kind,
  type LeaseOp,
  type LeaseView,
  type MemberView,
  type MessageView,
  PING,
  PONG,
  type RecordView,
  type RecoveryUse,
  requestSigningString,
  type ServiceFrame,
  CLOSE,
} from "./wire";

/** The WebSocket surface the client needs: a browser's or Bun's WebSocket has it. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", fn: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", fn: (event: unknown) => void): void;
}

/** Opens a socket to `url`; resolves once it is open. */
export type Connect = (url: string) => Promise<SocketLike>;

export const connectWebSocket: Connect = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const failed = () => reject(new Error("the socket did not open"));
    ws.addEventListener("open", () => {
      ws.removeEventListener("error", failed);
      resolve(ws as unknown as SocketLike);
    });
    ws.addEventListener("error", failed);
  });

export interface ClientOptions {
  /** The service's origin, e.g. https://handshake.waifucave.com */
  origin: string;
  fetch?: (request: Request) => Promise<Response>;
  connect?: Connect;
  now?: () => number;
}

export class HandshakeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(`handshake: ${status} ${code}`);
    this.name = "HandshakeError";
  }
}

export interface Ticket {
  url: string;
  expiresAt: number;
}

export class HandshakeClient {
  readonly origin: string;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly connect: Connect;
  readonly now: () => number;

  constructor(options: ClientOptions) {
    this.origin = options.origin.replace(/\/$/, "");
    this.fetch = options.fetch ?? ((request) => fetch(request));
    this.connect = options.connect ?? connectWebSocket;
    this.now = options.now ?? Date.now;
  }

  /** One request; answers the parsed body, or throws HandshakeError for a non-2xx answer. */
  async send(method: string, path: string, body: Uint8Array | null, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const init: RequestInit = { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) } };
    if (body) init.body = body as Uint8Array<ArrayBuffer>;
    const response = await this.fetch(new Request(`${this.origin}${path}`, init));
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    if (text) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    }
    if (!response.ok) throw new HandshakeError(response.status, typeof parsed.error === "string" ? parsed.error : "failed", parsed);
    return parsed;
  }

  private json(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value));
  }

  /** Registers a pair from both members' signatures over the pair statement. */
  registerPair(body: { pair: string; keys: [string, string]; t: number; sigs: [string, string] }): Promise<Record<string, unknown>> {
    return this.send("POST", "/v1/pairs", this.json(body));
  }

  createGroup(body: { group: string; key: string; t: number; sig: string }): Promise<Record<string, unknown>> {
    return this.send("POST", "/v1/groups", this.json(body));
  }

  /** A join: the joiner's statement and one member's admit; `admits` are more admits, so the key can vote at once. */
  joinGroup(
    group: string,
    body: { key: string; t: number; sig: string; by: string; bysig: string; admits?: Cosignature[]; from?: string; requester?: { key: string; sig: string } },
  ): Promise<Record<string, unknown>> {
    return this.send("POST", `/v1/groups/${group}/members`, this.json(body));
  }

  pair(pair: string, signer: Signer): PairScope {
    return new PairScope(this, pair, signer);
  }

  group(group: string, signer: Signer): GroupScope {
    return new GroupScope(this, group, signer);
  }

  account(token: () => Promise<string>): AccountScope {
    return new AccountScope(this, token);
  }
}

abstract class Scope {
  constructor(readonly client: HandshakeClient) {}

  protected abstract call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>>;

  protected abstract base(): string;

  async ticket(): Promise<Ticket> {
    return (await this.call("POST", `${this.base()}/tickets`)) as unknown as Ticket;
  }

  /** A socket that reconnects by itself (see ScopeSocket). */
  socket(handlers: SocketHandlers, options?: SocketOptions): ScopeSocket {
    return new ScopeSocket(this.client, () => this.ticket(), handlers, options);
  }
}

/** A pair or group scope: every request signed by the member's key, mutations one at a time (the replay rule). */
abstract class SignedScope extends Scope {
  private lastT = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    client: HandshakeClient,
    readonly id: string,
    readonly signer: Signer,
  ) {
    super(client);
  }

  get key(): string {
    return this.signer.key;
  }

  protected async signed(method: string, path: string, body: Uint8Array | null, t: number): Promise<Record<string, unknown>> {
    const hash = b64u(await sha256(body ?? new Uint8Array(0)));
    const sig = b64u(await this.signer.sign(new TextEncoder().encode(requestSigningString(method, path, t, hash))));
    return this.client.send(method, path, body, { authorization: authorizationHeader(this.signer.key, t, sig) });
  }

  protected call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const bytes = body === undefined ? null : new TextEncoder().encode(JSON.stringify(body));
    if (method === "GET") return this.signed(method, path, bytes, this.client.now());
    const run = async (): Promise<Record<string, unknown>> => {
      for (let attempt = 0; ; attempt++) {
        const t = Math.max(this.client.now(), this.lastT + 1);
        this.lastT = t;
        try {
          return await this.signed(method, path, bytes, t);
        } catch (err) {
          // Another client of the same key (a restart, a second tab) moved `t` on: once more with a fresh one.
          if (attempt === 0 && err instanceof HandshakeError && err.code === "replay") {
            this.lastT = Math.max(this.lastT, this.client.now() + 1000);
            continue;
          }
          throw err;
        }
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export interface PairView {
  pair: string;
  keys: string[];
  peer: { online: boolean };
  records: RecordView[];
}

export class PairScope extends SignedScope {
  protected base(): string {
    return `/v1/pairs/${this.id}`;
  }

  async get(): Promise<PairView> {
    return (await this.call("GET", this.base())) as unknown as PairView;
  }

  async putRecord(kind: Kind, record: { gen: number; ttl?: number; box: string }): Promise<void> {
    await this.call("PUT", `${this.base()}/records/${kind}`, record);
  }

  async sendMessage(kind: Kind, message: { ttl?: number; box: string }): Promise<{ id: string; delivered: boolean }> {
    return (await this.call("POST", `${this.base()}/messages`, { kind, ...message })) as unknown as { id: string; delivered: boolean };
  }

  async inbox(): Promise<MessageView[]> {
    return ((await this.call("POST", `${this.base()}/inbox`)) as { messages: MessageView[] }).messages;
  }

  /** Ends the pair at the service (after the local revoke, spec §8.1). */
  async end(): Promise<void> {
    await this.call("DELETE", this.base());
  }
}

export interface GroupView {
  group: string;
  members: MemberView[];
  lease: LeaseView;
  /** Whether the group has a recovery key. */
  recovery: boolean;
  recoveryUsed?: RecoveryUse;
}

/** Another key's vote over a statement (removeStatement, recoveryStatement, admitStatement). */
export interface Cosignature {
  by: string;
  sig: string;
}

export class GroupScope extends SignedScope {
  protected base(): string {
    return `/v1/groups/${this.id}`;
  }

  async get(): Promise<GroupView> {
    return (await this.call("GET", this.base())) as unknown as GroupView;
  }

  /**
   * Removes `key`: this member alone for itself; for another, a quorum of voters (PROTOCOL.md, "Group recovery"). This
   * member's own request is its vote; `cosigners` sign removeStatement(group, key, t, keep) with the same `t`.
   */
  async remove(key: string, options: { t?: number; keep?: string[]; cosigners?: Cosignature[] } = {}): Promise<void> {
    const body =
      options.cosigners || options.t !== undefined || options.keep
        ? { ...(options.keep ? { keep: options.keep } : {}), ...(options.cosigners || options.t !== undefined ? { t: options.t ?? this.client.now(), removes: options.cosigners ?? [] } : {}) }
        : undefined;
    await this.call("DELETE", `${this.base()}/members/${key}`, body);
  }

  /** What removing `key` would roll back: the members that come back, and the keys that go unless kept. */
  async rollback(key: string): Promise<{ restores: string[]; drops: string[] }> {
    return (await this.call("GET", `${this.base()}/rollback/${key}`)) as unknown as { restores: string[]; drops: string[] };
  }

  /** Sets (or with null clears) the recovery key; `cosigners` sign recoveryStatement(group, key, t). */
  async setRecovery(key: string | null, t: number, cosigners: Cosignature[] = []): Promise<{ recovery: boolean }> {
    return (await this.call("PUT", `${this.base()}/recovery`, { key, t, sigs: cosigners })) as unknown as { recovery: boolean };
  }

  /** A lease operation; a refusal throws HandshakeError `held` with the current lease in `body.lease`. */
  async lease(op: LeaseOp, options: { epoch?: number; ttl?: number } = {}): Promise<LeaseView> {
    return ((await this.call("POST", `${this.base()}/lease`, { op, ...options })) as { lease: LeaseView }).lease;
  }
}

export class AccountScope extends Scope {
  constructor(
    client: HandshakeClient,
    private readonly token: () => Promise<string>,
  ) {
    super(client);
  }

  protected base(): string {
    return "/v1/accounts/self";
  }

  protected async call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const bytes = body === undefined ? null : new TextEncoder().encode(JSON.stringify(body));
    return this.client.send(method, path, bytes, { authorization: `Bearer ${await this.token()}` });
  }

  async get(): Promise<{ online: string[]; records: RecordView[]; lease: LeaseView }> {
    return (await this.call("GET", this.base())) as unknown as { online: string[]; records: RecordView[]; lease: LeaseView };
  }

  async putRecord(kind: Kind, to: string, record: { gen: number; ttl?: number; box: string }): Promise<void> {
    await this.call("PUT", `${this.base()}/records/${kind}/${to}`, record);
  }

  async sendMessage(to: string, kind: Kind, message: { ttl?: number; box: string }): Promise<{ id: string; delivered: boolean }> {
    return (await this.call("POST", `${this.base()}/messages`, { to, kind, ...message })) as unknown as { id: string; delivered: boolean };
  }

  async inbox(): Promise<MessageView[]> {
    return ((await this.call("POST", `${this.base()}/inbox`)) as { messages: MessageView[] }).messages;
  }

  async lease(op: LeaseOp, options: { epoch?: number; ttl?: number } = {}): Promise<LeaseView> {
    return ((await this.call("POST", `${this.base()}/lease`, { op, ...options })) as { lease: LeaseView }).lease;
  }

  /** Tells the service a device was revoked at the account service. */
  async revokeDevice(device: string): Promise<void> {
    await this.call("DELETE", `${this.base()}/devices/${device}`);
  }
}

// ---- sockets ----

export interface SocketHandlers {
  onFrame(frame: ServiceFrame): void;
  /** The socket opened (again). */
  onOpen?(): void;
  /** The socket closed; it re-opens by itself unless `final`. */
  onClose?(code: number, final: boolean): void;
}

export interface SocketOptions {
  pingMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * A scope's socket that stays open: a fresh ticket per connection, a ping every 30 s, and re-opening with backoff
 * after a drop. It stops for good when the scope ends (4003) or another socket of the same member replaces it (4000).
 */
export class ScopeSocket {
  private ws: SocketLike | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private backoff: number;
  private readonly pingMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly client: HandshakeClient,
    private readonly ticket: () => Promise<Ticket>,
    private readonly handlers: SocketHandlers,
    options: SocketOptions = {},
  ) {
    this.pingMs = options.pingMs ?? 30_000;
    this.minBackoffMs = options.minBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.backoff = this.minBackoffMs;
  }

  get open(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  start(): this {
    void this.dial();
    return this;
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.timer) clearInterval(this.timer);
    this.retry = null;
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, "bye");
    } catch {
      // Already closed.
    }
  }

  private async dial(): Promise<void> {
    if (this.stopped) return;
    let ws: SocketLike;
    try {
      const { url } = await this.ticket();
      ws = await this.client.connect(url);
    } catch (err) {
      if (err instanceof HandshakeError && (err.status === 410 || err.status === 403)) {
        this.stopped = true;
        this.handlers.onClose?.(CLOSE.ended, true);
        return;
      }
      this.later();
      return;
    }
    if (this.stopped) {
      ws.close(1000, "bye");
      return;
    }
    this.ws = ws;
    this.backoff = this.minBackoffMs;
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || event.data === PONG) return;
      let frame: ServiceFrame;
      try {
        frame = JSON.parse(event.data) as ServiceFrame;
      } catch {
        return;
      }
      this.handlers.onFrame(frame);
    });
    ws.addEventListener("close", (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      const final = this.stopped || event.code === CLOSE.ended || event.code === CLOSE.replaced;
      if (final) this.stopped = true;
      this.handlers.onClose?.(event.code, final);
      if (!final) this.later();
    });
    ws.addEventListener("error", () => undefined);
    this.timer = setInterval(() => {
      try {
        if (ws.readyState === 1) ws.send(PING);
      } catch {
        // The close handler re-dials.
      }
    }, this.pingMs);
    this.handlers.onOpen?.();
  }

  private later(): void {
    if (this.stopped) return;
    const wait = this.backoff * (0.5 + Math.random() / 2);
    this.backoff = Math.min(this.backoff * 2, this.maxBackoffMs);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.dial();
    }, wait);
  }
}
