// Test helpers inside workerd: account tokens from the test signing key, the API, and the fakes' log.

import { env, exports } from "cloudflare:workers";

import { b64u, utf8 } from "../../shared/encoding";
import type { FakeLogEntry } from "./fake-log";

export const ORIGIN = "https://push.test";

const signingKeys = JSON.parse(env.TEST_SIGNING_KEYS ?? "{}") as { es256: JsonWebKey & { kid: string } };

export async function accountToken(options: { account: string; device: string; aud?: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: signingKeys.es256.kid, typ: "JWT" };
  const claims = { iss: env.ACCOUNT_ISSUER, aud: options.aud ?? env.PUSH_AUDIENCE, sub: options.account, dev: options.device, iat: now, exp: now + 600 };
  const input = `${b64u(utf8(JSON.stringify(header)))}.${b64u(utf8(JSON.stringify(claims)))}`;
  const { kid: _kid, alg: _alg, use: _use, key_ops: _ops, ...bare } = signingKeys.es256 as JsonWebKey & { kid: string; use?: string };
  const key = await crypto.subtle.importKey("jwk", bare, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(input));
  return `${input}.${b64u(new Uint8Array(signature))}`;
}

export function call(token: string | null, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
}

let counter = 0;
export function uniqueAccount(): string {
  counter += 1;
  return `acct-${Date.now().toString(36)}-${counter}`;
}

/** A phone or browser of an account, holding its own token. */
export async function device(account: string, id: string): Promise<{ token: string; id: string }> {
  return { token: await accountToken({ account, device: id }), id };
}

export interface TestSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export const subscriptions = JSON.parse(env.TEST_SUBSCRIPTIONS ?? "{}") as Record<"fcm" | "mozilla" | "apple" | "gone", TestSubscription>;

export function apnsToken(prefix = "a1"): string {
  const random = new Uint8Array(30);
  crypto.getRandomValues(random);
  return prefix + [...random].map((b) => b.toString(16).padStart(2, "0")).join("") + "00";
}

/**
 * Rate-limit windows are aligned to the wall clock's minutes (miniflare, like Cloudflare): a test that counts
 * toward a limit starts its burst well clear of the next minute, so the window cannot reset half-way.
 */
export async function clearOfMinuteBoundary(needMs = 12_000): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < needMs) await new Promise((r) => setTimeout(r, left + 50));
}

export async function fakeLog(): Promise<FakeLogEntry[]> {
  return (await (await fetch("https://fake.test/__log")).json()) as FakeLogEntry[];
}

export async function resetFakes(): Promise<void> {
  await fetch("https://fake.test/__reset", { method: "POST" });
}
