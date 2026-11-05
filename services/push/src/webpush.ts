// Web Push: the push protocol (RFC 8030), message encryption (RFC 8291, aes128gcm per RFC 8188) and VAPID
// (RFC 8292), for the web companion's browsers. The payload is only the count, encrypted to the browser's
// subscription key, so the browser's push service learns nothing either.

import { b64u, concatBytes, fromB64u, utf8, type Bytes } from "../../shared/encoding";
import { decodeRawPublicKey, importRawP256, signJwt } from "./es256";
import { PUSH_TIMEOUT_MS, type SendOutcome } from "./apns";

export interface VapidConfig {
  /** A contact for push services: "mailto:..." or an https URL. */
  subject: string;
  /** base64url of the 65-byte uncompressed P-256 public key (browsers subscribe with it). */
  publicKey: string;
  /** base64url of the 32-byte private scalar: a secret. */
  privateKey: string;
}

export interface WebPushSubscription {
  endpoint: string;
  /** base64url: the browser's 65-byte P-256 key and 16-byte auth secret, from PushSubscription.toJSON(). */
  p256dh: string;
  auth: string;
}

const RECORD_SIZE = 4096;

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", copy(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: copy(salt), info: copy(info) }, key, length * 8));
}

function copy(data: Uint8Array): Bytes {
  const out = new Uint8Array(data.length);
  out.set(data);
  return out;
}

/** The sender's ephemeral key and salt: fresh for every message, fixed only by the RFC's test vector. */
export interface EncryptionSeed {
  privateKey: CryptoKey;
  publicKey: Uint8Array;
  salt: Uint8Array;
}

async function freshSeed(): Promise<EncryptionSeed> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return { privateKey: pair.privateKey, publicKey, salt };
}

/** RFC 8291: one aes128gcm record holding `plaintext`, for the subscription's key and auth secret. */
export async function encryptPayload(plaintext: Uint8Array, uaPublic: Uint8Array, authSecret: Uint8Array, seed?: EncryptionSeed): Promise<Bytes> {
  if (authSecret.length !== 16) throw new TypeError("auth secret must be 16 bytes");
  if (plaintext.length + 17 > RECORD_SIZE) throw new RangeError("payload too large for one record");
  const { privateKey, publicKey: asPublic, salt } = seed ?? (await freshSeed());
  const uaKey = await crypto.subtle.importKey("raw", copy(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const params = { name: "ECDH", public: uaKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0];
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(params, privateKey, 256));
  const keyInfo = concatBytes(utf8("WebPush: info"), Uint8Array.of(0), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, concatBytes(utf8("Content-Encoding: aes128gcm"), Uint8Array.of(0)), 16);
  const nonce = await hkdf(salt, ikm, concatBytes(utf8("Content-Encoding: nonce"), Uint8Array.of(0)), 12);
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  // The last (and only) record ends with the 0x02 delimiter and no padding.
  const record = concatBytes(plaintext, Uint8Array.of(2));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, record));
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE);
  return concatBytes(salt, recordSize, Uint8Array.of(asPublic.length), asPublic, ciphertext);
}

// ---- VAPID ----

const VAPID_LIFETIME_S = 12 * 3600; // at most 24 hours (RFC 8292 §2)
const vapidCache = new Map<string, { header: string; expiresAt: number }>();
const vapidKeys = new Map<string, Promise<CryptoKey>>();

export async function vapidAuthorization(config: VapidConfig, audience: string, now: number): Promise<string> {
  const cacheKey = `${config.publicKey}|${audience}`;
  const hit = vapidCache.get(cacheKey);
  if (hit && hit.expiresAt - 3600 > now / 1000) return hit.header;
  let key = vapidKeys.get(config.privateKey);
  if (!key) {
    key = importRawP256(decodeRawPublicKey(config.publicKey), fromB64u(config.privateKey), "sign");
    vapidKeys.set(config.privateKey, key);
  }
  const expiresAt = Math.floor(now / 1000) + VAPID_LIFETIME_S;
  const jwt = await signJwt({ typ: "JWT", alg: "ES256" }, { aud: audience, exp: expiresAt, sub: config.subject }, await key);
  const header = `vapid t=${jwt}, k=${config.publicKey}`;
  vapidCache.set(cacheKey, { header, expiresAt });
  return header;
}

/** Push services an endpoint may point at: https, a listed host (a "*." entry covers subdomains), port 443. */
export function allowedEndpoint(endpoint: string, hosts: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password || endpoint.length > 1024) return false;
  const host = url.hostname.toLowerCase();
  return hosts
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .some((allowed) => (allowed.startsWith("*.") ? host.endsWith(allowed.slice(1)) && host.length > allowed.length - 1 : host === allowed));
}

export async function sendWebPush(
  config: VapidConfig,
  subscription: WebPushSubscription,
  payload: Uint8Array,
  options: { urgent: boolean; now: number; ttlSeconds: number; timeoutMs?: number },
): Promise<SendOutcome> {
  const audience = new URL(subscription.endpoint).origin;
  const body = await encryptPayload(payload, fromB64u(subscription.p256dh), fromB64u(subscription.auth));
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidAuthorization(config, audience, options.now),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(options.ttlSeconds),
      urgency: options.urgent ? "high" : "normal",
      topic: "clover-updates",
    },
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? PUSH_TIMEOUT_MS),
  });
  if (response.status >= 200 && response.status < 300) return { ok: true };
  return { ok: false, gone: response.status === 404 || response.status === 410, status: response.status, reason: `http ${response.status}` };
}

/** Whether a subscription's key is a point on P-256 that ECDH accepts (checked once, when it registers). */
export async function usableSubscriptionKey(p256dh: Uint8Array): Promise<boolean> {
  try {
    await crypto.subtle.importKey("raw", copy(p256dh), { name: "ECDH", namedCurve: "P-256" }, false, []);
    return true;
  } catch {
    return false;
  }
}

export function vapidPublicKey(config: VapidConfig): string {
  return b64u(decodeRawPublicKey(config.publicKey));
}
