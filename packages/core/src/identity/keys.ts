// Ed25519 keys for lane H: the device's link key, a desktop app's answer key, and the per-pair signing keys of devices
// paired without an account. A key is its 32-byte seed; the public key is derived from it, so a seed kept in the OS
// secret store (or handed to the link sidecar over its stdin) is the whole key. Signing uses node:crypto, which Bun
// implements; verifying takes the raw 32-byte public key.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify, type KeyObject } from "node:crypto";
import { ContractError } from "../contracts/common";
import { Secret } from "../contracts/secret-store";
import { type Bytes, fromBase64, own, toBase64 } from "./bytes";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** An Ed25519 key held in memory: it signs, and its seed comes out only wrapped in a `Secret`. */
export interface Ed25519Key {
  readonly publicKey: Bytes;
  sign(data: Uint8Array): Bytes;
  /** The 32-byte seed, base64, for the secret store or the link sidecar's stdin. */
  seed(): Secret;
}

class NodeEd25519Key implements Ed25519Key {
  readonly publicKey: Bytes;
  readonly #private: KeyObject;
  readonly #seed: Bytes;

  constructor(seed: Uint8Array) {
    if (seed.byteLength !== 32) throw new ContractError("invalid", "an Ed25519 seed is 32 bytes");
    this.#seed = own(seed);
    this.#private = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(this.#seed)]), format: "der", type: "pkcs8" });
    const spki = createPublicKey(this.#private).export({ format: "der", type: "spki" }) as Buffer;
    this.publicKey = own(spki.subarray(SPKI_PREFIX.length));
  }

  sign(data: Uint8Array): Bytes {
    return own(nodeSign(null, data, this.#private));
  }

  seed(): Secret {
    return new Secret(toBase64(this.#seed));
  }

  toJSON(): string {
    return "[ed25519 key]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[ed25519 key]";
  }
}

export function generateEd25519(): Ed25519Key {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  return new NodeEd25519Key(pkcs8.subarray(PKCS8_PREFIX.length));
}

export function ed25519FromSeed(seed: Uint8Array): Ed25519Key {
  return new NodeEd25519Key(seed);
}

/** The key whose base64 seed a `Secret` holds; `invalid` for anything that isn't one. */
export function ed25519FromSecret(secret: Secret): Ed25519Key {
  const seed = fromBase64(secret.reveal());
  if (!seed || seed.byteLength !== 32) throw new ContractError("invalid", "the stored key isn't an Ed25519 seed");
  return new NodeEd25519Key(seed);
}

/** Whether `signature` is `publicKey`'s Ed25519 signature over `data`; false for any malformed input. */
export function verifyEd25519(publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.byteLength !== 32 || signature.byteLength !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey)]), format: "der", type: "spki" });
    return nodeVerify(null, data, key, signature);
  } catch {
    return false;
  }
}

/** A raw public key from base64; null unless it is 32 bytes. */
export function publicKeyFromBase64(text: string): Bytes | null {
  const bytes = fromBase64(text);
  return bytes && bytes.byteLength === 32 ? bytes : null;
}

/** An answer key's algorithm (B's #187 `AnswerKeyAlg`; absent means ed25519). */
export type AnswerKeyAlg = "ed25519" | "p256";

/** An answer key's raw public key: 32 bytes for Ed25519, the 65-byte uncompressed point for P-256 (B's #187). */
export function answerKeyBytes(alg: AnswerKeyAlg, text: string): Bytes | null {
  const raw = fromBase64(text);
  if (!raw) return null;
  if (alg === "p256") return raw.length === 65 && raw[0] === 0x04 ? raw : null;
  return raw.length === 32 ? raw : null;
}

/** Checks a signature with the key's own algorithm: Ed25519, or ECDSA P-256 over SHA-256 with a raw `r‖s` signature
 *  (as B's `verifyKeySignature` does; lane H switches to it when #187 lands). False for anything that won't verify. */
export function verifyKeySignature(alg: AnswerKeyAlg, publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean {
  if (alg === "ed25519") return verifyEd25519(publicKey, data, signature);
  if (publicKey.byteLength !== 65 || publicKey[0] !== 0x04 || signature.byteLength !== 64) return false;
  try {
    const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(publicKey.subarray(1, 33)), y: b64u(publicKey.subarray(33, 65)) }, format: "jwk" });
    return nodeVerify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    return false;
  }
}
