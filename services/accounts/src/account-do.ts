// One account's devices (PROTOCOL.md): each device's link key, box key, name and kind, when it was added and revoked,
// and the last `t` it signed with, per statement, so a captured request can't be replayed. The Worker has checked
// the sign-in, the shapes and a registration's signature; a mint's signature is checked here, against the key this
// object holds. Revoked devices stay listed, so every other device learns of the revoke.

import { DurableObject } from "cloudflare:workers";

import { fromB64, fromB64u } from "../../shared/encoding";
import type { Env } from "./env";
import { verifyEd25519 } from "./verify";
import { type AccountDevice, type DeviceKind, LIMITS, mintStatement, type Os } from "./wire";

export type Reply<T = undefined> = { status: number; error?: string; body?: T };

interface DeviceRow extends Record<string, SqlStorageValue> {
  id: string;
  public_key: string;
  box_key: string;
  name: string;
  kind: string;
  os: string | null;
  added_at: number;
  revoked_at: number | null;
  last_t: number;
}

export interface DeviceInput {
  id: string;
  publicKey: string;
  boxKey: string;
  name: string;
  kind: DeviceKind;
  os?: Os;
}

function view(row: DeviceRow): AccountDevice {
  return {
    id: row.id,
    publicKey: row.public_key,
    boxKey: row.box_key,
    name: row.name,
    kind: row.kind as DeviceKind,
    ...(row.os !== null ? { os: row.os as Os } : {}),
    addedAt: row.added_at,
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
  };
}

export class AccountDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, public_key TEXT NOT NULL, box_key TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
      os TEXT, added_at INTEGER NOT NULL, revoked_at INTEGER, last_t INTEGER NOT NULL
    ) WITHOUT ROWID`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mints (
      device TEXT NOT NULL, aud TEXT NOT NULL, last_t INTEGER NOT NULL, PRIMARY KEY (device, aud)
    ) WITHOUT ROWID`);
  }

  private row(id: string): DeviceRow | undefined {
    return this.sql.exec<DeviceRow>("SELECT * FROM devices WHERE id = ?", id).toArray()[0];
  }

  /** Adds the device, or updates its name, kind, system and box key (a signed statement newer than its last). */
  async register(device: DeviceInput, t: number, now: number): Promise<Reply<{ device: AccountDevice }>> {
    const existing = this.row(device.id);
    if (existing) {
      if (existing.revoked_at !== null) return { status: 403, error: "revoked" };
      if (existing.public_key !== device.publicKey) return { status: 409, error: "conflict" };
      if (t <= existing.last_t) return { status: 409, error: "replay" };
      this.sql.exec(
        "UPDATE devices SET box_key = ?, name = ?, kind = ?, os = ?, last_t = ? WHERE id = ?",
        device.boxKey, device.name, device.kind, device.os ?? null, t, device.id,
      );
      return { status: 200, body: { device: view(this.row(device.id)!) } };
    }
    const active = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL").one().n;
    if (active >= LIMITS.maxDevices) return { status: 409, error: "full" };
    const rows = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM devices").one().n;
    if (rows >= LIMITS.maxRows) {
      // Makes room by forgetting the longest-revoked device; there is always one, since the active ones are fewer.
      this.sql.exec("DELETE FROM devices WHERE id = (SELECT id FROM devices WHERE revoked_at IS NOT NULL ORDER BY revoked_at LIMIT 1)");
    }
    this.sql.exec(
      "INSERT INTO devices (id, public_key, box_key, name, kind, os, added_at, revoked_at, last_t) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
      device.id, device.publicKey, device.boxKey, device.name, device.kind, device.os ?? null, now, t,
    );
    return { status: 201, body: { device: view(this.row(device.id)!) } };
  }

  async list(): Promise<AccountDevice[]> {
    return this.sql.exec<DeviceRow>("SELECT * FROM devices ORDER BY added_at, id").toArray().map(view);
  }

  /** Revokes a device of the account; revoking again changes nothing. */
  async revoke(id: string, now: number): Promise<Reply> {
    const existing = this.row(id);
    if (!existing) return { status: 404, error: "not_found" };
    if (existing.revoked_at === null) this.sql.exec("UPDATE devices SET revoked_at = ? WHERE id = ?", now, id);
    this.sql.exec("DELETE FROM mints WHERE device = ?", id);
    return { status: 204 };
  }

  /** Whether `device` may have a token for `aud` now: listed, not revoked, its signature good and its `t` new. */
  async allowMint(account: string, device: string, aud: string, t: number, sig: string): Promise<Reply> {
    const existing = this.row(device);
    if (!existing || existing.revoked_at !== null) return { status: 403, error: "not_member" };
    const key = fromB64(existing.public_key);
    if (!(await verifyEd25519(key, fromB64u(sig), mintStatement(account, aud, device, t)))) return { status: 403, error: "bad_signature" };
    // Everything from here runs without a pause, so a revoke or another mint can't slip in between the check and the
    // write; the revoke is looked at again, since it may have come during the signature check.
    if (this.row(device)?.revoked_at !== null) return { status: 403, error: "not_member" };
    const last = this.sql.exec<{ last_t: number }>("SELECT last_t FROM mints WHERE device = ? AND aud = ?", device, aud).toArray()[0];
    if (last && t <= last.last_t) return { status: 409, error: "replay" };
    this.sql.exec("INSERT INTO mints (device, aud, last_t) VALUES (?, ?, ?) ON CONFLICT (device, aud) DO UPDATE SET last_t = excluded.last_t", device, aud, t);
    return { status: 200 };
  }
}
