// hooks.waifucave.com: the waifucave forwarder's Worker (spec §7).
//
//   /<tag>/<routine>   a webhook from a service (GitHub, Sentry, ...), with the routine's key
//   /v1/...            the forwarder plugin's API, with the computer's account token (see wire/protocol.ts)
//
// The Worker checks what it can without state (the path, the tag's MAC, the rate, the size), hashes the
// presented key, and hands the request to the account's Durable Object, which seals and holds it. Nothing
// here logs a payload, a key or a token.

import { bearerToken, verifyAccountToken } from "../../shared/account-token";
import { fromB64u } from "../../shared/encoding";
import { errorResponse, json, readBodyCapped, readJsonObject, TooLarge } from "../../shared/http";
import { encodeRequestRecord, ROUTINE_ID_RE } from "../../../plugins/clover/forwarder/src/wire/envelope";
import {
  DEVICE_ID_RE,
  hookKeyHash,
  type DeviceRegistered,
  type RoutineConflict,
  type RoutineRegistered,
  type Ticket,
} from "../../../plugins/clover/forwarder/src/wire/protocol";
import type { Caller, ForwarderDO, Refusal } from "./forwarder-do";
import { limitsFrom, type Env } from "./env";
import { accountTag, isValidTag, mintTicket, ownerHash, readTicket, TAG_RE } from "./identity";
import { forwardedHeaders, forwardedQuery, presentedKey, REFUSED_METHODS } from "./ingress";

export { ForwarderDO } from "./forwarder-do";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const segments = url.pathname.split("/").slice(1);
      if (segments[0] === "v1") return await api(request, env, url, segments.slice(1));
      if (segments.length === 2 && TAG_RE.test(segments[0]!) && ROUTINE_ID_RE.test(segments[1]!)) {
        return await webhook(request, env, url, segments[0]!, segments[1]!);
      }
      return errorResponse(404, "not_found");
    } catch (err) {
      console.error(`forwarder: unhandled ${err instanceof Error ? err.name : "error"}`);
      return errorResponse(500, "internal");
    }
  },
} satisfies ExportedHandler<Env>;

function refusal(result: Refusal): Response {
  if (result.error === "held_elsewhere") {
    const body: RoutineConflict = { error: "held_elsewhere", device: result.device ?? "" };
    return json(body, 409);
  }
  return errorResponse(result.status, result.error);
}

// ---- webhooks ----

async function webhook(request: Request, env: Env, url: URL, tag: string, routineId: string): Promise<Response> {
  if (REFUSED_METHODS.has(request.method)) return errorResponse(405, "method_not_allowed", {}, { allow: "GET, POST, PUT, PATCH, DELETE" });
  if (!(await isValidTag(env.TAG_SECRET, tag))) return errorResponse(404, "not_found");
  const { success } = await env.HOOK_RATE.limit({ key: tag });
  if (!success) return errorResponse(429, "rate_limited", {}, { "retry-after": "60" });

  const key = presentedKey(request, url);
  if (key === null) return errorResponse(401, "unauthorized");
  const limits = limitsFrom(env);
  let body: Uint8Array;
  try {
    body = await readBodyCapped(request, limits.maxBodyBytes);
  } catch (err) {
    if (err instanceof TooLarge) return errorResponse(413, "too_large");
    throw err;
  }
  const headers = forwardedHeaders(request, limits.maxHeaderBytes);
  if (headers === null) return errorResponse(431, "headers_too_large");
  const ip = request.headers.get("cf-connecting-ip") ?? undefined;
  const record = encodeRequestRecord({ method: request.method, query: forwardedQuery(url), headers, body, ...(ip ? { ip } : {}) });

  const stub = env.FORWARDER.getByName(tag);
  const result = await stub.receive({ routineId, keyHash: await hookKeyHash(key), record, receivedAt: Date.now() });
  if (!result.ok) return errorResponse(result.status, result.error);
  return json({ id: result.id }, 202);
}

// ---- the plugin's API ----

async function api(request: Request, env: Env, url: URL, path: string[]): Promise<Response> {
  if (path.length === 1 && path[0] === "connect") return connect(request, env, url);

  const token = bearerToken(request);
  const identity = token
    ? await verifyAccountToken(token, { jwks: env.ACCOUNT_JWKS, issuer: env.ACCOUNT_ISSUER, audience: env.HOOKS_AUDIENCE })
    : null;
  if (!identity) return errorResponse(401, "unauthorized");
  const { success } = await env.API_RATE.limit({ key: identity.account });
  if (!success) return errorResponse(429, "rate_limited", {}, { "retry-after": "60" });

  const tag = await accountTag(env.TAG_SECRET, identity.account);
  const caller: Caller = { owner: await ownerHash(identity.account), device: identity.device };
  const stub: DurableObjectStub<ForwarderDO> = env.FORWARDER.getByName(tag);
  const route = `${request.method} ${path[0] ?? ""}${path.length > 1 ? "/:id" : ""}`;
  const id = path[1] ?? "";
  if (path.length > 2) return errorResponse(404, "not_found");

  switch (route) {
    case "PUT devices/:id": {
      if (id !== "self") return errorResponse(404, "not_found");
      const body = await readJsonObject(request);
      if (!body || typeof body.encKey !== "string") return errorResponse(400, "bad_request");
      let encKey: Uint8Array;
      try {
        encKey = fromB64u(body.encKey);
      } catch {
        return errorResponse(400, "bad_request");
      }
      const name = typeof body.name === "string" ? body.name.slice(0, 64) : null;
      const result = await stub.putDevice(caller, { encKey, name });
      if (!result.ok) return refusal(result);
      const out: DeviceRegistered = { device: identity.device, kid: result.kid, tag };
      return json(out);
    }
    case "GET devices": {
      const result = await stub.listDevices(caller);
      return result.ok ? json({ devices: result.devices }) : refusal(result);
    }
    case "DELETE devices/:id": {
      if (!DEVICE_ID_RE.test(id)) return errorResponse(404, "not_found");
      const result = await stub.revokeDevice(caller, id);
      return result.ok ? new Response(null, { status: 204 }) : refusal(result);
    }
    case "PUT routines/:id": {
      if (!ROUTINE_ID_RE.test(id)) return errorResponse(404, "not_found");
      const body = await readJsonObject(request);
      if (!body || typeof body.keyHash !== "string") return errorResponse(400, "bad_request");
      let keyHash: Uint8Array;
      try {
        keyHash = fromB64u(body.keyHash);
      } catch {
        return errorResponse(400, "bad_request");
      }
      if (keyHash.length !== 32) return errorResponse(400, "bad_request");
      const result = await stub.putRoutine(caller, id, { keyHash, takeover: body.takeover === true });
      if (!result.ok) return refusal(result);
      const out: RoutineRegistered = { routine: id, device: result.device, url: `${env.HOOKS_ORIGIN}/${tag}/${id}` };
      return json(out);
    }
    case "DELETE routines/:id": {
      if (!ROUTINE_ID_RE.test(id)) return errorResponse(404, "not_found");
      const result = await stub.deleteRoutine(caller, id);
      return result.ok ? new Response(null, { status: 204 }) : refusal(result);
    }
    case "GET routines": {
      const result = await stub.listRoutines(caller);
      return result.ok ? json({ routines: result.routines }) : refusal(result);
    }
    case "POST tickets": {
      const limits = limitsFrom(env);
      const { ticket, claims } = await mintTicket(env.TICKET_SECRET, { tag, device: identity.device, now: Date.now(), ttlMs: limits.ticketTtlMs });
      const ws = env.HOOKS_ORIGIN.replace(/^http/, "ws");
      const out: Ticket = { ticket, url: `${ws}/v1/connect?ticket=${ticket}`, expiresAt: claims.expiresAt };
      return json(out);
    }
    default:
      return errorResponse(404, "not_found");
  }
}

/** Opens a computer's WebSocket to its account's Durable Object, on a ticket from POST /v1/tickets. */
async function connect(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return errorResponse(426, "upgrade_required", {}, { upgrade: "websocket" });
  }
  const claims = await readTicket(env.TICKET_SECRET, url.searchParams.get("ticket") ?? "", Date.now());
  if (!claims) return errorResponse(401, "unauthorized");
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.set("x-clover-device", claims.device);
  headers.set("x-clover-nonce", claims.nonce);
  return env.FORWARDER.getByName(claims.tag).fetch(new Request("https://forwarder.internal/connect", { method: "GET", headers }));
}
