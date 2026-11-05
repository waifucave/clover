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
// Around that, flat per event rather than per hour held:
//   * a drop (cap, expiry, unreadable) writes one row more, the routine's drop count, and one more when the
//     routine's computer is told;
//   * a connection costs two rows of its own (its ticket's nonce, kept until the ticket has expired, in a
//     WITHOUT ROWID table so no index row is written beside it, and that row's delete);
//   * a webhook whose key no Worker instance has checked lately costs one more request (checkKey), no write.
// So the hold ends only on the policy's limits: until the routine's computer takes it, for at most HOLD_DAYS,
// with the account capped at MAX_HELD payloads and MAX_HELD_BYTES bytes; past a cap, the oldest webhook of
// the routine holding the most is dropped first, so one noisy routine cannot push out the others.
//
// Which computer holds a routine decides who may delete it and its webhooks: a DELETE or a nack from another
// computer is refused (held_elsewhere) or ignored. An ack is honoured from any of the account's computers,
// since the one that acks has run the webhook. When the holder deletes a routine, its held webhooks stay
// until they expire, so a routine moving to another computer (spec §7) keeps them whichever arrives first,
// the old computer's DELETE or the new one's registration. Each held webhook carries a short tag of the key
// it arrived under (in the same insert, no extra write): a registration keeps or adopts only those under its
// own key, and drops the rest as "rekeyed", so re-creating a routine to replace a leaked key, or re-keying it
// in place, never hands over what the old key queued.
//
// Revocation takes any device id (one revoked before it ever registered stays out too) and lasts 24 hours
// and 10 minutes: past that, every token issued before it has expired, and the account service issues no
// new ones to a revoked device. Old revocations are pruned by age when a new one is written.

import { DurableObject } from "cloudflare:workers";

import { b64u, equalBytes, fromB64u, own, randomBytes, type Bytes } from "../../../plugins/clover/forwarder/src/wire/bytes";
import { keyId, sealEnvelope, ROUTINE_ID_RE } from "../../../plugins/clover/forwarder/src/wire/envelope";
import { encap } from "../../../plugins/clover/forwarder/src/wire/hpke";
import {
  CLOSE_PROTOCOL,
  CLOSE_REAUTH,
  CLOSE_REPLACED,
  CLOSE_REVOKED,
  CLOSE_STALE,
  DEVICE_ID_RE,
  encodeWebhookFrame,
  MAX_ACKS_PER_FRAME,
  PING,
  PONG,
  type DeviceInfo,
  type DropReason,
  type DropReport,
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

export type Refusal = { ok: false; status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 503; error: string; device?: string };

export type ReceiveResult = { ok: true; id: string; seq: number; delivered: boolean } | Refusal;

export type KeyCheck = { ok: true; allowGet: boolean } | { ok: false };

/** Kept with each hibernatable socket (serializeAttachment), so it survives the object being evicted. */
interface SocketState {
  device: string;
  /** The highest sequence number sent on this socket: frames at or below it are in flight until acknowledged. */
  sentUpTo: number;
  connectedAt: number;
  lastSeen: number;
  /** When the account token the connection was opened with expires (ms): the connection ends there. */
  authExpires: number;
}

interface HeldRow extends Record<string, SqlStorageValue> {
  seq: number;
  size: number;
  env: ArrayBuffer;
}

interface RoutineRow extends Record<string, SqlStorageValue> {
  key_hash: ArrayBuffer;
  device: string;
  allow_get: number;
}

const SOCKET_TAG = (device: string) => `d:${device}`;

/** A used ticket's nonce is kept this long past the ticket's expiry, in case this object's clock runs ahead of the Worker's. */
const TICKET_SLACK_MS = 60_000;

/** Sequence numbers count microseconds, so a cutoff time in ms becomes a sequence number this way. */
const SEQ_PER_MS = 1000;

/** The bytes of a routine's key hash kept on each held webhook, to tell which key it arrived under. */
const KEY_TAG_BYTES = 8;

/** How long a revocation is kept: the longest account-token lifetime (24 h), plus clock skew and margin. */
export const REVOCATION_KEEP_MS = 24 * 3600 * 1000 + 10 * 60 * 1000;

function keyTag(keyHash: Uint8Array): ArrayBuffer {
  return own(keyHash.subarray(0, KEY_TAG_BYTES)).buffer;
}

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
    // WITHOUT ROWID wherever the key is text, so a row write is one row, with no index row beside it.
    // Frozen at the first deploy: any later change needs a new schema version and a step that migrates to it.
    this.sql.exec(`
      CREATE TABLE devices (id TEXT PRIMARY KEY, kid BLOB NOT NULL, pub BLOB NOT NULL, name TEXT, added INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE revoked (id TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE routines (id TEXT PRIMARY KEY, key_hash BLOB NOT NULL, device TEXT NOT NULL, allow_get INTEGER NOT NULL,
                             registered INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE held (seq INTEGER PRIMARY KEY, routine TEXT NOT NULL, key_tag BLOB NOT NULL, pid BLOB NOT NULL,
                         received INTEGER NOT NULL, size INTEGER NOT NULL, env BLOB NOT NULL);
      CREATE TABLE tickets (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE drops (routine TEXT PRIMARY KEY, count INTEGER NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID;
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
    return this.sql.exec("SELECT 1 AS x FROM revoked WHERE id = ? AND at > ?", id, Date.now() - REVOCATION_KEEP_MS).toArray().length > 0;
  }

  private routineRow(id: string): RoutineRow | undefined {
    return this.sql.exec<RoutineRow>("SELECT key_hash, device, allow_get FROM routines WHERE id = ?", id).toArray()[0];
  }

  private heldFor(routine: string): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM held WHERE routine = ?", routine).one().n;
  }

  /** Common checks for a device API call: the right account, and a computer that has not been revoked. */
  private refuse(caller: Caller): Refusal | null {
    if (!this.ownerMatches(caller.owner)) return { ok: false, status: 403, error: "wrong_account" };
    if (this.isRevoked(caller.device)) return { ok: false, status: 403, error: "revoked" };
    return null;
  }

  // ---- device API ----

  async putDevice(caller: Caller, input: { encKey: Uint8Array; name: string | null }): Promise<{ ok: true; kid: string } | Refusal> {
    if (input.encKey.length !== 32) return { ok: false, status: 400, error: "bad_key" };
    // A key nothing can be sealed to (a small-order point) would fail every webhook for the account: refuse it here.
    try {
      await encap(input.encKey);
    } catch {
      return { ok: false, status: 400, error: "bad_key" };
    }
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
   * Revokes a device (spec §8.1: revoking cuts its links at once), registered here or not: one revoked before
   * it ever connected cannot register later with a token it already holds. A registered computer's key stops
   * being a recipient, its socket closes, and its routines go with it: their files lived on it. Revocations
   * older than every token they guard against are pruned here, so the list stays bounded by age.
   */
  async revokeDevice(caller: Caller, deviceId: string): Promise<{ ok: true } | Refusal> {
    const refused = this.refuse(caller);
    if (refused) return refused;
    if (!DEVICE_ID_RE.test(deviceId)) return { ok: false, status: 404, error: "unknown_device" };
    const now = Date.now();
    this.sql.exec("DELETE FROM revoked WHERE at <= ?", now - REVOCATION_KEEP_MS);
    this.sql.exec("INSERT INTO revoked (id, at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at", deviceId, now);
    if (!this.deviceRow(deviceId)) return { ok: true };
    this.sql.exec("DELETE FROM devices WHERE id = ?", deviceId);
    this.dropWhere("routine IN (SELECT id FROM routines WHERE device = ?)", null, deviceId);
    this.sql.exec("DELETE FROM drops WHERE routine IN (SELECT id FROM routines WHERE device = ?)", deviceId);
    this.sql.exec("DELETE FROM routines WHERE device = ?", deviceId);
    for (const ws of this.ctx.getWebSockets(SOCKET_TAG(deviceId))) this.closeSocket(ws, CLOSE_REVOKED, "revoked");
    return { ok: true };
  }

  async putRoutine(
    caller: Caller,
    routineId: string,
    input: { keyHash: Uint8Array; takeover: boolean; allowGet: boolean },
  ): Promise<{ ok: true; device: string } | Refusal> {
    const refused = this.refuse(caller);
    if (refused) return refused;
    if (!ROUTINE_ID_RE.test(routineId) || input.keyHash.length !== 32) return { ok: false, status: 400, error: "bad_routine" };
    if (!this.deviceRow(caller.device)) return { ok: false, status: 409, error: "device_not_registered" };
    const existing = this.routineRow(routineId);
    const keyHash = own(input.keyHash).buffer;
    const allowGet = input.allowGet ? 1 : 0;
    if (!existing) {
      const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM routines").one().n;
      if (count >= this.limits.maxRoutines) return { ok: false, status: 409, error: "too_many_routines" };
      this.sql.exec(
        "INSERT INTO routines (id, key_hash, device, allow_get, registered) VALUES (?, ?, ?, ?, ?)",
        routineId,
        keyHash,
        caller.device,
        allowGet,
        Date.now(),
      );
      // Webhooks kept from an earlier holder (a move whose DELETE came first) are this computer's now, if they
      // came under this key; under another key (the routine re-created to replace it), they are dropped.
      this.dropRekeyed(routineId, input.keyHash);
      if (this.heldFor(routineId) > 0) this.resendTo(caller.device);
      return { ok: true, device: caller.device };
    }
    if (existing.device === caller.device) {
      const sameKey = equalBytes(new Uint8Array(existing.key_hash), input.keyHash);
      if (!sameKey || existing.allow_get !== allowGet) {
        this.sql.exec("UPDATE routines SET key_hash = ?, allow_get = ? WHERE id = ?", keyHash, allowGet, routineId);
      }
      if (!sameKey) this.dropRekeyed(routineId, input.keyHash);
      return { ok: true, device: caller.device };
    }
    // Held by another computer. Moving a routine file re-registers it from its new computer with takeover
    // (spec §7); without it, a second copy must not steal the routine's webhooks.
    if (!input.takeover) return { ok: false, status: 409, error: "held_elsewhere", device: existing.device };
    this.sql.exec(
      "UPDATE routines SET device = ?, key_hash = ?, allow_get = ?, registered = ? WHERE id = ?",
      caller.device,
      keyHash,
      allowGet,
      Date.now(),
      routineId,
    );
    this.dropRekeyed(routineId, input.keyHash);
    this.resendTo(caller.device);
    return { ok: true, device: caller.device };
  }

  /** Drops a routine's held webhooks that arrived under another key than `keyHash`, reported as "rekeyed". */
  private dropRekeyed(routineId: string, keyHash: Uint8Array): void {
    this.dropWhere("routine = ? AND key_tag != ?", "rekeyed", routineId, keyTag(keyHash));
  }

  /**
   * Deletes a routine this computer holds. Its held webhooks stay until they expire, for whichever computer
   * registers the routine next; a computer that does not hold it is told where it is held instead.
   */
  async deleteRoutine(caller: Caller, routineId: string): Promise<{ ok: true } | Refusal> {
    const refused = this.refuse(caller);
    if (refused) return refused;
    const existing = this.routineRow(routineId);
    if (!existing) return { ok: true };
    if (existing.device !== caller.device) return { ok: false, status: 409, error: "held_elsewhere", device: existing.device };
    this.sql.exec("DELETE FROM routines WHERE id = ?", routineId);
    this.sql.exec("DELETE FROM drops WHERE routine = ?", routineId);
    return { ok: true };
  }

  /**
   * The account's routines. Drops on the caller's own routines are cleared once listed here (the hello only
   * reports them), so a computer that restarts before listing still learns of them.
   */
  async listRoutines(caller: Caller): Promise<{ ok: true; routines: RoutineInfo[] } | Refusal> {
    const refused = this.refuse(caller);
    if (refused) return refused;
    const rows = this.sql
      .exec<{ id: string; device: string; allow_get: number; held: number; count: number | null; reason: string | null; at: number | null }>(
        `SELECT r.id AS id, r.device AS device, r.allow_get AS allow_get,
                (SELECT COUNT(*) FROM held h WHERE h.routine = r.id) AS held,
                d.count AS count, d.reason AS reason, d.at AS at
         FROM routines r LEFT JOIN drops d ON d.routine = r.id ORDER BY r.id`,
      )
      .toArray();
    let told = false;
    const routines = rows.map((row) => {
      const info: RoutineInfo = { id: row.id, device: row.device, held: row.held, allowGet: row.allow_get === 1 };
      if (row.count !== null && row.reason !== null && row.at !== null) {
        info.dropped = { count: row.count, reason: row.reason as DropReason, at: row.at };
        if (row.device === caller.device) told = true;
      }
      return info;
    });
    if (told) this.sql.exec("DELETE FROM drops WHERE routine IN (SELECT id FROM routines WHERE device = ?)", caller.device);
    return { ok: true, routines };
  }

  // ---- webhooks ----

  /**
   * Whether `keyHash` is the routine's key, for the Worker to check before it reads a body. Reads only; the
   * Worker caches a success, and receive() checks again anyway.
   */
  async checkKey(routineId: string, keyHash: Uint8Array): Promise<KeyCheck> {
    const routine = this.routineRow(routineId);
    if (!routine || !equalBytes(new Uint8Array(routine.key_hash), keyHash)) return { ok: false };
    return { ok: true, allowGet: routine.allow_get === 1 };
  }

  /**
   * A webhook for one of this account's routines. The Worker has already checked the path, the key (or a
   * recent check of it), the size and the rate, and hashed the key; the key itself never reaches this object.
   */
  async receive(input: { routineId: string; keyHash: Uint8Array; method: string; record: Uint8Array; receivedAt: number }): Promise<ReceiveResult> {
    const routine = this.routineRow(input.routineId);
    if (!routine || !equalBytes(new Uint8Array(routine.key_hash), input.keyHash)) return { ok: false, status: 401, error: "unauthorized" };
    if (input.method === "GET" && routine.allow_get !== 1) return { ok: false, status: 405, error: "method_not_allowed" };
    const recipients = this.sql
      .exec<{ kid: ArrayBuffer; pub: ArrayBuffer }>("SELECT kid, pub FROM devices ORDER BY added")
      .toArray()
      .map((row) => ({ kid: new Uint8Array(row.kid), publicKey: new Uint8Array(row.pub) }));
    if (recipients.length === 0) return { ok: false, status: 503, error: "no_devices" };

    // Sealed on arrival: from here on the request exists only as ciphertext. A computer whose key cannot be
    // sealed to is left out, and the others still get the webhook.
    const pid = randomBytes(16);
    let skipped = 0;
    let envelope: Bytes;
    try {
      envelope = await sealEnvelope({
        routineId: input.routineId,
        receivedAt: input.receivedAt,
        recipients,
        plaintext: input.record,
        pid,
        onRecipientError: () => {
          skipped += 1;
        },
      });
    } catch {
      return { ok: false, status: 503, error: "no_devices" };
    }
    if (skipped > 0) console.warn(`forwarder: ${skipped} computer key(s) could not be sealed to`);

    // Other events may have run during the await; check again, then write without awaiting anything.
    const still = this.routineRow(input.routineId);
    if (!still || !equalBytes(new Uint8Array(still.key_hash), input.keyHash)) return { ok: false, status: 401, error: "unauthorized" };
    if (envelope.length > this.limits.maxHeldBytes) return { ok: false, status: 413, error: "too_large" };
    const now = Date.now();
    this.dropExpired(now);
    this.makeRoom(envelope.length);
    const seq = this.nextSeq(now);
    this.sql.exec(
      "INSERT INTO held (seq, routine, key_tag, pid, received, size, env) VALUES (?, ?, ?, ?, ?, ?, ?)",
      seq,
      input.routineId,
      keyTag(input.keyHash),
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
   * Because they follow the clock, expiry finds old webhooks by sequence number, on the primary key.
   */
  private nextSeq(now: number): number {
    if (this.lastSeq === 0) {
      this.lastSeq = this.sql.exec<{ m: number | null }>("SELECT MAX(seq) AS m FROM held").one().m ?? 0;
    }
    this.lastSeq = Math.max(now * SEQ_PER_MS, this.lastSeq + 1);
    return this.lastSeq;
  }

  private loadTotals(): { count: number; bytes: number } {
    if (!this.totals) {
      const row = this.sql.exec<{ n: number; b: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM held").one();
      this.totals = { count: row.n, bytes: row.b };
    }
    return this.totals;
  }

  /**
   * Drops held payloads until one of `size` bytes fits under the account's caps, each time the oldest of the
   * routine holding the most (by count, or by bytes when bytes are the cap reached).
   */
  private makeRoom(size: number): void {
    const totals = this.loadTotals();
    for (;;) {
      const overCount = totals.count + 1 > this.limits.maxHeld;
      const overBytes = totals.bytes + size > this.limits.maxHeldBytes;
      if (totals.count === 0 || (!overCount && !overBytes)) return;
      const largest = this.sql
        .exec<{ routine: string }>(
          `SELECT routine FROM held GROUP BY routine ORDER BY ${overCount ? "COUNT(*)" : "SUM(size)"} DESC, MIN(seq) ASC LIMIT 1`,
        )
        .one().routine;
      const before = totals.count;
      this.dropWhere("seq = (SELECT MIN(seq) FROM held WHERE routine = ?)", "cap", largest);
      if (totals.count === before) return;
    }
  }

  private dropExpired(now: number): void {
    this.dropWhere("seq <= ?", "expired", (now - this.limits.holdMs) * SEQ_PER_MS);
  }

  /**
   * Deletes held payloads matching `where`, keeping the cached totals right. With a reason, the drops are
   * counted for each routine that still exists, to be reported to its computer once.
   */
  private dropWhere(where: string, reason: DropReason | null, ...bindings: unknown[]): number {
    const rows = this.sql.exec<{ routine: string; size: number }>(`DELETE FROM held WHERE ${where} RETURNING routine, size`, ...bindings).toArray();
    if (this.totals) {
      for (const row of rows) {
        this.totals.count -= 1;
        this.totals.bytes -= row.size;
      }
    }
    if (reason && rows.length > 0) {
      const counts = new Map<string, number>();
      for (const row of rows) counts.set(row.routine, (counts.get(row.routine) ?? 0) + 1);
      const now = Date.now();
      for (const [routine, count] of counts) {
        if (!this.routineRow(routine)) continue;
        this.sql.exec(
          `INSERT INTO drops (routine, count, reason, at) VALUES (?, ?, ?, ?)
           ON CONFLICT(routine) DO UPDATE SET count = count + excluded.count, reason = excluded.reason, at = excluded.at`,
          routine,
          count,
          reason,
          now,
        );
      }
    }
    return rows.length;
  }

  /** Drops on a computer's routines, for its hello. Only listing the routines clears them. */
  private dropsFor(device: string): DropReport[] {
    return this.sql
      .exec<{ routine: string; count: number; reason: string; at: number }>(
        "SELECT d.routine AS routine, d.count AS count, d.reason AS reason, d.at AS at FROM drops d JOIN routines r ON r.id = d.routine WHERE r.device = ?",
        device,
      )
      .toArray()
      .map((row) => ({ routine: row.routine, count: row.count, reason: row.reason as DropReason, at: row.at }));
  }

  // ---- expiry ----

  /** Sets the expiry alarm when none is pending. One alarm serves the whole account. */
  private async ensureAlarm(): Promise<void> {
    if (this.alarmAt === undefined) this.alarmAt = await this.ctx.storage.getAlarm();
    if (this.alarmAt !== null) return;
    const oldest = this.sql.exec<{ s: number | null }>("SELECT MIN(seq) AS s FROM held").one().s;
    if (oldest === null) return;
    const at = Math.max(Math.floor(oldest / SEQ_PER_MS) + this.limits.holdMs - this.limits.expiryGapMs, Date.now() + this.limits.expiryGapMs);
    await this.ctx.storage.setAlarm(at);
    this.alarmAt = at;
  }

  /**
   * Drops what would expire before the next run (at most one gap early, never late), then sets the next
   * alarm at least one gap away, so expiry costs at most one alarm write per gap for the whole account.
   */
  override async alarm(): Promise<void> {
    this.alarmAt = null;
    this.dropWhere("seq <= ?", "expired", (Date.now() + this.limits.expiryGapMs - this.limits.holdMs) * SEQ_PER_MS);
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
    const authExpires = Number(request.headers.get("x-clover-auth-expires"));
    if (!nonce || !Number.isSafeInteger(expires) || !Number.isSafeInteger(authExpires)) return new Response("bad ticket", { status: 400 });
    if (!this.deviceRow(device) || this.isRevoked(device)) return new Response("unknown device", { status: 403 });
    const now = Date.now();
    if (authExpires <= now) return new Response("token expired", { status: 401 });
    // A ticket opens one connection, ever: its nonce is kept until the ticket can no longer be presented.
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
    const state: SocketState = { device, sentUpTo: 0, connectedAt: now, lastSeen: now, authExpires };
    server.serializeAttachment(state);
    this.dropExpired(now);
    const pending = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM held h JOIN routines r ON r.id = h.routine WHERE r.device = ?", device)
      .one().n;
    const dropped = this.dropsFor(device);
    const hello: ServiceFrame = { t: "hello", v: 1, device, pending, ...(dropped.length > 0 ? { dropped } : {}) };
    server.send(JSON.stringify(hello));
    this.pump(server, state);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = ws.deserializeAttachment() as SocketState | null;
    if (!state) return this.closeSocket(ws, CLOSE_PROTOCOL, "no state");
    if (this.authExpired(ws, state)) return;
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
    const parsed = parseAcks(frame);
    if (!parsed) return this.closeSocket(ws, CLOSE_PROTOCOL, "bad frame");
    for (const [seq, pid] of parsed.refs) {
      if (parsed.kind === "ack") this.dropWhere("seq = ? AND pid = ?", null, seq, pid.buffer);
      else {
        // Only the routine's own computer may refuse its webhooks.
        this.dropWhere(
          "seq = ? AND pid = ? AND routine IN (SELECT id FROM routines WHERE device = ?)",
          parsed.unreadable ? "unreadable" : null,
          seq,
          pid.buffer,
          state.device,
        );
      }
    }
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

  /** Starts a computer's sockets over from the oldest webhook it holds (a routine it has just taken on). */
  private resendTo(device: string): void {
    for (const ws of this.openSockets(device)) {
      const state = ws.deserializeAttachment() as SocketState | null;
      if (!state) continue;
      state.sentUpTo = 0;
      ws.serializeAttachment(state);
      this.pump(ws, state);
    }
  }

  /**
   * A connection outlives nothing it was opened with: once the account token behind it has expired, the next
   * event on it closes it (no timer, so no cost), and the computer connects again with a fresh token, which
   * the account service will not issue to a revoked device.
   */
  private authExpired(ws: WebSocket, state: SocketState): boolean {
    if (typeof state.authExpires === "number" && state.authExpires > Date.now()) return false;
    this.closeSocket(ws, CLOSE_REAUTH, "reauth");
    return true;
  }

  private closeSocket(ws: WebSocket, code: number, reason: "replaced" | "revoked" | "stale" | "reauth" | string): void {
    try {
      if (reason === "replaced" || reason === "revoked" || reason === "stale" || reason === "reauth") {
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
    if (this.authExpired(ws, state)) return false;
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

function parseAcks(frame: unknown): { kind: "ack" | "nack"; unreadable: boolean; refs: [number, Bytes][] } | null {
  if (frame === null || typeof frame !== "object") return null;
  const { t, a, reason } = frame as { t?: unknown; a?: unknown; reason?: unknown };
  if ((t !== "ack" && t !== "nack") || !Array.isArray(a) || a.length > MAX_ACKS_PER_FRAME) return null;
  const refs: [number, Bytes][] = [];
  for (const ref of a) {
    if (!Array.isArray(ref) || ref.length !== 2) return null;
    const [seq, pid] = ref as [unknown, unknown];
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0 || typeof pid !== "string") return null;
    try {
      const bytes = fromB64u(pid);
      if (bytes.length !== 16) return null;
      refs.push([seq, bytes]);
    } catch {
      return null;
    }
  }
  return { kind: t, unreadable: t === "nack" && reason === "unreadable", refs };
}
