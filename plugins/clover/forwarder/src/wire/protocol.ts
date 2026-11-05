// The forwarder's wire protocol between a computer's forwarder plugin and hooks.waifucave.com.
// Shared by the plugin and the service (services/forwarder imports this file by relative path).
//
// HTTP, JSON, authenticated with the computer's waifucave account token (the core's keyed fetch adds it):
//
//   PUT    /v1/devices/self      { encKey, name? }            -> DeviceRegistered      this computer's forwarder key
//   GET    /v1/devices                                          -> { devices: DeviceInfo[] }
//   DELETE /v1/devices/:id                                      -> 204                   revoke a computer
//   PUT    /v1/routines/:id      { keyHash, takeover? }       -> RoutineRegistered     (409 RoutineConflict)
//   DELETE /v1/routines/:id                                     -> 204
//   GET    /v1/routines                                         -> { routines: RoutineInfo[] }
//   POST   /v1/tickets                                          -> Ticket                one connection, 60 s
//
// The connection: a WebSocket to Ticket.url (GET /v1/connect?ticket=...), used only for webhooks.
//
//   service -> computer   binary  [0x01][seq: u64][envelope]      a held webhook (envelope.ts)
//                         text    JSON ServiceFrame               hello, bye
//                         text    "pong"                          the Durable Object's free auto-response
//   computer -> service   text    "ping"                          keep-alive, answered without waking the object
//                         text    JSON ComputerFrame              ack / nack, at most 64 [seq, pid] pairs each
//
// Webhooks themselves: any method but HEAD, OPTIONS, CONNECT and TRACE to
//   https://hooks.waifucave.com/<tag>/<routine>   with the routine's key as "Authorization: Bearer <key>" or "?key=<key>".

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

export const MAX_ACKS_PER_FRAME = 64;

export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A routine's key as senders present it: 16 to 512 URL-safe characters. Clover makes 32 random bytes, base64url. */
export const HOOK_KEY_RE = /^[A-Za-z0-9._~-]{16,512}$/;

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

export type ServiceFrame =
  | { t: "hello"; v: 1; device: string; pending: number }
  | { t: "bye"; reason: "replaced" | "revoked" | "stale" };

/** An acknowledged webhook: its sequence number and its payload id (base64url), so an ack never matches another payload. */
export type AckRef = [seq: number, pid: string];

export type ComputerFrame = { t: "ack"; a: AckRef[] } | { t: "nack"; a: AckRef[]; reason?: string };

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
}

export interface Ticket {
  ticket: string;
  url: string;
  expiresAt: number;
}

export interface ErrorBody {
  error: string;
}
