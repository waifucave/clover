// Test helpers that run inside workerd: members' keys, the client library pointed at the Worker, account tokens from
// the test signing keys, and sockets opened through the real Worker.

import { env, exports } from "cloudflare:workers";

import { b64u, utf8 } from "../../shared/encoding";
import {
  type Connect,
  generateSigner,
  groupStatement,
  HandshakeClient,
  type ServiceFrame,
  type Signer,
  type SocketLike,
  pairStatement,
  signText,
  joinStatement,
  admitStatement,
} from "../client";

export const ORIGIN = "https://handshake.test";

/** Rate-limit windows follow the wall clock's minutes: a test that counts toward a limit starts well clear of the next. */
export async function clearOfMinuteBoundary(needMs = 12_000): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < needMs) await new Promise((r) => setTimeout(r, left + 50));
}

let addressCounter = 0;

/** A fresh client address per test, so registration limits don't spill from one test into the next. */
export function freshAddress(): string {
  addressCounter++;
  return `198.51.100.${addressCounter % 250}`;
}

export function worker(request: Request): Promise<Response> {
  return exports.default.fetch(request);
}

/** A socket through the Worker: the ticket URL's wss:// becomes the https:// request workerd upgrades. */
export const connect: Connect = async (url) => {
  const response = await worker(new Request(url.replace(/^ws/, "http"), { headers: { upgrade: "websocket" } }));
  const ws = response.webSocket;
  if (!ws) throw new Error(`no socket: ${response.status} ${await response.text()}`);
  ws.accept();
  return ws as unknown as SocketLike;
};

export function client(address = freshAddress()): HandshakeClient {
  return new HandshakeClient({
    origin: ORIGIN,
    fetch: (request) => {
      const headers = new Headers(request.headers);
      headers.set("cf-connecting-ip", address);
      return worker(new Request(request, { headers }));
    },
    connect,
  });
}

export const newPairId = () => b64u(crypto.getRandomValues(new Uint8Array(16)));

export async function signer(): Promise<Signer> {
  return (await generateSigner()).signer;
}

/** A registered pair: its id and both members. */
export async function registeredPair(c = client()): Promise<{ pair: string; a: Signer; b: Signer; c: HandshakeClient }> {
  const pair = newPairId();
  const [a, b] = [await signer(), await signer()];
  const t = Date.now();
  const statement = pairStatement(pair, a.key, b.key, t);
  await c.registerPair({ pair, keys: [a.key, b.key], t, sigs: [await signText(a, statement), await signText(b, statement)] });
  return { pair, a, b, c };
}

export async function createdGroup(c = client()): Promise<{ group: string; founder: Signer; c: HandshakeClient }> {
  const group = newPairId();
  const founder = await signer();
  const t = Date.now();
  await c.createGroup({ group, key: founder.key, t, sig: await signText(founder, groupStatement(group, founder.key, t)) });
  return { group, founder, c };
}

export async function join(c: HandshakeClient, group: string, joiner: Signer, by: Signer, t = Date.now()): Promise<Record<string, unknown>> {
  return c.joinGroup(group, {
    key: joiner.key,
    t,
    sig: await signText(joiner, joinStatement(group, joiner.key, t)),
    by: by.key,
    bysig: await signText(by, admitStatement(group, joiner.key, t)),
  });
}

/** Collects a socket's frames, to wait on. */
export class Frames {
  readonly frames: ServiceFrame[] = [];
  readonly closes: number[] = [];
  private waiters: (() => void)[] = [];

  onFrame = (frame: ServiceFrame): void => {
    this.frames.push(frame);
    this.wake();
  };

  onClose = (code: number): void => {
    this.closes.push(code);
    this.wake();
  };

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  async until<T extends ServiceFrame>(match: (frame: ServiceFrame) => frame is T, timeoutMs?: number): Promise<T>;
  async until(match: (frame: ServiceFrame) => boolean, timeoutMs?: number): Promise<ServiceFrame>;
  async until(match: (frame: ServiceFrame) => boolean, timeoutMs = 5000): Promise<ServiceFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.frames.find(match);
      if (hit) return hit;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no matching frame; got ${JSON.stringify(this.frames)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async closed(timeoutMs = 5000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.closes.length === 0) {
      if (Date.now() > deadline) throw new Error("the socket did not close");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.closes[0]!;
  }
}

/** Opens a raw socket for a ticket and collects its frames (no reconnecting). */
export async function rawSocket(ticketUrl: string): Promise<{ ws: SocketLike; frames: Frames }> {
  const ws = await connect(ticketUrl);
  const frames = new Frames();
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string" && event.data !== "pong") frames.onFrame(JSON.parse(event.data) as ServiceFrame);
  });
  ws.addEventListener("close", (event) => frames.onClose(event.code));
  return { ws, frames };
}

// ---- account tokens ----

interface SigningKeys {
  es256: JsonWebKey & { kid: string };
  ed25519: JsonWebKey & { kid: string };
  rotated: JsonWebKey & { kid: string };
}

const signingKeys = JSON.parse(env.TEST_SIGNING_KEYS ?? "{}") as SigningKeys;

export async function accountToken(options: { account: string; device: string; key?: keyof SigningKeys; aud?: string; exp?: number }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const which = options.key ?? "es256";
  const jwk = signingKeys[which];
  const alg = which === "es256" ? "ES256" : "EdDSA";
  const header = { alg, kid: jwk.kid, typ: "JWT" };
  const claims = { iss: env.ACCOUNT_ISSUER, aud: options.aud ?? env.HANDSHAKE_AUDIENCE, sub: options.account, dev: options.device, iat: now, exp: options.exp ?? now + 300 };
  const input = `${b64u(utf8(JSON.stringify(header)))}.${b64u(utf8(JSON.stringify(claims)))}`;
  const { kid: _kid, ...bare } = jwk;
  const key =
    alg === "ES256"
      ? await crypto.subtle.importKey("jwk", bare, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
      : await crypto.subtle.importKey("jwk", bare, { name: "Ed25519" }, false, ["sign"]);
  const sig = alg === "ES256" ? await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(input)) : await crypto.subtle.sign({ name: "Ed25519" }, key, utf8(input));
  return `${input}.${b64u(new Uint8Array(sig))}`;
}

/** A box of `n` bytes; the service never opens one, so any bytes do. */
export function box(n = 64): string {
  return b64u(crypto.getRandomValues(new Uint8Array(n)));
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
