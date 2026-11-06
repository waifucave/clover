// The Cloudflare relay's Worker (PROTOCOL.md), run in the user's own Cloudflare account.
//
//   POST /v1/tickets                       a room ticket URL                         (Bearer: the relay key)
//   GET  /v1/rooms?ticket=…&room=…&peer=…  a peer's socket in a room                 (the ticket)
//   PUT  /v1/mail/<device>/<id>            keep a sealed piece of mail                (Bearer)
//   GET  /v1/mail/<device>?max=…           the device's mail, oldest first            (Bearer)
//   POST /v1/mail/<device>/ack             delete the pieces taken                    (Bearer)
//
// Nothing here logs a frame, a piece of mail, a key or a ticket.

import { errorResponse, intVar, json, readBodyCapped, readJsonObject, TooLarge } from "../../shared/http";
import { addressKey } from "../../shared/web";
import { hasKey, mintRoomTicket, roomTicketValid } from "./auth";
import type { Env } from "./env";
import { MAIL_LIMITS } from "./mailbox-do";

export { MailboxDO } from "./mailbox-do";
export { RoomDO } from "./room-do";

const ROOM_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PEER_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAIL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const rateLimited = () => errorResponse(429, "rate_limited", {}, { "retry-after": "60" });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname.split("/").slice(1);
      if (path[0] !== "v1") return errorResponse(404, "not_found");
      if (path[1] === "rooms" && path.length === 2) return await room(request, env, url);
      if (!(await env.API_RATE.limit({ key: addressKey(request) })).success) return rateLimited();
      if (!(await hasKey(request, env.RELAY_KEY))) return errorResponse(401, "unauthorized");
      if (request.method === "POST" && path[1] === "tickets" && path.length === 2) return await ticket(env);
      if (path[1] === "mail" && path[2] !== undefined && DEVICE_RE.test(path[2])) return await mail(request, env, url, path[2], path.slice(3));
      return errorResponse(404, "not_found");
    } catch (err) {
      console.error(`relay: unhandled ${err instanceof Error ? err.name : "error"}`);
      return errorResponse(500, "internal");
    }
  },
} satisfies ExportedHandler<Env>;

async function ticket(env: Env): Promise<Response> {
  const expiresAt = Date.now() + intVar(env.TICKET_HOURS, 24) * 3600_000;
  const ws = env.RELAY_ORIGIN.replace(/^http/, "ws");
  return json({ url: `${ws}/v1/rooms?ticket=${await mintRoomTicket(env.RELAY_KEY, expiresAt)}`, expiresAt });
}

async function room(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return errorResponse(426, "upgrade_required", {}, { upgrade: "websocket" });
  }
  if (!(await env.CONNECT_RATE.limit({ key: addressKey(request) })).success) return rateLimited();
  if (!(await roomTicketValid(env.RELAY_KEY, url.searchParams.get("ticket") ?? "", Date.now()))) return errorResponse(401, "unauthorized");
  const roomId = url.searchParams.get("room") ?? "";
  const peer = url.searchParams.get("peer") ?? "";
  if (!ROOM_RE.test(roomId) || !PEER_RE.test(peer)) return errorResponse(400, "bad_request");
  const headers = new Headers();
  for (const name of ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("x-relay-peer", peer);
  return env.ROOMS.getByName(roomId).fetch(new Request("https://relay.internal/room", { method: "GET", headers }));
}

async function mail(request: Request, env: Env, url: URL, device: string, rest: string[]): Promise<Response> {
  const box = env.MAIL.getByName(device);
  if (request.method === "PUT" && rest.length === 1 && MAIL_ID_RE.test(rest[0]!)) {
    const expiresAt = Number(request.headers.get("x-expires-at"));
    if (!Number.isSafeInteger(expiresAt)) return errorResponse(400, "bad_request");
    let sealed: Uint8Array;
    try {
      sealed = await readBodyCapped(request, MAIL_LIMITS.pieceBytes);
    } catch (err) {
      if (err instanceof TooLarge) return errorResponse(413, "too_large");
      throw err;
    }
    if (sealed.length === 0) return errorResponse(400, "bad_request");
    const result = await box.put(rest[0]!, sealed, expiresAt);
    return "error" in result ? errorResponse(result.status, result.error) : new Response(null, { status: result.status });
  }
  if (request.method === "GET" && rest.length === 0) {
    const raw = url.searchParams.get("max");
    const max = raw === null ? 16 : Number(raw);
    if (!Number.isSafeInteger(max) || max < 1 || max > MAIL_LIMITS.takeMax) return errorResponse(400, "bad_request");
    return json({ mail: await box.take(max) });
  }
  if (request.method === "POST" && rest.length === 1 && rest[0] === "ack") {
    const body = await readJsonObject(request, 64 * 1024);
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length > 256 || !ids.every((id) => typeof id === "string" && MAIL_ID_RE.test(id))) return errorResponse(400, "bad_request");
    await box.ack(ids as string[]);
    return new Response(null, { status: 204 });
  }
  return errorResponse(404, "not_found");
}
