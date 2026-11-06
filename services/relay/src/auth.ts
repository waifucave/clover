// The relay's access check: the user's key as a bearer token, and room tickets MAC'd with a key derived from it.

import { b64u, equalBytes, fromB64u, sha256, utf8 } from "../../shared/encoding";

/** Whether the request carries the relay's key. Compared as hashes, so the comparison's time says nothing. */
export async function hasKey(request: Request, relayKey: string): Promise<boolean> {
  if (relayKey.length < 43) return false;
  const match = /^Bearer ([A-Za-z0-9_-]{43,256})$/.exec(request.headers.get("authorization") ?? "");
  if (!match) return false;
  return equalBytes(await sha256(utf8(match[1]!)), await sha256(utf8(relayKey)));
}

let derived: { relayKey: string; key: Promise<CryptoKey> } | null = null;

function ticketKey(relayKey: string): Promise<CryptoKey> {
  if (derived?.relayKey !== relayKey) {
    derived = {
      relayKey,
      key: crypto.subtle.importKey("raw", utf8(`clover-relay-v1 ticket|${relayKey}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    };
  }
  return derived.key;
}

async function mac(relayKey: string, body: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await ticketKey(relayKey), utf8(body))).subarray(0, 16);
}

/** A room ticket: `v1.<expires ms>.<mac>`. */
export async function mintRoomTicket(relayKey: string, expiresAt: number): Promise<string> {
  const body = `v1.${expiresAt}`;
  return `${body}.${b64u(await mac(relayKey, body))}`;
}

export async function roomTicketValid(relayKey: string, ticket: string, now: number): Promise<boolean> {
  const match = /^v1\.(\d{1,16})\.([A-Za-z0-9_-]{22})$/.exec(ticket);
  if (!match || relayKey.length < 43) return false;
  if (Number(match[1]) <= now) return false;
  try {
    return equalBytes(fromB64u(match[2]!), await mac(relayKey, `v1.${match[1]}`));
  } catch {
    return false;
  }
}
