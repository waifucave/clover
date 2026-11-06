// One device's mailbox: sealed sync mail kept until the device acknowledges it or it expires (PROTOCOL.md, "Mail").
// The relay never opens a piece; it was sealed for its device before it reached the relay plugin.

import { DurableObject } from "cloudflare:workers";

import { b64u } from "../../shared/encoding";
import type { Env } from "./env";

export const MAIL_LIMITS = {
  pieceBytes: 1024 * 1024,
  pieces: 256,
  totalBytes: 64 * 1024 * 1024,
  maxAheadMs: 30 * 24 * 3600_000,
  takeBytes: 8 * 1024 * 1024,
  takeMax: 64,
} as const;

export type PutResult = { status: 200 | 201 } | { status: 400 | 409; error: string };

export class MailboxDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID");
    if (this.sql.exec("SELECT v FROM meta WHERE k = 'schema'").toArray().length === 0) {
      // Frozen at the first deploy: a later change needs a new schema version and a step that migrates to it.
      this.sql.exec(`
        CREATE TABLE mail (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL, size INTEGER NOT NULL, sealed BLOB NOT NULL);
        INSERT INTO meta (k, v) VALUES ('schema', '1');
      `);
    }
  }

  async put(id: string, sealed: Uint8Array, expiresAt: number): Promise<PutResult> {
    const now = Date.now();
    if (!(expiresAt > now && expiresAt <= now + MAIL_LIMITS.maxAheadMs)) return { status: 400, error: "bad_request" };
    this.sql.exec("DELETE FROM mail WHERE expires <= ?", now);
    if (this.sql.exec("SELECT 1 AS x FROM mail WHERE id = ?", id).toArray().length > 0) return { status: 200 };
    const totals = this.sql.exec<{ n: number; bytes: number | null }>("SELECT COUNT(*) AS n, SUM(size) AS bytes FROM mail").one();
    if (totals.n >= MAIL_LIMITS.pieces || (totals.bytes ?? 0) + sealed.length > MAIL_LIMITS.totalBytes) return { status: 409, error: "full" };
    this.sql.exec("INSERT INTO mail (id, expires, size, sealed) VALUES (?, ?, ?, ?)", id, expiresAt, sealed.length, sealed);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > expiresAt) await this.ctx.storage.setAlarm(expiresAt);
    return { status: 201 };
  }

  /** The oldest mail first, up to `max` pieces and the take's byte limit (at least one piece). It stays until acked. */
  async take(max: number): Promise<{ id: string; expiresAt: number; sealed: string }[]> {
    const now = Date.now();
    const out: { id: string; expiresAt: number; sealed: string }[] = [];
    let bytes = 0;
    for (const row of this.sql.exec<{ id: string; expires: number; size: number; sealed: ArrayBuffer }>(
      "SELECT id, expires, size, sealed FROM mail WHERE expires > ? ORDER BY seq LIMIT ?",
      now,
      max,
    )) {
      if (out.length > 0 && bytes + row.size > MAIL_LIMITS.takeBytes) break;
      bytes += row.size;
      out.push({ id: row.id, expiresAt: row.expires, sealed: b64u(new Uint8Array(row.sealed)) });
    }
    return out;
  }

  async ack(ids: string[]): Promise<void> {
    for (const id of ids) this.sql.exec("DELETE FROM mail WHERE id = ?", id);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    this.sql.exec("DELETE FROM mail WHERE expires <= ?", now);
    const next = this.sql.exec<{ at: number | null }>("SELECT MIN(expires) AS at FROM mail").one().at;
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}
