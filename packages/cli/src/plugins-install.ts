// The bundled plugins on a server install (#244, the controller's ruling (a) and the per-target tarball ruling): a
// server's daemon lives at `<home>/bin/daemon/clover-core` and its bundled plugins at `<home>/bin/plugins`, the folder
// core's `bundledPluginsDir` finds beside it. Each core embeds the manifest of the plugins it was built with
// (packages/core/src/bundled-plugins-dir.ts), and the registry trusts a bundled file only when its bytes are that
// manifest's; this module only makes the folder hold that tree, so the plugins are there to be trusted.
//
// The tree comes from the release whose tag is the core's version (`releases/tags/v<version>`, its channel checked),
// as the daemon itself and plain Bun do, checked in the same order and stopping at the first thing that fails:
//   1. the update file (`<channel>-plugins-<target>.yml`) and its signature, before a byte of it is read; it must name
//      exactly `clover-plugins-<version>-<target>.tar.gz` for the core's own version
//   2. the tarball: its signature, then its SHA-512 and size against the update file (at most its signed size read)
//   3. unpacked in memory (packages/update-feed's strict `unpackTarball`: regular files, plain portable paths),
//      measured, and the measured manifest's text must hash to the one the core carries
// Then each file is written and flushed, the staging folder measured again from disk and flushed, and swapped in
// whole (durable.ts's steps, so a power cut leaves a whole folder at one of the names below).
//
// Names beside `<home>/bin/plugins`:
//   .new    a self-update's staged tree (self-update.ts), against the NEW core's manifest
//   .old    the tree before a self-update's swap, kept until a good boot (a rollback puts it back); never removed
//           while `<home>/update/boot.json` still watches an update
//   .fetch  the start-time refetch's staging folder (its own name: it never meets a self-update's `.new`)
//   .bad    a folder set aside by a recovery or a rollback
// At each start, before the registry reads anything (`recoverServerPlugins`): a folder that doesn't measure to this
// core's manifest is replaced by `.new` or `.old` when either does, with no download. Only then, and after the daemon
// is up, is the tree fetched (`ensureServerPlugins`), with a back-off on failure (`<home>/update/plugins-fetch.json`).
// Every step that touches the folder runs in one `PluginsLock`, and the self-update starts only after the start-time
// refetch settled; a refetch never swaps once the update gate committed a restart.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatBundledManifest, measureBundledTree, type BundledManifest } from "@waifucave/clover-core";
import {
  parsePluginsFeed, pluginsFeedFile, pluginsTarballFile, SIGNATURE_SUFFIX, unpackTarball, verifyFeed, type CoreFeed, type CoreTarget, type FeedChannel,
} from "@waifucave/clover-update-feed";
import { realOps, syncDir, syncFile, type DurableOps } from "./durable";
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

/** One at a time: every step that touches `<home>/bin/plugins` (the start's recovery and refetch, a self-update's
 *  staging and swap) runs through the daemon's one lock. */
export class PluginsLock {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.#tail.then(fn, fn);
    this.#tail = next.catch(() => {});
    return next;
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
  ops?: DurableOps;
  log(line: string): void;
}

export type PluginsResult =
  | { kind: "in place" }
  | { kind: "recovered"; from: ".new" | ".old" }
  | { kind: "installed"; version: string; files: number }
  | { kind: "refused"; why: string };

interface ReleaseAsset { name: string; browser_download_url: string }
interface Release { tag_name: string; draft: boolean; prerelease: boolean; assets: ReleaseAsset[] }

/**
 * Fetches, checks and writes the core's bundled plugins to `staged` (default `<dir>.new`), each file flushed, then the
 * folder measured from disk to the manifest the core carries and flushed: the files written, or why not. Never throws.
 */
export async function stageServerPlugins(d: PluginsDeps, staged = `${d.dir}.new`): Promise<{ files: number } | { why: string }> {
  try {
    if (d.manifestSha256 === undefined) return { why: "this core carries no bundled-plugins manifest" };
    const get = (url: string, maxBytes: number, accept?: string) => (d.fetch ?? httpFetch)(url, { maxBytes, ...(accept ? { accept } : {}) });
    const verify = (name: string, bytes: Uint8Array, sig: Uint8Array | undefined) => {
      const text = sig === undefined ? undefined : new TextDecoder().decode(sig);
      return d.publicKey === undefined ? verifyFeed(name, bytes, text) : verifyFeed(name, bytes, text, d.publicKey);
    };
    const feedName = pluginsFeedFile(d.channel, d.target);
    const tarName = pluginsTarballFile(d.version, d.target);
    // The release tagged with the core's own version, and nothing else: its tag, and its channel.
    const tag = `v${d.version}`;
    const body = await get(`https://api.github.com/repos/${d.repo ?? UPDATE_REPO}/releases/tags/${tag}`, 4 * 1024 * 1024, "application/vnd.github+json");
    let release: Release | undefined;
    try {
      release = body === undefined ? undefined : (JSON.parse(new TextDecoder().decode(body)) as Release);
    } catch {
      release = undefined;
    }
    if (release === undefined || typeof release !== "object" || release === null) return { why: `release ${tag} could not be read` };
    if (release.tag_name !== tag || release.draft) return { why: `release ${tag} is not a published release of that tag` };
    if (d.channel === "latest" && release.prerelease) return { why: `release ${tag} is a beta, and this server takes latest` };
    if (!Array.isArray(release.assets)) return { why: `release ${tag} lists no files` };
    const asset = (name: string) => release!.assets.find((a) => a?.name === name)?.browser_download_url;
    if (asset(feedName) === undefined || asset(tarName) === undefined) return { why: `release ${tag} carries no ${tarName}` };
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
    const bytes = await get(asset(tarName)!, feed.size);
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
    // Written beside the folder, each file flushed, then measured again from what is on disk and the folders flushed.
    rmSync(staged, { recursive: true, force: true });
    const dirs = new Set<string>();
    for (const f of files) {
      const path = join(staged, ...f.path.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, f.bytes, { flag: "wx", mode: f.executable ? 0o755 : 0o644 });
      if (process.platform !== "win32") chmodSync(path, f.executable ? 0o755 : 0o644);
      syncFile(path);
      for (let p = dirname(path); p.length >= staged.length; p = dirname(p)) dirs.add(p);
    }
    for (const p of [...dirs].sort((a, b) => b.length - a.length)) syncDir(p);
    if (treeManifestSha256(staged) !== d.manifestSha256) {
      rmSync(staged, { recursive: true, force: true });
      return { why: `${staged} doesn't measure to the core's manifest once written` };
    }
    return { files: files.length };
  } catch (err) {
    try { rmSync(staged, { recursive: true, force: true }); } catch { /* best effort */ }
    return { why: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `from` (a staged, flushed folder) takes `dir`'s place; the folder there goes to `aside` first (an earlier `aside`
 * is removed). Each rename is atomic and the parent folder is flushed after them, so a power cut leaves a whole tree
 * at `dir`, or at `aside` and `from`, which the next start's recovery takes back. A failed rename puts `dir` back and
 * throws. `.old` is the aside a self-update keeps for a rollback (`swapPluginsIn(dir, true)`).
 */
export function swapPluginsIn(dir: string, keepOld: boolean, ops: DurableOps = realOps, from = `${dir}.new`, aside = keepOld ? `${dir}.old` : `${dir}.bad`): void {
  ops.rm(aside);
  const had = existsSync(dir);
  if (had) ops.rename(dir, aside);
  try {
    ops.rename(from, dir);
  } catch (err) {
    if (had) ops.rename(aside, dir);
    throw err;
  }
  ops.syncDir(dirname(dir));
  if (!keepOld) ops.rm(aside);
}

export interface RecoverDeps {
  dir: string;
  manifestSha256: string | undefined;
  /** Whether `<home>/update/boot.json` watches an update now: `.old` is the rollback's then, never removed. */
  watching: boolean;
  ops?: DurableOps;
  log(line: string): void;
}

/**
 * The start's local recovery, before anything reads the folder: when `dir` doesn't measure to this core's manifest
 * and `<dir>.new` or `<dir>.old` does (a power cut in a self-update's swap or a rollback, or a rollback with no
 * plugins step behind it), that copy takes its place, the one there set aside as `.bad`. Undefined when nothing was
 * to be done or nothing local matches. Never throws.
 */
export function recoverServerPlugins(d: RecoverDeps): PluginsResult | undefined {
  try {
    if (d.manifestSha256 === undefined || treeManifestSha256(d.dir) === d.manifestSha256) return undefined;
    // While an update is watched, `.old` is the rollback's copy: left where it is.
    for (const suffix of d.watching ? ([".new"] as const) : ([".new", ".old"] as const)) {
      const candidate = `${d.dir}${suffix}`;
      if (treeManifestSha256(candidate) !== d.manifestSha256) continue;
      swapPluginsIn(d.dir, false, d.ops ?? realOps, candidate, `${d.dir}.bad`);
      d.log(`bundled plugins: ${candidate} measures to this core's manifest and took ${d.dir}'s place`);
      return { kind: "recovered", from: suffix };
    }
    return undefined;
  } catch (err) {
    d.log(`bundled plugins: the local recovery failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** The start-time refetch's back-off record (`<home>/update/plugins-fetch.json`): failures so far, and when the next
 *  try may be. */
interface FetchBackoff { version: string; failures: number; until: number }
export const FETCH_BACKOFF_MS = 15 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

export function fetchBackoffFile(home: string): string {
  return join(home, "update", "plugins-fetch.json");
}

function readBackoff(file: string): FetchBackoff | undefined {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as FetchBackoff;
    return typeof v.version === "string" && typeof v.failures === "number" && typeof v.until === "number" ? v : undefined;
  } catch {
    return undefined;
  }
}

export interface EnsureDeps extends PluginsDeps {
  home: string;
  /** Whether the update gate committed a restart: the refetch then never swaps. */
  committed(): boolean;
  now?(): number;
}

/**
 * The start-time refetch, after the daemon is up: puts the core's bundled plugins in `d.dir` unless they are there
 * already (the tree measures to its manifest), staged in `<dir>.fetch` (never a self-update's `.new`), with a back-off
 * on failure that a marker keeps across restarts. Never swaps once the update gate committed a restart.
 */
export async function ensureServerPlugins(d: EnsureDeps): Promise<PluginsResult> {
  if (d.manifestSha256 !== undefined && treeManifestSha256(d.dir) === d.manifestSha256) {
    rmSync(fetchBackoffFile(d.home), { force: true });
    return { kind: "in place" };
  }
  const now = (d.now ?? Date.now)();
  const backoff = readBackoff(fetchBackoffFile(d.home));
  if (backoff !== undefined && backoff.version === d.version && now < backoff.until) {
    return { kind: "refused", why: `fetching ${d.version}'s plugins failed ${backoff.failures} time(s); tried again after ${new Date(backoff.until).toISOString()}` };
  }
  const staging = `${d.dir}.fetch`;
  const staged = await stageServerPlugins(d, staging);
  const failed = (why: string): PluginsResult => {
    const failures = backoff !== undefined && backoff.version === d.version ? backoff.failures + 1 : 1;
    const wait = Math.min(MAX_BACKOFF_MS, FETCH_BACKOFF_MS * 2 ** (failures - 1));
    try {
      mkdirSync(dirname(fetchBackoffFile(d.home)), { recursive: true });
      const tmp = `${fetchBackoffFile(d.home)}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: d.version, failures, until: now + wait })}\n`);
      renameSync(tmp, fetchBackoffFile(d.home));
    } catch { /* the back-off is best effort */ }
    return { kind: "refused", why };
  };
  if ("why" in staged) return failed(staged.why);
  if (d.committed()) {
    rmSync(staging, { recursive: true, force: true });
    return { kind: "refused", why: "an update's restart is under way; the folder is left to it" };
  }
  try {
    swapPluginsIn(d.dir, false, d.ops ?? realOps, staging, `${d.dir}.bad`);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    return failed(`the swap failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  rmSync(fetchBackoffFile(d.home), { force: true });
  d.log(`bundled plugins ${d.version} are in place at ${d.dir} (${staged.files} files)`);
  return { kind: "installed", version: d.version, files: staged.files };
}
