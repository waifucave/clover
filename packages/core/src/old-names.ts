// The OLD product's names that a user wrote on disk outside the home, in exactly ONE place. The new build reads
// the new name first and one of these second: it never writes them, and nothing else in live code spells them.
// Each helper answers "which path do I read": the new one when it exists, the old one when only that exists, the
// new one when neither does (so a caller's own "nothing there" handling is unchanged).
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** A project's settings folder before the rename. */
export const OLD_PROJECT_DIR = ".clover";
/** A project's (or the home's) instructions file before the rename. */
export const OLD_INSTRUCTIONS_FILE = "CLOVER.md";
/** A folder plugin's manifest before the rename. */
export const OLD_PLUGIN_MANIFEST = "clover.json";
/** The plugin SDK's import specifier before the rename, which a folder plugin not yet updated still imports: the
 *  build resolves it (and each subpath) to the new package, read second (`registry/build.ts`), and the load guard
 *  lets it in as a shared package (`registry/loader-config.ts`). */
export const OLD_PLUGIN_SDK = "@waifucave/clover-plugin-sdk";
export const NEW_PLUGIN_SDK = "@waifucave/moss-plugin-sdk";

/** Every folder name the build reads a project's config from, the new name first. A fence that names the new project
 *  folder names these: a name the build reads second is fenced like the first. */
export const PROJECT_DIR_NAMES: readonly string[] = [".moss", OLD_PROJECT_DIR];
/** The same names as one regular-expression alternative, `(?:\.moss|\.clover)`, for a fence written as a pattern. */
export const PROJECT_DIR_PATTERN = `(?:${PROJECT_DIR_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;

/** Every name above, for the one test that holds this file to them. */
export const OLD_NAMES = [OLD_PROJECT_DIR, OLD_INSTRUCTIONS_FILE, OLD_PLUGIN_MANIFEST, OLD_PLUGIN_SDK] as const;

/** The old SDK's specifiers as a bundler's resolve filter: the package and its subpaths. */
export const OLD_PLUGIN_SDK_FILTER = new RegExp(`^${OLD_PLUGIN_SDK.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?:/|$)`);

/** An import specifier with the old SDK's name as the new one's (`<old>` → `<new>`, `<old>/ui` → `<new>/ui`), or
 *  `undefined` when it isn't the old SDK's. */
export function newSdkSpecifier(spec: string): string | undefined {
  if (spec === OLD_PLUGIN_SDK) return NEW_PLUGIN_SDK;
  return spec.startsWith(`${OLD_PLUGIN_SDK}/`) ? `${NEW_PLUGIN_SDK}${spec.slice(OLD_PLUGIN_SDK.length)}` : undefined;
}

/** `newPath` when it exists, else `oldPath` when it exists, else `newPath`. */
export function newThenOld(newPath: string, oldPath: string): string {
  if (existsSync(newPath)) return newPath;
  return existsSync(oldPath) ? oldPath : newPath;
}

/** A project's `.moss` folder, or its old-named one when only that is there. */
export function projectDirOf(cwd: string, newName = ".moss"): string {
  return newThenOld(join(cwd, newName), join(cwd, OLD_PROJECT_DIR));
}

/** The instructions file in `dir`: `newName` (`MOSS.md`), else the old-named one. */
export function instructionsFileIn(dir: string, newName = "MOSS.md"): string {
  return newThenOld(join(dir, newName), join(dir, OLD_INSTRUCTIONS_FILE));
}

/** The manifest of the plugin folder `dir`: its `moss.json`, else the old-named file when only that is there. */
export function manifestPathIn(dir: string, newName = "moss.json"): string {
  return newThenOld(join(dir, newName), join(dir, OLD_PLUGIN_MANIFEST));
}

/** The old-named manifest that stands in for the new-named path `rel` (a plugin folder's `moss.json` or a child's), or
 *  `undefined` when `rel` is not a manifest path. The caller uses it only when the new-named file is absent. */
export function oldManifestFor(rel: string, newName = "moss.json"): string | undefined {
  if (basename(rel) !== newName) return undefined;
  const dir = dirname(rel);
  return dir === "." || dir === "" ? OLD_PLUGIN_MANIFEST : join(dir, OLD_PLUGIN_MANIFEST);
}

/** The inverse, for a tree listing: the new-named path a plugin folder's (or child's) old-named manifest `rel` is listed
 *  as, or `undefined` when `rel` is not one. The caller uses it only when the new-named file is absent. */
export function newManifestFor(rel: string, newName = "moss.json"): string | undefined {
  if (rel === OLD_PLUGIN_MANIFEST) return newName;
  const parts = rel.split("/");
  return parts.length === 3 && parts[0] === "plugins" && parts[2] === OLD_PLUGIN_MANIFEST ? `${dirname(rel)}/${newName}` : undefined;
}
