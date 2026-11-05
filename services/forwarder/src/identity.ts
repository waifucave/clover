// Account object names, tags, owner hashes and connection tickets.
//
// An account's Durable Object is named by a stable id that no rotating key touches:
//   object = base64url( HMAC(ACCOUNT_ID_KEY, "account-id|" + account)[0..11] )
// ACCOUNT_ID_KEY never rotates. Leaking it lets someone tell which account a tag belongs to, if they already
// know the account id; it lets no one make a tag.
//
// A tag is the account's alias in webhook URLs, checked at the edge without a lookup, so a made-up tag never
// reaches (or creates) a Durable Object:
//   tag = base64url( version(1) || id(11) || mac6 ),  mac6 = HMAC(TAG_KEYS[version], "tag-mac|" || version || id)[0..6]
// TAG_KEYS holds numbered keys. New tags use the highest version; every listed version is accepted, so a key
// can be rotated (add the next version, let computers re-register their routines for new URLs, then remove
// the old one) or retired after a leak, without touching the accounts' objects.
//
// A ticket lets one connection open:
//   "<object>.<device>.<exp>.<authExp>.<nonce>.<mac>",  mac = HMAC(TICKET_SECRET, "ticket|" + the rest)
// The forwarder plugin never holds the account token (the core's keyed fetch adds it), so it trades it for a
// ticket over HTTP and opens the WebSocket with that. authExp is the token's own expiry: the connection lasts
// no longer than the token. The account's object keeps each used nonce until the ticket has expired, so a
// ticket opens one connection only, even after that connection closes.

import { b64u, concatBytes, equalBytes, fromB64u, hmacSha256, sha256, utf8 } from "../../shared/encoding";

export const TAG_RE = /^[A-Za-z0-9_-]{24}$/;
export const OBJECT_RE = /^[A-Za-z0-9_-]{15}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ID_BYTES = 11;
const MAC_BYTES = 6;

/** The tag keys by version, from TAG_KEYS: a JSON object {"1": "<base64url, 32+ bytes>", ...}. */
export interface TagKeys {
  current: number;
  byVersion: Map<number, string>;
}

const parsedTagKeys = new Map<string, TagKeys>();

export function tagKeysFrom(json: string): TagKeys {
  const cached = parsedTagKeys.get(json);
  if (cached) return cached;
  const raw = JSON.parse(json) as Record<string, unknown>;
  const byVersion = new Map<number, string>();
  for (const [version, key] of Object.entries(raw)) {
    const n = Number(version);
    if (!Number.isInteger(n) || n < 1 || n > 255 || typeof key !== "string" || key.length === 0) throw new Error("TAG_KEYS: bad entry");
    byVersion.set(n, key);
  }
  if (byVersion.size === 0) throw new Error("TAG_KEYS: no keys");
  const keys = { current: Math.max(...byVersion.keys()), byVersion };
  parsedTagKeys.set(json, keys);
  return keys;
}

async function accountId(idKey: string, account: string): Promise<Uint8Array> {
  return (await hmacSha256(idKey, utf8(`account-id|${account}`))).slice(0, ID_BYTES);
}

/** The name of the account's Durable Object. */
export async function accountObject(idKey: string, account: string): Promise<string> {
  return b64u(await accountId(idKey, account));
}

async function tagMac(key: string, version: number, id: Uint8Array): Promise<Uint8Array> {
  return (await hmacSha256(key, concatBytes(utf8("tag-mac|"), Uint8Array.of(version), id))).slice(0, MAC_BYTES);
}

/** The account's tag under the current tag key. */
export async function accountTag(keys: TagKeys, idKey: string, account: string): Promise<string> {
  const id = await accountId(idKey, account);
  return b64u(concatBytes(Uint8Array.of(keys.current), id, await tagMac(keys.byVersion.get(keys.current)!, keys.current, id)));
}

/** The object a tag names, when its MAC checks out under a listed version; otherwise null. */
export async function readTag(keys: TagKeys, tag: string): Promise<{ object: string; version: number } | null> {
  if (!TAG_RE.test(tag)) return null;
  let raw: Uint8Array;
  try {
    raw = fromB64u(tag);
  } catch {
    return null;
  }
  if (raw.length !== 1 + ID_BYTES + MAC_BYTES) return null;
  const version = raw[0]!;
  const key = keys.byVersion.get(version);
  if (!key) return null;
  const id = raw.subarray(1, 1 + ID_BYTES);
  if (!equalBytes(await tagMac(key, version, id), raw.subarray(1 + ID_BYTES))) return null;
  return { object: b64u(id), version };
}

/** What the Durable Object stores to know which account it belongs to. */
export async function ownerHash(account: string): Promise<string> {
  return b64u(await sha256(utf8(`owner|${account}`)));
}

export interface TicketClaims {
  object: string;
  device: string;
  expiresAt: number;
  /** When the account token the ticket was bought with expires (ms since the epoch). */
  authExpiresAt: number;
  nonce: string;
}

export async function mintTicket(
  secret: string,
  input: { object: string; device: string; now: number; ttlMs: number; authExpiresAt: number },
): Promise<{ ticket: string; claims: TicketClaims }> {
  const nonceBytes = new Uint8Array(12);
  crypto.getRandomValues(nonceBytes);
  const claims: TicketClaims = {
    object: input.object,
    device: input.device,
    expiresAt: Math.min(input.now + input.ttlMs, input.authExpiresAt),
    authExpiresAt: input.authExpiresAt,
    nonce: b64u(nonceBytes),
  };
  const body = `${claims.object}.${claims.device}.${claims.expiresAt}.${claims.authExpiresAt}.${claims.nonce}`;
  const mac = b64u(await hmacSha256(secret, utf8(`ticket|${body}`)));
  return { ticket: `${body}.${mac}`, claims };
}

export async function readTicket(secret: string, ticket: string, now: number): Promise<TicketClaims | null> {
  if (ticket.length > 512) return null;
  const parts = ticket.split(".");
  if (parts.length !== 6) return null;
  const [object, device, exp, authExp, nonce, mac] = parts as [string, string, string, string, string, string];
  if (!OBJECT_RE.test(object) || !DEVICE_RE.test(device) || !/^\d{1,16}$/.test(exp) || !/^\d{1,16}$/.test(authExp)) return null;
  if (!/^[A-Za-z0-9_-]{16}$/.test(nonce)) return null;
  let given: Uint8Array;
  try {
    given = fromB64u(mac);
  } catch {
    return null;
  }
  const expected = await hmacSha256(secret, utf8(`ticket|${object}.${device}.${exp}.${authExp}.${nonce}`));
  if (!equalBytes(given, expected)) return null;
  const expiresAt = Number(exp);
  if (expiresAt <= now) return null;
  return { object, device, expiresAt, authExpiresAt: Number(authExp), nonce };
}
