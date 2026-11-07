// Test helpers that run inside workerd: sessions at the fake Supabase project (vitest.config.ts), devices with real
// Ed25519 link keys, and the Worker called with its rate limits on StepLimiters, so no test depends on the clock.

import { env } from "cloudflare:workers";

import { b64u } from "../../shared/encoding";
import { StepLimiter } from "../../shared/testing/step-limiter";
import accounts from "../src/index";
import type { Env } from "../src/env";
import { deviceIdFor, mintStatement, registerStatement } from "../src/wire";

export const ORIGIN = "https://accounts.test";
export const AUDIENCE = "handshake.waifucave.com";

export type Via = (request: Request) => Promise<Response>;

/** The Worker with some of its environment replaced; its limits are StepLimiters too generous to matter unless given. */
export function withEnv(overrides: Partial<Record<keyof Env, unknown>> = {}): Via {
  const changed = { ...env, ADDRESS_RATE: new StepLimiter(1_000_000), API_RATE: new StepLimiter(1_000_000), ...overrides } as Env;
  return (request) => accounts.fetch(request, changed);
}

export const worker: Via = withEnv();

let addressCounter = 0;
export function freshAddress(): string {
  addressCounter++;
  return `198.51.100.${addressCounter % 250}`;
}

export const uniqueAccount = (): string => crypto.randomUUID();

async function fake(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const init: RequestInit = body === undefined ? {} : { method: "POST", body: JSON.stringify(body) };
  return (await (await fetch(`https://auth.test${path}`, init)).json()) as Record<string, unknown>;
}

export interface Session {
  account: string;
  token: string;
}

/** A session at the fake Supabase project. */
export async function signIn(account = uniqueAccount(), options: { anonymous?: boolean } = {}): Promise<Session> {
  const { token } = (await fake("/__session", { id: account, anonymous: options.anonymous ?? false })) as { token: string };
  return { account, token };
}

export const signOut = async (session: Session): Promise<void> => void (await fake("/__signout", { token: session.token }));
export const setAuthDown = async (down: boolean): Promise<void> => void (await fake("/__down", { down }));
export const userCalls = async (): Promise<number> => (await fake("/__calls")).userCalls as number;

export interface TestDevice {
  id: string;
  /** Standard base64, as the core's DeviceKey sends it. */
  publicKey: string;
  rawPublicKey: Uint8Array;
  boxKey: string;
  sign(data: Uint8Array): Promise<string>;
}

export async function newDevice(): Promise<TestDevice> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return {
    id: await deviceIdFor(raw),
    publicKey: btoa(String.fromCharCode(...raw)),
    rawPublicKey: raw,
    boxKey: b64u(crypto.getRandomValues(new Uint8Array(32))),
    sign: async (data) => b64u(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, data as Uint8Array<ArrayBuffer>))),
  };
}

export function call(method: string, path: string, options: { session?: Session | string; body?: unknown; address?: string; via?: Via; origin?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": options.address ?? freshAddress() };
  const token = typeof options.session === "string" ? options.session : options.session?.token;
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) init.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  return (options.via ?? worker)(new Request(`${options.origin ?? ORIGIN}${path}`, init));
}

export async function registration(
  session: Session,
  device: TestDevice,
  options: { name?: string; kind?: string; os?: string; t?: number; signer?: TestDevice; account?: string } = {},
): Promise<Record<string, unknown>> {
  const t = options.t ?? Date.now();
  const record = { id: device.id, publicKey: device.publicKey, boxKey: device.boxKey, name: options.name ?? "studio", kind: options.kind ?? "desktop", ...(options.os === undefined ? { os: "macos" } : options.os === "" ? {} : { os: options.os }) };
  const sig = await (options.signer ?? device).sign(registerStatement(options.account ?? session.account, record, t));
  return { device: record, t, sig };
}

export async function register(session: Session, device: TestDevice, options: Parameters<typeof registration>[2] & { via?: Via } = {}): Promise<Response> {
  return call("POST", "/v1/devices", { session, body: await registration(session, device, options), ...(options.via ? { via: options.via } : {}) });
}

export async function mintFor(session: Session, device: TestDevice, options: { aud?: string; t?: number; signer?: TestDevice; via?: Via; account?: string } = {}): Promise<Response> {
  const aud = options.aud ?? AUDIENCE;
  const t = options.t ?? Date.now();
  const sig = await (options.signer ?? device).sign(mintStatement(options.account ?? session.account, aud, device.id, t));
  return call("POST", "/v1/tokens", { session, body: { aud, dev: device.id, t, sig }, ...(options.via ? { via: options.via } : {}) });
}

/** A fetch for the shared JWKS check, answered by the Worker itself. */
export function jwksFetcher(via: Via = worker): typeof fetch {
  return ((input: RequestInfo | URL) => via(new Request(String(input)))) as typeof fetch;
}

