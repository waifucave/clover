// The update feed's signature (spec §3.1: the app and a server's daemon update only from a feed they can check).
// Each update file a release holds (`latest-mac.yml`, `beta.yml`, …, scripts/release/lib.ts) has an Ed25519
// signature in a `.sig` file beside it (base64), made at the owner's release step with the key in their login
// Keychain. What is signed is the file's name with its bytes (`signedMessage`): a beta file can't be put up under
// the latest name, nor one OS's under another's. The app's updater and the daemon's self-update check it before they read anything in the
// file, so a sha512 in it is trusted only once the file is: that covers the Linux AppImage, which has no OS signature
// check, and a release account someone else got into.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
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

/** The update file names a signature may cover: a channel and an OS (scripts/release/lib.ts's `feedFile`). */
const FEED_NAME = /^(latest|beta)(-mac|-linux|-linux-arm64)?\.yml$/;

/**
 * What is signed for an update file: a fixed label, its file name and the SHA-512 of its bytes, each ended by a
 * zero byte (`clover-update-feed-v1\0latest-mac.yml\0<hex>\0`), so the signature holds only for that file under
 * that name.
 */
export function signedMessage(name: string, bytes: Uint8Array): Buffer {
  if (!FEED_NAME.test(name)) throw new Error(`${name} is not an update file's name`);
  return Buffer.from(`clover-update-feed-v1\0${name}\0${createHash("sha512").update(bytes).digest("hex")}\0`, "utf8");
}

/** The signature for the update file `name` with these bytes, as its `.sig` file holds it. */
export function signFeed(name: string, bytes: Uint8Array, privateKeyPkcs8: string): string {
  return sign(null, signedMessage(name, bytes), { key: Buffer.from(privateKeyPkcs8, "base64"), format: "der", type: "pkcs8" }).toString("base64");
}

/** The public half of a private key (the release step checks it matches the embedded one before signing). */
export function publicKeyOf(privateKeyPkcs8: string): string {
  return rawPublicKey(createPublicKey(createPrivateKey({ key: Buffer.from(privateKeyPkcs8, "base64"), format: "der", type: "pkcs8" })));
}

export type FeedVerdict = { ok: true } | { ok: false; reason: "no key" | "bad key" | "bad name" | "no signature" | "malformed signature" | "bad signature" };

/**
 * Whether `bytes`, the update file `name` as downloaded (the name the updater asked for), carries a good signature
 * (`signature` is its `.sig` file's text). An updater refuses the file on anything but `ok`, before reading it.
 * `publicKey` is the embedded one but in tests. Never throws.
 */
export function verifyFeed(name: string, bytes: Uint8Array, signature: string | undefined, publicKey: string | null = UPDATE_FEED_PUBLIC_KEY): FeedVerdict {
  if (publicKey === null) return { ok: false, reason: "no key" };
  let key: KeyObject;
  try {
    key = publicKeyFromRaw(publicKey);
  } catch {
    return { ok: false, reason: "bad key" };
  }
  if (!FEED_NAME.test(name)) return { ok: false, reason: "bad name" };
  if (signature === undefined || signature.trim() === "") return { ok: false, reason: "no signature" };
  const sig = Buffer.from(signature.trim(), "base64");
  if (sig.length !== 64 || sig.toString("base64") !== signature.trim()) return { ok: false, reason: "malformed signature" };
  try {
    return verify(null, signedMessage(name, bytes), key, sig) ? { ok: true } : { ok: false, reason: "bad signature" };
  } catch {
    return { ok: false, reason: "bad signature" };
  }
}
