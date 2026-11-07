// The update feed's signature (spec §3.1: the app and a server's daemon update only from a feed they can check).
// Each update file a release holds (`latest-mac.yml`, `beta.yml`, …, scripts/release/lib.ts) has an Ed25519
// signature over its exact bytes in a `.sig` file beside it (base64), made at the owner's release step with the key
// in their login Keychain. The app's updater and the daemon's self-update check it before they read anything in the
// file, so a sha512 in it is trusted only once the file is: that covers the Linux AppImage, which has no OS signature
// check, and a release account someone else got into.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { UPDATE_FEED_PUBLIC_KEY } from "./key";

export { UPDATE_FEED_PUBLIC_KEY };

/** The signature's file: the update file's name with this after it. */
export const SIGNATURE_SUFFIX = ".sig";

/** Ed25519's SubjectPublicKeyInfo header, before the 32 raw bytes. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function publicKeyFromRaw(rawBase64: string): KeyObject {
  const raw = Buffer.from(rawBase64, "base64");
  if (raw.length !== 32 || raw.toString("base64") !== rawBase64) throw new Error("an update feed key is 32 bytes in base64");
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function rawPublicKey(key: KeyObject): string {
  const der = key.export({ format: "der", type: "spki" });
  if (der.length !== 44 || !der.subarray(0, 12).equals(SPKI_PREFIX)) throw new Error("not an Ed25519 public key");
  return der.subarray(12).toString("base64");
}

/** A new key pair: the private half as PKCS#8 DER in base64 (for the Keychain alone), the public half raw. */
export function generateFeedKey(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), publicKey: rawPublicKey(pair.publicKey) };
}

/** The signature for an update file's exact bytes, as its `.sig` file holds it. */
export function signFeed(bytes: Uint8Array, privateKeyPkcs8: string): string {
  return sign(null, bytes, { key: Buffer.from(privateKeyPkcs8, "base64"), format: "der", type: "pkcs8" }).toString("base64");
}

/** The public half of a private key (the release step checks it matches the embedded one before signing). */
export function publicKeyOf(privateKeyPkcs8: string): string {
  return rawPublicKey(createPublicKey(createPrivateKey({ key: Buffer.from(privateKeyPkcs8, "base64"), format: "der", type: "pkcs8" })));
}

export type FeedVerdict = { ok: true } | { ok: false; reason: "no key" | "no signature" | "malformed signature" | "bad signature" };

/**
 * Whether `bytes`, an update file as downloaded, carries a good signature (`signature` is its `.sig` file's text).
 * An updater refuses the file on anything but `ok`, before reading it. `publicKey` is the embedded one but in tests.
 */
export function verifyFeed(bytes: Uint8Array, signature: string | undefined, publicKey: string | null = UPDATE_FEED_PUBLIC_KEY): FeedVerdict {
  if (publicKey === null) return { ok: false, reason: "no key" };
  if (signature === undefined || signature.trim() === "") return { ok: false, reason: "no signature" };
  const sig = Buffer.from(signature.trim(), "base64");
  if (sig.length !== 64 || sig.toString("base64") !== signature.trim()) return { ok: false, reason: "malformed signature" };
  return verify(null, bytes, publicKeyFromRaw(publicKey), sig) ? { ok: true } : { ok: false, reason: "bad signature" };
}
