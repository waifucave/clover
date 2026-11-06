// handshake.waifucave.com: the waifucave handshake's Worker (PROTOCOL.md). It introduces devices to each other:
// addresses, "dial now" and WebRTC signalling as sealed boxes, and the main computer's lease.
//
//   POST /v1/pairs                        register a pair (both members' signatures)
//   …    /v1/pairs/<pair>[/…]             a pair's calls, signed by a member
//   POST /v1/groups                       create a group (the founder's signature)
//   POST /v1/groups/<group>/members       join a group (the joiner's and a member's signatures)
//   …    /v1/groups/<group>[/…]           a group's calls, signed by a member
//   …    /v1/accounts/self[/…]            the account channel, with the device's account token
//   GET  /v1/socket?ticket=…              a member's WebSocket
//   PUT|GET|DELETE /v1/rendezvous/<slot>  a short pairing code's slot (unsigned: the box is sealed under the code)
//
// Everything stateless is checked here, before any Durable Object is called: the route, sizes, the signature or the
// token, and the rate limits. Nothing here logs a body, a key, a signature or a token.

import { bearerToken } from "../../shared/account-token";
import { b64u, fromB64u, sha256 } from "../../shared/encoding";
import { errorResponse, json, readBodyCapped, TooLarge } from "../../shared/http";
import { verifyAccountTokenFrom } from "../../shared/jwks";
import { addressKey, originsFrom, preflight, withCors } from "../../shared/web";
import {
  admitStatement,
  DEVICE_ID_RE,
  groupStatement,
  isKind,
  joinStatement,
  KEY_RE,
  KINDS,
  type Kind,
  LIMITS,
  pairStatement,
  parseAuthorization,
  requestSigningString,
  SCOPE_ID_RE,
  type ScopeKind,
  SIG_RE,
  SLOT_RE,
  SLOT_TOKEN_RE,
} from "../client/wire";
import { mintTicket, readTicket, verifySignature } from "./auth";
import type { Env } from "./env";
import type { Call, HandshakeDO, Reply } from "./handshake-do";

export { HandshakeDO } from "./handshake-do";
export { RendezvousDO } from "./rendezvous-do";

const METHODS = "GET, POST, PUT, DELETE";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origins = originsFrom(env.WEB_ORIGINS);
    if (request.method === "OPTIONS") return preflight(request, origins, METHODS);
    let response: Response;
    try {
      response = await route(request, env);
    } catch (err) {
      console.error(`handshake: unhandled ${err instanceof Error ? err.name : "error"}`);
      response = errorResponse(500, "internal");
    }
    return withCors(response, request, origins);
  },
} satisfies ExportedHandler<Env>;

class Refused extends Error {
  constructor(readonly response: Response) {
    super("refused");
  }
}

const refuse = (status: number, code: string): never => {
  throw new Refused(errorResponse(status, code));
};

const rateLimited = (): never => {
  throw new Refused(errorResponse(429, "rate_limited", {}, { "retry-after": "60" }));
};

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.split("/").slice(1);
  if (path[0] !== "v1") return errorResponse(404, "not_found");
  try {
    const [area, id, ...rest] = path.slice(1);
    if (area === "socket" && id === undefined) return await socket(request, env, url);
    if (area === "pairs") {
      if (id === undefined && request.method === "POST") return await registerPair(request, env);
      if (id !== undefined && SCOPE_ID_RE.test(id)) return await signedCall(request, env, url, "pair", id, rest);
    }
    if (area === "groups") {
      if (id === undefined && request.method === "POST") return await createGroup(request, env);
      if (id !== undefined && SCOPE_ID_RE.test(id)) {
        if (request.method === "POST" && rest.length === 1 && rest[0] === "members") return await joinGroup(request, env, id);
        return await signedCall(request, env, url, "group", id, rest);
      }
    }
    if (area === "accounts" && id === "self") return await accountCall(request, env, rest);
    if (area === "rendezvous" && id !== undefined && SLOT_RE.test(id) && rest.length === 0) return await rendezvous(request, env, id);
    return errorResponse(404, "not_found");
  } catch (err) {
    if (err instanceof Refused) return err.response;
    throw err;
  }
}

function reply(result: Reply): Response {
  return result.body === undefined ? new Response(null, { status: result.status }) : json(result.body, result.status);
}

function stubFor(env: Env, scope: ScopeKind, id: string): DurableObjectStub<HandshakeDO> {
  return env.HANDSHAKE.getByName(`${scope}:${id}`);
}

async function readBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await readBodyCapped(request, LIMITS.maxBodyBytes);
  } catch (err) {
    if (err instanceof TooLarge) refuse(413, "too_large");
    throw err;
  }
}

function parseJson(body: Uint8Array): Record<string, unknown> {
  if (body.length === 0) return {};
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body)) as unknown;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Falls through to the refusal.
  }
  return refuse(400, "bad_request");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  return parseJson(await readBody(request));
}

function withinStatementWindow(t: unknown, now: number): t is number {
  return typeof t === "number" && Number.isSafeInteger(t) && Math.abs(t - now) <= LIMITS.statementWindowMs;
}

async function limitRegistration(request: Request, env: Env): Promise<void> {
  if (!(await env.REGISTER_RATE.limit({ key: addressKey(request) })).success) rateLimited();
}

// ---- registration ----

async function registerPair(request: Request, env: Env): Promise<Response> {
  await limitRegistration(request, env);
  const body = await readJson(request);
  const now = Date.now();
  const { pair, keys, t, sigs } = body;
  if (typeof pair !== "string" || !SCOPE_ID_RE.test(pair)) return errorResponse(400, "bad_request");
  if (!Array.isArray(keys) || keys.length !== 2 || !keys.every((k) => typeof k === "string" && KEY_RE.test(k))) return errorResponse(400, "bad_request");
  if (!Array.isArray(sigs) || sigs.length !== 2 || !sigs.every((s) => typeof s === "string" && SIG_RE.test(s))) {
    return errorResponse(400, "bad_signature_form");
  }
  const [a, b] = keys as [string, string];
  if (a === b) return errorResponse(400, "bad_request");
  if (!withinStatementWindow(t, now)) return errorResponse(401, "unauthorized");
  const statement = pairStatement(pair, a, b, t);
  const [okA, okB] = await Promise.all([verifySignature(a, sigs[0] as string, statement), verifySignature(b, sigs[1] as string, statement)]);
  if (!okA || !okB) return errorResponse(401, "unauthorized");
  return reply(await stubFor(env, "pair", pair).registerPair(pair, [a, b], now));
}

async function createGroup(request: Request, env: Env): Promise<Response> {
  await limitRegistration(request, env);
  const { group, key, t, sig } = await readJson(request);
  const now = Date.now();
  if (typeof group !== "string" || !SCOPE_ID_RE.test(group) || typeof key !== "string" || !KEY_RE.test(key)) return errorResponse(400, "bad_request");
  if (typeof sig !== "string" || !SIG_RE.test(sig)) return errorResponse(400, "bad_signature_form");
  if (!withinStatementWindow(t, now)) return errorResponse(401, "unauthorized");
  if (!(await verifySignature(key, sig, groupStatement(group, key, t)))) return errorResponse(401, "unauthorized");
  return reply(await stubFor(env, "group", group).createGroup(group, key, now));
}

async function joinGroup(request: Request, env: Env, group: string): Promise<Response> {
  await limitRegistration(request, env);
  const { key, t, sig, by, bysig } = await readJson(request);
  const now = Date.now();
  if (typeof key !== "string" || !KEY_RE.test(key) || typeof by !== "string" || !KEY_RE.test(by) || key === by) return errorResponse(400, "bad_request");
  if (typeof sig !== "string" || !SIG_RE.test(sig) || typeof bysig !== "string" || !SIG_RE.test(bysig)) return errorResponse(400, "bad_signature_form");
  if (!withinStatementWindow(t, now)) return errorResponse(401, "unauthorized");
  const [okJoin, okAdmit] = await Promise.all([
    verifySignature(key, sig, joinStatement(group, key, t)),
    verifySignature(by, bysig, admitStatement(group, key, t)),
  ]);
  if (!okJoin || !okAdmit) return errorResponse(401, "unauthorized");
  return reply(await stubFor(env, "group", group).joinGroup(key, by, t, now));
}

// ---- argument checks ----

function ttlOf(value: unknown, max: number, fallback: number, min = 1): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return refuse(400, "bad_request");
  return value;
}

function boxOf(value: unknown, kind: Kind): Uint8Array {
  return sealedBox(value, KINDS[kind].maxBox);
}

/** A sealed box from the body: canonical base64url, not empty, at most `maxBox` bytes once decoded. */
function sealedBox(value: unknown, maxBox: number): Uint8Array {
  if (typeof value !== "string") return refuse(400, "bad_request");
  let box: Uint8Array;
  try {
    box = fromB64u(value);
  } catch {
    return refuse(400, "bad_request");
  }
  if (box.length === 0) return refuse(400, "bad_request");
  if (box.length > maxBox) return refuse(413, "too_large");
  return box;
}

function recordArgs(kind: string | undefined, body: Record<string, unknown>): Record<string, unknown> {
  if (!isKind(kind) || KINDS[kind].as !== "record") return refuse(400, "bad_kind");
  const gen = body.gen;
  if (typeof gen !== "number" || !Number.isSafeInteger(gen) || gen <= 0) return refuse(400, "bad_request");
  const rule = KINDS[kind];
  return { kind, gen, ttl: ttlOf(body.ttl, rule.maxTtl, rule.defaultTtl), box: boxOf(body.box, kind) };
}

function messageArgs(body: Record<string, unknown>): Record<string, unknown> {
  const kind = body.kind;
  if (!isKind(kind) || KINDS[kind].as !== "message") return refuse(400, "bad_kind");
  const rule = KINDS[kind];
  return { kind, ttl: ttlOf(body.ttl, rule.maxTtl, rule.defaultTtl), box: boxOf(body.box, kind) };
}

function leaseArgs(body: Record<string, unknown>): Record<string, unknown> {
  const op = body.op;
  if (op !== "acquire" && op !== "renew" && op !== "release" && op !== "takeover") return refuse(400, "bad_request");
  const { minTtl, maxTtl, defaultTtl } = LIMITS.lease;
  const ttl = ttlOf(body.ttl, maxTtl, defaultTtl, minTtl);
  const epoch = body.epoch;
  if ((op === "renew" || op === "release") && (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0)) return refuse(400, "bad_request");
  return { op, ttl, ...(typeof epoch === "number" ? { epoch } : {}) };
}

// ---- signed calls (pairs and groups) ----

/** The operation a signed path names, and its arguments from the body. */
function signedOp(scope: "pair" | "group", method: string, rest: string[], body: Record<string, unknown>): { op: string; args?: Record<string, unknown> } {
  const route = `${scope} ${method} ${rest[0] ?? ""}`;
  switch (route) {
    case "pair GET ":
    case "group GET ":
      if (rest.length === 0) return { op: "get" };
      break;
    case "pair DELETE ":
      if (rest.length === 0) return { op: "end" };
      break;
    case "pair PUT records":
      if (rest.length === 2) return { op: "putRecord", args: recordArgs(rest[1], body) };
      break;
    case "pair POST messages":
      if (rest.length === 1) return { op: "sendMessage", args: messageArgs(body) };
      break;
    case "pair POST inbox":
      if (rest.length === 1) return { op: "inbox" };
      break;
    case "pair POST tickets":
    case "group POST tickets":
      if (rest.length === 1) return { op: "ticket" };
      break;
    case "group DELETE members":
      if (rest.length === 2 && KEY_RE.test(rest[1]!)) return { op: "removeMember", args: { key: rest[1] } };
      break;
    case "group POST lease":
      if (rest.length === 1) return { op: "lease", args: leaseArgs(body) };
      break;
  }
  return refuse(404, "not_found");
}

async function signedCall(request: Request, env: Env, url: URL, scope: "pair" | "group", id: string, rest: string[]): Promise<Response> {
  const auth = parseAuthorization(request.headers.get("authorization"));
  if (!auth) return errorResponse(401, "unauthorized");
  const now = Date.now();
  if (Math.abs(auth.t - now) > LIMITS.requestWindowMs) return errorResponse(401, "unauthorized");
  if (!(await env.ADDRESS_RATE.limit({ key: addressKey(request) })).success) rateLimited();
  const bytes = await readBody(request);
  const signing = requestSigningString(request.method, url.pathname + url.search, auth.t, b64u(await sha256(bytes)));
  if (!(await verifySignature(auth.key, auth.sig, signing))) return errorResponse(401, "unauthorized");
  if (!(await env.API_RATE.limit({ key: `${scope}:${id}|${auth.key}` })).success) rateLimited();
  const { op, args } = signedOp(scope, request.method, rest, parseJson(bytes));
  const call: Call = { scope, id, member: auth.key, op, ...(args ? { args } : {}), ...(request.method !== "GET" ? { t: auth.t } : {}) };
  return finish(env, call, await stubFor(env, scope, id).call(call));
}

/** A call's answer; a ticket call's is turned into the ticket here, since only the Worker holds the secret. */
async function finish(env: Env, call: Call, result: Reply): Promise<Response> {
  if (call.op !== "ticket" || result.status !== 200) return reply(result);
  const { ticket, claims } = await mintTicket(env.TICKET_SECRET, {
    scope: call.scope,
    id: call.id,
    member: call.member,
    expiresAt: Date.now() + LIMITS.ticketTtlMs,
  });
  const ws = env.HANDSHAKE_ORIGIN.replace(/^http/, "ws");
  return json({ url: `${ws}/v1/socket?ticket=${ticket}`, expiresAt: claims.expiresAt });
}

// ---- the account channel ----

function accountOp(method: string, rest: string[], body: Record<string, unknown>): { op: string; args?: Record<string, unknown> } {
  switch (`${method} ${rest[0] ?? ""}`) {
    case "GET ":
      if (rest.length === 0) return { op: "get" };
      break;
    case "PUT records":
      if (rest.length === 3 && DEVICE_ID_RE.test(rest[2]!)) return { op: "putRecord", args: { ...recordArgs(rest[1], body), to: rest[2] } };
      break;
    case "POST messages": {
      if (rest.length !== 1) break;
      const to = body.to;
      if (typeof to !== "string" || !DEVICE_ID_RE.test(to)) return refuse(400, "bad_request");
      return { op: "sendMessage", args: { ...messageArgs(body), to } };
    }
    case "POST inbox":
      if (rest.length === 1) return { op: "inbox" };
      break;
    case "POST lease":
      if (rest.length === 1) return { op: "lease", args: leaseArgs(body) };
      break;
    case "POST tickets":
      if (rest.length === 1) return { op: "ticket" };
      break;
    case "DELETE devices":
      if (rest.length === 2 && DEVICE_ID_RE.test(rest[1]!)) return { op: "revokeDevice", args: { device: rest[1] } };
      break;
  }
  return refuse(404, "not_found");
}

async function accountCall(request: Request, env: Env, rest: string[]): Promise<Response> {
  const token = bearerToken(request);
  const identity = token ? await verifyAccountTokenFrom(token, env, env.HANDSHAKE_AUDIENCE) : null;
  if (!identity) return errorResponse(401, "unauthorized");
  if (!(await env.API_RATE.limit({ key: `account:${identity.account}|${identity.device}` })).success) rateLimited();
  const { op, args } = accountOp(request.method, rest, await readJson(request));
  const call: Call = { scope: "account", id: identity.account, member: identity.device, op, ...(args ? { args } : {}) };
  return finish(env, call, await stubFor(env, "account", identity.account).call(call));
}

// ---- rendezvous: a short pairing code's slot ----

async function limitAddress(request: Request, env: Env): Promise<void> {
  if (!(await env.ADDRESS_RATE.limit({ key: addressKey(request) })).success) rateLimited();
}

const slotTokenHash = async (token: string): Promise<string> => b64u(await sha256(new TextEncoder().encode(token)));

async function rendezvous(request: Request, env: Env, slot: string): Promise<Response> {
  const stub = env.RENDEZVOUS.getByName(slot);
  const now = Date.now();
  switch (request.method) {
    case "PUT": {
      await limitRegistration(request, env);
      const body = await readJson(request);
      const { maxTtl, maxBox } = LIMITS.rendezvous;
      const token = body.token;
      if (typeof token !== "string" || !SLOT_TOKEN_RE.test(token)) return errorResponse(400, "bad_request");
      const ttl = ttlOf(body.ttl, maxTtl, maxTtl);
      sealedBox(body.box, maxBox);
      const result = await stub.put(body.box as string, await slotTokenHash(token), ttl, now);
      if (!("expiresAt" in result)) return errorResponse(409, "taken");
      return json({ slot, expiresAt: result.expiresAt }, result.status);
    }
    case "GET": {
      await limitAddress(request, env);
      const found = await stub.get(now);
      return found ? json(found) : errorResponse(404, "not_found");
    }
    case "DELETE": {
      await limitAddress(request, env);
      const token = bearerToken(request);
      if (!token || !SLOT_TOKEN_RE.test(token)) return errorResponse(401, "unauthorized");
      const result = await stub.remove(await slotTokenHash(token), now);
      if (result.status === 204) return new Response(null, { status: 204 });
      return errorResponse(result.status, result.status === 403 ? "forbidden" : "not_found");
    }
  }
  return errorResponse(405, "method_not_allowed", {}, { allow: "GET, PUT, DELETE" });
}

// ---- sockets ----

async function socket(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return errorResponse(426, "upgrade_required", {}, { upgrade: "websocket" });
  }
  const claims = await readTicket(env.TICKET_SECRET, url.searchParams.get("ticket") ?? "", Date.now());
  if (!claims) return errorResponse(401, "unauthorized");
  const headers = new Headers();
  for (const name of ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("x-handshake-member", claims.member);
  headers.set("x-handshake-nonce", claims.nonce);
  headers.set("x-handshake-expires", String(claims.expiresAt));
  return stubFor(env, claims.scope, claims.id).fetch(new Request("https://handshake.internal/socket", { method: "GET", headers }));
}
