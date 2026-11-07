// The bundled plugins on a server install (#244, the controller's ruling (a) and the per-target tarball ruling): a
// server's daemon lives at `<home>/bin/daemon/clover-core` and its bundled plugins at `<home>/bin/plugins`, the folder
// core's `bundledPluginsDir` finds beside it. Each core embeds the manifest of the plugins it was built with
// (packages/core/src/bundled-plugins-dir.ts), and the registry trusts a bundled file only when its bytes are that
// manifest's; this module only makes the folder hold that tree, so the plugins are there to be trusted.
//
// The tree comes from the release, as the daemon itself and plain Bun do, checked in the same order and stopping at
// the first thing that fails:
//   1. the update file (`<channel>-plugins-<target>.yml`) and its signature, before a byte of it is read; it must name
//      exactly `clover-plugins-<version>-<target>.tar.gz` for the core's own version
//   2. the tarball: its signature, then its SHA-512 and size against the update file (at most its signed size read)
//   3. unpacked in memory (packages/update-feed's strict `unpackTarball`: regular files, plain paths), measured, and the
//      measured manifest's text must hash to the one the core carries
// Then it is written to `<home>/bin/plugins.new`, measured again from disk, and swapped in atomically: the old folder
// becomes `plugins.old`, `.new` takes its name, and a failure puts the old one back. At a self-update (self-update.ts)
// the new version's tree is staged the same way against the NEW core's manifest and swapped with the binary.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatBundledManifest, measureBundledTree, type BundledManifest } from "@waifucave/clover-core";
import {
  parsePluginsFeed, pluginsFeedFile, pluginsTarballFile, SIGNATURE_SUFFIX, unpackTarball, verifyFeed, type CoreFeed, type CoreTarget, type FeedChannel,
} from "@waifucave/clover-update-feed";
import { httpFetch, MAX_FEED_BYTES, UPDATE_REPO, type Fetcher } from "./self-update";

/** Where a server install keeps its bundled plugins: `<home>/bin/plugins`, beside `<home>/bin/daemon/`. */
export function serverPluginsDir(home: string): string {
  return join(home, "bin", "plugins");
}

/** The SHA-256 (hex) of a manifest's one text form: what a core's `__bundled-manifest` prints and a tree must match. */
export function manifestSha256(m: BundledManifest): string {
  return createHash("sha256").update(formatBundledManifest(m)).digest("hex");
}

/** The SHA-256 of the manifest the tree at `dir` measures to, or undefined when there is no tree or it can't be
 *  measured (a symlink, a file that can't ship). */
export function treeManifestSha256(dir: string): string | undefined {
  try {
    return existsSync(dir) ? manifestSha256(measureBundledTree(dir)) : undefined;
  } catch {
    return undefined;
  }
}

export interface PluginsDeps {
  /** `<home>/bin/plugins` (`serverPluginsDir`). */
  dir: string;
  /** The core's version: the release whose tarball it takes. */
  version: string;
  /** The SHA-256 of the manifest text the core carries; undefined when it carries none (nothing can be installed). */
  manifestSha256: string | undefined;
  target: CoreTarget;
  channel: FeedChannel;
  publicKey?: string | null;
  repo?: string;
  fetch?: Fetcher;
  log(line: string): void;
}

export type PluginsResult =
  | { kind: "in place" }
  | { kind: "installed"; version: string; files: number }
  | { kind: "refused"; why: string };

interface ReleaseAsset { name: string; browser_download_url: string }
interface Release { draft: boolean; prerelease: boolean; assets: ReleaseAsset[] }

/**
 * Fetches, checks and writes the core's bundled plugins to `<dir>.new`, measured from disk to the manifest the core
 * carries: the files written (`.new` is ready for `swapPluginsIn`), or why not. Never throws.
 */
export async function stageServerPlugins(d: PluginsDeps): Promise<{ files: number } | { why: string }> {
  try {
    if (d.manifestSha256 === undefined) return { why: "this core carries no bundled-plugins manifest" };
    const get = (url: string, maxBytes: number, accept?: string) => (d.fetch ?? httpFetch)(url, { maxBytes, ...(accept ? { accept } : {}) });
    const verify = (name: string, bytes: Uint8Array, sig: Uint8Array | undefined) => {
      const text = sig === undefined ? undefined : new TextDecoder().decode(sig);
      return d.publicKey === undefined ? verifyFeed(name, bytes, text) : verifyFeed(name, bytes, text, d.publicKey);
    };
    const feedName = pluginsFeedFile(d.channel, d.target);
    const tarName = pluginsTarballFile(d.version, d.target);
    const body = await get(`https://api.github.com/repos/${d.repo ?? UPDATE_REPO}/releases?per_page=30`, 4 * 1024 * 1024, "application/vnd.github+json");
    let releases: unknown;
    try {
      releases = body === undefined ? undefined : JSON.parse(new TextDecoder().decode(body));
    } catch {
      releases = undefined;
    }
    if (!Array.isArray(releases)) return { why: "the releases could not be read" };
    // The release this channel allows that carries this version's tarball for this target.
    const release = (releases as Release[]).find((r) => r && !r.draft && (d.channel === "beta" || !r.prerelease) && Array.isArray(r.assets) && r.assets.some((a) => a?.name === feedName) && r.assets.some((a) => a?.name === tarName));
    if (release === undefined) return { why: `no release carries ${tarName}` };
    const asset = (name: string) => release.assets.find((a) => a.name === name)?.browser_download_url;
    // 1. The update file's signature, before a byte of it is read.
    const feedBytes = await get(asset(feedName)!, MAX_FEED_BYTES);
    if (feedBytes === undefined) return { why: `${feedName} could not be read (or is over ${MAX_FEED_BYTES} bytes)` };
    const feedSig = asset(`${feedName}${SIGNATURE_SUFFIX}`);
    const feedVerdict = verify(feedName, feedBytes, feedSig === undefined ? undefined : await get(feedSig, MAX_FEED_BYTES));
    if (!feedVerdict.ok) return { why: `${feedName}: ${feedVerdict.reason}` };
    let feed: CoreFeed;
    try {
      feed = parsePluginsFeed(new TextDecoder().decode(feedBytes));
    } catch (err) {
      return { why: `${feedName}: ${(err as Error).message}` };
    }
    if (feed.version !== d.version || feed.file !== tarName) return { why: `${feedName} names ${feed.file}, not ${tarName}` };
    // 2. The tarball: its signature, then its SHA-512 and size; at most its signed size is read.
    const tarUrl = asset(tarName);
    const bytes = tarUrl === undefined ? undefined : await get(tarUrl, feed.size);
    if (bytes === undefined) return { why: `${tarName} could not be read (or is over its ${feed.size} bytes)` };
    const tarSig = asset(`${tarName}${SIGNATURE_SUFFIX}`);
    const tarVerdict = verify(tarName, bytes, tarSig === undefined ? undefined : await get(tarSig, MAX_FEED_BYTES));
    if (!tarVerdict.ok) return { why: `${tarName}: ${tarVerdict.reason}` };
    if (createHash("sha512").update(bytes).digest("base64") !== feed.sha512 || bytes.length !== feed.size) return { why: `${tarName}'s sha512 or size doesn't match ${feedName}` };
    // 3. Unpacked in memory and measured: exactly the tree the core's manifest names.
    let files: ReturnType<typeof unpackTarball>;
    try {
      files = unpackTarball(bytes);
    } catch (err) {
      return { why: `${tarName}: ${(err as Error).message}` };
    }
    const measured: Record<string, { sha256: string; size: number }> = {};
    for (const f of files) measured[f.path] = { sha256: createHash("sha256").update(f.bytes).digest("hex"), size: f.bytes.length };
    if (manifestSha256({ files: measured }) !== d.manifestSha256) return { why: `${tarName} isn't the tree this core's manifest names` };
    // Written beside the folder, then measured again from what is on disk.
    const staged = `${d.dir}.new`;
    rmSync(staged, { recursive: true, force: true });
    for (const f of files) {
      const path = join(staged, ...f.path.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, f.bytes, { flag: "wx", mode: f.executable ? 0o755 : 0o644 });
      if (process.platform !== "win32") chmodSync(path, f.executable ? 0o755 : 0o644);
    }
    if (treeManifestSha256(staged) !== d.manifestSha256) {
      rmSync(staged, { recursive: true, force: true });
      return { why: `${staged} doesn't measure to the core's manifest once written` };
    }
    return { files: files.length };
  } catch (err) {
    try { rmSync(`${d.dir}.new`, { recursive: true, force: true }); } catch { /* best effort */ }
    return { why: err instanceof Error ? err.message : String(err) };
  }
}

/** `<dir>.new` takes `dir`'s place; the previous folder becomes `<dir>.old` (kept for a rollback when `keepOld`, else
 *  removed). A failed rename puts the previous folder back and throws. */
export function swapPluginsIn(dir: string, keepOld: boolean): void {
  const staged = `${dir}.new`, old = `${dir}.old`;
  rmSync(old, { recursive: true, force: true });
  const had = existsSync(dir);
  if (had) renameSync(dir, old);
  try {
    renameSync(staged, dir);
  } catch (err) {
    if (had) renameSync(old, dir);
    throw err;
  }
  if (!keepOld) rmSync(old, { recursive: true, force: true });
}

/** Puts the core's bundled plugins in `d.dir` unless they are there already (the tree measures to its manifest). */
export async function ensureServerPlugins(d: PluginsDeps): Promise<PluginsResult> {
  if (d.manifestSha256 !== undefined && treeManifestSha256(d.dir) === d.manifestSha256) return { kind: "in place" };
  const staged = await stageServerPlugins(d);
  if ("why" in staged) return { kind: "refused", why: staged.why };
  try {
    swapPluginsIn(d.dir, false);
  } catch (err) {
    rmSync(`${d.dir}.new`, { recursive: true, force: true });
    return { kind: "refused", why: `the swap failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  d.log(`bundled plugins ${d.version} are in place at ${d.dir} (${staged.files} files)`);
  return { kind: "installed", version: d.version, files: staged.files };
}
