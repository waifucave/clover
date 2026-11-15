// The bundled plugins the registry loads (#259's rule; B-M2's dev layout): never a folder read in place. Each bundled
// top-level plugin is read once through `readBundledPlugin` (every file's size and hash against the manifest, and
// nothing in its folder the manifest doesn't name), and the verified bytes are written into a private copy under the
// Clover home's `run/` (which no runner writes). The registry's `bundledDirs` is that copy, so a file swapped in the
// app's resources after the check changes nothing that runs.
//
// Where the manifest comes from:
// * an installed core (compiled, the dist profile): the one compiled into it (`bundledManifest()`), over the folder
//   `bundledPluginsDir` finds by layout;
// * the dev profile, or a core run from source: the dev stage, `<home>/run/dev-bundled/`, which `buildDevBundledPlugins`
//   makes from the repository's `plugins/` with `buildPluginForShipping({ dev: true, bundled: true })` and measures. A
//   dist core never reads a dev stage. So in a dev run, the checkout's own `plugins/` is what counts as bundled: a local
//   edit to `plugins/alpha` is Clover's own there (its model asks nothing, `stagedBotChoice`).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import {
  BUNDLED_MANIFEST_FILE, bundledPluginIds, formatBundledManifest, measureBundledTree, parseBundledManifest, readBundledPlugin,
  type BundledManifest,
} from "../bundled-plugins-dir";
import { buildPluginForShipping, hostShipTarget } from "./ship";
import { parseJsonc } from "@waifucave/clover-plugin-sdk";

/** The private copy of the verified bundled plugins (the registry's `bundledDirs`). */
export function stagedBundledDir(cloverHome: string): string {
  return join(cloverHome, "run", "bundled-plugins");
}

/** The dev stage: `plugins/` (each top-level plugin built for this computer) and the manifest measured from it. */
export function devBundledDir(cloverHome: string): string {
  return join(cloverHome, "run", "dev-bundled");
}

/** Copies every bundled plugin that verifies against `manifest` into `out`, replacing what was there, and returns `out`
 *  (undefined when the manifest names none). A plugin that fails is left out with its refusal, never copied in part.
 *  `digests` holds each copied file's SHA-256 by its real path, as verified: the plugin host runs a bundled plugin's
 *  entry only from bytes that match it (#322's review, S2), so a file rewritten after staging doesn't run. */
export function stageBundledPlugins(o: { root: string; manifest: BundledManifest; out: string; log?: (line: string) => void }): { dir: string | undefined; staged: string[]; refused: string[]; digests: ReadonlyMap<string, string> } {
  const ids = bundledPluginIds(o.manifest);
  rmSync(o.out, { recursive: true, force: true });
  const digests = new Map<string, string>();
  if (ids.length === 0) return { dir: undefined, staged: [], refused: [], digests };
  const verified: string[] = [];
  const tmp = `${o.out}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const staged: string[] = [];
  const refused: string[] = [];
  try {
    for (const id of ids) {
      const read = readBundledPlugin(o.root, id, o.manifest);
      if (!read.ok) {
        refused.push(read.refusal);
        o.log?.(`bundled plugin refused: ${read.refusal}`);
        continue;
      }
      for (const [rel, bytes] of read.files) {
        const file = join(tmp, ...rel.split("/"));
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, bytes, { mode: 0o600 });
        verified.push(rel);
      }
      staged.push(id);
    }
    renameSync(tmp, o.out);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  const out = realpathSync(o.out);
  for (const rel of verified) digests.set(join(out, ...rel.split("/")), o.manifest.files[rel]!.sha256);
  return { dir: o.out, staged, refused, digests };
}

/** The dev stage's root and manifest, or undefined when there is none (or it's unreadable). */
export function devBundledSource(cloverHome: string): { root: string; manifest: BundledManifest } | undefined {
  const dir = devBundledDir(cloverHome);
  const file = join(dir, BUNDLED_MANIFEST_FILE);
  if (!existsSync(file)) return undefined;
  try {
    return { root: join(dir, "plugins"), manifest: parseBundledManifest(readFileSync(file, "utf8")) };
  } catch {
    return undefined;
  }
}

/** Builds the dev stage from the repository's `plugins/`: each of `ids` built for this computer as a release would
 *  build it (`dev: true` lets it copy natives from this checkout), then measured into the manifest beside them.
 *  Replaces the stage whole, or leaves the old one when a build fails. Returns how long it took and what it built. */
export async function buildDevBundledPlugins(o: { sources: string; ids: readonly string[]; cloverHome: string }): Promise<{ ms: number; built: string[] }> {
  const started = performance.now();
  const target = hostShipTarget();
  if (target === undefined) throw new Error(`no release target builds for ${process.platform}-${process.arch}`);
  const dir = devBundledDir(o.cloverHome);
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, "plugins"), { recursive: true, mode: 0o700 });
  try {
    for (const id of o.ids) {
      await buildPluginForShipping(join(o.sources, id), { target, out: join(tmp, "plugins", id), dev: true, bundled: true });
    }
    writeFileSync(join(tmp, BUNDLED_MANIFEST_FILE), formatBundledManifest(measureBundledTree(join(tmp, "plugins"))), { mode: 0o600 });
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  return { ms: Math.round(performance.now() - started), built: [...o.ids] };
}

/** A bundled plugin's manifest bytes, only when its folder is inside this run's staged copy and the manifest still
 *  has the digest staging recorded for it; undefined otherwise (never throws). */
export function stagedManifest(o: { folder: string; stagedDir: string; digests: ReadonlyMap<string, string> | undefined }): Buffer | undefined {
  if (o.digests === undefined) return undefined;
  try {
    const root = realpathSync(o.stagedDir);
    const folder = realpathSync(o.folder);
    if (!(folder + sep).startsWith(root.endsWith(sep) ? root : root + sep)) return undefined;
    const manifest = realpathSync(join(folder, "clover.json"));
    const want = o.digests.get(manifest);
    if (want === undefined) return undefined;
    const bytes = readFileSync(manifest);
    return createHash("sha256").update(bytes).digest("hex") === want ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** What Clover's own bundled plugin chose for its bot (its `contributes.bot` model tag and voice), read from a staged
 *  folder's manifest as staging verified it, or undefined on any doubt: the folder must be inside the staged copy
 *  (`stagedBundledDir`, under `run/`, which no runner reads or writes), and the manifest's bytes, read once, must hash
 *  to the digest staging measured (`digests`, by real path); the choice is parsed from those same bytes. The bot side
 *  (`BotServiceOptions.bundledChoice`) exempts a loaded tag from the provider card only when it equals this, so what
 *  is exempt is a tag Clover's verified bytes chose, never the id, the name or a manifest's claim.
 *
 *  In a dev run (`dev:daemon`, or a core run from source) the staged copy is built from this checkout's own
 *  `plugins/` (`devBundledSource`): a local edit to `plugins/alpha` is staged, verified and exempt there, as the
 *  checkout's owner is the one choosing. A dist core stages only the bytes its compiled manifest names. */
export function stagedBotChoice(o: { folder: string; stagedDir: string; digests: ReadonlyMap<string, string> | undefined }): { model?: string; voice?: { provider: string; voice: string; model?: string } } | undefined {
  const bytes = stagedManifest(o);
  if (bytes === undefined) return undefined;
  try {
    const parsed = parseJsonc(bytes.toString("utf8"));
    if (!parsed.ok) return undefined;
    const bot = (parsed.value as { contributes?: { bot?: { model?: unknown; voice?: unknown } } } | null)?.contributes?.bot;
    if (bot === null || typeof bot !== "object") return undefined;
    const str = (v: unknown): v is string => typeof v === "string";
    const m = bot.model as { default?: unknown } | undefined;
    const v = bot.voice as { provider?: unknown; voice?: unknown; model?: unknown } | undefined;
    return {
      ...(m !== null && typeof m === "object" && str(m.default) ? { model: m.default } : {}),
      ...(v !== null && typeof v === "object" && str(v.provider) && str(v.voice) && (v.model === undefined || str(v.model))
        ? { voice: { provider: v.provider, voice: v.voice, ...(v.model === undefined ? {} : { model: v.model }) } } : {}),
    };
  } catch {
    return undefined;
  }
}
