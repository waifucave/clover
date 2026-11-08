// The bundled plugins every installed build ships (the registry's `bundledDirs`, packages/core/src/registry): the
// repository's plugins/ as the app's read-only resources/plugins, each subfolder one top-level plugin. Only COMMITTED
// files ship: `stageBundledPlugins` writes HEAD's blobs under plugins/ (less what a release leaves out) into a staging
// folder that electron-builder.yml packs, and refuses a build whose plugins/ has any uncommitted change, so nothing a
// working tree happens to hold (an edit, a build output, a `.env`, a key, a file swapped for a symlink) can come
// along, and no symlink is ever copied or followed. The staged tree is then measured (`measureBundledTree`: every
// file's SHA-256 and size) and that manifest compiled into clover-core (scripts/build-daemon.ts --plugins-manifest):
// the core trusts a bundled file only when its bytes are the manifest's (packages/core/src/bundled-plugins-dir.ts).
// The checks here run on what was built:
//   - `bundledPluginsProblems`: what shipped is exactly the manifest's tree, each top-level plugin's manifest is
//     there, nothing the filter leaves out is, no symlink;
//   - `unshippedPluginDependencies`: what a plugin's package.json needs that nothing ships beside it;
//   - `builtPluginImportProblems`: the exact check on a release-time-built tree (wired with that build).
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, posix } from "node:path";
import { CLIENT_BARE_IMPORTS } from "../../packages/plugin-sdk/src/manifest/schema";
import { formatBundledManifest, measureBundledTree, type BundledManifest } from "../../packages/core/src/bundled-plugins-dir";

/** The bundled plugins' folder in the app's resources (electron-builder.yml), beside `daemon/`. */
export const BUNDLED_PLUGINS_DIR = "plugins";
/** The top-level plugins every build ships (each with its manifest). */
export const BUNDLED_PLUGIN_IDS = ["clover", "alpha"] as const;
/** Where the release scripts stage the tracked plugins for electron-builder (relative to apps/desktop). */
export const STAGED_PLUGINS = join("out", "plugins");

/** Why a path inside the plugins tree (relative to it) never ships, or undefined when it does: what electron-builder.yml's
 *  filter leaves out, plus anything that looks like a secret or an OS artifact. */
export function leftOut(rel: string): string | undefined {
  const parts = rel.split("/");
  const name = parts.at(-1)!;
  if (parts.includes("node_modules")) return "installed packages (node_modules)";
  if (parts.slice(0, -1).some((p) => p === "test" || p === "tests")) return "a test folder";
  if (/\.test\.tsx?$/.test(name)) return "a test file";
  if (/^tsconfig.*\.json$/.test(name)) return "a tsconfig";
  if (name === ".env" || name.startsWith(".env.")) return "an environment file";
  if (name === ".DS_Store") return "an OS artifact";
  return undefined;
}

/** One entry of a walked tree: its path relative to the tree, and whether it is a symlink (never followed). */
export interface TreeEntry { rel: string; link: boolean }

/** Every file and symlink under `dir`, relative to it, read with lstat: a symlink is reported, never followed, so a
 *  link can't pull in its target or loop. `[]` when there is no `dir`. */
export function walkTree(dir: string, rel = ""): TreeEntry[] {
  let names: string[];
  try { names = readdirSync(join(dir, rel)); } catch { return []; }
  return names.sort().flatMap((n) => {
    const r = rel === "" ? n : `${rel}/${n}`;
    const st = lstatSync(join(dir, r));
    if (st.isSymbolicLink()) return [{ rel: r, link: true }];
    return st.isDirectory() ? walkTree(dir, r) : [{ rel: r, link: false }];
  });
}

/** How staging reads the repository: the committed tree under plugins/, whether plugins/ has uncommitted changes, and
 *  the committed blobs by object id. */
export interface PluginsSource {
  /** `git ls-tree -r -z HEAD -- plugins`: `<mode> <type> <object>\t<path>` entries. */
  tree(): string;
  /** `git status --porcelain -z -- plugins`: empty when nothing under plugins/ differs from HEAD. */
  status(): string;
  /** Each object's committed bytes (`git cat-file --batch`). */
  blobs(objects: readonly string[]): Map<string, Uint8Array>;
}

/** The repository at `root`, through git. */
export function gitPluginsSource(root: string): PluginsSource {
  const git = (args: string[], input?: string) => {
    const r = spawnSync("git", args, { cwd: root, maxBuffer: 1 << 30, ...(input === undefined ? {} : { input }) });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(r.stderr).trim()}`);
    return r.stdout as Buffer;
  };
  return {
    tree: () => git(["ls-tree", "-r", "-z", "HEAD", "--", BUNDLED_PLUGINS_DIR]).toString("utf8"),
    status: () => git(["status", "--porcelain", "-z", "--untracked-files=all", "--", BUNDLED_PLUGINS_DIR]).toString("utf8"),
    blobs: (objects) => {
      // `<object> blob <size>\n<bytes>\n` per object, in order.
      const out = git(["cat-file", "--batch"], objects.map((o) => `${o}\n`).join(""));
      const map = new Map<string, Uint8Array>();
      let at = 0;
      for (const o of objects) {
        const nl = out.indexOf(0x0a, at);
        const [id, type, size] = out.subarray(at, nl).toString("utf8").split(" ");
        if (id !== o || type !== "blob") throw new Error(`git cat-file: ${o} is ${type ?? "missing"}, not a blob`);
        const n = Number(size);
        map.set(o, new Uint8Array(out.subarray(nl + 1, nl + 1 + n)));
        at = nl + 1 + n + 1;
      }
      return map;
    },
  };
}

/**
 * Writes the COMMITTED files under `plugins/` (HEAD's tree, never the working tree) into `dest`, less what a release
 * leaves out, and answers the files staged. Refuses a build whose plugins/ has any uncommitted change (an edit, a file
 * swapped for a symlink, an untracked file), and a committed symlink or submodule. A partial stage is removed.
 */
export function stageBundledPlugins(root: string, dest: string, source: PluginsSource = gitPluginsSource(root)): string[] {
  rmSync(dest, { recursive: true, force: true });
  const dirty = source.status().split("\0").filter((e) => e !== "");
  if (dirty.length > 0) throw new Error(`${BUNDLED_PLUGINS_DIR}/ has uncommitted changes, which a release never ships: ${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""}`);
  const entries: Array<{ rel: string; object: string; exec: boolean }> = [];
  for (const entry of source.tree().split("\0").filter((e) => e !== "")) {
    // `<mode> <type> <object>\t<path>`
    const tab = entry.indexOf("\t");
    const [mode, , object] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    const rel = path.slice(`${BUNDLED_PLUGINS_DIR}/`.length);
    if (mode === "120000") throw new Error(`${path} is a symlink: bundled plugins ship no symlinks`);
    if (mode === "160000") throw new Error(`${path} is a submodule: bundled plugins ship committed files only`);
    if (mode !== "100644" && mode !== "100755") throw new Error(`${path} has mode ${mode}: bundled plugins ship regular files only`);
    if (leftOut(rel) !== undefined) continue;
    entries.push({ rel, object: object!, exec: mode === "100755" });
  }
  try {
    const blobs = source.blobs(entries.map((e) => e.object));
    for (const e of entries) {
      mkdirSync(dirname(join(dest, e.rel)), { recursive: true });
      writeFileSync(join(dest, e.rel), blobs.get(e.object)!, { flag: "wx" });
      // git's two file modes, whatever the umask: 100755 stays executable.
      chmodSync(join(dest, e.rel), e.exec ? 0o755 : 0o644);
    }
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    throw err;
  }
  return entries.map((e) => e.rel);
}

/** Measures the staged tree and writes its manifest (the text the core embeds) to `file`; answers the manifest. */
export function writeStagedManifest(staged: string, file: string): BundledManifest {
  const manifest = measureBundledTree(staged);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, formatBundledManifest(manifest));
  return manifest;
}

/** How the shipped tree differs from the manifest the core carries: a file missing, one that isn't the manifest's
 *  bytes, or one the manifest doesn't name. */
export function manifestDifferences(expected: BundledManifest, shipped: BundledManifest): string[] {
  const out: string[] = [];
  for (const [rel, e] of Object.entries(expected.files)) {
    const s = shipped.files[rel];
    if (s === undefined) out.push(`${rel} is missing`);
    else if (s.sha256 !== e.sha256 || s.size !== e.size) out.push(`${rel} isn't the bytes the core's manifest names`);
  }
  for (const rel of Object.keys(shipped.files)) if (!Object.hasOwn(expected.files, rel)) out.push(`${rel} isn't in the core's manifest`);
  return out.sort();
}

/** What's wrong with a packaged app's bundled plugins under `resources`: the tree is exactly `manifest` (the one
 *  compiled into its core), each top-level plugin's manifest is there, nothing a release leaves out came along, and
 *  nothing is a symlink. `walk` lists the tree without following links. */
export function bundledPluginsProblems(resources: string, manifest: BundledManifest, exists: (path: string) => boolean, walk: (dir: string) => TreeEntry[], measure: (dir: string) => BundledManifest = measureBundledTree): string[] {
  const dir = join(resources, BUNDLED_PLUGINS_DIR);
  const problems = BUNDLED_PLUGIN_IDS.filter((id) => !exists(join(dir, id, "clover.json"))).map((id) => `${join(dir, id, "clover.json")} is missing: the ${id} plugin isn't bundled`);
  const entries = walk(dir);
  const links = entries.filter((e) => e.link).map((e) => e.rel);
  if (links.length > 0) problems.push(`${dir} holds symlinks, which a release never ships: ${links.slice(0, 5).join(", ")}${links.length > 5 ? ", …" : ""}`);
  const stray = entries.filter((e) => !e.link && leftOut(e.rel) !== undefined).map((e) => e.rel);
  if (stray.length > 0) problems.push(`${dir} holds files a release leaves out: ${stray.slice(0, 5).join(", ")}${stray.length > 5 ? ", …" : ""}`);
  if (links.length === 0) {
    let shipped: BundledManifest | undefined;
    try { shipped = measure(dir); } catch (err) { problems.push(`${dir} can't be measured: ${(err as Error).message}`); }
    const diff = shipped === undefined ? [] : manifestDifferences(manifest, shipped);
    if (diff.length > 0) problems.push(`${dir} isn't the tree the core's manifest names: ${diff.slice(0, 5).join("; ")}${diff.length > 5 ? "; …" : ""}`);
  }
  return problems;
}

/** The package name a bare specifier names (`@scope/name/sub` → `@scope/name`). */
export function packageOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** The packages a UI layer provides whole through its import map: those whose root is among the plugin SDK's
 *  `CLIENT_BARE_IMPORTS` (react, react-dom). The SDK itself is not one: the layer provides only its `/ui`. */
export const LAYER_PROVIDED_PACKAGES: readonly string[] = [...new Set(CLIENT_BARE_IMPORTS.filter((s) => packageOf(s) === s))];

/**
 * Each bundled plugin's runtime dependency that nothing ships: a `dependencies`, `optionalDependencies` or
 * `peerDependencies` entry the layers don't provide, of any package.json in the bundled tree, with no
 * `node_modules/<name>` shipped in its folder or any folder above it inside the tree (Node's lookup). `files` is the
 * tree's files, relative to it; `read` reads one. Wired into the release with the release-time build.
 */
export function unshippedPluginDependencies(files: readonly string[], read: (rel: string) => string): string[] {
  const shipped = new Set(files);
  const out: string[] = [];
  for (const rel of files.filter((f) => f === "package.json" || f.endsWith("/package.json")).filter((f) => !f.split("/").includes("node_modules")).sort()) {
    const dir = rel === "package.json" ? "" : rel.slice(0, -"/package.json".length);
    let pkg: Record<string, Record<string, string> | undefined>;
    try { pkg = JSON.parse(read(rel)); } catch { out.push(`${rel}: not JSON`); continue; }
    const wanted = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]
      .filter((n) => !LAYER_PROVIDED_PACKAGES.includes(n)));
    for (const name of [...wanted].sort()) {
      if (!nodeModulesHas(shipped, dir, name)) out.push(`${dir === "" ? "." : dir}: ${name}`);
    }
  }
  return out;
}

/** Whether `node_modules/<name>/package.json` is in the tree at `dir` or any folder above it (inside the tree). */
function nodeModulesHas(tree: ReadonlySet<string>, dir: string, name: string): boolean {
  for (let d = dir; ; d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "") {
    if (tree.has(`${d === "" ? "" : `${d}/`}node_modules/${name}/package.json`)) return true;
    if (d === "") return false;
  }
}

/** A module of a built bundled plugin: its path in the shipped tree, which side runs it, and its text. */
export interface BuiltModule { file: string; kind: "client" | "host"; source: string }

/** A native addon the build copied beside a bundle (lane B's `buildPluginForShipping`'s `natives`). */
export interface ShippedNative { file: string; package: string; target: string }

/** A module's imports as Bun's transpiler reads them, plus what a bundle hides from it: Bun's own `__require(…)` and
 *  `import.meta.require(…)` for an external. Counted as computed (can't be verified): any import or require whose
 *  specifier isn't a literal, any `createRequire(…)(…)` call, and any `process.dlopen(…)`.
 *  Known blind spots (a check of a build, not of an adversary): `new Worker(…)`, `module.require(…)`, and a require
 *  reached through another name (`const r = require; r("x")`). */
export function scanModule(source: string): { specifiers: string[]; computed: number } {
  const specifiers = new Set<string>();
  for (const i of new Bun.Transpiler({ loader: "js", ...({ macro: false } as object) }).scanImports(source)) specifiers.add(i.path);
  // A bundle calls an external through `__require` (= import.meta.require), which the transpiler doesn't see.
  for (const m of source.matchAll(/(?<![\w$])(?:__require|import\.meta\.require)\s*\(\s*(["'])([^"'\\]+)\1\s*\)/g)) specifiers.add(m[2]!);
  let computed = 0;
  for (const _ of source.matchAll(/(?<![\w$.])(?:import|require|__require|import\.meta\.require)\s*\(\s*(?!["']|\))/g)) computed++;
  // createRequire's function, called in place or later (`const r = createRequire(url); r("x")`), and native loading.
  for (const _ of source.matchAll(/(?<![\w$.])createRequire\s*\(/g)) computed++;
  for (const _ of source.matchAll(/(?<![\w$])process\s*\.\s*dlopen\s*\(/g)) computed++;
  // A literal that isn't the whole argument (`require("a" + b)`) is computed too.
  for (const _ of source.matchAll(/(?<![\w$.])(?:import|require|__require|import\.meta\.require)\s*\(\s*(["'])[^"'\\]*\1\s*[^\s)]/g)) computed++;
  return { specifiers: [...specifiers].sort(), computed };
}

/** Node's and Bun's own modules, with or without the `node:` prefix. */
function builtin(spec: string): boolean {
  return spec.startsWith("node:") || spec === "bun" || spec.startsWith("bun:") || builtinModules.includes(spec) || builtinModules.includes(spec.split("/")[0]!);
}

/** A relative import's file inside the importing module's own top-level plugin folder, or undefined when it leaves
 *  that folder (another plugin's files, or outside the tree) or isn't there. */
function resolveRelative(tree: ReadonlySet<string>, from: string, spec: string): string | undefined {
  const joined = posix.normalize(posix.join(posix.dirname(from), spec));
  if (joined === ".." || joined.startsWith("../") || posix.isAbsolute(joined)) return undefined;
  const own = from.split("/")[0]!;
  if (!joined.startsWith(`${own}/`)) return undefined;
  for (const c of [joined, `${joined}.js`, `${joined}.mjs`, `${joined}.cjs`, `${joined}/index.js`, `${joined}/index.mjs`]) if (tree.has(c)) return c;
  return undefined;
}

/**
 * The exact check on a built bundled plugin tree (`tree`: every shipped file, relative to the tree): a client
 * module's only bare imports are the layers' (the plugin SDK's CLIENT_BARE_IMPORTS); a host module's bare imports
 * are Node's and Bun's own, a package shipped in a `node_modules` at or above it inside the tree, or a native addon
 * the build shipped for `target`; every relative import resolves inside the tree. An absolute path or a `file:`,
 * `data:` or `http(s):` specifier is refused outright, and so is any import whose specifier isn't a literal, which
 * can't be checked.
 */
export function builtPluginImportProblems(modules: readonly BuiltModule[], tree: readonly string[], o: { natives?: readonly ShippedNative[]; target?: string } = {}): string[] {
  const files = new Set(tree);
  const problems: string[] = [];
  for (const n of o.natives ?? []) {
    if (o.target !== undefined && n.target !== o.target) problems.push(`${n.file}: a native addon for ${n.target}, not ${o.target}`);
    if (!files.has(n.file)) problems.push(`${n.file}: a native addon the build reported isn't in the shipped tree`);
  }
  for (const m of modules) {
    const { specifiers, computed } = scanModule(m.source);
    if (computed > 0) problems.push(`${m.file}: ${computed} import or require call(s) with a computed specifier, which can't be verified`);
    for (const spec of specifiers) {
      if (spec.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(spec) && !spec.startsWith("node:") && !spec.startsWith("bun:")) {
        problems.push(`${m.file}: imports ${spec}, an absolute path or URL, which a shipped plugin never does`);
      } else if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
        if (resolveRelative(files, m.file, spec) === undefined) problems.push(`${m.file}: imports ${spec}, which isn't in its own plugin's shipped files`);
      } else if (m.kind === "client") {
        if (!(CLIENT_BARE_IMPORTS as readonly string[]).includes(spec)) problems.push(`${m.file}: a client module imports ${spec}; only ${CLIENT_BARE_IMPORTS.join(", ")} come from the layer, everything else must be bundled`);
      } else if (!builtin(spec)) {
        const dir = m.file.includes("/") ? m.file.slice(0, m.file.lastIndexOf("/")) : "";
        const native = (o.natives ?? []).some((n) => n.package === packageOf(spec) && (o.target === undefined || n.target === o.target));
        if (!native && !nodeModulesHas(files, dir, packageOf(spec))) problems.push(`${m.file}: host code imports ${spec}, which nothing in the shipped tree provides`);
      }
    }
  }
  return problems;
}
