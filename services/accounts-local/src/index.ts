// A local stand-in for waifucave sign-in (wrangler.jsonc says what it serves). The services' emulators point their
// ACCOUNT_JWKS_URL here, so the local stack checks account tokens exactly as production will: ES256 or EdDSA JWS,
// against a JWKS fetched by URL. Lane H's account service replaces it; until then its token mint stands in for
// signing in.
//
// The signing keys live in one Durable Object's memory (not its storage), so nothing is written down: a restart makes
// new keys, and the services pick them up through their unknown-kid refetch. A harness may give its own keys instead
// (SIGNING_JWKS: private JWKs with kids), to mint tokens of its own too.

import { DurableObject } from "cloudflare:workers";

import { b64u, utf8 } from "../../shared/encoding";
import { errorResponse, json, readJsonObject } from "../../shared/http";

export interface Env {
  KEYS: DurableObjectNamespace<KeysDO>;
  /** The `iss` of the tokens, which the services check: this stand-in's own origin. */
  ISSUER: string;
  /** "1" enables POST /dev/token. */
  DEV_MINT?: string;
  /** Optional: {"keys":[private JWK with kid and alg, ...]}; the first signs. */
  SIGNING_JWKS?: string;
}

interface SigningKey {
  kid: string;
  alg: "ES256" | "EdDSA";
  privateKey: CryptoKey;
  publicJwk: JsonWebKey & { kid: string; alg: string; use: "sig" };
}

const DEVICE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT_RE = /^[\x21-\x7e]{1,128}$/;
const AUD_RE = /^[a-z0-9.-]{1,253}$/;

export class KeysDO extends DurableObject<Env> {
  private keys: Promise<SigningKey[]> | null = null;

  private load(): Promise<SigningKey[]> {
    this.keys ??= this.env.SIGNING_JWKS ? fromJwks(this.env.SIGNING_JWKS) : fresh();
    return this.keys;
  }

  async jwks(): Promise<{ keys: SigningKey["publicJwk"][] }> {
    return { keys: (await this.load()).map((k) => k.publicJwk) };
  }

  async mint(claims: { account: string; device: string; aud: string; ttl: number }): Promise<string> {
    const [key] = await this.load();
    if (!key) throw new Error("no signing key");
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: key.alg, kid: key.kid, typ: "JWT" };
    const body = { iss: this.env.ISSUER, aud: claims.aud, sub: claims.account, dev: claims.device, iat: now, exp: now + claims.ttl, jti: b64u(crypto.getRandomValues(new Uint8Array(12))) };
    const input = `${b64u(utf8(JSON.stringify(header)))}.${b64u(utf8(JSON.stringify(body)))}`;
    const signature =
      key.alg === "ES256"
        ? await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, utf8(input))
        : await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, utf8(input));
    return `${input}.${b64u(new Uint8Array(signature))}`;
  }
}

async function fresh(): Promise<SigningKey[]> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const kid = `local-${b64u(crypto.getRandomValues(new Uint8Array(6)))}`;
  return [{ kid, alg: "EdDSA", privateKey: pair.privateKey, publicJwk: { kty: "OKP", crv: "Ed25519", x: publicJwk.x, kid, alg: "EdDSA", use: "sig" } }];
}

async function fromJwks(text: string): Promise<SigningKey[]> {
  const parsed = JSON.parse(text) as { keys: (JsonWebKey & { kid: string; alg?: string })[] };
  const out: SigningKey[] = [];
  for (const jwk of parsed.keys) {
    const { kid, alg: _alg, use: _use, key_ops: _ops, ...bare } = jwk as JsonWebKey & { kid: string; use?: string };
    if (jwk.kty === "EC") {
      const privateKey = await crypto.subtle.importKey("jwk", bare, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      out.push({ kid, alg: "ES256", privateKey, publicJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, kid, alg: "ES256", use: "sig" } });
    } else if (jwk.kty === "OKP") {
      const privateKey = await crypto.subtle.importKey("jwk", bare, { name: "Ed25519" }, false, ["sign"]);
      out.push({ kid, alg: "EdDSA", privateKey, publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, kid, alg: "EdDSA", use: "sig" } });
    }
  }
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const keys = env.KEYS.getByName("keys");
    if (request.method === "GET" && url.pathname === "/.well-known/jwks.json") {
      return json(await keys.jwks(), 200, { "cache-control": "public, max-age=60" });
    }
    if (request.method === "POST" && url.pathname === "/dev/token") {
      if (env.DEV_MINT !== "1") return errorResponse(404, "not_found");
      const body = await readJsonObject(request);
      const ttl = body?.ttl === undefined ? 300 : body.ttl;
      if (
        !body ||
        typeof body.account !== "string" ||
        !ACCOUNT_RE.test(body.account) ||
        typeof body.device !== "string" ||
        !DEVICE_RE.test(body.device) ||
        typeof body.aud !== "string" ||
        !AUD_RE.test(body.aud) ||
        typeof ttl !== "number" ||
        !Number.isSafeInteger(ttl) ||
        ttl < 1 ||
        ttl > 86_400
      ) {
        return errorResponse(400, "bad_request");
      }
      return json({ token: await keys.mint({ account: body.account, device: body.device, aud: body.aud, ttl }) });
    }
    return errorResponse(404, "not_found");
  },
} satisfies ExportedHandler<Env>;
