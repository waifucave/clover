// HPKE (RFC 9180), base mode, single-shot, with DHKEM(X25519, HKDF-SHA256) and HKDF-SHA256, on WebCrypto.
// The forwarder seals with AES-256-GCM (suite 0x0020/0x0001/0x0002, the same as CryptoKit's
// Curve25519_SHA256_AES_GCM_256); AES-128-GCM is here so the RFC's test vectors (A.1) can check the code.

import { concat, fromB64u, i2osp, own, utf8, type Bytes } from "./bytes";

export const KEM_X25519_SHA256 = 0x0020;
export const KDF_HKDF_SHA256 = 0x0001;
export const AEAD_AES_128_GCM = 0x0001;
export const AEAD_AES_256_GCM = 0x0002;
export type AeadId = typeof AEAD_AES_128_GCM | typeof AEAD_AES_256_GCM;

const N_SECRET = 32; // DHKEM(X25519) shared secret
const N_PK = 32; // X25519 public key
const N_H = 32; // SHA-256
const N_N = 12; // AES-GCM nonce
const MODE_BASE = 0x00;

function keyLength(aead: AeadId): number {
  return aead === AEAD_AES_256_GCM ? 32 : 16;
}

const HPKE_V1 = utf8("HPKE-v1");
const KEM_SUITE = concat(utf8("KEM"), i2osp(KEM_X25519_SHA256, 2));

function hpkeSuite(aead: AeadId): Bytes {
  return concat(utf8("HPKE"), i2osp(KEM_X25519_SHA256, 2), i2osp(KDF_HKDF_SHA256, 2), i2osp(aead, 2));
}

// ---- HKDF-SHA256 (RFC 5869) on HMAC, since HPKE uses Extract and Expand separately ----

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  // An empty HMAC key is the same as N_H zero bytes (both pad to a zero block); WebCrypto refuses empty keys.
  const raw = key.length === 0 ? new Uint8Array(N_H) : own(key);
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, own(data)));
}

async function extract(salt: Uint8Array, ikm: Uint8Array): Promise<Bytes> {
  return hmac(salt, ikm);
}

async function expand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Bytes> {
  if (length > 255 * N_H) throw new RangeError("hkdf expand: too long");
  const out = new Uint8Array(length);
  let previous: Uint8Array = new Uint8Array(0);
  let offset = 0;
  for (let i = 1; offset < length; i++) {
    previous = await hmac(prk, concat(previous, info, Uint8Array.of(i)));
    out.set(previous.subarray(0, Math.min(N_H, length - offset)), offset);
    offset += N_H;
  }
  return out;
}

function labeledExtract(suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Promise<Bytes> {
  return extract(salt, concat(HPKE_V1, suite, utf8(label), ikm));
}

function labeledExpand(suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number): Promise<Bytes> {
  return expand(prk, concat(i2osp(length, 2), HPKE_V1, suite, utf8(label), info), length);
}

// ---- X25519 ----

// PKCS #8 wrapping of a raw X25519 private key (RFC 8410): WebCrypto imports private keys only as PKCS #8 or JWK.
const X25519_PKCS8_PREFIX = Uint8Array.of(
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
);

export interface X25519KeyPair {
  /** The 32-byte private scalar. Callers keep it secret. */
  privateKey: Bytes;
  publicKey: Bytes;
}

async function importPrivate(privateKey: Uint8Array, extractable: boolean): Promise<CryptoKey> {
  if (privateKey.length !== 32) throw new TypeError("x25519: private key must be 32 bytes");
  return crypto.subtle.importKey("pkcs8", concat(X25519_PKCS8_PREFIX, privateKey), { name: "X25519" }, extractable, [
    "deriveBits",
  ]);
}

async function importPublic(publicKey: Uint8Array): Promise<CryptoKey> {
  if (publicKey.length !== N_PK) throw new TypeError("x25519: public key must be 32 bytes");
  return crypto.subtle.importKey("raw", own(publicKey), { name: "X25519" }, true, []);
}

/** Generates a fresh X25519 key pair. */
export async function generateX25519(): Promise<X25519KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  if (typeof jwk.d !== "string" || typeof jwk.x !== "string") throw new Error("x25519: export failed");
  return { privateKey: fromB64u(jwk.d), publicKey: fromB64u(jwk.x) };
}

/** The public key for a private scalar (WebCrypto computes it when exporting the key as a JWK). */
export async function x25519PublicKey(privateKey: Uint8Array): Promise<Bytes> {
  const key = await importPrivate(privateKey, true);
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  if (typeof jwk.x !== "string") throw new Error("x25519: export failed");
  return fromB64u(jwk.x);
}

async function dh(privateKey: CryptoKey, publicKey: Uint8Array): Promise<Bytes> {
  const pub = await importPublic(publicKey);
  // The parameter is spelled `public` at run time; some type libraries name it differently, hence the cast.
  const params = { name: "X25519", public: pub } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0];
  const bits = await crypto.subtle.deriveBits(params, privateKey, 256);
  const out = new Uint8Array(bits);
  // RFC 9180 §7.1.4: an all-zero output means a small-order public key; refuse it.
  if (out.every((b) => b === 0)) throw new Error("x25519: invalid public key");
  return out;
}

// ---- DHKEM(X25519, HKDF-SHA256) ----

async function extractAndExpand(dhSecret: Uint8Array, kemContext: Uint8Array): Promise<Bytes> {
  const eaePrk = await labeledExtract(KEM_SUITE, new Uint8Array(0), "eae_prk", dhSecret);
  return labeledExpand(KEM_SUITE, eaePrk, "shared_secret", kemContext, N_SECRET);
}

/** Encap(pkR). `ephemeralPrivateKey` is only for known-answer tests; normally a fresh key is made. */
export async function encap(
  recipientPublicKey: Uint8Array,
  ephemeralPrivateKey?: Uint8Array,
): Promise<{ sharedSecret: Bytes; enc: Bytes }> {
  const ephemeral = ephemeralPrivateKey ?? (await generateX25519()).privateKey;
  const skE = await importPrivate(ephemeral, true);
  const jwk = (await crypto.subtle.exportKey("jwk", skE)) as JsonWebKey;
  if (typeof jwk.x !== "string") throw new Error("x25519: export failed");
  const enc = fromB64u(jwk.x);
  const secret = await dh(skE, recipientPublicKey);
  return { sharedSecret: await extractAndExpand(secret, concat(enc, recipientPublicKey)), enc };
}

export async function decap(enc: Uint8Array, recipient: X25519KeyPair): Promise<Bytes> {
  if (enc.length !== N_PK) throw new TypeError("hpke: enc must be 32 bytes");
  const skR = await importPrivate(recipient.privateKey, false);
  const secret = await dh(skR, enc);
  return extractAndExpand(secret, concat(enc, recipient.publicKey));
}

// ---- Key schedule (base mode) and the single-shot API ----

export interface HpkeContext {
  key: Bytes;
  baseNonce: Bytes;
}

export async function keySchedule(aead: AeadId, sharedSecret: Uint8Array, info: Uint8Array): Promise<HpkeContext> {
  const suite = hpkeSuite(aead);
  const empty = new Uint8Array(0);
  const pskIdHash = await labeledExtract(suite, empty, "psk_id_hash", empty);
  const infoHash = await labeledExtract(suite, empty, "info_hash", info);
  const context = concat(Uint8Array.of(MODE_BASE), pskIdHash, infoHash);
  const secret = await labeledExtract(suite, sharedSecret, "secret", empty);
  return {
    key: await labeledExpand(suite, secret, "key", context, keyLength(aead)),
    baseNonce: await labeledExpand(suite, secret, "base_nonce", context, N_N),
  };
}

/** The nonce for message `seq` of a context (RFC 9180 §5.2). */
export function nonceFor(ctx: HpkeContext, seq: number): Bytes {
  const nonce = own(ctx.baseNonce);
  const seqBytes = i2osp(seq, N_N);
  for (let i = 0; i < N_N; i++) nonce[i]! ^= seqBytes[i]!;
  return nonce;
}

export async function aeadSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", own(key), { name: "AES-GCM" }, false, ["encrypt"]);
  return new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: own(nonce), additionalData: own(aad), tagLength: 128 }, k, own(plaintext)),
  );
}

export async function aeadOpen(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", own(key), { name: "AES-GCM" }, false, ["decrypt"]);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: own(nonce), additionalData: own(aad), tagLength: 128 }, k, own(ciphertext)),
  );
}

/** SealBase, single shot (sequence number 0). */
export async function sealBase(
  aead: AeadId,
  recipientPublicKey: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<{ enc: Bytes; ciphertext: Bytes }> {
  const { sharedSecret, enc } = await encap(recipientPublicKey);
  const ctx = await keySchedule(aead, sharedSecret, info);
  return { enc, ciphertext: await aeadSeal(ctx.key, nonceFor(ctx, 0), aad, plaintext) };
}

/** OpenBase, single shot (sequence number 0). Throws when the ciphertext does not authenticate. */
export async function openBase(
  aead: AeadId,
  recipient: X25519KeyPair,
  enc: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Bytes> {
  const sharedSecret = await decap(enc, recipient);
  const ctx = await keySchedule(aead, sharedSecret, info);
  return aeadOpen(ctx.key, nonceFor(ctx, 0), aad, ciphertext);
}
