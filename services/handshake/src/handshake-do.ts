// One Durable Object per scope: a pair (`pair:<id>`), a group (`group:<id>`) or an account (`account:<sub>`). It
// keeps the scope's current state only (PROTOCOL.md, "Principles"):
//   * the members (a pair's two keys, a group's keys) and each one's last signed `t`, for the replay check;
//   * the latest record of each kind per sender and recipient, until its TTL;
//   * messages queued for a recipient whose socket is closed, until their TTL (16 at most per recipient);
//   * the lease (groups and accounts);
//   * removed keys (groups) and revoked devices (accounts), and a tombstone once a pair or group has ended.
// Records and messages are boxes the devices sealed to each other; this object never opens one.
//
// The Worker in front checks every signature and token before it calls in, so the calls here trust the member they
// are given; this object checks membership, the replay rule and every limit.
//
// Expiry is one alarm at the earliest TTL, moved only when something expires sooner, so a busy pair costs few alarm
// writes. Sockets use the hibernation API, and keep-alives are answered by the runtime without waking the object.

import { DurableObject } from "cloudflare:workers";

import {
  CLOSE,
  KINDS,
  type Kind,
  type LeaseOp,
  type LeaseView,
  LIMITS,
  type MemberView,
  type MessageView,
  PING,
  PONG,
  type RecordView,
  type ScopeKind,
  type ServiceFrame,
} from "../client/wire";
import { b64u } from "../../shared/encoding";
import type { Env } from "./env";

export interface Reply {
  status: number;
  body?: Record<string, unknown>;
}

const ok = (body?: Record<string, unknown>, status = 200): Reply => (body ? { status, body } : { status });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Reply => ({ status, body: { error, ...extra } });

/** A request the Worker has authenticated: a member key (pair, group) or a device id (account). */
export interface Call {
  scope: ScopeKind;
  id: string;
  member: string;
  /** The signed request's `t`, for a request that must be newer than the member's last (all but GET). */
  t?: number;
  op: string;
  args?: Record<string, unknown>;
}

interface SocketState {
  member: string;
  openedAt: number;
  /** Account sockets only: when the socket must be opened again (LIMITS.accountSocketMaxMs). */
  until?: number;
}

/** A used ticket's nonce is kept this long past the ticket's expiry, in case this object's clock runs ahead. */
const TICKET_SLACK_MS = 60_000;
/** Expiries closer together than this share one alarm. */
const ALARM_GAP_MS = 15_000;
/** How many records one device may keep in an account (one per recipient and kind). */
const ACCOUNT_RECORDS_PER_SENDER = 64;
/** How many messages an account holds for all its devices together. */
const ACCOUNT_QUEUED_MAX = 512;

const socketTag = (member: string) => `m:${member}`;

export class HandshakeDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private alarmAt: number | null | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  private migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID");
    if (this.metaGet("schema")) return;
    // Frozen at the first deploy: a later change needs a new schema version and a step that migrates to it.
    this.sql.exec(`
      CREATE TABLE members (key TEXT PRIMARY KEY, joined INTEGER NOT NULL, last_t INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE removed (key TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE records (recipient TEXT NOT NULL, sender TEXT NOT NULL, kind TEXT NOT NULL, gen INTEGER NOT NULL,
        expires INTEGER NOT NULL, box BLOB NOT NULL, PRIMARY KEY (recipient, sender, kind)) WITHOUT ROWID;
      CREATE TABLE messages (seq INTEGER PRIMARY KEY, id TEXT NOT NULL, recipient TEXT NOT NULL, sender TEXT NOT NULL,
        kind TEXT NOT NULL, at INTEGER NOT NULL, expires INTEGER NOT NULL, box BLOB NOT NULL);
      CREATE TABLE lease (one INTEGER PRIMARY KEY CHECK (one = 1), holder TEXT, epoch INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE tickets (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL) WITHOUT ROWID;
      INSERT INTO meta (k, v) VALUES ('schema', '1');
    `);
  }

  // ---- meta ----

  private metaGet(k: string): string | undefined {
    return this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v;
  }

  private metaSet(k: string, v: string): void {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
  }

  private kind(): ScopeKind | undefined {
    return this.metaGet("kind") as ScopeKind | undefined;
  }

  private ended(): boolean {
    return this.metaGet("ended") !== undefined;
  }

  private members(): MemberView[] {
    return this.sql
      .exec<{ key: string; joined: number }>("SELECT key, joined FROM members ORDER BY joined, key")
      .toArray()
      .map((r) => ({ key: r.key, joinedAt: r.joined }));
  }

  private isMember(key: string): boolean {
    return this.sql.exec("SELECT 1 AS x FROM members WHERE key = ?", key).toArray().length > 0;
  }

  /** Accounts: a device revoked within the keep window. Prunes older revocations as it goes. */
  private isRevoked(device: string, now: number): boolean {
    const row = this.sql.exec<{ at: number }>("SELECT at FROM removed WHERE key = ?", device).toArray()[0];
    return row !== undefined && row.at > now - LIMITS.revocationKeepMs;
  }

  // ---- registration ----

  /** A pair's registration, after the Worker checked both signatures over the pair statement. */
  async registerPair(pair: string, keys: [string, string], now: number): Promise<Reply> {
    const kind = this.kind();
    if (kind !== undefined && kind !== "pair") return fail(409, "conflict");
    if (this.ended()) return fail(410, "ended");
    if (kind === "pair") {
      const have = this.members().map((m) => m.key);
      const same = have.length === 2 && keys.every((k) => have.includes(k));
      return same ? ok({ pair, keys: have }) : fail(409, "conflict");
    }
    this.metaSet("kind", "pair");
    this.metaSet("id", pair);
    // B's join time is a millisecond after A's, so the pair's keys keep the order they were registered in.
    keys.forEach((key, i) => this.sql.exec("INSERT INTO members (key, joined, last_t) VALUES (?, ?, 0)", key, now + i));
    return ok({ pair, keys }, 201);
  }

  /** A group's creation, after the Worker checked the founder's group statement. */
  async createGroup(group: string, key: string, now: number): Promise<Reply> {
    const kind = this.kind();
    if (kind !== undefined && kind !== "group") return fail(409, "conflict");
    if (this.ended()) return fail(410, "ended");
    if (kind === "group") return this.isMember(key) ? ok({ group }) : fail(409, "conflict");
    this.metaSet("kind", "group");
    this.metaSet("id", group);
    this.sql.exec("INSERT INTO members (key, joined, last_t) VALUES (?, ?, 0)", key, now);
    this.sql.exec("INSERT INTO lease (one, holder, epoch, expires) VALUES (1, NULL, 0, 0)");
    return ok({ group }, 201);
  }

  /** A join, after the Worker checked the joining key's join statement and `by`'s admit statement, both at `t`. */
  async joinGroup(key: string, by: string, t: number, now: number): Promise<Reply> {
    if (this.kind() !== "group") return fail(404, "not_found");
    if (this.ended()) return fail(410, "ended");
    if (!this.isMember(by)) return fail(403, "not_member");
    if (this.isMember(key)) return ok({ members: this.members() });
    const removedAt = this.sql.exec<{ at: number }>("SELECT at FROM removed WHERE key = ?", key).toArray()[0]?.at;
    if (removedAt !== undefined && t <= removedAt) return fail(403, "revoked");
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM members").one().n;
    if (count >= LIMITS.membersPerGroup) return fail(409, "full");
    this.sql.exec("INSERT INTO members (key, joined, last_t) VALUES (?, ?, 0)", key, now);
    this.sql.exec("DELETE FROM removed WHERE key = ?", key);
    const members = this.members();
    this.broadcast({ t: "members", members });
    return ok({ members }, 201);
  }

  // ---- signed and token calls ----

  async call(c: Call): Promise<Reply> {
    const now = Date.now();
    const auth = this.authorize(c, now);
    if (auth) return auth;
    const args = c.args ?? {};
    switch (`${c.scope} ${c.op}`) {
      case "pair get":
        return this.pairView(c.member, now);
      case "group get":
        return ok({ group: c.id, members: this.members(), lease: this.leaseView() });
      case "account get":
        return ok({ online: this.onlineDevices(now, c.member), records: this.recordsFor(c.member, now), lease: this.leaseView() });
      case "pair putRecord":
      case "account putRecord":
        return await this.putRecord(c, args, now);
      case "pair sendMessage":
      case "account sendMessage":
        return await this.sendMessage(c, args, now);
      case "pair inbox":
      case "account inbox":
        return ok({ messages: this.takeInbox(c.member, now) });
      case "pair ticket":
      case "group ticket":
      case "account ticket":
        return ok({ member: c.member });
      case "pair end":
        return await this.endScope();
      case "group removeMember":
        return await this.removeMember(String(args.key ?? ""), now);
      case "group lease":
      case "account lease":
        return this.leaseCall(c.member, args, now);
      case "account revokeDevice":
        return this.revokeDevice(String(args.device ?? ""), now);
      default:
        return fail(404, "not_found");
    }
  }

  /** Checks the scope, the member and the replay rule; returns a refusal, or undefined to go on. */
  private authorize(c: Call, now: number): Reply | undefined {
    if (c.scope === "account") {
      if (this.kind() === undefined) {
        this.metaSet("kind", "account");
        this.metaSet("id", c.id);
        this.sql.exec("INSERT INTO lease (one, holder, epoch, expires) VALUES (1, NULL, 0, 0)");
      } else if (this.kind() !== "account") return fail(404, "not_found");
      if (this.isRevoked(c.member, now)) return fail(403, "revoked");
      return undefined;
    }
    if (this.kind() !== c.scope) return this.ended() ? fail(410, "ended") : fail(404, "not_found");
    if (this.ended()) return fail(410, "ended");
    if (!this.isMember(c.member)) return fail(403, "not_member");
    if (c.t !== undefined) {
      const written = this.sql.exec("UPDATE members SET last_t = ? WHERE key = ? AND last_t < ?", c.t, c.member, c.t).rowsWritten;
      if (written === 0) return fail(401, "replay");
    }
    return undefined;
  }

  private peerOf(member: string): string | undefined {
    return this.members().find((m) => m.key !== member)?.key;
  }

  private pairView(member: string, now: number): Reply {
    const keys = this.members().map((m) => m.key);
    const peer = this.peerOf(member);
    return ok({ pair: this.metaGet("id"), keys, peer: { online: peer ? this.isOnline(peer, now) : false }, records: this.recordsFor(member, now) });
  }

  private recordsFor(recipient: string, now: number): RecordView[] {
    return this.sql
      .exec<{ sender: string; kind: string; gen: number; expires: number; box: ArrayBuffer }>(
        "SELECT sender, kind, gen, expires, box FROM records WHERE recipient = ? AND expires > ? ORDER BY sender, kind",
        recipient,
        now,
      )
      .toArray()
      .map((r) => ({ from: r.sender, kind: r.kind as Kind, gen: r.gen, expiresAt: r.expires, box: b64u(new Uint8Array(r.box)) }));
  }

  /** The recipient a record or message goes to: the pair's other member, or a named device of the account. */
  private recipientOf(c: Call, args: Record<string, unknown>, now: number): string | Reply {
    if (c.scope === "pair") return this.peerOf(c.member) ?? fail(404, "not_found");
    const to = String(args.to ?? "");
    if (to === c.member) return fail(400, "bad_request");
    if (this.isRevoked(to, now)) return fail(403, "revoked");
    return to;
  }

  private async putRecord(c: Call, args: Record<string, unknown>, now: number): Promise<Reply> {
    const kind = args.kind as Kind;
    const gen = args.gen as number;
    const ttl = args.ttl as number;
    const box = args.box as Uint8Array;
    const recipient = this.recipientOf(c, args, now);
    if (typeof recipient !== "string") return recipient;
    const current = this.sql
      .exec<{ gen: number; expires: number }>("SELECT gen, expires FROM records WHERE recipient = ? AND sender = ? AND kind = ?", recipient, c.member, kind)
      .toArray()[0];
    if (current && current.expires > now && gen <= current.gen) return fail(409, "stale");
    if (!current && c.scope === "account") {
      const mine = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM records WHERE sender = ? AND expires > ?", c.member, now).one().n;
      if (mine >= ACCOUNT_RECORDS_PER_SENDER) return fail(409, "full");
    }
    const expires = now + ttl * 1000;
    this.sql.exec(
      `INSERT INTO records (recipient, sender, kind, gen, expires, box) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (recipient, sender, kind) DO UPDATE SET gen = excluded.gen, expires = excluded.expires, box = excluded.box`,
      recipient,
      c.member,
      kind,
      gen,
      expires,
      box,
    );
    this.send(recipient, { t: "record", from: c.member, kind, gen, expiresAt: expires, box: b64u(box) }, now);
    await this.scheduleExpiry(expires);
    return { status: 204 };
  }

  private async sendMessage(c: Call, args: Record<string, unknown>, now: number): Promise<Reply> {
    const kind = args.kind as Kind;
    const ttl = args.ttl as number;
    const box = args.box as Uint8Array;
    const recipient = this.recipientOf(c, args, now);
    if (typeof recipient !== "string") return recipient;
    const expires = now + ttl * 1000;
    const id = b64u(crypto.getRandomValues(new Uint8Array(12)));
    const frame: ServiceFrame = { t: "message", id, from: c.member, kind, at: now, expiresAt: expires, box: b64u(box) };
    if (this.send(recipient, frame, now)) return ok({ id, delivered: true }, 202);
    this.sql.exec(
      "INSERT INTO messages (id, recipient, sender, kind, at, expires, box) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      recipient,
      c.member,
      kind,
      now,
      expires,
      box,
    );
    // The oldest go first: per recipient, and for an account, over all its devices.
    this.sql.exec(
      "DELETE FROM messages WHERE recipient = ? AND seq NOT IN (SELECT seq FROM messages WHERE recipient = ? ORDER BY seq DESC LIMIT ?)",
      recipient,
      recipient,
      LIMITS.queuedPerRecipient,
    );
    if (c.scope === "account") {
      this.sql.exec("DELETE FROM messages WHERE seq NOT IN (SELECT seq FROM messages ORDER BY seq DESC LIMIT ?)", ACCOUNT_QUEUED_MAX);
    }
    await this.scheduleExpiry(expires);
    return ok({ id, delivered: false }, 202);
  }

  private takeInbox(member: string, now: number): MessageView[] {
    const rows = this.sql
      .exec<{ id: string; sender: string; kind: string; at: number; expires: number; box: ArrayBuffer }>(
        "SELECT id, sender, kind, at, expires, box FROM messages WHERE recipient = ? AND expires > ? ORDER BY seq",
        member,
        now,
      )
      .toArray();
    if (rows.length > 0) this.sql.exec("DELETE FROM messages WHERE recipient = ?", member);
    return rows.map((r) => ({ id: r.id, from: r.sender, kind: r.kind as Kind, at: r.at, expiresAt: r.expires, box: b64u(new Uint8Array(r.box)) }));
  }

  /** A pair's end, or a group's after its last member left: forget everything but a tombstone, close every socket. */
  private async endScope(): Promise<Reply> {
    const now = Date.now();
    this.sql.exec("DELETE FROM members");
    this.sql.exec("DELETE FROM records");
    this.sql.exec("DELETE FROM messages");
    this.sql.exec("DELETE FROM lease");
    this.sql.exec("DELETE FROM removed");
    this.metaSet("ended", String(now));
    for (const ws of this.ctx.getWebSockets()) this.closeSocket(ws, CLOSE.ended, "ended");
    await this.scheduleExpiry(now + LIMITS.tombstoneMs, true);
    return { status: 204 };
  }

  private async removeMember(key: string, now: number): Promise<Reply> {
    if (!this.isMember(key)) return fail(404, "not_found");
    this.sql.exec("DELETE FROM members WHERE key = ?", key);
    this.sql.exec("INSERT INTO removed (key, at) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET at = excluded.at", key, now);
    for (const ws of this.ctx.getWebSockets(socketTag(key))) this.closeSocket(ws, CLOSE.ended, "ended");
    const remaining = this.members();
    if (remaining.length === 0) return await this.endScope();
    const lease = this.leaseRow();
    if (lease.holder === key) {
      this.sql.exec("UPDATE lease SET holder = NULL, expires = ? WHERE one = 1", now);
      this.broadcast({ t: "lease", lease: this.leaseView() });
    }
    this.broadcast({ t: "members", members: remaining });
    return { status: 204 };
  }

  private revokeDevice(device: string, now: number): Reply {
    this.sql.exec("DELETE FROM removed WHERE at <= ?", now - LIMITS.revocationKeepMs);
    this.sql.exec("INSERT INTO removed (key, at) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET at = excluded.at", device, now);
    this.sql.exec("DELETE FROM records WHERE sender = ? OR recipient = ?", device, device);
    this.sql.exec("DELETE FROM messages WHERE sender = ? OR recipient = ?", device, device);
    for (const ws of this.ctx.getWebSockets(socketTag(device))) this.closeSocket(ws, CLOSE.ended, "ended");
    if (this.leaseRow().holder === device) {
      this.sql.exec("UPDATE lease SET holder = NULL, expires = ? WHERE one = 1", now);
      this.broadcast({ t: "lease", lease: this.leaseView() });
    }
    return { status: 204 };
  }

  // ---- the lease ----

  private leaseRow(): { holder: string | null; epoch: number; expires: number } {
    return (
      this.sql.exec<{ holder: string | null; epoch: number; expires: number }>("SELECT holder, epoch, expires FROM lease WHERE one = 1").toArray()[0] ?? {
        holder: null,
        epoch: 0,
        expires: 0,
      }
    );
  }

  private leaseView(): LeaseView {
    const row = this.leaseRow();
    return { holder: row.holder, epoch: row.epoch, expiresAt: row.expires };
  }

  private leaseCall(member: string, args: Record<string, unknown>, now: number): Reply {
    const op = args.op as LeaseOp;
    const ttl = args.ttl as number;
    const epoch = args.epoch as number | undefined;
    const row = this.leaseRow();
    const live = row.holder !== null && row.expires > now;
    const mine = live && row.holder === member;
    let next: { holder: string | null; epoch: number; expires: number } | null = null;
    switch (op) {
      case "acquire":
        // A new tenure (anyone's, the caller's own after a lapse) raises the epoch; holding on keeps it.
        if (live && !mine) break;
        next = { holder: member, epoch: mine ? row.epoch : row.epoch + 1, expires: now + ttl * 1000 };
        break;
      case "renew":
        if (mine && epoch === row.epoch) next = { holder: member, epoch: row.epoch, expires: now + ttl * 1000 };
        break;
      case "release":
        if (mine && epoch === row.epoch) next = { holder: null, epoch: row.epoch, expires: now };
        break;
      case "takeover":
        next = { holder: member, epoch: row.epoch + 1, expires: now + ttl * 1000 };
        break;
    }
    if (!next) return fail(409, "held", { lease: this.leaseView() });
    this.sql.exec("UPDATE lease SET holder = ?, epoch = ?, expires = ? WHERE one = 1", next.holder, next.epoch, next.expires);
    const lease = this.leaseView();
    // A renewal changes only the expiry: others learn of it when they read the lease, not by a push each time.
    if (op !== "renew") this.broadcast({ t: "lease", lease });
    return ok({ lease });
  }

  // ---- sockets ----

  /** A member's WebSocket, forwarded by the Worker once it has checked the ticket's MAC and expiry. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a websocket", { status: 426 });
    const member = request.headers.get("x-handshake-member") ?? "";
    const nonce = request.headers.get("x-handshake-nonce") ?? "";
    const expires = Number(request.headers.get("x-handshake-expires"));
    if (!member || !nonce || !Number.isSafeInteger(expires)) return new Response("bad ticket", { status: 400 });
    const now = Date.now();
    const kind = this.kind();
    if (kind === undefined) return new Response("not found", { status: 404 });
    if (this.ended()) return new Response("ended", { status: 410 });
    if (kind === "account" ? this.isRevoked(member, now) : !this.isMember(member)) return new Response("not a member", { status: 403 });
    this.sql.exec("DELETE FROM tickets WHERE expires <= ?", now - TICKET_SLACK_MS);
    if (this.sql.exec("SELECT 1 AS x FROM tickets WHERE nonce = ?", nonce).toArray().length > 0) {
      return new Response("ticket already used", { status: 409 });
    }
    this.sql.exec("INSERT INTO tickets (nonce, expires) VALUES (?, ?)", nonce, expires);

    const hadSocket = this.openSockets(member).length > 0;
    for (const ws of this.ctx.getWebSockets(socketTag(member))) this.closeSocket(ws, CLOSE.replaced, "replaced");
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [socketTag(member)]);
    const state: SocketState = { member, openedAt: now, ...(kind === "account" ? { until: now + LIMITS.accountSocketMaxMs } : {}) };
    server.serializeAttachment(state);

    if (kind === "pair") {
      const peer = this.peerOf(member);
      server.send(JSON.stringify({ t: "hello", v: 1, scope: "pair", peer: { online: peer ? this.isOnline(peer, now) : false } } satisfies ServiceFrame));
    } else if (kind === "group") {
      server.send(JSON.stringify({ t: "hello", v: 1, scope: "group", lease: this.leaseView(), members: this.members() } satisfies ServiceFrame));
    } else {
      server.send(JSON.stringify({ t: "hello", v: 1, scope: "account", online: this.onlineDevices(now, member), lease: this.leaseView() } satisfies ServiceFrame));
    }
    if (kind !== "group") {
      for (const message of this.takeInbox(member, now)) server.send(JSON.stringify({ t: "message", ...message } satisfies ServiceFrame));
      for (const record of this.recordsFor(member, now)) server.send(JSON.stringify({ t: "record", ...record } satisfies ServiceFrame));
      if (!hadSocket) this.presence(member, true, now);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Clients send only "ping" (answered by the runtime, so it never arrives here); anything else is a mistake.
    if (message === PING) {
      ws.send(PONG);
      return;
    }
    this.closeSocket(ws, CLOSE.protocol, null);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const state = ws.deserializeAttachment() as SocketState | null;
    if (!state || this.kind() === "group" || this.ended()) return;
    const now = Date.now();
    if (this.openSockets(state.member).some((other) => other !== ws)) return;
    this.presence(state.member, false, now);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  private openSockets(member: string): WebSocket[] {
    return this.ctx.getWebSockets(socketTag(member)).filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  /**
   * The member's sockets that are live: open, pinged (or opened) within the presence window, and for an account not
   * past their time. A socket that isn't is closed here, with `stale` or `reauth`.
   */
  private liveSockets(member: string, now: number): WebSocket[] {
    const live: WebSocket[] = [];
    for (const ws of this.openSockets(member)) {
      const state = ws.deserializeAttachment() as SocketState | null;
      if (!state) continue;
      if (state.until !== undefined && state.until <= now) {
        this.closeSocket(ws, CLOSE.reauth, "reauth");
        continue;
      }
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      if (now - Math.max(pinged, state.openedAt) > LIMITS.presenceStaleMs) {
        this.closeSocket(ws, CLOSE.stale, "stale");
        continue;
      }
      live.push(ws);
    }
    return live;
  }

  private isOnline(member: string, now: number): boolean {
    return this.liveSockets(member, now).length > 0;
  }

  /** The account's devices with a live socket, but the caller. */
  private onlineDevices(now: number, caller: string): string[] {
    const devices = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as SocketState | null;
      if (state && state.member !== caller && !devices.has(state.member) && this.isOnline(state.member, now)) devices.add(state.member);
    }
    return [...devices].sort();
  }

  /** Sends a frame to a member's live sockets; true when at least one took it. */
  private send(member: string, frame: ServiceFrame, now: number): boolean {
    const text = JSON.stringify(frame);
    let sent = false;
    for (const ws of this.liveSockets(member, now)) {
      try {
        ws.send(text);
        sent = true;
      } catch {
        // A socket that just closed: the next one, or the queue, gets it.
      }
    }
    return sent;
  }

  private broadcast(frame: ServiceFrame): void {
    const text = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(text);
      } catch {
        // Closing already.
      }
    }
  }

  /** Tells the others in a pair or account that a member's socket came or went. */
  private presence(member: string, online: boolean, now: number): void {
    const kind = this.kind();
    if (kind === "pair") {
      const peer = this.peerOf(member);
      if (peer) this.send(peer, { t: "presence", online }, now);
    } else if (kind === "account") {
      const frame: ServiceFrame = { t: "presence", device: member, online };
      for (const ws of this.ctx.getWebSockets()) {
        const state = ws.deserializeAttachment() as SocketState | null;
        if (!state || state.member === member || ws.readyState !== WebSocket.OPEN) continue;
        try {
          ws.send(JSON.stringify(frame));
        } catch {
          // Closing already.
        }
      }
    }
  }

  private closeSocket(ws: WebSocket, code: number, reason: "replaced" | "ended" | "stale" | "reauth" | null): void {
    try {
      if (reason) ws.send(JSON.stringify({ t: "bye", reason } satisfies ServiceFrame));
      ws.close(code, reason ?? "protocol");
    } catch {
      // Already closed.
    }
  }

  // ---- expiry ----

  /** Makes sure an alarm runs by `at` (within one gap). `force` sets it even when a later alarm is pending. */
  private async scheduleExpiry(at: number, force = false): Promise<void> {
    if (this.alarmAt === undefined) this.alarmAt = await this.ctx.storage.getAlarm();
    if (!force && this.alarmAt !== null && this.alarmAt <= at + ALARM_GAP_MS) return;
    await this.ctx.storage.setAlarm(at);
    this.alarmAt = at;
  }

  override async alarm(): Promise<void> {
    this.alarmAt = null;
    const now = Date.now();
    const ended = Number(this.metaGet("ended") ?? "0");
    if (ended > 0) {
      if (now >= ended + LIMITS.tombstoneMs) {
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        this.migrate();
        return;
      }
      await this.ctx.storage.setAlarm(ended + LIMITS.tombstoneMs);
      this.alarmAt = ended + LIMITS.tombstoneMs;
      return;
    }
    const horizon = now + ALARM_GAP_MS / 3;
    this.sql.exec("DELETE FROM records WHERE expires <= ?", horizon);
    this.sql.exec("DELETE FROM messages WHERE expires <= ?", horizon);
    this.sql.exec("DELETE FROM tickets WHERE expires <= ?", now - TICKET_SLACK_MS);
    const next = this.sql
      .exec<{ at: number | null }>("SELECT MIN(at) AS at FROM (SELECT MIN(expires) AS at FROM records UNION ALL SELECT MIN(expires) AS at FROM messages)")
      .one().at;
    if (next !== null) {
      const at = Math.max(next, now + ALARM_GAP_MS);
      await this.ctx.storage.setAlarm(at);
      this.alarmAt = at;
    }
  }
}
