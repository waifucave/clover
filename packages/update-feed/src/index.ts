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

/** The daemon's own release targets (scripts/build-daemon.ts's): a server's daemon updates itself from these. */
export const CORE_TARGETS = ["darwin-arm64", "linux-x64", "linux-arm64", "windows-x64"] as const;
export type CoreTarget = (typeof CORE_TARGETS)[number];
export type FeedChannel = "latest" | "beta";

/** The daemon's update file for `target` on `channel` (`latest-core-linux-x64.yml`). */
export function coreFeedFile(channel: FeedChannel, target: CoreTarget): string {
  return `${channel}-core-${target}.yml`;
}

/** The daemon's binary in a release (`clover-core-1.2.3-linux-x64`, `…-windows-x64.exe`). */
export function coreBinaryFile(version: string, target: CoreTarget): string {
  return `clover-core-${version}-${target}${target === "windows-x64" ? ".exe" : ""}`;
}

/** Plain Bun for plugins' update file for `target` on `channel` (`latest-plugin-bun-linux-x64.yml`): what a server
 *  install fetches beside its daemon, and again when the daemon's Bun version changes. */
export function pluginBunFeedFile(channel: FeedChannel, target: CoreTarget): string {
  return `${channel}-plugin-bun-${target}.yml`;
}

/** Plain Bun for plugins in a release (`clover-plugin-bun-1.4.4-linux-x64`, `…-windows-x64.exe`): named by its Bun
 *  version, the daemon's. */
export function pluginBunBinaryFile(bunVersion: string, target: CoreTarget): string {
  return `clover-plugin-bun-${bunVersion}-${target}${target === "windows-x64" ? ".exe" : ""}`;
}

/**
 * The names a signature may cover: the app's update files (a channel and an OS, scripts/release/lib.ts's `feedFile`),
 * the daemon's (`coreFeedFile`) and plugin Bun's (`pluginBunFeedFile`), and those binaries themselves
 * (`coreBinaryFile`, `pluginBunBinaryFile`), which a server checks before it trusts their bytes.
 */
export const FEED_NAME = /^(?:(latest|beta)(-mac|-linux|-linux-arm64|-(?:core|plugin-bun)-(?:darwin-arm64|linux-x64|linux-arm64|windows-x64))?\.yml|clover-(?:core|plugin-bun)-\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?-(?:darwin-arm64|linux-x64|linux-arm64|windows-x64\.exe))$/;

/** The daemon's update file (`coreFeedFile`): one binary, its version, SHA-512 (base64) and size. */
export interface CoreFeed {
  version: string;
  file: string;
  sha512: string;
  size: number;
}

export function formatCoreFeed(f: CoreFeed): string {
  return `version: ${f.version}\nfile: ${f.file}\nsha512: ${f.sha512}\nsize: ${f.size}\n`;
}

/** A daemon's update file, read strictly: exactly its four fields, each well formed; anything else throws. */
export function parseCoreFeed(text: string): CoreFeed {
  return parseBinaryFeed(text, "clover-core-", "daemon");
}

/** Plain Bun's update file (`pluginBunFeedFile`): the same four fields, `version` being Bun's. */
export function parsePluginBunFeed(text: string): CoreFeed {
  return parseBinaryFeed(text, "clover-plugin-bun-", "plugin Bun");
}

function parseBinaryFeed(text: string, prefix: string, what: string): CoreFeed {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const m = /^(version|file|sha512|size): (\S+)$/.exec(line);
    if (!m || fields.has(m[1]!)) throw new Error(`not a ${what} update file`);
    fields.set(m[1]!, m[2]!);
  }
  const version = fields.get("version"), file = fields.get("file"), sha512 = fields.get("sha512"), size = Number(fields.get("size"));
  if (version === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new Error(`a ${what} update file needs a version`);
  if (file === undefined || !FEED_NAME.test(file) || !file.startsWith(prefix)) throw new Error(`a ${what} update file names a ${prefix.slice(0, -1)} binary`);
  if (sha512 === undefined || Buffer.from(sha512, "base64").length !== 64) throw new Error(`a ${what} update file needs a sha512`);
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`a ${what} update file needs a size`);
  return { version, file, sha512, size };
}

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
