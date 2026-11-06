// Test helpers that run inside workerd: account tokens from the test signing keys, the plugin's HTTP API,
// webhooks, and computer sockets opened through the real Worker.

import { env, exports } from "cloudflare:workers";

import { b64u, fromB64u, utf8 } from "../../shared/encoding";
import type { StepLimiter } from "../../shared/testing/step-limiter";
import forwarder from "../src/index";
import { keyId, type DeviceKey } from "../../../plugins/clover/plugins/forwarder/src/wire/envelope";
import { generateX25519 } from "../../../plugins/clover/plugins/forwarder/src/wire/hpke";
import { hookKeyHash, type DeviceRegistered, type RoutineRegistered, type Ticket } from "../../../plugins/clover/plugins/forwarder/src/wire/protocol";

export const ORIGIN = "https://hooks.test";

/** The name of the Durable Object an account's tag points at: the 11-byte id after its version byte. */
export function objectOf(tag: string): string {
  return b64u(fromB64u(tag).subarray(1, 12));
}

interface SigningKeys {
  es256: JsonWebKey & { kid: string };
  ed25519: JsonWebKey & { kid: string };
}

const signingKeys = JSON.parse(env.TEST_SIGNING_KEYS ?? "{}") as SigningKeys;

export interface TokenOptions {
  account: string;
  device: string;
  alg?: "ES256" | "EdDSA";
  aud?: string | string[];
  iss?: string;
  iat?: number;
  exp?: number;
  kid?: string;
  extra?: Record<string, unknown>;
  header?: Record<string, unknown>;
}

/** An account token as lane H's account service would issue it, signed with the test keys. */
export async function accountToken(options: TokenOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const alg = options.alg ?? "ES256";
  const jwk = alg === "ES256" ? signingKeys.es256 : signingKeys.ed25519;
  const header = { alg, kid: options.kid ?? jwk.kid, typ: "JWT", ...options.header };
  const claims = {
    iss: options.iss ?? env.ACCOUNT_ISSUER,
    aud: options.aud ?? env.HOOKS_AUDIENCE,
    sub: options.account,
    dev: options.device,
    iat: options.iat ?? now,
    exp: options.exp ?? now + 300,
    ...options.extra,
  };
  const signingInput = `${b64u(utf8(JSON.stringify(header)))}.${b64u(utf8(JSON.stringify(claims)))}`;
  const { kid: _kid, alg: _alg, use: _use, key_ops: _ops, ...bare } = jwk as JsonWebKey & { kid: string; use?: string };
  const key =
    alg === "ES256"
      ? await crypto.subtle.importKey("jwk", bare, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
      : await crypto.subtle.importKey("jwk", bare, { name: "Ed25519" }, false, ["sign"]);
  const signature =
    alg === "ES256"
      ? await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(signingInput))
      : await crypto.subtle.sign({ name: "Ed25519" }, key, utf8(signingInput));
  return `${signingInput}.${b64u(new Uint8Array(signature))}`;
}

export function worker(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

export function apiCall(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  return worker(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

/** A computer of an account: its token and its forwarder key, registered with the service. */
export interface Computer {
  account: string;
  device: string;
  token: string;
  key: DeviceKey;
  tag: string;
}

let counter = 0;
export function uniqueAccount(prefix = "acct"): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export async function registerComputer(account: string, device: string, name = device): Promise<Computer> {
  const token = await accountToken({ account, device });
  const pair = await generateX25519();
  const key: DeviceKey = { ...pair, kid: await keyId(pair.publicKey) };
  const response = await apiCall(token, "PUT", "/v1/devices/self", { encKey: b64u(pair.publicKey), name });
  if (response.status !== 200) throw new Error(`register computer: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as DeviceRegistered;
  return { account, device, token, key, tag: body.tag };
}

export function routineKey(): string {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return b64u(raw);
}

export async function registerRoutine(computer: Computer, routine: string, key: string, takeover = false): Promise<Response> {
  return apiCall(computer.token, "PUT", `/v1/routines/${routine}`, { keyHash: b64u(await hookKeyHash(key)), takeover });
}

export async function registeredRoutine(computer: Computer, routine: string, key = routineKey()): Promise<{ key: string; url: string }> {
  const response = await registerRoutine(computer, routine, key);
  if (response.status !== 200) throw new Error(`register routine: ${response.status} ${await response.text()}`);
  return { key, url: ((await response.json()) as RoutineRegistered).url };
}

export function postHook(
  url: string,
  key: string | null,
  body: BodyInit | null,
  init: RequestInit & { keyIn?: "header" | "query"; via?: (request: Request) => Promise<Response> } = {},
): Promise<Response> {
  const target = new URL(url);
  const headers = new Headers(init.headers);
  if (key !== null) {
    if (init.keyIn === "query") target.searchParams.set("key", key);
    else headers.set("authorization", `Bearer ${key}`);
  }
  const request = new Request(target, { method: init.method ?? "POST", headers, body });
  return init.via ? init.via(request) : exports.default.fetch(request);
}

/**
 * The Worker with some of its rate limits replaced by StepLimiters (shared/testing/step-limiter.ts), so a test of a
 * limit doesn't depend on the wall clock's minutes or the runner's speed. Everything else is the real binding.
 */
export function withLimiters(limiters: Partial<Record<"HOOK_RATE" | "TAG_RATE" | "CHECK_RATE" | "API_RATE", StepLimiter>>): (request: Request) => Promise<Response> {
  const limited = { ...env, ...limiters } as typeof env;
  return (request) => forwarder.fetch(request, limited);
}

/** A computer's WebSocket, opened like the plugin opens it: a ticket over HTTP, then the upgrade. */
export class Socket {
  readonly messages: (string | ArrayBuffer)[] = [];
  private waiters: (() => void)[] = [];
  closed: { code: number; reason: string } | null = null;

  constructor(readonly ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (event) => {
      this.messages.push(event.data as string | ArrayBuffer);
      this.wake();
    });
    ws.addEventListener("close", (event) => {
      this.closed = { code: event.code, reason: event.reason };
      this.wake();
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** Waits until `predicate` holds over what has arrived, or fails after `ms`. */
  async until(predicate: () => boolean, ms = 5000, what = "condition"): Promise<void> {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await Promise.race([new Promise<void>((resolve) => this.waiters.push(resolve)), new Promise((r) => setTimeout(r, 50))]);
    }
  }

  binary(): Uint8Array[] {
    return this.messages.filter((m): m is ArrayBuffer => typeof m !== "string").map((m) => new Uint8Array(m));
  }

  text(): string[] {
    return this.messages.filter((m): m is string => typeof m === "string");
  }

  send(data: string): void {
    this.ws.send(data);
  }

  close(): void {
    try {
      this.ws.close(1000, "done");
    } catch {
      // Already closed.
    }
  }
}

export async function ticketFor(computer: Computer): Promise<Ticket> {
  const response = await apiCall(computer.token, "POST", "/v1/tickets");
  if (response.status !== 200) throw new Error(`ticket: ${response.status}`);
  return (await response.json()) as Ticket;
}

export async function upgrade(ticketUrl: string): Promise<Response> {
  const url = new URL(ticketUrl);
  return exports.default.fetch(new Request(`${ORIGIN}${url.pathname}${url.search}`, { headers: { upgrade: "websocket" } }));
}

export async function openSocket(computer: Computer): Promise<Socket> {
  const ticket = await ticketFor(computer);
  const response = await upgrade(ticket.url);
  if (response.status !== 101 || !response.webSocket) throw new Error(`connect: ${response.status} ${await response.text()}`);
  response.webSocket.accept();
  const socket = new Socket(response.webSocket);
  await socket.until(() => socket.text().some((m) => m.includes('"hello"')), 5000, "hello");
  return socket;
}
