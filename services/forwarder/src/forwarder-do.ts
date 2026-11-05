// The account's Durable Object: its computers' forwarder keys, its webhook routines, and the webhooks held for
// them, sealed. Each computer keeps one WebSocket here, accepted through the WebSocket Hibernation API.
//
// The holding rule (spec §7, [D]): hold a payload for as long as holding stays flat in cost. What a payload
// costs here does not grow with the time it is held:
//   * a webhook is one insert and, once the computer acknowledges it, one delete (two rows written; no index
//     beyond the primary key, so no extra index rows);
//   * nothing runs while a payload waits: the object hibernates with its sockets open, keep-alives are
//     answered by the runtime's auto-response (free), and no timers are set (a timer would pin it in memory);
//   * expiry is one alarm, set only when none is pending and moved at most once an hour, so a week of
//     waiting adds at most a few alarm writes for the whole account, not per payload;
//   * stored bytes are billed per GB-month, a rounding error for webhook payloads.
// A connection costs two rows of its own (its ticket's nonce, kept until the ticket has expired, in a
// WITHOUT ROWID table so no index row is written beside it, and that row's delete), however many payloads it carries.
// So the hold ends only on the policy's limits: until the routine's computer takes it, for at most HOLD_DAYS,
// with the account capped at MAX_HELD payloads and MAX_HELD_BYTES bytes, oldest dropped first.

import { DurableObject } from "cloudflare:workers";

import { b64u, equalBytes, fromB64u, own, randomBytes, type Bytes } from "../../../plugins/clover/forwarder/src/wire/bytes";
import { keyId, sealEnvelope, ROUTINE_ID_RE } from "../../../plugins/clover/forwarder/src/wire/envelope";
import {
  CLOSE_PROTOCOL,
  CLOSE_REPLACED,
  CLOSE_REVOKED,
  CLOSE_STALE,
  DEVICE_ID_RE,
  encodeWebhookFrame,
  MAX_ACKS_PER_FRAME,
  PING,
  PONG,
  type DeviceInfo,
  type RoutineInfo,
  type ServiceFrame,
} from "../../../plugins/clover/forwarder/src/wire/protocol";
import { limitsFrom, type Env, type Limits } from "./env";

/** Who is calling, as the Worker established it from a verified account token. */
export interface Caller {
  /** ownerHash(account): the Durable Object belongs to exactly one account. */
  owner: string;
  device: string;
}

export type Refusal = { ok: false; status: 401 | 403 | 404 | 409 | 413 | 503; error: string; device?: string };

export type ReceiveResult = { ok: true; id: string; seq: number; delivered: boolean } | Refusal;

/** Kept with each hibernatable socket (serializeAttachment), so it survives the object being evicted. */
interface SocketState {
  device: string;
  /** The highest sequence number sent on this socket: frames at or below it are in flight until acknowledged. */
  sentUpTo: number;
  connectedAt: number;
  lastSeen: number;
}

interface HeldRow extends Record<string, SqlStorageValue> {
  seq: number;
  size: number;
  env: ArrayBuffer;
}

const SOCKET_TAG = (device: string) => `d:${device}`;

/** A used ticket's nonce is kept this long past the ticket's expiry, in case this object's clock runs ahead of the Worker's. */
const TICKET_SLACK_MS = 60_000;

export class ForwarderDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly limits: Limits;
  /** Lazily loaded caches; all lost (and rebuilt) when the object is evicted. */
  private owner: string | null | undefined;
  private totals: { count: number; bytes: number } | undefined;
  private alarmAt: number | null | undefined;
  private lastSeq = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.limits = limitsFrom(env);
    // Synchronous SQL: it finishes before any event is delivered, so no blockConcurrencyWhile is needed.
    this.migrate();
    // Keep-alives never wake the object: the runtime answers "ping" itself.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  private migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    const schema = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'schema'").toArray()[0];
    if (schema) return;
    this.sql.exec(`
      CREATE TABLE devices (id TEXT PRIMARY KEY, kid BLOB NOT NULL, pub BLOB NOT NULL, name TEXT, added INTEGER NOT NULL);
      CREATE TABLE revoked (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE routines (id TEXT PRIMARY KEY, key_hash BLOB NOT NULL, device TEXT NOT NULL, registered INTEGER NOT NULL);
      CREATE TABLE held (seq INTEGER PRIMARY KEY, routine TEXT NOT NULL, pid BLOB NOT NULL,
                         received INTEGER NOT NULL, size INTEGER NOT NULL, env BLOB NOT NULL);
      CREATE TABLE tickets (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL) WITHOUT ROWID;
      INSERT INTO meta (k, v) VALUES ('schema', '1');
    `);
  }

  // ---- account ownership ----

  private ownerMatches(owner: string): boolean {
    if (this.owner === undefined) {
      this.owner = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'owner'").toArray()[0]?.v ?? null;
    }
    if (this.owner === null) {
      this.sql.exec("INSERT INTO meta (k, v) VALUES ('owner', ?)", owner);
      this.owner = owner;
      return true;
    }
    return this.owner === owner;
  }

  private deviceRow(id: string): { id: string; kid: ArrayBuffer; pub: ArrayBuffer; name: string | null } | undefined {
    return this.sql
      .exec<{ id: string; kid: ArrayBuffer; pub: ArrayBuffer; name: string | null }>("SELECT id, kid, pub, name FROM devices WHERE id = ?", id)
      .toArray()[0];
  }

  private isRevoked(id: string): boolean {
    return this.sql.exec("SELECT 1 AS x FROM revoked WHERE id = ?", id).toArray().length > 0;
  }

  private routineRow(id: string): { key_hash: ArrayBuffer; device: string } | undefined {
    return this.sql.exec<{ key_hash: ArrayBuffer; device: string }>("SELECT key_hash, device FROM routines WHERE id = ?", id).toArray()[0];
  }

  /** Common checks for a device API call: the right account, and a computer that has not been revoked. */
  private refuse(caller: Caller): Refusal | null {
    if (!this.ownerMatches(caller.owner)) return { ok: false, status: 403, error: "wrong_account" };
    if (this.isRevoked(caller.device)) return { ok: false, status: 403, error: "revoked" };
    return null;
  }

  // ---- device API ----

  async putDevice(caller: Caller, input: { encKey: Uint8Array; name: string | null }): Promise<{ ok: true; kid: string } | Refusal> {
    if (input.encKey.length !== 32) return { ok: false, status: 409, error: "bad_key" };
    const kid = await keyId(input.encKey);
    // Synchronous from here on: nothing can interleave between the checks and the write.
    const refused = this.refuse(caller);
    if (refused) return refused;
    const existing = this.deviceRow(caller.device);
    if (existing && equalBytes(new Uint8Array(existing.pub), input.encKey) && existing.name === input.name) {
      return { ok: true, kid: b64u(kid) }; // unchanged: no write
    }
    if (!existing) {
      const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM devices").one().n;
      if (count >= this.limits.maxDevices) return { ok: false, status: 409, error: "too_many_devices" };
    }
    this.sql.exec(
      `INSERT INTO devices (id, kid, pub, name, added) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kid = excluded.kid, pub = excluded.pub, name = excluded.name`,
      caller.device,
      kid.buffer,
      own(input.encKey).buffer,
      input.name,
      Date.now(),
    );
    return { ok: true, kid: b64u(kid) };
  }

  async listDevices(caller: Caller): Promise<{ ok: true; devices: DeviceInfo[] } | Refusal> {
    const refused = this.refuse(caller);
    if (refused) return refused;
    const devices = this.sql
      .exec<{ id: string; name: string | null; kid: ArrayBuffer; added: number }>("SELECT id, name, kid, added FROM devices ORDER BY added")
      .toArray()
      .map((row) => ({ id: row.id, name: row.name, kid: b64u(new Uint8Array(row.kid)), added: row.added }));
    return { ok: true, devices };
  }

  /**
   * Revokes a computer (spec §8.1: revoking cuts its links at once). Its key stops being a recipient, its
   * socket closes, and its routines go with it: their files lived on it, so nothing else can run them.
   */
  async revokeDevice(caller: Caller, deviceId: string): Promise<{ ok: true } | Refusal> {
    const refused = this.refuse(caller);
    if (refused) return refused;
    if (!DEVICE_ID_RE.test(deviceId)) return { ok: false, status: 404, error: "unknown_device" };
    this.sql.exec("INSERT OR IGNORE INTO revoked (id, at) VALUES (?, ?)", deviceId, Date.now());
    this.sql.exec("DELETE FROM devices WHERE id = ?", deviceId);
    this.dropWhere("routine IN (SELECT id FROM routines WHERE device = ?)", deviceId);
    this.sql.exec("DELETE FROM routines WHERE device = ?", deviceId);
    for (const ws of this.ctx.getWebSockets(SOCKET_TAG(deviceId))) this.closeSocket(ws, CLOSE_REVOKED, "revoked");
    return { ok: true };
  }

  async putRoutine(
    caller: Caller,
    routineId: string,
    input: { keyHash: Uint8Array; takeover: boolean },
  ): Promise<{ ok: true; device: string } | Refusal> {
    const refused = this.refuse(caller);
    if (refused) return refused;
    if (!ROUTINE_ID_RE.test(routineId) || input.keyHash.length !== 32) return { ok: false, status: 409, error: "bad_routine" };
    if (!this.deviceRow(caller.device)) return { ok: false, status: 409, error: "device_not_registered" };
    const existing = this.routineRow(routineId);
    const keyHash = own(input.keyHash).buffer;
    if (!existing) {
      const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM routines").one().n;
      if (count >= this.limits.maxRoutines) return { ok: false, status: 409, error: "too_many_routines" };
      this.sql.exec("INSERT INTO routines (id, key_hash, device, registered) VALUES (?, ?, ?, ?)", routineId, keyHash, caller.device, Date.now());
      return { ok: true, device: caller.device };
    }
    const sameKey = equalBytes(new Uint8Array(existing.key_hash), input.keyHash);
    if (existing.device === caller.device) {
      if (!sameKey) this.sql.exec("UPDATE routines SET key_hash = ? WHERE id = ?", keyHash, routineId);
      return { ok: true, device: caller.device };
    }
    // Held by another computer. Moving a routine file re-registers it from its new computer with takeover
    // (spec §7); without it, a second copy must not steal the routine's webhooks.
    if (!input.takeover) return { ok: false, status: 409, error: "held_elsewhere", device: existing.device };
    this.sql.exec("UPDATE routines SET device = ?, key_hash = ?, registered = ? WHERE id = ?", caller.device, keyHash, Date.now(), routineId);
    // Its held payloads follow it: start the new computer's socket over so they are sent there too.
    for (const ws of this.ctx.getWebSockets(SOCKET_TAG(caller.device))) {
      const state = ws.deserializeAttachment() as SocketState | null;
      if (!state) continue;
      state.sentUpTo = 0;
      ws.serializeAttachment(state);
      this.pump(ws, state);
    }
    return { ok: true, device: caller.device };
  }

  async deleteRoutine(caller: Caller, routineId: string): Promise<{ ok: true } | Refusal> {
    const refused = this.refuse(caller);
    if (refused) return refused;
    this.dropWhere("routine = ?", routineId);
    this.sql.exec("DELETE FROM routines WHERE id = ?", routineId);
    return { ok: true };
  }

  async listRoutines(caller: Caller): Promise<{ ok: true; routines: RoutineInfo[] } | Refusal> {
    const refused = this.refuse(caller);
    if (refused) return refused;
    const routines = this.sql
      .exec<{ id: string; device: string; held: number }>(
        `SELECT r.id AS id, r.device AS device, COUNT(h.seq) AS held
         FROM routines r LEFT JOIN held h ON h.routine = r.id GROUP BY r.id ORDER BY r.id`,
      )
      .toArray();
    return { ok: true, routines };
  }

  // ---- webhooks ----

  /**
   * A webhook for one of this account's routines. The Worker has already checked the path, the size and the
   * rate, and hashed the key the sender presented; the key itself never reaches this object.
   */
  async receive(input: { routineId: string; keyHash: Uint8Array; record: Uint8Array; receivedAt: number }): Promise<ReceiveResult> {
    const routine = this.routineRow(input.routineId);
    if (!routine || !equalBytes(new Uint8Array(routine.key_hash), input.keyHash)) return { ok: false, status: 401, error: "unauthorized" };
    const recipients = this.sql
      .exec<{ kid: ArrayBuffer; pub: ArrayBuffer }>("SELECT kid, pub FROM devices ORDER BY added")
      .toArray()
      .map((row) => ({ kid: new Uint8Array(row.kid), publicKey: new Uint8Array(row.pub) }));
    if (recipients.length === 0) return { ok: false, status: 503, error: "no_devices" };

    // Sealed on arrival: from here on the request exists only as ciphertext.
    const pid = randomBytes(16);
    const envelope = await sealEnvelope({ routineId: input.routineId, receivedAt: input.receivedAt, recipients, plaintext: input.record, pid });

    // Other events may have run during the await; check again, then write without awaiting anything.
    const still = this.routineRow(input.routineId);
    if (!still || !equalBytes(new Uint8Array(still.key_hash), input.keyHash)) return { ok: false, status: 401, error: "unauthorized" };
    if (envelope.length > this.limits.maxHeldBytes) return { ok: false, status: 413, error: "too_large" };
    const now = Date.now();
    this.dropWhere("received <= ?", now - this.limits.holdMs);
    this.makeRoom(envelope.length);
    const seq = this.nextSeq(now);
    this.sql.exec(
      "INSERT INTO held (seq, routine, pid, received, size, env) VALUES (?, ?, ?, ?, ?, ?)",
      seq,
      input.routineId,
      pid.buffer,
      input.receivedAt,
      envelope.length,
      envelope.buffer,
    );
    const totals = this.loadTotals();
    totals.count += 1;
    totals.bytes += envelope.length;

    let delivered = false;
    for (const ws of this.openSockets(still.device)) {
      delivered = this.pump(ws, ws.deserializeAttachment() as SocketState) || delivered;
    }
    await this.ensureAlarm();
    return { ok: true, id: b64u(pid), seq, delivered };
  }

  /**
   * Sequence numbers only ever grow, across evictions too: they start from the clock in microseconds, and an
   * object is evicted only after seconds idle, so a woken object's first number is far above its last one.
   * Acknowledgements also carry the payload id, so even a reused number could not delete another payload.
   */
  private nextSeq(now: number): number {
    if (this.lastSeq === 0) {
      this.lastSeq = this.sql.exec<{ m: number | null }>("SELECT MAX(seq) AS m FROM held").one().m ?? 0;
    }
    this.lastSeq = Math.max(now * 1000, this.lastSeq + 1);
    return this.lastSeq;
  }

  private loadTotals(): { count: number; bytes: number } {
    if (!this.totals) {
      const row = this.sql.exec<{ n: number; b: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM held").one();
      this.totals = { count: row.n, bytes: row.b };
    }
    return this.totals;
  }

  /** Drops the oldest held payloads until one of `size` bytes fits under the account's caps. */
  private makeRoom(size: number): void {
    const totals = this.loadTotals();
    while (totals.count > 0 && (totals.count + 1 > this.limits.maxHeld || totals.bytes + size > this.limits.maxHeldBytes)) {
      const before = totals.count;
      this.dropWhere("seq = (SELECT MIN(seq) FROM held)");
      if (totals.count === before) break;
    }
  }

  /** Deletes held payloads matching `where`, keeping the cached totals right. */
  private dropWhere(where: string, ...bindings: unknown[]): number {
    const rows = this.sql.exec<{ size: number }>(`DELETE FROM held WHERE ${where} RETURNING size`, ...bindings).toArray();
    if (this.totals) {
      for (const row of rows) {
        this.totals.count -= 1;
        this.totals.bytes -= row.size;
      }
    }
    return rows.length;
  }

  // ---- expiry ----

  /** Sets the expiry alarm when none is pending. One alarm serves the whole account. */
  private async ensureAlarm(): Promise<void> {
    if (this.alarmAt === undefined) this.alarmAt = await this.ctx.storage.getAlarm();
    if (this.alarmAt !== null) return;
    const oldest = this.sql.exec<{ r: number | null }>("SELECT MIN(received) AS r FROM held").one().r;
    if (oldest === null) return;
    const at = Math.max(oldest + this.limits.holdMs - this.limits.expiryGapMs, Date.now() + this.limits.expiryGapMs);
    await this.ctx.storage.setAlarm(at);
    this.alarmAt = at;
  }

  /**
   * Drops what would expire before the next run (at most one gap early, never late), then sets the next
   * alarm at least one gap away, so expiry costs at most one alarm write per gap for the whole account.
   */
  override async alarm(): Promise<void> {
    this.alarmAt = null;
    this.dropWhere("received <= ?", Date.now() + this.limits.expiryGapMs - this.limits.holdMs);
    await this.ensureAlarm();
  }

  // ---- connections ----

  /** A computer's WebSocket, forwarded by the Worker once it has checked the ticket. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a websocket", { status: 426 });
    // Set by the Worker from the ticket it verified; nothing else can reach this object.
    const device = request.headers.get("x-clover-device") ?? "";
    const nonce = request.headers.get("x-clover-nonce") ?? "";
    const expires = Number(request.headers.get("x-clover-ticket-expires"));
    if (!nonce || !Number.isSafeInteger(expires)) return new Response("bad ticket", { status: 400 });
    if (!this.deviceRow(device) || this.isRevoked(device)) return new Response("unknown device", { status: 403 });
    // A ticket opens one connection, ever: its nonce is kept until the ticket can no longer be presented.
    const now = Date.now();
    this.sql.exec("DELETE FROM tickets WHERE expires <= ?", now - TICKET_SLACK_MS);
    if (this.sql.exec("SELECT 1 AS x FROM tickets WHERE nonce = ?", nonce).toArray().length > 0) {
      return new Response("ticket already used", { status: 409 });
    }
    this.sql.exec("INSERT INTO tickets (nonce, expires) VALUES (?, ?)", nonce, expires);
    // One connection per computer: a new one replaces the old.
    for (const ws of this.ctx.getWebSockets(SOCKET_TAG(device))) this.closeSocket(ws, CLOSE_REPLACED, "replaced");

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [SOCKET_TAG(device)]);
    const state: SocketState = { device, sentUpTo: 0, connectedAt: now, lastSeen: now };
    server.serializeAttachment(state);
    this.dropWhere("received <= ?", now - this.limits.holdMs);
    const pending = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM held h JOIN routines r ON r.id = h.routine WHERE r.device = ?", device)
      .one().n;
    const hello: ServiceFrame = { t: "hello", v: 1, device, pending };
    server.send(JSON.stringify(hello));
    this.pump(server, state);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = ws.deserializeAttachment() as SocketState | null;
    if (!state) return this.closeSocket(ws, CLOSE_PROTOCOL, "no state");
    if (typeof message !== "string" || message.length > 16 * 1024) return this.closeSocket(ws, CLOSE_PROTOCOL, "bad frame");
    if (message === PING) {
      ws.send(PONG);
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch {
      return this.closeSocket(ws, CLOSE_PROTOCOL, "bad frame");
    }
    const refs = parseAcks(frame);
    if (!refs) return this.closeSocket(ws, CLOSE_PROTOCOL, "bad frame");
    for (const [seq, pid] of refs) this.dropWhere("seq = ? AND pid = ?", seq, pid.buffer);
    state.lastSeen = Date.now();
    ws.serializeAttachment(state);
    this.pump(ws, state);
  }

  override async webSocketClose(): Promise<void> {
    // Nothing to keep: what was in flight on the socket stays held and is sent again on the next connection.
  }

  override async webSocketError(): Promise<void> {}

  private openSockets(device: string): WebSocket[] {
    return this.ctx.getWebSockets(SOCKET_TAG(device)).filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  private closeSocket(ws: WebSocket, code: number, reason: "replaced" | "revoked" | "stale" | string): void {
    try {
      if (reason === "replaced" || reason === "revoked" || reason === "stale") {
        const bye: ServiceFrame = { t: "bye", reason };
        ws.send(JSON.stringify(bye));
      }
      ws.close(code, reason);
    } catch {
      // Already closing.
    }
  }

  /**
   * Sends the computer what fits in its window: payloads of the routines it holds, oldest first, past what
   * this socket has already been sent. Returns whether anything was sent.
   */
  private pump(ws: WebSocket, state: SocketState): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    const now = Date.now();
    const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    if (now - Math.max(lastPing, state.lastSeen, state.connectedAt) > this.limits.staleMs) {
      this.closeSocket(ws, CLOSE_STALE, "stale");
      return false;
    }
    const inflight = this.sql
      .exec<{ n: number; b: number }>(
        `SELECT COUNT(*) AS n, COALESCE(SUM(h.size), 0) AS b FROM held h JOIN routines r ON r.id = h.routine
         WHERE r.device = ? AND h.seq <= ?`,
        state.device,
        state.sentUpTo,
      )
      .one();
    let frames = this.limits.windowFrames - inflight.n;
    let bytes = this.limits.windowBytes - inflight.b;
    if (frames <= 0) return false;
    const rows = this.sql
      .exec<HeldRow>(
        `SELECT h.seq AS seq, h.size AS size, h.env AS env FROM held h JOIN routines r ON r.id = h.routine
         WHERE r.device = ? AND h.seq > ? ORDER BY h.seq LIMIT ?`,
        state.device,
        state.sentUpTo,
        frames,
      )
      .toArray();
    let sent = 0;
    for (const row of rows) {
      // Always let one frame through when nothing is in flight, however large it is.
      if ((inflight.n > 0 || sent > 0) && row.size > bytes) break;
      ws.send(encodeWebhookFrame(row.seq, new Uint8Array(row.env)));
      state.sentUpTo = row.seq;
      bytes -= row.size;
      frames -= 1;
      sent += 1;
    }
    if (sent > 0) ws.serializeAttachment(state);
    return sent > 0;
  }
}

function parseAcks(frame: unknown): [number, Bytes][] | null {
  if (frame === null || typeof frame !== "object") return null;
  const { t, a } = frame as { t?: unknown; a?: unknown };
  if ((t !== "ack" && t !== "nack") || !Array.isArray(a) || a.length > MAX_ACKS_PER_FRAME) return null;
  const out: [number, Bytes][] = [];
  for (const ref of a) {
    if (!Array.isArray(ref) || ref.length !== 2) return null;
    const [seq, pid] = ref as [unknown, unknown];
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0 || typeof pid !== "string") return null;
    try {
      const bytes = fromB64u(pid);
      if (bytes.length !== 16) return null;
      out.push([seq, bytes]);
    } catch {
      return null;
    }
  }
  return out;
}
