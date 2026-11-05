// An account's push targets: its phones' APNs device tokens and its browsers' Web Push subscriptions. A notify
// fans a count out to each; a target the push service reports gone is removed, and one APNs calls a bad token
// is removed only after several such answers in a row (a wrong topic at our end would answer the same).
// Revoking a device (DELETE /v1/devices/:id, what the account service's revocation calls) keeps it from
// registering or notifying with a token it already holds, for 24 hours and 10 minutes: past that, every
// token issued before the revocation has expired. Removing a target only stops pushes to it.

import { DurableObject } from "cloudflare:workers";

import { utf8 } from "../../shared/encoding";
import { sendApns, type SendOutcome } from "./apns";
import { apnsConfig, maxTargets, pushTimeoutMs, vapidConfig, type Env } from "./env";
import { sendWebPush } from "./webpush";

export interface Caller {
  owner: string;
  device: string;
}

export type Target =
  | { kind: "apns"; token: string; env: "production" | "sandbox" }
  | { kind: "webpush"; endpoint: string; p256dh: string; auth: string };

export interface TargetInfo {
  id: string;
  kind: Target["kind"];
  env?: string;
  /** For a browser, only its push service's host: the endpoint itself is a bearer capability. */
  host?: string;
  added: number;
}

export interface NotifyResult {
  sent: number;
  removed: number;
  failed: number;
}

export type Refusal = { ok: false; status: 403 | 409; error: string };

const TTL_SECONDS = 24 * 3600;
/** Bad-token answers in a row before a phone's target is forgotten. */
const SUSPECT_LIMIT = 3;
/** How long a revocation is kept: the longest account-token lifetime (24 h), plus clock skew and margin. */
export const REVOCATION_KEEP_MS = 24 * 3600 * 1000 + 10 * 60 * 1000;

export class PushDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private owner: string | null | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    if (!this.sql.exec("SELECT 1 AS x FROM meta WHERE k = 'schema'").toArray().length) {
      // Frozen at the first deploy: any later change needs a new schema version and a step that migrates to it.
      this.sql.exec(`
        CREATE TABLE targets (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, added INTEGER NOT NULL,
                              failures INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
        CREATE TABLE revoked (id TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;
        INSERT INTO meta (k, v) VALUES ('schema', '1');
      `);
    }
  }

  private ownerMatches(owner: string): boolean {
    if (this.owner === undefined) {
      this.owner = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'owner'").toArray()[0]?.v ?? null;
    }
    if (this.owner === null) {
      this.sql.exec("INSERT INTO meta (k, v) VALUES ('owner', ?)", owner);
      this.owner = owner;
    }
    return this.owner === owner;
  }

  private refuse(caller: Caller): Refusal | null {
    if (!this.ownerMatches(caller.owner)) return { ok: false, status: 403, error: "wrong_account" };
    if (this.sql.exec("SELECT 1 AS x FROM revoked WHERE id = ? AND at > ?", caller.device, Date.now() - REVOCATION_KEEP_MS).toArray().length > 0) {
      return { ok: false, status: 403, error: "revoked" };
    }
    return null;
  }

  async putTarget(caller: Caller, id: string, target: Target): Promise<{ ok: true } | Refusal> {
    const refused = this.refuse(caller);
    if (refused) return refused;
    const data = JSON.stringify(target);
    const existing = this.sql.exec<{ data: string }>("SELECT data FROM targets WHERE id = ?", id).toArray()[0];
    if (existing?.data === data) return { ok: true };
    if (!existing) {
      const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM targets").one().n;
      if (count >= maxTargets(this.env)) return { ok: false, status: 409, error: "too_many_targets" };
    }
    this.sql.exec(
      `INSERT INTO targets (id, kind, data, added) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, data = excluded.data, failures = 0`,
      id,
      target.kind,
      data,
      Date.now(),
    );
    return { ok: true };
  }

  /** Removes a target: its device stops receiving pushes, and may register again. */
  async deleteTarget(caller: Caller, id: string): Promise<{ ok: true } | Refusal> {
    const refused = this.refuse(caller);
    if (refused) return refused;
    this.sql.exec("DELETE FROM targets WHERE id = ?", id);
    return { ok: true };
  }

  /**
   * Revokes a device (spec §8.1), whether or not it has a target: it loses its target and cannot register or
   * notify again with a token it holds. Revocations older than every token they guard against are pruned
   * here, so the list stays bounded by age.
   */
  async revokeDevice(caller: Caller, id: string): Promise<{ ok: true } | Refusal> {
    const refused = this.refuse(caller);
    if (refused) return refused;
    const now = Date.now();
    this.sql.exec("DELETE FROM revoked WHERE at <= ?", now - REVOCATION_KEEP_MS);
    this.sql.exec("INSERT INTO revoked (id, at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at", id, now);
    this.sql.exec("DELETE FROM targets WHERE id = ?", id);
    return { ok: true };
  }

  async listTargets(caller: Caller): Promise<{ ok: true; targets: TargetInfo[] } | Refusal> {
    const refused = this.refuse(caller);
    if (refused) return refused;
    const targets = this.rows().map(({ id, target, added }) => {
      const info: TargetInfo = { id, kind: target.kind, added };
      if (target.kind === "apns") info.env = target.env;
      else info.host = new URL(target.endpoint).host;
      return info;
    });
    return { ok: true, targets };
  }

  /** Sends the count to every target, content-free, and forgets the ones their push service says are gone. */
  async notify(caller: Caller, input: { badge: number; urgent: boolean }): Promise<({ ok: true } & NotifyResult) | Refusal> {
    const refused = this.refuse(caller);
    if (refused) return refused;
    const now = Date.now();
    const payload = utf8(JSON.stringify({ n: input.badge }));
    const rows = this.rows();
    const outcomes = await Promise.all(
      rows.map(async ({ target }): Promise<SendOutcome> => {
        try {
          return target.kind === "apns"
            ? await sendApns(apnsConfig(this.env), target, input.badge, now)
            : await sendWebPush(vapidConfig(this.env), target, payload, {
                urgent: input.urgent,
                now,
                ttlSeconds: TTL_SECONDS,
                timeoutMs: pushTimeoutMs(this.env),
              });
        } catch {
          return { ok: false, gone: false, status: 0, reason: "network" };
        }
      }),
    );
    const result: NotifyResult = { sent: 0, removed: 0, failed: 0 };
    outcomes.forEach((outcome, i) => {
      const row = rows[i]!;
      // Written only when something changes: a success after failures, a failure, a removal.
      if (outcome.ok) {
        result.sent += 1;
        if (row.failures > 0) this.sql.exec("UPDATE targets SET failures = 0 WHERE id = ?", row.id);
      } else if (outcome.gone || (outcome.suspect && row.failures + 1 >= SUSPECT_LIMIT)) {
        this.sql.exec("DELETE FROM targets WHERE id = ?", row.id);
        result.removed += 1;
      } else {
        if (outcome.suspect) this.sql.exec("UPDATE targets SET failures = failures + 1 WHERE id = ?", row.id);
        result.failed += 1;
      }
    });
    return { ok: true, ...result };
  }

  private rows(): { id: string; target: Target; added: number; failures: number }[] {
    return this.sql
      .exec<{ id: string; data: string; added: number; failures: number }>("SELECT id, data, added, failures FROM targets ORDER BY added")
      .toArray()
      .map((row) => ({ id: row.id, target: JSON.parse(row.data) as Target, added: row.added, failures: row.failures }));
  }
}
