// Plain Bun for plugins on a server install (the controller's ruling (a), #244): `clover-core server install` puts
// `<home>/bin/daemon/clover-plugin-bun` beside `<home>/bin/daemon/clover-core`, and the server's daemon fetches it again at start
// whenever its own Bun version (the daemon's `Bun.version`, which a self-update can change) differs from the installed
// one. Lane B's `pluginBun()` finds it beside the compiled core and fails closed without it.
//
// The same checks as the daemon's own update (self-update.ts), in the same order, stopping at the first that fails:
//   1. the update file (`<channel>-plugin-bun-<target>.yml`) and its signature, before a byte of it is read
//   2. the binary (`clover-plugin-bun-<bun version>-<target>`): its signature, then its SHA-512 and size against the
//      update file, which must name exactly the daemon's Bun version
//   3. only then it runs, once: `--version` (PATH alone, 10 s), which must print that version
// Then the atomic swap: the checked binary waits as `.new`, the installed one becomes `.old`, `.new` takes its name,
// and the installed one is asked `--version` again; anything wrong puts `.old` back. The rollback mirrors the
// daemon's: a daemon rolled back to an older version (an older Bun) finds that Bun in `.old` and swaps it back in
// rather than downloading it. All of it lives in `<home>/bin/`, which no session can write (core's
// `selfGrantDenyWrite`).
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parsePluginBunFeed, pluginBunBinaryFile, pluginBunFeedFile, SIGNATURE_SUFFIX, verifyFeed, type CoreFeed, type CoreTarget, type FeedChannel } from "@waifucave/clover-update-feed";
import { httpFetch, MAX_FEED_BYTES, runVersion, UPDATE_REPO, type Fetcher } from "./self-update";

/** Where a server install keeps plugin Bun: beside its daemon, in `<home>/bin/daemon/`. */
export function serverPluginBun(home: string, os: NodeJS.Platform | "win32" | "darwin" | "linux"): string {
  return join(home, "bin", "daemon", os === "win32" ? "clover-plugin-bun.exe" : "clover-plugin-bun");
}

export interface PluginBunDeps {
  /** `<home>/bin/daemon/clover-plugin-bun` (`serverPluginBun`). */
  path: string;
  /** The daemon's Bun version, which plugin Bun must be. */
  bunVersion: string;
  target: CoreTarget;
  channel: FeedChannel;
  publicKey?: string | null;
  repo?: string;
  fetch?: Fetcher;
  runVersion?: (path: string) => Promise<string | undefined>;
  log(line: string): void;
}

export type PluginBunResult =
  | { kind: "in place" }
  | { kind: "installed"; version: string; from: "release" | "old" }
  | { kind: "refused"; why: string };

interface ReleaseAsset { name: string; browser_download_url: string }
interface Release { draft: boolean; prerelease: boolean; assets: ReleaseAsset[] }

/** Puts the daemon's Bun at `d.path` unless it is there already. Never throws. */
export async function ensurePluginBun(d: PluginBunDeps): Promise<PluginBunResult> {
  const ask = d.runVersion ?? runVersion;
  try {
    if (existsSync(d.path) && (await ask(d.path)) === d.bunVersion) return { kind: "in place" };
    // A rolled-back daemon's Bun is the one the last swap set aside.
    const old = `${d.path}.old`;
    if (existsSync(old) && (await ask(old)) === d.bunVersion) {
      const swapped = await swapIn(d, old, ask);
      return swapped ?? { kind: "installed", version: d.bunVersion, from: "old" };
    }
    const get = (url: string, maxBytes: number, accept?: string) => (d.fetch ?? httpFetch)(url, { maxBytes, ...(accept ? { accept } : {}) });
    const verify = (name: string, bytes: Uint8Array, sig: Uint8Array | undefined) => {
      const text = sig === undefined ? undefined : new TextDecoder().decode(sig);
      return d.publicKey === undefined ? verifyFeed(name, bytes, text) : verifyFeed(name, bytes, text, d.publicKey);
    };
    const feedName = pluginBunFeedFile(d.channel, d.target);
    const binName = pluginBunBinaryFile(d.bunVersion, d.target);
    const body = await get(`https://api.github.com/repos/${d.repo ?? UPDATE_REPO}/releases?per_page=30`, 4 * 1024 * 1024, "application/vnd.github+json");
    let releases: unknown;
    try {
      releases = body === undefined ? undefined : JSON.parse(new TextDecoder().decode(body));
    } catch {
      releases = undefined;
    }
    if (!Array.isArray(releases)) return { kind: "refused", why: "the releases could not be read" };
    // The newest release this channel allows that carries this Bun for this target.
    const release = (releases as Release[]).find((r) => r && !r.draft && (d.channel === "beta" || !r.prerelease) && Array.isArray(r.assets) && r.assets.some((a) => a?.name === feedName) && r.assets.some((a) => a?.name === binName));
    if (release === undefined) return { kind: "refused", why: `no release carries ${binName}` };
    const asset = (name: string) => release.assets.find((a) => a.name === name)?.browser_download_url;
    // 1. The update file's signature, before a byte of it is read.
    const feedBytes = await get(asset(feedName)!, MAX_FEED_BYTES);
    if (feedBytes === undefined) return { kind: "refused", why: `${feedName} could not be read (or is over ${MAX_FEED_BYTES} bytes)` };
    const feedSig = asset(`${feedName}${SIGNATURE_SUFFIX}`);
    const feedVerdict = verify(feedName, feedBytes, feedSig === undefined ? undefined : await get(feedSig, MAX_FEED_BYTES));
    if (!feedVerdict.ok) return { kind: "refused", why: `${feedName}: ${feedVerdict.reason}` };
    let feed: CoreFeed;
    try {
      feed = parsePluginBunFeed(new TextDecoder().decode(feedBytes));
    } catch (err) {
      return { kind: "refused", why: `${feedName}: ${(err as Error).message}` };
    }
    if (feed.version !== d.bunVersion || feed.file !== binName) return { kind: "refused", why: `${feedName} names ${feed.file}, not ${binName}` };
    // 2. The binary: its signature, then its SHA-512 and size; at most its signed size is read.
    const binUrl = asset(binName);
    const bytes = binUrl === undefined ? undefined : await get(binUrl, feed.size);
    if (bytes === undefined) return { kind: "refused", why: `${binName} could not be read (or is over its ${feed.size} bytes)` };
    const binSig = asset(`${binName}${SIGNATURE_SUFFIX}`);
    const binVerdict = verify(binName, bytes, binSig === undefined ? undefined : await get(binSig, MAX_FEED_BYTES));
    if (!binVerdict.ok) return { kind: "refused", why: `${binName}: ${binVerdict.reason}` };
    if (createHash("sha512").update(bytes).digest("base64") !== feed.sha512 || bytes.length !== feed.size) return { kind: "refused", why: `${binName}'s sha512 or size doesn't match ${feedName}` };
    // 3. Only now it runs: `--version`.
    const staged = `${d.path}.new`;
    mkdirSync(dirname(d.path), { recursive: true });
    rmSync(staged, { force: true });
    writeFileSync(staged, bytes, { mode: 0o755 });
    chmodSync(staged, 0o755);
    const said = await ask(staged);
    if (said !== d.bunVersion) {
      rmSync(staged, { force: true });
      return { kind: "refused", why: `${binName}'s --version said ${said === undefined ? "nothing (it failed or ran over 10 s)" : JSON.stringify(said.slice(0, 80))}, not ${d.bunVersion}` };
    }
    // `.new` is checked once more, just before it is used.
    if (createHash("sha512").update(readFileSync(staged)).digest("base64") !== feed.sha512) {
      rmSync(staged, { force: true });
      return { kind: "refused", why: `${staged} changed after its check` };
    }
    const swapped = await swapIn(d, staged, ask);
    return swapped ?? { kind: "installed", version: d.bunVersion, from: "release" };
  } catch (err) {
    return { kind: "refused", why: err instanceof Error ? err.message : String(err) };
  }
}

/** `from` (a checked `.new`, or `.old`) takes plugin Bun's place; the installed one becomes `.old`. A failure, or an
 *  installed binary that then doesn't answer the version, puts the previous one back. Undefined when it worked. */
async function swapIn(d: PluginBunDeps, from: string, ask: (path: string) => Promise<string | undefined>): Promise<PluginBunResult | undefined> {
  const bin = d.path, old = `${bin}.old`, aside = `${bin}.swap`;
  const had = existsSync(bin);
  // `.old` may be `from` itself (a rollback): the installed one goes aside first.
  rmSync(aside, { force: true });
  if (had) renameSync(bin, aside);
  try {
    renameSync(from, bin);
  } catch (err) {
    if (had) renameSync(aside, bin);
    return { kind: "refused", why: `the swap failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if ((await ask(bin)) !== d.bunVersion) {
    rmSync(bin, { force: true });
    if (had) renameSync(aside, bin);
    return { kind: "refused", why: `${bin} didn't answer ${d.bunVersion} once in place; the previous one is back` };
  }
  if (had) {
    rmSync(old, { force: true });
    renameSync(aside, old);
  }
  d.log(`plugin Bun ${d.bunVersion} is in place at ${bin}`);
  return undefined;
}

/** The daemon's own Bun version, the one plugin Bun must match. */
export function daemonBunVersion(): string {
  return Bun.version;
}
