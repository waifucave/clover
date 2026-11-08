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
//   dist core never reads a dev stage.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BUNDLED_MANIFEST_FILE, bundledPluginIds, formatBundledManifest, measureBundledTree, parseBundledManifest, readBundledPlugin,
  type BundledManifest,
} from "../bundled-plugins-dir";
import { buildPluginForShipping, hostShipTarget } from "./ship";

/** The private copy of the verified bundled plugins (the registry's `bundledDirs`). */
export function stagedBundledDir(cloverHome: string): string {
  return join(cloverHome, "run", "bundled-plugins");
}

/** The dev stage: `plugins/` (each top-level plugin built for this computer) and the manifest measured from it. */
export function devBundledDir(cloverHome: string): string {
  return join(cloverHome, "run", "dev-bundled");
}

/** Copies every bundled plugin that verifies against `manifest` into `out`, replacing what was there, and returns `out`
 *  (undefined when the manifest names none). A plugin that fails is left out with its refusal, never copied in part. */
export function stageBundledPlugins(o: { root: string; manifest: BundledManifest; out: string; log?: (line: string) => void }): { dir: string | undefined; staged: string[]; refused: string[] } {
  const ids = bundledPluginIds(o.manifest);
  rmSync(o.out, { recursive: true, force: true });
  if (ids.length === 0) return { dir: undefined, staged: [], refused: [] };
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
      }
      staged.push(id);
    }
    renameSync(tmp, o.out);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  return { dir: o.out, staged, refused };
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
