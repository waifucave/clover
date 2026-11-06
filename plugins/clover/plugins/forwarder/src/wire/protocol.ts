// The forwarder's wire protocol between a computer's forwarder plugin and hooks.waifucave.com.
// Shared by the plugin and the service (services/forwarder imports this file by relative path).
//
// HTTP, JSON, authenticated with the computer's waifucave account token (the core's keyed fetch adds it):
//
//   PUT    /v1/devices/self      { encKey, name? }            -> DeviceRegistered      this computer's forwarder key
//   GET    /v1/devices                                          -> { devices: DeviceInfo[] }
//   DELETE /v1/devices/:id                                      -> 204                   revoke a device (any id, for 24 h 10 min)
//   PUT    /v1/routines/:id      { keyHash, takeover?, allowGet? } -> RoutineRegistered (409 RoutineConflict)
//   DELETE /v1/routines/:id                                     -> 204                   (409 RoutineConflict: held elsewhere)
//   GET    /v1/routines                                         -> { routines: RoutineInfo[] }  clears the caller's drop reports
//   POST   /v1/tickets                                          -> Ticket                one connection, 60 s
//
// The connection: a WebSocket to Ticket.url (GET /v1/connect?ticket=...), used only for webhooks.
//
//   service -> computer   binary  [0x01][seq: u64][envelope]      a held webhook (envelope.ts)
//                         text    JSON ServiceFrame               hello (with the drops not yet listed), bye
//                         text    "pong"                          the Durable Object's free auto-response
//   computer -> service   text    "ping"                          keep-alive, answered without waking the object
//                         text    JSON ComputerFrame              ack / nack, at most 64 [seq, pid] pairs each
//
// An ack deletes the webhook whichever routine it is for (the computer that acks has run it); a nack deletes
// only webhooks of routines this computer holds. A connection lasts no longer than the account token it was
// opened with: past that, the next thing to arrive closes it with CLOSE_REAUTH, and the computer connects
// again with a fresh token.
//
// Webhooks themselves: POST, PUT, PATCH or DELETE (GET only for a routine registered with allowGet) to
//   https://hooks.waifucave.com/<tag>/<routine>   with the routine's key as "Authorization: Bearer <key>" or "?key=<key>".
// The tag is the account's alias in URLs; services/forwarder/src/identity.ts describes it.

import { concat, readU64, sha256, u64, utf8, type Bytes } from "./bytes";

export const PING = "ping";
export const PONG = "pong";

export const FRAME_WEBHOOK = 0x01;

/** Close codes the service uses. */
export const CLOSE_REPLACED = 4000; // the same computer connected again
export const CLOSE_UNAUTHORIZED = 4001;
export const CLOSE_REVOKED = 4003; // the computer was revoked: stop, don't reconnect
export const CLOSE_PROTOCOL = 4008;
export const CLOSE_STALE = 4009; // no keep-alive seen for too long
export const CLOSE_REAUTH = 4010; // the account token behind this connection expired: connect again with a fresh one

export const MAX_ACKS_PER_FRAME = 64;

export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A routine's key as senders present it: 16 to 512 URL-safe characters. Clover makes 32 random bytes, base64url. */
export const HOOK_KEY_RE = /^[A-Za-z0-9._~-]{16,512}$/;

/** The shortest key the plugin registers: 43 characters, the base64url of Clover's 32 random bytes. */
export const MIN_ROUTINE_KEY_LENGTH = 43;

/**
 * What the service keeps of a routine's key: SHA-256 of "clover hook key v1|" + key. The computer registers
 * this hash and the edge hashes the key a sender presents, so the key itself is never stored by waifucave.
 */
export async function hookKeyHash(key: string): Promise<Bytes> {
  return sha256(utf8(`clover hook key v1|${key}`));
}

export function encodeWebhookFrame(seq: number, envelope: Uint8Array): Bytes {
  return concat(Uint8Array.of(FRAME_WEBHOOK), u64(seq), envelope);
}

export function decodeWebhookFrame(frame: Uint8Array): { seq: number; envelope: Uint8Array } {
  if (frame.length < 10 || frame[0] !== FRAME_WEBHOOK) throw new TypeError("frame: not a webhook frame");
  return { seq: readU64(frame, 1), envelope: frame.subarray(9) };
}

/**
 * Why webhooks were dropped before a routine's computer took them: the account's cap (the routine holding the
 * most went first), the 7-day hold, a computer that could not open them (sealed before its key registered),
 * or a new key (they arrived under the routine's old key, which may have leaked).
 */
export type DropReason = "cap" | "expired" | "unreadable" | "rekeyed";

export interface DropCount {
  count: number;
  /** The latest drop's reason, and when it happened (ms since the epoch). */
  reason: DropReason;
  at: number;
}

export interface DropReport extends DropCount {
  routine: string;
}

export type ServiceFrame =
  /** `dropped`: drops on this computer's routines not yet listed; listing its routines (GET) clears them. */
  | { t: "hello"; v: 1; device: string; pending: number; dropped?: DropReport[] }
  | { t: "bye"; reason: "replaced" | "revoked" | "stale" | "reauth" };

/** An acknowledged webhook: its sequence number and its payload id (base64url), so an ack never matches another payload. */
export type AckRef = [seq: number, pid: string];

/** A nack with reason "unreadable" is counted as a drop for the routine; a plain nack is the computer's own refusal. */
export type ComputerFrame = { t: "ack"; a: AckRef[] } | { t: "nack"; a: AckRef[]; reason?: "unreadable" };

export interface DeviceRegistered {
  device: string;
  /** base64url of the 8-byte key id. */
  kid: string;
  /** This account's hook tag: the first segment of every webhook URL. */
  tag: string;
}

export interface DeviceInfo {
  id: string;
  name: string | null;
  kid: string;
  added: number;
}

export interface RoutineRegistered {
  routine: string;
  device: string;
  url: string;
}

export interface RoutineConflict {
  error: "held_elsewhere";
  device: string;
}

export interface RoutineInfo {
  id: string;
  device: string;
  held: number;
  /** Whether a GET to its URL counts as a webhook (off unless asked for: link previewers fetch pasted URLs). */
  allowGet: boolean;
  /** Drops not yet listed by the routine's computer; that computer's list clears them. */
  dropped?: DropCount;
}

export interface Ticket {
  ticket: string;
  url: string;
  expiresAt: number;
}

export interface ErrorBody {
  error: string;
}
