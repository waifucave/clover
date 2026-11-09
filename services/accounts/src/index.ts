// waifucave's account service (PROTOCOL.md): the account's device list, and the account tokens every waifucave
// service checks (the hooks forwarder, push, the handshake). Signing in is Supabase's (spec §8.1); this service takes
// a Supabase session and answers for the devices of its account. The wire is lane H's proposal (the core's
// identity/account.ts):
//
//   GET    /.well-known/jwks.json   the public keys account tokens are checked against
//   POST   /v1/devices              {device, t, sig}: registers this device, signed by its link key
//   GET    /v1/devices              {devices}: the account's devices, the revoked ones with `revokedAt`
//   DELETE /v1/devices/<id>         revokes a device of the account
//   POST   /v1/tokens               {aud, dev, t, sig} -> {token, expiresAt}: a token for one service, 5 minutes
//   POST   /dev/token               the local profile's mint without a sign-in (DEV_MINT = "1" only)
//
// Every /v1 call takes the Supabase access token as `Authorization: Bearer`. Everything stateless is checked here
// before the account's object is called: the route, the rate limits, the sign-in, the shapes and a registration's
// signature. Nothing here logs a body, a key, a signature or a token.

import { bearerToken } from "../../shared/account-token";
import { b64u, fromB64, fromB64u } from "../../shared/encoding";
import { errorResponse, json, readJsonObject } from "../../shared/http";
import { addressKey } from "../../shared/web";
import { isStrictX25519PublicKey } from "../../shared/x25519-strict";
import type { DeviceInput, Reply } from "./account-do";
import type { Env } from "./env";
import { memorySigner, NotConfigured, signerFor } from "./keys";
import { sessionOf } from "./session";
import { verifyEd25519 } from "./verify";
import { ACCOUNT_RE, DEVICE_ID_RE, DEVICE_KINDS, deviceIdFor, LIMITS, OSES, type RegisterFields, registerStatement, SIG_RE } from "./wire";

export { AccountDO } from "./account-do";
export { KeysDO } from "./keys";

const AUD_RE = /^[a-z0-9.-]{1,253}$/;
const DEV_DEVICE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STANDARD_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const URL_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try {
      response = await route(request, env);
    } catch (err) {
      if (err instanceof NotConfigured) response = errorResponse(503, "not_configured");
      else {
        console.error(`accounts: unhandled ${err instanceof Error ? err.name : "error"}`);
        response = errorResponse(500, "internal");
      }
    }
    return response;
  },
} satisfies ExportedHandler<Env>;

/** The path under PATH_PREFIX, or null for one outside it. */
function pathOf(url: URL, prefix: string): string | null {
  const base = prefix.replace(/\/+$/, "");
  if (!base) return url.pathname;
  return url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length) : null;
}

async function route(request: Request, env: Env): Promise<Response> {
  const path = pathOf(new URL(request.url), env.PATH_PREFIX ?? "");
  if (path === null) return errorResponse(404, "not_found");
  if (path === "/.well-known/jwks.json" && request.method === "GET") {
    return json(await signerFor(env).jwks(), 200, { "cache-control": "public, max-age=300" });
  }
  // The mint without a sign-in: only in the local profile, with its in-memory keys and never beside real ones.
  if (path === "/dev/token" && request.method === "POST" && env.DEV_MINT === "1" && env.EPHEMERAL_KEYS === "1" && !env.SIGNING_JWKS) {
    return devToken(request, env);
  }

  const [version, area, id, ...rest] = path.split("/").slice(1);
  if (version !== "v1" || rest.length > 0) return errorResponse(404, "not_found");
  let handler: ((account: string) => Promise<Response>) | undefined;
  if (area === "devices" && id === undefined && request.method === "GET") handler = (account) => listDevices(env, account);
  else if (area === "devices" && id === undefined && request.method === "POST") handler = (account) => register(request, env, account);
  else if (area === "devices" && id !== undefined && DEVICE_ID_RE.test(id) && request.method === "DELETE") handler = (account) => revoke(env, account, id);
  else if (area === "tokens" && id === undefined && request.method === "POST") handler = (account) => mint(request, env, account);
  if (!handler) return errorResponse(404, "not_found");

  if (!(await env.ADDRESS_RATE.limit({ key: addressKey(request) })).success) return rateLimited();
  const token = bearerToken(request);
  if (!token) return errorResponse(401, "unauthorized");
  const session = await sessionOf(token, env);
  if ("unavailable" in session) return errorResponse(503, "auth_unavailable", {}, { "retry-after": "30" });
  if ("refused" in session) return errorResponse(401, "unauthorized");
  if (!(await env.API_RATE.limit({ key: session.account })).success) return rateLimited();
  return handler(session.account);
}

const rateLimited = (): Response => errorResponse(429, "rate_limited", {}, { "retry-after": "60" });

function answer<T>(reply: Reply<T>): Response {
  if (reply.error !== undefined) return errorResponse(reply.status, reply.error);
  return reply.body === undefined ? new Response(null, { status: reply.status }) : json(reply.body, reply.status);
}

const accountObject = (env: Env, account: string) => env.ACCOUNTS.getByName(account);

function withinWindow(t: unknown, now: number): t is number {
  return typeof t === "number" && Number.isSafeInteger(t) && Math.abs(t - now) <= LIMITS.statementWindowMs;
}

/** A link key sent as standard base64 (the core's DeviceKey) or base64url, as 32 bytes; null otherwise. */
function linkKey(value: unknown): Uint8Array | null {
  if (typeof value !== "string") return null;
  try {
    const bytes = STANDARD_KEY_RE.test(value) ? fromB64(value) : URL_KEY_RE.test(value) ? fromB64u(value) : null;
    return bytes?.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

function standardB64(bytes: Uint8Array): string {
  return b64u(bytes).replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((3 - (bytes.length % 3)) % 3);
}

/** The device in a registration, checked: its id is its key's (lane B's deviceIdFor), its box key a usable X25519 key. */
async function deviceInput(value: unknown): Promise<{ input: DeviceInput; key: Uint8Array; signed: RegisterFields } | { error: string }> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { error: "bad_request" };
  const d = value as Record<string, unknown>;
  const key = linkKey(d.publicKey);
  if (!key || typeof d.id !== "string" || !DEVICE_ID_RE.test(d.id)) return { error: "bad_request" };
  if ((await deviceIdFor(key)) !== d.id) return { error: "bad_device_id" };
  let boxKey: Uint8Array;
  try {
    boxKey = typeof d.boxKey === "string" ? fromB64u(d.boxKey) : new Uint8Array(0);
  } catch {
    return { error: "bad_request" };
  }
  if (!isStrictX25519PublicKey(boxKey)) return { error: "bad_request" };
  const name = d.name;
  if (typeof name !== "string" || name.trim() === "" || [...name].length > LIMITS.maxName || /\p{Cc}/u.test(name)) return { error: "bad_request" };
  if (!(DEVICE_KINDS as readonly unknown[]).includes(d.kind)) return { error: "bad_request" };
  if (d.os !== undefined && !(OSES as readonly unknown[]).includes(d.os)) return { error: "bad_request" };
  const input: DeviceInput = {
    id: d.id,
    publicKey: standardB64(key),
    boxKey: d.boxKey as string,
    name,
    kind: d.kind as DeviceInput["kind"],
    ...(d.os !== undefined ? { os: d.os as NonNullable<DeviceInput["os"]> } : {}),
  };
  // The statement covers the fields as sent; the record keeps the link key in standard base64.
  const signed: RegisterFields = { id: d.id, publicKey: d.publicKey as string, boxKey: d.boxKey as string, name, kind: d.kind as string, ...(d.os !== undefined ? { os: d.os as string } : {}) };
  return { input, key, signed };
}

async function register(request: Request, env: Env, account: string): Promise<Response> {
  const body = await readJsonObject(request, LIMITS.maxBodyBytes);
  if (!body) return errorResponse(400, "bad_request");
  const now = Date.now();
  const checked = await deviceInput(body.device);
  if ("error" in checked) return errorResponse(400, checked.error);
  const { t, sig } = body;
  if (typeof sig !== "string" || !SIG_RE.test(sig)) return errorResponse(400, "bad_request");
  if (!withinWindow(t, now)) return errorResponse(400, "bad_time");
  if (!(await verifyEd25519(checked.key, fromB64u(sig), registerStatement(account, checked.signed, t)))) return errorResponse(403, "bad_signature");
  return answer(await accountObject(env, account).register(checked.input, t, now));
}

async function listDevices(env: Env, account: string): Promise<Response> {
  return json({ devices: await accountObject(env, account).list() });
}

async function revoke(env: Env, account: string, id: string): Promise<Response> {
  return answer(await accountObject(env, account).revoke(id, Date.now()));
}

function audiencesOf(env: Env): Set<string> {
  return new Set(env.AUDIENCES.split(",").map((a) => a.trim()).filter((a) => AUD_RE.test(a)));
}

function tokenTtl(env: Env): number {
  const n = Number(env.TOKEN_TTL ?? LIMITS.maxTokenSeconds);
  return Number.isSafeInteger(n) && n >= 1 && n <= LIMITS.maxTokenSeconds ? n : LIMITS.maxTokenSeconds;
}

async function mint(request: Request, env: Env, account: string): Promise<Response> {
  const body = await readJsonObject(request, LIMITS.maxBodyBytes);
  if (!body) return errorResponse(400, "bad_request");
  const now = Date.now();
  const { aud, dev, t, sig } = body;
  if (typeof aud !== "string" || !audiencesOf(env).has(aud)) return errorResponse(400, "bad_audience");
  if (typeof dev !== "string" || !DEVICE_ID_RE.test(dev) || typeof sig !== "string" || !SIG_RE.test(sig)) return errorResponse(400, "bad_request");
  if (!withinWindow(t, now)) return errorResponse(400, "bad_time");
  // The signer first: a service without its keys refuses before a device's `t` is spent.
  const signer = signerFor(env);
  const allowed = await accountObject(env, account).allowMint(account, dev, aud, t, sig);
  if (allowed.status !== 200) return answer(allowed);
  const iat = Math.floor(now / 1000);
  const exp = iat + tokenTtl(env);
  const token = await signer.sign({ iss: env.ISSUER, aud, sub: account, dev, iat, exp, jti: b64u(crypto.getRandomValues(new Uint8Array(12))) });
  return json({ token, expiresAt: exp * 1000 });
}

/** The local profile's mint without a sign-in, for emulator tests that need a token and no account. */
async function devToken(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const ttl = body?.ttl === undefined ? 300 : body.ttl;
  if (
    !body ||
    typeof body.account !== "string" ||
    !ACCOUNT_RE.test(body.account) ||
    typeof body.device !== "string" ||
    !DEV_DEVICE_RE.test(body.device) ||
    typeof body.aud !== "string" ||
    !AUD_RE.test(body.aud) ||
    typeof ttl !== "number" ||
    !Number.isSafeInteger(ttl) ||
    ttl < 1 ||
    ttl > 300
  ) {
    return errorResponse(400, "bad_request");
  }
  const iat = Math.floor(Date.now() / 1000);
  const token = await memorySigner(env).sign({
    iss: env.ISSUER,
    aud: body.aud,
    sub: body.account,
    dev: body.device,
    iat,
    exp: iat + ttl,
    jti: b64u(crypto.getRandomValues(new Uint8Array(12))),
  });
  return json({ token });
}
