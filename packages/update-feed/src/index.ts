// The update feed's signature (spec §3.1: the app and a server's daemon update only from a feed they can check).
// Each update file a release holds (`latest-mac.yml`, `beta.yml`, …, scripts/release/lib.ts) has an Ed25519
// signature in a `.sig` file beside it (base64), made at the owner's release step with the key in their login
// Keychain. What is signed is the file's name with its bytes (`signedMessage`): a beta file can't be put up under
// the latest name, nor one OS's under another's. The app's updater and the daemon's self-update check it before they read anything in the
// file, so a sha512 in it is trusted only once the file is: that covers the Linux AppImage, which has no OS signature
// check, and a release account someone else got into.
import { gunzipSync, gzipSync } from "node:zlib";
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

/** The bundled plugins' update file for `target` on `channel` (`latest-plugins-linux-x64.yml`): what a server install
 *  fetches into `<home>/bin/plugins`, and again with each update of its daemon (whose core embeds their manifest). */
export function pluginsFeedFile(channel: FeedChannel, target: CoreTarget): string {
  return `${channel}-plugins-${target}.yml`;
}

/** The bundled plugins in a release (`clover-plugins-1.2.3-linux-x64.tar.gz`): the tree that target's core's manifest
 *  names, exactly. */
export function pluginsTarballFile(version: string, target: CoreTarget): string {
  return `clover-plugins-${version}-${target}.tar.gz`;
}

/**
 * The names a signature may cover: the app's update files (a channel and an OS, scripts/release/lib.ts's `feedFile`),
 * the daemon's (`coreFeedFile`), plugin Bun's (`pluginBunFeedFile`) and the bundled plugins' (`pluginsFeedFile`), and
 * the files they name (`coreBinaryFile`, `pluginBunBinaryFile`, `pluginsTarballFile`), which a server checks before
 * it trusts their bytes.
 */
export const FEED_NAME = /^(?:(latest|beta)(-mac|-linux|-linux-arm64|-(?:core|plugin-bun|plugins)-(?:darwin-arm64|linux-x64|linux-arm64|windows-x64))?\.yml|clover-(?:core|plugin-bun)-\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?-(?:darwin-arm64|linux-x64|linux-arm64|windows-x64\.exe)|clover-plugins-\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?-(?:darwin-arm64|linux-x64|linux-arm64|windows-x64)\.tar\.gz)$/;

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

/** The bundled plugins' update file (`pluginsFeedFile`): the same four fields, naming `clover-plugins-…tar.gz`. */
export function parsePluginsFeed(text: string): CoreFeed {
  return parseBinaryFeed(text, "clover-plugins-", "bundled plugins");
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

// ---- the bundled plugins' tarball ----
//
// A plain ustar archive, gzipped, of regular files only: no folder entries (a file's folders are implied), no links,
// no devices, no extended headers. `packTarball` writes it the same way every time (sorted paths, mode 0644 or 0755,
// owner 0, time 0); `unpackTarball` reads it strictly and never touches the disk, so the caller checks every file
// before anything is written.

/** One file of the tarball: its path (relative, with `/`), its bytes, and whether it is executable. */
export interface TarballFile { path: string; bytes: Uint8Array; executable: boolean }

const BLOCK = 512;
/** The most a tarball may unpack to (and the most files it may hold): far above the bundled plugins today. */
export const MAX_TARBALL_BYTES = 512 * 1024 * 1024;
export const MAX_TARBALL_FILES = 100_000;

/** Whether `path` is a plain relative path: `/`-separated, no empty, `.` or `..` segment, no backslash, colon or NUL. */
export function plainRelativePath(path: string): boolean {
  if (path === "" || /[\\:\0]/.test(path)) return false;
  return path.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, "0")}\0`;
}

/** The ustar name and prefix for `path` (name at most 100 bytes, prefix at most 155, split at a `/`). */
function splitName(path: string): { name: Uint8Array; prefix: Uint8Array } {
  const enc = new TextEncoder();
  const whole = enc.encode(path);
  if (whole.length <= 100) return { name: whole, prefix: new Uint8Array() };
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== "/") continue;
    const prefix = enc.encode(path.slice(0, i)), name = enc.encode(path.slice(i + 1));
    if (prefix.length <= 155 && name.length <= 100 && name.length > 0) return { name, prefix };
  }
  throw new Error(`${path} is too long for a ustar header`);
}

/** The gzipped tarball of `files` (sorted by path; each path plain and relative, no duplicates). */
export function packTarball(files: readonly TarballFile[]): Uint8Array {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const parts: Uint8Array[] = [];
  let last: string | undefined;
  for (const f of sorted) {
    if (!plainRelativePath(f.path)) throw new Error(`${JSON.stringify(f.path)} is not a plain relative path`);
    if (f.path === last) throw new Error(`${f.path} is in the tarball twice`);
    last = f.path;
    const header = new Uint8Array(BLOCK);
    const { name, prefix } = splitName(f.path);
    const put = (at: number, text: string) => header.set(new TextEncoder().encode(text), at);
    header.set(name, 0);
    put(100, octal(f.executable ? 0o755 : 0o644, 8));
    put(108, octal(0, 8));
    put(116, octal(0, 8));
    put(124, octal(f.bytes.length, 12));
    put(136, octal(0, 12));
    put(148, "        ");
    put(156, "0");
    put(257, "ustar\0");
    put(263, "00");
    header.set(prefix, 345);
    let sum = 0;
    for (const b of header) sum += b;
    put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
    parts.push(header, f.bytes);
    const pad = (BLOCK - (f.bytes.length % BLOCK)) % BLOCK;
    if (pad > 0) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const tar = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { tar.set(p, at); at += p.length; }
  return new Uint8Array(gzipSync(tar, { level: 9 }));
}

/** A tarball's files, read strictly: gzip, then ustar headers with good checksums, regular files only (type `0`),
 *  plain relative paths, no duplicates, within MAX_TARBALL_BYTES and MAX_TARBALL_FILES. Throws on anything else. */
export function unpackTarball(gz: Uint8Array): TarballFile[] {
  let tar: Uint8Array;
  try {
    tar = new Uint8Array(gunzipSync(gz, { maxOutputLength: MAX_TARBALL_BYTES }));
  } catch (err) {
    throw new Error(`not a gzip stream within ${MAX_TARBALL_BYTES} bytes (${(err as Error).message})`);
  }
  const dec = new TextDecoder("utf-8", { fatal: true });
  const field = (h: Uint8Array, at: number, len: number) => {
    const raw = h.subarray(at, at + len);
    const end = raw.indexOf(0);
    return dec.decode(end === -1 ? raw : raw.subarray(0, end));
  };
  const num = (h: Uint8Array, at: number, len: number) => {
    const text = field(h, at, len).trim();
    if (!/^[0-7]+$/.test(text)) throw new Error("a tar header holds a bad number");
    return parseInt(text, 8);
  };
  const out: TarballFile[] = [];
  const seen = new Set<string>();
  let at = 0;
  for (;;) {
    if (at + BLOCK > tar.length) throw new Error("the tarball ends without its end blocks");
    const h = tar.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (num(h, 148, 8) !== sum) throw new Error("a tar header's checksum is wrong");
    if (field(h, 257, 6) !== "ustar") throw new Error("not a ustar archive");
    const type = String.fromCharCode(h[156]!);
    const prefix = field(h, 345, 155), name = field(h, 0, 100);
    const path = prefix === "" ? name : `${prefix}/${name}`;
    if (type !== "0" && h[156] !== 0) throw new Error(`${path}: only regular files ship (type ${JSON.stringify(type)})`);
    if (!plainRelativePath(path)) throw new Error(`${JSON.stringify(path)} is not a plain relative path`);
    if (seen.has(path)) throw new Error(`${path} is in the tarball twice`);
    seen.add(path);
    if (seen.size > MAX_TARBALL_FILES) throw new Error(`the tarball holds over ${MAX_TARBALL_FILES} files`);
    const size = num(h, 124, 12);
    const mode = num(h, 100, 8);
    if (at + BLOCK + size > tar.length) throw new Error(`${path} runs past the end of the tarball`);
    out.push({ path, bytes: tar.slice(at + BLOCK, at + BLOCK + size), executable: (mode & 0o111) !== 0 });
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}
