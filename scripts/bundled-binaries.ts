// The binaries that ship beside `clover-core` in resources/daemon/ and run code that is not the core's own, each
// signed under its OWN identifier and named in no Keychain ACL (the core's items trust `clover-core` alone, so
// nothing that runs bot or plugin code may share its identity):
//
//   clover-plugin-bun       plain Bun at the core's exact Bun version (`.bun-version`), for plugin code. Lane B's
//                           `pluginBun()` resolves it beside the compiled core and fails closed without it. Every OS.
//   clover-process-holder   lane A's F8 holder (macOS only): a small C `posix_spawn` with the disclaim attribute and
//                           POSIX_SPAWN_SETEXEC, the responsible process of everything a bot's command starts, so the
//                           pause can find what the command left running. Built from the installed agent runtime's
//                           `native/process-holder.c`, so it always matches the runtime that drives it.
//
// `scripts/build-daemon.ts` puts both in dist/daemon/<target>/ beside the core; the release build, the Linux
// packages and the dev daemon take them from there (the dev daemon signs its own copies). `bundledBinaryProblems`
// is the package gate: a packaged build never ships without them, never with one signed as the core, and never falls
// back silently (to process-group tracking, for the holder).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { DaemonTarget } from "./build-daemon";

/** The Bun that `clover-plugin-bun` is: the release asset per target and its SHA-256, pinned here (not trusted from
 *  the release's own SHASUMS256.txt). `bundled-binaries.test.ts` holds `version` to `.bun-version`, so a Bun bump
 *  must re-pin these. The assets are the same builds the core compiles from (`bun-<os>-<arch>`, not `-baseline`). */
export const PLUGIN_BUN = {
  version: "1.4.4",
  assets: {
    "darwin-arm64": { asset: "bun-darwin-aarch64", sha256: "c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510" },
    "linux-x64": { asset: "bun-linux-x64", sha256: "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c" },
    "linux-arm64": { asset: "bun-linux-aarch64", sha256: "baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e" },
    "windows-x64": { asset: "bun-windows-x64", sha256: "cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5" },
  } satisfies Record<DaemonTarget, { asset: string; sha256: string }>,
} as const;

export const PLUGIN_BUN_FILE = "clover-plugin-bun";
export const HOLDER_FILE = "clover-process-holder";

/** The identifiers each is signed under: a release's, and the dev daemon's (`.dev`). Never the core's. Lane B's
 *  `packages/core/src/bundled-identities.ts` (#234) holds the same values for `pluginBun()`'s requirement check; once it
 *  lands these come from there, one source for the signer and the checker. */
export const BUNDLED_IDENTIFIERS = {
  [PLUGIN_BUN_FILE]: { dist: "com.waifucave.clover.plugin-bun", dev: "com.waifucave.clover.plugin-bun.dev" },
  [HOLDER_FILE]: { dist: "com.waifucave.clover.process-holder", dev: "com.waifucave.clover.process-holder.dev" },
} as const;

/** The core's own identifiers, which none of these may carry. */
export const CORE_IDENTIFIERS = ["com.waifucave.clover.core", "com.waifucave.clover.core.dev"] as const;

/** Plain Bun runs plugin code: JIT, bun:ffi and native addons (another team's code). Nothing else. */
export const PLUGIN_BUN_ENTITLEMENTS = "scripts/clover-plugin-bun.entitlements";

/** The files beside the core a target ships (its file names, `.exe` on Windows). */
export function bundledFiles(target: DaemonTarget): string[] {
  const exe = target.startsWith("windows-") ? ".exe" : "";
  return [`${PLUGIN_BUN_FILE}${exe}`, ...(target === "darwin-arm64" ? [HOLDER_FILE] : [])];
}

/** The holder's source in the installed agent runtime (`@waifucave/clover-agent-runtime/native/process-holder.c`,
 *  SDK 0.0.70 and later), or undefined when this install's runtime has none. */
export function holderSource(root: string): string | undefined {
  try {
    const pkg = Bun.resolveSync("@waifucave/clover-agent-runtime/package.json", join(root, "packages", "core"));
    const src = join(dirname(pkg), "native", "process-holder.c");
    return existsSync(src) ? src : undefined;
  } catch {
    return undefined;
  }
}

/** Lane A's build line (darwin-arm64): libSystem only, no frameworks. */
export function holderCompileArgs(source: string, out: string): string[] {
  return ["clang", "-O2", "-Wall", "-Wextra", "-mmacosx-version-min=26.0", "-arch", "arm64", "-o", out, source];
}

/** Builds the holder into `out` and signs it ad hoc under its own identifier (a release or the dev daemon signs it
 *  for real). macOS only. */
export function buildHolder(root: string, out: string): void {
  const source = holderSource(root);
  if (source === undefined) throw new Error(`the installed agent runtime has no native/process-holder.c (it ships from SDK 0.0.70): ${HOLDER_FILE} can't be built`);
  mkdirSync(dirname(out), { recursive: true });
  const cc = spawnSync(holderCompileArgs(source, out)[0]!, holderCompileArgs(source, out).slice(1), { encoding: "utf8" });
  if (cc.status !== 0) throw new Error(`clang failed building ${HOLDER_FILE}: ${(cc.stderr ?? "").trim().slice(0, 600)}`);
  const sign = spawnSync("codesign", ["--force", "--sign", "-", "--identifier", BUNDLED_IDENTIFIERS[HOLDER_FILE].dist, "--options", "runtime", out], { encoding: "utf8" });
  if (sign.status !== 0) throw new Error(`codesign (ad hoc) of ${HOLDER_FILE} failed: ${sign.stderr.trim()}`);
}

function bunCache(): string {
  if (process.env.CLOVER_BUN_CACHE) return process.env.CLOVER_BUN_CACHE;
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "clover-bun");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "clover-bun");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "clover-bun");
}

export type Fetcher = (url: string) => Promise<Uint8Array>;
const httpFetch: Fetcher = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

/**
 * The pinned Bun release zip for `target`, from the cache or the release: its BYTES, the ones checked against the
 * pinned SHA-256 (read once; never the file again, which a same-user process could swap after the check).
 */
export async function pluginBunZip(target: DaemonTarget, fetcher: Fetcher = httpFetch, cache: string = bunCache()): Promise<Uint8Array> {
  const { asset, sha256 } = PLUGIN_BUN.assets[target];
  const zip = join(cache, PLUGIN_BUN.version, "zips", `${asset}.zip`);
  const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  if (existsSync(zip)) {
    const cached = new Uint8Array(readFileSync(zip));
    if (digest(cached) === sha256) return cached;
  }
  const base = process.env.CLOVER_BUN_RELEASES ?? "https://github.com/oven-sh/bun/releases/download";
  const bytes = await fetcher(`${base}/bun-v${PLUGIN_BUN.version}/${asset}.zip`);
  const got = digest(bytes);
  if (got !== sha256) throw new Error(`${asset}.zip has SHA-256 ${got}, but scripts/bundled-binaries.ts pins ${sha256}: nothing staged`);
  mkdirSync(dirname(zip), { recursive: true });
  const tmp = `${zip}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, zip);
  return bytes;
}

/**
 * One file of a zip, read in-process (no `tar` or `unzip`: Git Bash's GNU tar, first on a Windows runner's PATH, reads
 * `C:\…` as a remote `host:path`). Stored or deflated entries, each checked against its size and CRC-32; undefined when
 * the zip has no entry by that name. Refuses what it can't read whole: zip64, an encrypted entry, another method.
 */
export function zipEntry(zip: Uint8Array, name: string): Uint8Array | undefined {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = (o: number) => v.getUint16(o, true);
  const u32 = (o: number) => v.getUint32(o, true);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (u32(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no end-of-central-directory record)");
  const count = u16(eocd + 10), cdOffset = u32(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("a zip64 archive, which this reader doesn't take");
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || u32(p) !== 0x02014b50) throw new Error("a zip whose central directory doesn't read");
    const flags = u16(p + 8), method = u16(p + 10), crc = u32(p + 16), csize = u32(p + 20), usize = u32(p + 24);
    const nameLen = u16(p + 28), extraLen = u16(p + 30), commentLen = u16(p + 32), local = u32(p + 42);
    const entry = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (entry !== name) continue;
    if (flags & 1) throw new Error(`${name} is encrypted`);
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new Error(`${name} is a zip64 entry, which this reader doesn't take`);
    if (u32(local) !== 0x04034b50) throw new Error(`${name}'s local header doesn't read`);
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    const data = zip.subarray(start, start + csize);
    if (data.length !== csize) throw new Error(`${name} is cut short`);
    let bytes: Uint8Array | undefined;
    if (method === 0) bytes = data;
    else if (method === 8) {
      // Never more than the entry says it holds: a deflate stream that inflates past it is refused, not allocated.
      try {
        bytes = new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(1, usize) }));
      } catch {
        throw new Error(`${name} doesn't inflate to its stated size (${usize} bytes)`);
      }
    }
    if (bytes === undefined) throw new Error(`${name} is compressed with method ${method}, which this reader doesn't take`);
    if (bytes.length !== usize || (Bun.hash.crc32(bytes) >>> 0) !== crc) throw new Error(`${name} doesn't match its size and CRC-32`);
    return bytes;
  }
  return undefined;
}

/** Writes plain Bun for `target` from its release zip's checked bytes (pluginBunZip) to `out`, unpacked in-process. */
export function unpackPluginBun(zip: Uint8Array, target: DaemonTarget, out: string): void {
  const { asset } = PLUGIN_BUN.assets[target];
  const inside = `${asset}/${target.startsWith("windows-") ? "bun.exe" : "bun"}`;
  let bytes: Uint8Array | undefined;
  try {
    bytes = zipEntry(zip, inside);
  } catch (e) {
    throw new Error(`could not unpack ${asset}.zip: ${(e as Error).message}`);
  }
  if (bytes === undefined) throw new Error(`${asset}.zip holds no ${inside}`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  chmodSync(out, 0o755);
}

/** Stages plain Bun for `target` at `out` (`clover-plugin-bun`, `.exe` on Windows). */
export async function stagePluginBun(target: DaemonTarget, out: string, fetcher?: Fetcher): Promise<void> {
  unpackPluginBun(await pluginBunZip(target, fetcher), target, out);
  // Oven's signature names Bun; ours names clover-plugin-bun (ad hoc here; a release or the dev daemon signs it for real).
  if (target === "darwin-arm64" && process.platform === "darwin") {
    const entitlements = join(dirname(import.meta.dir), PLUGIN_BUN_ENTITLEMENTS);
    const sign = spawnSync("codesign", ["--force", "--sign", "-", "--identifier", BUNDLED_IDENTIFIERS[PLUGIN_BUN_FILE].dist, "--options", "runtime", "--entitlements", entitlements, out], { encoding: "utf8" });
    if (sign.status !== 0) throw new Error(`codesign (ad hoc) of ${PLUGIN_BUN_FILE} failed: ${sign.stderr.trim()}`);
  }
}

/** `codesign -dv`'s Identifier, or undefined (not signed, or not macOS). */
export function signedIdentifier(path: string): string | undefined {
  const r = spawnSync("codesign", ["-dv", path], { encoding: "utf8" });
  return /^Identifier=(.+)$/m.exec(r.stderr ?? "")?.[1]?.trim();
}

/**
 * The package gate over a folder that holds the core (resources/daemon/, a staging folder, dist/daemon/<target>/):
 * every bundled binary is there and executable, and on macOS each is signed under its own identifier — `kind`'s, or
 * at least never the core's.
 */
export function bundledBinaryProblems(dir: string, target: DaemonTarget, opts: { kind?: "dist" | "dev"; identifierOf?: (path: string) => string | undefined } = {}): string[] {
  const problems: string[] = [];
  const identifierOf = opts.identifierOf ?? signedIdentifier;
  for (const file of bundledFiles(target)) {
    const path = join(dir, file);
    if (!existsSync(path)) {
      problems.push(`${file} is missing from ${dir}${file === HOLDER_FILE ? " (a bot's commands would fall back to process-group tracking)" : " (plugins could not run)"}`);
      continue;
    }
    if (target === "darwin-arm64") {
      const id = identifierOf(path);
      const name = file.replace(/\.exe$/, "") as keyof typeof BUNDLED_IDENTIFIERS;
      const want = opts.kind === undefined ? undefined : BUNDLED_IDENTIFIERS[name][opts.kind];
      if (id === undefined) problems.push(`${file} is not signed`);
      else if ((CORE_IDENTIFIERS as readonly string[]).includes(id)) problems.push(`${file} is signed as the core (${id}): the Keychain items would trust it`);
      else if (want !== undefined && id !== want) problems.push(`${file} is signed as ${id}, not ${want}`);
    }
  }
  return problems;
}
