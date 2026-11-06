// The keys that sign account tokens.
//
// * Production: SIGNING_JWKS, a secret, {"keys":[private JWK with kid, ...]}. Every Worker instance imports it once;
//   the first key signs and every key is published, so a rotation adds the new key first and drops the old one once
//   its tokens have ended (5 minutes).
// * The local profile (EPHEMERAL_KEYS = "1", never in production): keys made in one Durable Object's memory, not its
//   storage, so nothing is written down and every Worker instance signs with the same key. A restart makes new
//   keys, and the services pick them up through their unknown-kid refetch.
//
// Neither path ever logs or returns a private half.

import { DurableObject } from "cloudflare:workers";

import { b64u, utf8 } from "../../shared/encoding";

export type PublicJwk = JsonWebKey & { kid: string; alg: "ES256" | "EdDSA"; use: "sig" };

interface SigningKey {
  kid: string;
  alg: "ES256" | "EdDSA";
  privateKey: CryptoKey;
  publicJwk: PublicJwk;
}

/** What signs: the published keys, and a JWS over the given claims with the first key. */
export interface TokenSigner {
  jwks(): Promise<{ keys: PublicJwk[] }>;
  sign(claims: Record<string, unknown>): Promise<string>;
}

export class NotConfigured extends Error {
  constructor() {
    super("no signing keys");
  }
}

async function signWith(keys: SigningKey[], claims: Record<string, unknown>): Promise<string> {
  const [key] = keys;
  if (!key) throw new NotConfigured();
  const header = { alg: key.alg, kid: key.kid, typ: "JWT" };
  const input = `${b64u(utf8(JSON.stringify(header)))}.${b64u(utf8(JSON.stringify(claims)))}`;
  const signature =
    key.alg === "ES256"
      ? await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, utf8(input))
      : await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, utf8(input));
  return `${input}.${b64u(new Uint8Array(signature))}`;
}

async function freshKeys(): Promise<SigningKey[]> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const kid = `local-${b64u(crypto.getRandomValues(new Uint8Array(6)))}`;
  return [{ kid, alg: "EdDSA", privateKey: pair.privateKey, publicJwk: { kty: "OKP", crv: "Ed25519", x: publicJwk.x, kid, alg: "EdDSA", use: "sig" } }];
}

/** The private JWKs in `text`; any key that doesn't import makes the whole set refused, so a typo is never half-used. */
async function importKeys(text: string): Promise<SigningKey[]> {
  const parsed = JSON.parse(text) as { keys?: unknown };
  if (!Array.isArray(parsed.keys) || parsed.keys.length === 0) throw new NotConfigured();
  const out: SigningKey[] = [];
  for (const jwk of parsed.keys as (JsonWebKey & { kid?: unknown })[]) {
    const kid = jwk.kid;
    if (typeof kid !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(kid) || typeof jwk.d !== "string") throw new NotConfigured();
    if (jwk.kty === "EC" && jwk.crv === "P-256") {
      const privateKey = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      out.push({ kid, alg: "ES256", privateKey, publicJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, kid, alg: "ES256", use: "sig" } });
    } else if (jwk.kty === "OKP" && jwk.crv === "Ed25519") {
      const privateKey = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d }, { name: "Ed25519" }, false, ["sign"]);
      out.push({ kid, alg: "EdDSA", privateKey, publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, kid, alg: "EdDSA", use: "sig" } });
    } else {
      throw new NotConfigured();
    }
  }
  return out;
}

const imported = new Map<string, Promise<SigningKey[]>>();

function secretSigner(text: string): TokenSigner {
  let keys = imported.get(text);
  if (!keys) {
    keys = importKeys(text).catch(() => {
      imported.delete(text);
      throw new NotConfigured();
    });
    imported.set(text, keys);
  }
  const loaded = keys;
  return {
    jwks: async () => ({ keys: (await loaded).map((k) => k.publicJwk) }),
    sign: async (claims) => signWith(await loaded, claims),
  };
}

/** The local profile's keys, in memory. */
export class KeysDO extends DurableObject {
  private keys: Promise<SigningKey[]> | null = null;

  private load(): Promise<SigningKey[]> {
    this.keys ??= freshKeys();
    return this.keys;
  }

  async jwks(): Promise<{ keys: PublicJwk[] }> {
    return { keys: (await this.load()).map((k) => k.publicJwk) };
  }

  async sign(claims: Record<string, unknown>): Promise<string> {
    return signWith(await this.load(), claims);
  }
}

export interface KeysEnv {
  KEYS: DurableObjectNamespace<KeysDO>;
  SIGNING_JWKS?: string;
  EPHEMERAL_KEYS?: string;
}

/** The signer for this environment; throws NotConfigured when it has none (production without its secret). */
export function signerFor(env: KeysEnv): TokenSigner {
  if (env.SIGNING_JWKS) return secretSigner(env.SIGNING_JWKS);
  if (env.EPHEMERAL_KEYS === "1") {
    const stub = env.KEYS.getByName("keys");
    return { jwks: () => stub.jwks(), sign: (claims) => stub.sign(claims) };
  }
  throw new NotConfigured();
}
