// Running a plugin's code with Bun, held to the plugin's own tree at run time (#234's review, F2, the controller's
// ruling). A static read of loader configs can't see every way one sends a load elsewhere (a `paths` target with `..`
// after its `*`, a `jsxImportSource`, a dependency's `main`, a bunfig `preload`, a `.env` `NODE_OPTIONS`), so every
// process Clover starts for a plugin (its host half, a stdio server, a hook) runs with:
//
// * Clover's own `bunfig.toml` (`--config`), never the plugin's: no `preload`, and no auto-install from the network;
// * no `.env` loading (`--no-env-file`), and no inherited `NODE_OPTIONS`, `BUN_OPTIONS` or `NODE_PATH`;
// * Clover's guard preloaded (`--preload`): a Bun plugin whose `onLoad` sees every file the process loads, by its real
//   path after links, and refuses one outside the plugin's tree and Clover's shared packages; and `process.dlopen`
//   (native addons) held to the same rule.
//
// The flags go in `BUN_OPTIONS` too, so a `bun` a hook's shell command starts gets them, whatever its cwd (measured on
// Bun 1.4.4: a plugin folder's `.env` `NODE_OPTIONS=--require <file>` and bunfig `preload` both run without them, and
// neither does with them). The static check (`loaderReach`) stays as `clover plugin validate`'s early error.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Clover's bunfig for plugin processes: nothing installed at run time. */
export const PLUGIN_BUNFIG = `# Clover's own config for plugin processes; a plugin's bunfig.toml never applies.\n[install]\nauto = "disable"\n`;

/** The guard, preloaded into every plugin process. It reads its plugin's root and the shared roots from the env. */
export const PLUGIN_GUARD_SOURCE = String.raw`// Clover's load guard for a plugin process (registry/plugin-run.ts). Generated; do not edit.
import { realpathSync } from "node:fs";
import { sep } from "node:path";
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const root = realpathSync(process.env.CLOVER_PLUGIN_ROOT);
const shared = JSON.parse(process.env.CLOVER_PLUGIN_SHARED ?? "[]").map(real);
const inside = (p, r) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
const allowed = (p) => { const r = real(p); return inside(r, root) || shared.some((s) => inside(r, s)); };
const refuse = (p) => { throw new Error("clover: refused to load " + p + ": it is outside the plugin's own folder"); };
// The filter matches only a script outside the plugin's root and the shared roots (Bun hands it the resolved real
// path), so onLoad runs only to refuse, and the plugin's own files load as Bun loads them (contents onLoad returns
// lose CommonJS interop, as measured on Bun 1.4.4).
const esc = (s) => Array.from(s, (c) => ("\\^$.*+?()[]{}|/".includes(c) ? "\\" + c : c)).join("");
const roots = [root, ...shared].map((r) => esc(r.endsWith(sep) ? r : r + sep)).join("|");
Bun.plugin({
  name: "clover-plugin-guard",
  setup(build) {
    // Case-sensitive on the roots (a case-folded prefix would let a sibling folder through on Linux); any case on the
    // extension.
    build.onLoad({ filter: new RegExp("^(?!(?:" + roots + "))(?:/|[A-Za-z]:[\\\\/]|\\\\\\\\).*\\.[mMcC]?[jJtT][sS][xX]?$") }, (args) => refuse(args.path));
  },
});
// A native addon loads through process.dlopen: held to the same rule.
const dlopen = process.dlopen.bind(process);
process.dlopen = (module, filename, ...rest) => { if (!allowed(filename)) refuse(filename); return dlopen(module, filename, ...rest); };
`;

export interface PluginRunFiles {
  bunfig: string;
  guard: string;
}

/** What a process runner needs to hold a plugin's processes to its tree: the run files, and the shared roots (default:
 *  `cloverSharedRoots()`). */
export interface PluginRunGuard {
  files: PluginRunFiles;
  shared?: readonly string[];
}

/** Writes Clover's bunfig and guard for plugin processes into `dir` (the daemon's run folder), and returns their paths.
 *  `BUN_OPTIONS` splits on spaces and takes no quotes (measured on Bun 1.4.4), so the files live in a folder whose path
 *  has none: the run folder's, else one in the system temp folder; with neither it throws, and no plugin process starts. */
export function ensurePluginRunFiles(dir: string): PluginRunFiles {
  const candidates = [join(dir, "plugin-run"), join(tmpdir(), `clover-plugin-run-${createHash("sha256").update(dir).digest("hex").slice(0, 16)}`)];
  const folder = candidates.find((c) => !/\s/.test(c));
  if (folder === undefined) throw new Error("no folder without spaces for plugin processes' run files; plugin processes can't start");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  // The guard is only as good as its file: the folder must be a real one of this user's that no one else can write
  // (the temp fallback's path is predictable).
  const st = lstatSync(folder);
  const uid = process.getuid?.();
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o022) !== 0) {
    throw new Error(`${folder} is not a private folder of this user's; plugin processes can't start`);
  }
  const files = { bunfig: join(folder, "bunfig.toml"), guard: join(folder, "guard.mjs") };
  for (const [path, text] of [[files.bunfig, PLUGIN_BUNFIG], [files.guard, PLUGIN_GUARD_SOURCE]] as const) {
    let current: string | undefined;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = undefined;
    }
    if (current !== text) writeFileSync(path, text, { mode: 0o600 });
  }
  return files;
}

/** The Bun flags every plugin process runs with. */
export function pluginBunFlags(files: PluginRunFiles): string[] {
  return [`--config=${files.bunfig}`, "--no-env-file", `--preload=${files.guard}`];
}

/** Variables a plugin process never inherits: they change what Bun or Node loads. */
const DROPPED_ENV = /^(NODE_OPTIONS|BUN_OPTIONS|NODE_PATH|BUN_CONFIG_.+|NODE_EXTRA_CA_CERTS_.+)$/;

/** The packages a plugin may load from Clover's own install (the plugin SDK and what it imports), as folders. */
export function cloverSharedRoots(): string[] {
  const out: string[] = [];
  for (const name of ["@waifucave/clover-plugin-sdk", "@waifucave/clover-protocol", "zod"]) {
    try {
      out.push(realpathSync(dirname(Bun.resolveSync(`${name}/package.json`, import.meta.dir))));
    } catch {
      /* not installed beside the core: not shared */
    }
  }
  return out;
}

/** A plugin process's environment: `base` without what changes loading, Clover's flags in `BUN_OPTIONS`, and what the
 *  guard reads. `pluginRoot` is the plugin's top-level folder. */
export function guardedPluginEnv(base: Readonly<Record<string, string | undefined>>, o: { pluginRoot: string; files: PluginRunFiles; shared?: readonly string[] }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !DROPPED_ENV.test(k)) env[k] = v;
  env.BUN_OPTIONS = pluginBunFlags(o.files).join(" ");
  let root: string;
  try {
    root = realpathSync(o.pluginRoot);
  } catch {
    root = resolve(o.pluginRoot); // missing: the guard's own realpath fails, and the process loads nothing
  }
  env.CLOVER_PLUGIN_ROOT = root;
  env.CLOVER_PLUGIN_SHARED = JSON.stringify(o.shared ?? cloverSharedRoots());
  return env;
}
