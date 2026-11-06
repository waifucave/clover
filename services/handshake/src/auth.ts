// What the Worker checks before any Durable Object is called: Ed25519 signatures over statements and requests, and
// socket tickets.

import { b64u, equalBytes, fromB64u, utf8 } from "../../shared/encoding";
import type { ScopeKind } from "../client/wire";

const keyCache = new Map<string, Promise<CryptoKey>>();
const KEY_CACHE_MAX = 2000;

function importKey(key: string): Promise<CryptoKey> {
  let cached = keyCache.get(key);
  if (!cached) {
    cached = crypto.subtle.importKey("raw", fromB64u(key), { name: "Ed25519" }, false, ["verify"]);
    keyCache.set(key, cached);
    while (keyCache.size > KEY_CACHE_MAX) keyCache.delete(keyCache.keys().next().value!);
  }
  return cached;
}

/** Whether `sig` (base64url) is `key`'s Ed25519 signature over the UTF-8 text. Never throws. */
export async function verifySignature(key: string, sig: string, text: string): Promise<boolean> {
  try {
    const signature = fromB64u(sig);
    if (signature.length !== 64) return false;
    return await crypto.subtle.verify({ name: "Ed25519" }, await importKey(key), signature, utf8(text));
  } catch {
    keyCache.delete(key);
    return false;
  }
}

// ---- tickets ----

export interface TicketClaims {
  scope: ScopeKind;
  id: string;
  member: string;
  expiresAt: number;
  nonce: string;
  /** Account sockets: the account token's end (ms); the socket closes at its next event after it. */
  until?: number;
}

let macKey: { secret: string; key: Promise<CryptoKey> } | null = null;

function ticketKey(secret: string): Promise<CryptoKey> {
  if (macKey?.secret !== secret) {
    macKey = {
      secret,
      key: crypto.subtle.importKey("raw", utf8(`clover-handshake-v1 ticket|${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    };
  }
  return macKey.key;
}

async function mac(secret: string, body: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await ticketKey(secret), utf8(body))).subarray(0, 16);
}

/** A single-use socket ticket for a member of a scope (PROTOCOL.md, "The socket"). */
export async function mintTicket(secret: string, claims: Omit<TicketClaims, "nonce">): Promise<{ ticket: string; claims: TicketClaims }> {
  const full: TicketClaims = { ...claims, nonce: b64u(crypto.getRandomValues(new Uint8Array(16))) };
  const body = b64u(utf8(JSON.stringify({ s: full.scope, i: full.id, m: full.member, e: full.expiresAt, n: full.nonce, ...(full.until !== undefined ? { u: full.until } : {}) })));
  return { ticket: `${body}.${b64u(await mac(secret, body))}`, claims: full };
}

export async function readTicket(secret: string, ticket: string, now: number): Promise<TicketClaims | null> {
  if (ticket.length > 1024) return null;
  const [body, tag, extra] = ticket.split(".");
  if (!body || !tag || extra !== undefined) return null;
  try {
    if (!equalBytes(fromB64u(tag), await mac(secret, body))) return null;
    const raw = JSON.parse(new TextDecoder().decode(fromB64u(body))) as Record<string, unknown>;
    const scope = raw.s;
    if (scope !== "pair" && scope !== "group" && scope !== "account") return null;
    if (typeof raw.i !== "string" || typeof raw.m !== "string" || typeof raw.n !== "string") return null;
    if (typeof raw.e !== "number" || raw.e <= now) return null;
    if (raw.u !== undefined && typeof raw.u !== "number") return null;
    return { scope, id: raw.i, member: raw.m, expiresAt: raw.e, nonce: raw.n, ...(typeof raw.u === "number" ? { until: raw.u } : {}) };
  } catch {
    return null;
  }
}
