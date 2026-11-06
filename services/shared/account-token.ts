// Verifies a waifucave account token: how a computer, phone or browser proves to a waifucave service which
// account and which device it is (spec §8.1: "the account is the root of trust").
//
// The token is a JWT (JWS compact) the account service signs, checked offline against its public keys:
//   header  { alg: "ES256" | "EdDSA", kid }
//   claims  { iss, aud (string or array, must name this service), sub: account id, dev: device id,
//             iat, exp, nbf? }
// Lane H's sign-in stack issues these; the exact claim names are this lane's proposal until H confirms them.

import { fromB64u, utf8 } from "./encoding";

export interface AccountIdentity {
  account: string;
  device: string;
  expiresAt: number;
}

export interface AccountTokenConfig {
  /** The account service's public keys, as a JWKS JSON string: {"keys":[...]} */
  jwks: string;
  issuer: string;
  audience: string;
  /** Seconds since the epoch; defaults to the clock. */
  now?: number;
  skewSeconds?: number;
  maxLifetimeSeconds?: number;
}

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT_RE = /^[\x21-\x7e]{1,128}$/;
const MAX_TOKEN_LENGTH = 8192;

type Alg = "ES256" | "EdDSA";
interface VerifyKey {
  alg: Alg;
  /** Null when the JWKS entry doesn't import (a malformed key): tokens under its kid are refused. */
  key: Promise<CryptoKey | null>;
}

const keySets = new Map<string, Map<string, VerifyKey>>();

function loadKeys(jwks: string): Map<string, VerifyKey> {
  const cached = keySets.get(jwks);
  if (cached) return cached;
  const keys = new Map<string, VerifyKey>();
  const parsed = JSON.parse(jwks) as { keys?: unknown };
  if (!Array.isArray(parsed.keys)) throw new Error("account jwks: no keys");
  for (const raw of parsed.keys as Record<string, unknown>[]) {
    const kid = raw.kid;
    if (typeof kid !== "string" || kid.length === 0) continue;
    if (raw.kty === "EC" && raw.crv === "P-256" && typeof raw.x === "string" && typeof raw.y === "string") {
      const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x: raw.x, y: raw.y };
      keys.set(kid, { alg: "ES256", key: crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]).catch(() => null) });
    } else if (raw.kty === "OKP" && raw.crv === "Ed25519" && typeof raw.x === "string") {
      const jwk: JsonWebKey = { kty: "OKP", crv: "Ed25519", x: raw.x };
      keys.set(kid, { alg: "EdDSA", key: crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]).catch(() => null) });
    }
  }
  keySets.set(jwks, keys);
  return keys;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(fromB64u(part))) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Returns the identity in a valid token, or null for any token that is malformed, unsigned, expired or not for us. */
export async function verifyAccountToken(token: string, config: AccountTokenConfig): Promise<AccountIdentity | null> {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, claimsPart, signaturePart] = parts as [string, string, string];
  const header = decodeJson(headerPart);
  const claims = decodeJson(claimsPart);
  if (!header || !claims) return null;
  if (header.alg !== "ES256" && header.alg !== "EdDSA") return null;
  if (typeof header.kid !== "string") return null;
  if (header.crit !== undefined) return null;

  const key = loadKeys(config.jwks).get(header.kid);
  if (!key || key.alg !== header.alg) return null;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = fromB64u(signaturePart);
  } catch {
    return null;
  }
  const signed = utf8(`${headerPart}.${claimsPart}`);
  const verifyKey = await key.key;
  if (!verifyKey || signature.length !== 64) return null;
  const ok =
    key.alg === "ES256"
      ? await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, signature, signed)
      : await crypto.subtle.verify({ name: "Ed25519" }, verifyKey, signature, signed);
  if (!ok) return null;

  const now = config.now ?? Math.floor(Date.now() / 1000);
  const skew = config.skewSeconds ?? 60;
  const maxLifetime = config.maxLifetimeSeconds ?? 24 * 3600;
  const { iss, aud, sub, dev, exp, iat, nbf } = claims;
  if (iss !== config.issuer) return null;
  const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  if (!audiences.includes(config.audience)) return null;
  if (typeof sub !== "string" || !ACCOUNT_RE.test(sub)) return null;
  if (typeof dev !== "string" || !DEVICE_ID_RE.test(dev)) return null;
  if (typeof exp !== "number" || typeof iat !== "number" || !Number.isFinite(exp) || !Number.isFinite(iat)) return null;
  if (exp <= now - skew) return null;
  if (iat > now + skew) return null;
  if (exp - iat > maxLifetime) return null;
  if (nbf !== undefined && (typeof nbf !== "number" || nbf > now + skew)) return null;
  return { account: sub, device: dev, expiresAt: exp };
}

/** The bearer token in an Authorization header, or null. */
export function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value) return null;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(value);
  return match ? match[1]! : null;
}
