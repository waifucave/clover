// Account tags, owner hashes and connection tickets.
//
// A tag names an account's Durable Object and is the first segment of its webhook URLs:
//   tag = base64url( id12 || mac6 ),  id12 = HMAC(TAG_SECRET, "tag-id|" + account)[0..12],
//                                     mac6 = HMAC(TAG_SECRET, "tag-mac|" + id12)[0..6]
// It is stable for an account, does not reveal the account id, and the edge can check its MAC without a
// lookup, so a made-up tag never reaches (or creates) a Durable Object.
//
// A ticket lets one connection open: "<tag>.<device>.<exp>.<nonce>.<mac>", mac = HMAC(TICKET_SECRET, "ticket|" + the rest).
// The forwarder plugin never holds the account token (the core's keyed fetch adds it), so it trades it for a
// ticket over HTTP and opens the WebSocket with that.

import { b64u, concatBytes, equalBytes, fromB64u, hmacSha256, sha256, utf8 } from "../../shared/encoding";

export const TAG_RE = /^[A-Za-z0-9_-]{24}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function accountTag(secret: string, account: string): Promise<string> {
  const id = (await hmacSha256(secret, utf8(`tag-id|${account}`))).slice(0, 12);
  const mac = (await hmacSha256(secret, concatBytes(utf8("tag-mac|"), id))).slice(0, 6);
  return b64u(concatBytes(id, mac));
}

export async function isValidTag(secret: string, tag: string): Promise<boolean> {
  if (!TAG_RE.test(tag)) return false;
  let raw: Uint8Array;
  try {
    raw = fromB64u(tag);
  } catch {
    return false;
  }
  if (raw.length !== 18) return false;
  const mac = (await hmacSha256(secret, concatBytes(utf8("tag-mac|"), raw.subarray(0, 12)))).slice(0, 6);
  return equalBytes(mac, raw.subarray(12));
}

/** What the Durable Object stores to know which account it belongs to. */
export async function ownerHash(account: string): Promise<string> {
  return b64u(await sha256(utf8(`owner|${account}`)));
}

export interface TicketClaims {
  tag: string;
  device: string;
  expiresAt: number;
  nonce: string;
}

export async function mintTicket(
  secret: string,
  input: { tag: string; device: string; now: number; ttlMs: number },
): Promise<{ ticket: string; claims: TicketClaims }> {
  const nonceBytes = new Uint8Array(12);
  crypto.getRandomValues(nonceBytes);
  const claims: TicketClaims = { tag: input.tag, device: input.device, expiresAt: input.now + input.ttlMs, nonce: b64u(nonceBytes) };
  const body = `${claims.tag}.${claims.device}.${claims.expiresAt}.${claims.nonce}`;
  const mac = b64u(await hmacSha256(secret, utf8(`ticket|${body}`)));
  return { ticket: `${body}.${mac}`, claims };
}

export async function readTicket(secret: string, ticket: string, now: number): Promise<TicketClaims | null> {
  if (ticket.length > 512) return null;
  const parts = ticket.split(".");
  if (parts.length !== 5) return null;
  const [tag, device, exp, nonce, mac] = parts as [string, string, string, string, string];
  if (!TAG_RE.test(tag) || !DEVICE_RE.test(device) || !/^\d{1,16}$/.test(exp) || !/^[A-Za-z0-9_-]{16}$/.test(nonce)) return null;
  let given: Uint8Array;
  try {
    given = fromB64u(mac);
  } catch {
    return null;
  }
  const expected = await hmacSha256(secret, utf8(`ticket|${tag}.${device}.${exp}.${nonce}`));
  if (!equalBytes(given, expected)) return null;
  const expiresAt = Number(exp);
  if (expiresAt <= now) return null;
  return { tag, device, expiresAt, nonce };
}
