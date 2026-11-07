// Running a plugin's code with Bun, held to the plugin's own tree at run time (#234's review, F2, the controller's
// ruling). A static read of loader configs can't see every way one sends a load elsewhere (a `paths` target with `..`
// after its `*`, a `jsxImportSource`, a dependency's `main`, a bunfig `preload`, a `.env` `NODE_OPTIONS`), so the
// processes for a plugin's code run with what follows, always on the plugin Bun (`pluginBun`). Exactly these are
// covered: a supervised plugin host (`plugins/supervisor.ts`, which starts only a Bun command), a hook
// (`plugins/hook-runner.ts`, and any `bun` its shell command starts, which the PATH makes Clover's), and a plugin's stdio
// MCP server whose command is Bun (`guardedMcpServer`, the one door a plugin-sourced stdio entry takes into a runtime's
// config). Not covered, by the controller's rulings: an agent backend (its quirks rule), and any program that isn't Bun
// (a `stdio` server's other command, a helper, a `node` the plugin's code starts), which is code by declaration that
// the OK covers and Clover doesn't confine. Neither is what the approved code chooses to do itself: `eval`, a child it
// starts with a clean environment. Nor an ESM load of a file without an extension, which Bun 1.4.4 hands to no plugin
// hook: the fence keeps runners from writing a `node_modules` above a plugin (`pluginLoadDenies`), and the OK refuses
// a plugin that imports a dependency it doesn't ship (`loaderReach`'s `missing`). Each process runs with:
//
// * Clover's own `bunfig.toml` (`--config`), never the plugin's: no `preload`, and no auto-install from the network;
// * no `.env` loading (`--no-env-file`), and no inherited `NODE_OPTIONS`, `BUN_OPTIONS` or `NODE_PATH`;
// * Clover's guard preloaded (`--preload`): a Bun plugin whose `onLoad` sees every file the process loads, by its real
//   path after links, and refuses one outside the plugin's tree and Clover's shared packages, whatever its name or
//   loader; `process.dlopen` (native addons) held to the same rule; every worker (`Worker`, `node:worker_threads`)
//   preloading the guard first, pinned to the same plugin folder; and no `ShadowRealm`.
//
// The flags go in `BUN_OPTIONS` too, so a `bun` a hook's shell command starts gets them, whatever its cwd (measured on
// Bun 1.4.4: a plugin folder's `.env` `NODE_OPTIONS=--require <file>` and bunfig `preload` both run without them, and
// neither does with them). The static check (`loaderReach`) stays as `clover plugin validate`'s early error.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

/** Clover's bunfig for plugin processes: nothing installed at run time. */
export const PLUGIN_BUNFIG = `# Clover's own config for plugin processes; a plugin's bunfig.toml never applies.\n[install]\nauto = "disable"\n`;

/** The guard, preloaded into every plugin process. It reads its plugin's root and the shared roots from the env. */
export const PLUGIN_GUARD_SOURCE = String.raw`// Clover's load guard for a plugin process (registry/plugin-run.ts). Generated; do not edit.
import { realpathSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
// Through require, never an ESM import: the plugin's own ESM imports of it then see the wrapped Worker below (measured
// on Bun 1.4.4; an ESM import here would fix its named exports before the wrap).
const workerThreads = createRequire(import.meta.url)("node:worker_threads");
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const fail = (why) => { throw new Error("clover: " + why); };
// What this thread was started with, pinned before any plugin code runs: a worker gets these, never process.env's.
// Never Bun's "be Bun" switch in a plugin's process, whatever started it (#234's check 5, K2).
delete process.env.BUN_BE_BUN;
const rootEnv = process.env.CLOVER_PLUGIN_ROOT;
const sharedEnv = process.env.CLOVER_PLUGIN_SHARED ?? "[]";
if (typeof rootEnv !== "string" || rootEnv === "") fail("a plugin process starts only with its plugin's folder");
const root = realpathSync(rootEnv);
const guardFile = fileURLToPath(import.meta.url);
// The guard's own folder (its run files) loads too: a worker preloads the guard from there.
const shared = [...JSON.parse(sharedEnv), dirname(guardFile)].map(real);
const inside = (p, r) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
const allowed = (p) => { const r = real(p); return inside(r, root) || shared.some((s) => inside(r, s)); };
const refuse = (p) => fail("refused to load " + p + ": it is outside the plugin's own folder");
// The filter matches every file outside the plugin's root and the shared roots, whatever its name or the loader asked
// for (Bun hands it the resolved real path), so onLoad runs only to refuse, and the plugin's own files load as Bun
// loads them (contents onLoad returns lose CommonJS interop, as measured on Bun 1.4.4). Case-sensitive: a case-folded
// prefix would let a sibling folder through on Linux.
const esc = (s) => Array.from(s, (c) => ("\\^$.*+?()[]{}|/".includes(c) ? "\\" + c : c)).join("");
const roots = [root, ...shared].map((r) => esc(r.endsWith(sep) ? r : r + sep)).join("|");
Bun.plugin({
  name: "clover-plugin-guard",
  setup(build) {
    build.onLoad({ filter: new RegExp("^(?!(?:" + roots + "))(?:/|[A-Za-z]:[\\\\/]|\\\\\\\\)") }, (args) => refuse(args.path));
  },
});
// A require of a file with no extension Bun knows skips onLoad (measured on Bun 1.4.4), never the resolver: held to
// the same rule there.
// Bun takes an override through the property's setter, so it is assigned, then locked.
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  const f = resolveFilename.call(this, request, ...rest);
  if (typeof f === "string" && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(f) && !allowed(f)) refuse(f);
  return f;
};
const guardedResolve = Module._resolveFilename;
Object.defineProperty(Module, "_resolveFilename", { get: () => guardedResolve, set: () => fail("the load guard stays"), enumerable: true, configurable: false });
// The guard stays registered.
Object.defineProperty(Bun.plugin, "clearAll", { value: () => fail("the load guard stays"), writable: false, configurable: false });
// A native addon loads through process.dlopen: held to the same rule.
const dlopen = process.dlopen.bind(process);
Object.defineProperty(process, "dlopen", {
  value: (module, filename, ...rest) => { if (!allowed(filename)) refuse(filename); return dlopen(module, filename, ...rest); },
  writable: false, configurable: false,
});
// Every worker runs the guard first, with this thread's plugin folder (never one the plugin set in process.env).
const guarded = (opts) => {
  const o = opts !== null && typeof opts === "object" ? { ...opts } : {};
  const own = o.preload === undefined ? [] : [].concat(o.preload);
  const env = o.env !== null && typeof o.env === "object" ? o.env : process.env;
  return { ...o, preload: [guardFile, ...own], env: { ...env, CLOVER_PLUGIN_ROOT: rootEnv, CLOVER_PLUGIN_SHARED: sharedEnv } };
};
const wrap = (Original) => {
  // A plain function, not a subclass: the original isn't reachable through the wrapper's prototype chain.
  const Worker = function Worker(url, opts) {
    if (new.target === undefined) fail("Worker needs new");
    return new Original(url, guarded(opts));
  };
  Worker.prototype = Original.prototype;
  Object.defineProperty(Original.prototype, "constructor", { value: Worker, writable: false, configurable: false });
  return Worker;
};
const lock = (obj, key, value) => Object.defineProperty(obj, key, { value, writable: false, configurable: false, enumerable: true });
lock(globalThis, "Worker", wrap(globalThis.Worker));
// A ShadowRealm's importValue loads a module with none of this (#234's check 4, H2): there is none.
lock(globalThis, "ShadowRealm", function ShadowRealm() { fail("ShadowRealm isn't available to a plugin"); });
lock(workerThreads, "Worker", wrap(workerThreads.Worker));
`;

export interface PluginRunFiles {
  bunfig: string;
  guard: string;
  /** A folder holding `bun`, a link to the plugin Bun (`pluginBun`): first on a hook's and an MCP server's PATH, so
   *  their `bun` is it. */
  bin: string;
}

/** True inside a `bun build --compile` binary, whose modules live under `/$bunfs/` (`B:/~BUN/` on Windows). */
const compiled = () => import.meta.path.startsWith("/$bunfs/") || import.meta.path.includes("~BUN");

/** The plugin Bun's file name (lane M's layout): beside clover-core in `<resources>/daemon/` (in `<home>/bin/` for a
 *  server install), and in `dist/dev/` for the dev daemon run under plain Bun. */
export const PLUGIN_BUN_NAME = "clover-plugin-bun";

/** The repository's `dist/dev/`, where `bun run dev:daemon` puts the dev plugin Bun (from source only). */
const DEV_DIST = join(import.meta.dir, "..", "..", "..", "..", "dist", "dev");

/** Where plugin code runs (#234's check 5, K1, the controller's ruling; lane M's layout): a Bun of its own,
 *  `clover-plugin-bun`, the core's version, signed under its own identifier (`com.waifucave.clover.plugin-bun`, `.dev`
 *  for dev), so no Keychain item's access list (which names `clover-core` alone) lets a plugin in. Never the compiled
 *  core's own binary, never with `BUN_BE_BUN`, never a `bun` the plugin or the PATH names.
 *  - a compiled core: the one beside it, failing closed without it;
 *  - from source with a test Keychain service (the test preloads set `CLOVER_KEYCHAIN_SERVICE` to one): the Bun it
 *    runs on, which no access list names;
 *  - from source otherwise (a dev daemon under plain Bun): `dist/dev/clover-plugin-bun`, failing closed without it. */
export function pluginBun(): string {
  return pluginBunFor({ compiled: compiled(), execPath: process.execPath, keychainService: process.env.CLOVER_KEYCHAIN_SERVICE });
}

/** Whether a Keychain service is a test one (the test preloads' `…core.test-isolated`). */
export const isTestKeychainService = (service: string | undefined): boolean => service !== undefined && /(^|[.-])test([.-]|$)/.test(service);

/** `pluginBun`'s rule, for a given binary (tests). */
export function pluginBunFor(o: { compiled: boolean; execPath: string; keychainService?: string; devDist?: string; exists?: (path: string) => boolean; real?: (path: string) => string }): string {
  const exists = o.exists ?? ((p: string) => {
    try {
      return lstatSync(p).isFile() || lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  });
  const real = o.real ?? ((p: string) => realpathSync(p));
  const file = process.platform === "win32" ? `${PLUGIN_BUN_NAME}.exe` : PLUGIN_BUN_NAME;
  if (!o.compiled && isTestKeychainService(o.keychainService)) return o.execPath;
  const path = o.compiled ? join(dirname(o.execPath), file) : join(o.devDist ?? DEV_DIST, file);
  if (!exists(path)) throw new Error(`${PLUGIN_BUN_NAME} isn't at ${path}; plugin code can't run without it`);
  if (o.compiled) {
    let same: boolean;
    try {
      same = real(path) === real(o.execPath);
    } catch {
      same = true;
    }
    if (same) throw new Error(`${PLUGIN_BUN_NAME} is the core's own binary; plugin code never runs on it`);
  }
  return path;
}

/** Whether a command asks for Bun (`bun`, or a path to one): the manifest chooses Bun or not, never which Bun. */
export function isBunCommand(command: string): boolean {
  return /^bun(\.exe)?$/i.test(basename(command.replace(/\\/g, "/")));
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
  const files = { bunfig: join(folder, "bunfig.toml"), guard: join(folder, "guard.mjs"), bin: join(folder, "bin") };
  mkdirSync(files.bin, { recursive: true, mode: 0o700 });
  const bunLink = join(files.bin, process.platform === "win32" ? "bun.exe" : "bun");
  let linked: string | undefined;
  try {
    linked = readlinkSync(bunLink);
  } catch {
    linked = undefined;
  }
  const bun = pluginBun();
  if (linked !== bun) {
    try {
      unlinkSync(bunLink);
    } catch {
      /* none yet */
    }
    symlinkSync(bun, bunLink);
  }
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
const DROPPED_ENV = /^(NODE_OPTIONS|BUN_OPTIONS|NODE_PATH|BUN_BE_BUN|BUN_CONFIG_.+|NODE_EXTRA_CA_CERTS_.+)$/;

/** How a plugin's Bun process starts (a supervised host): the plugin Bun with `args`, and the guarded environment.
 *  The supervisor and the compiled-core probe (`packages/cli/src/plugin-run-probe.ts`) share it. */
export function pluginBunLaunch(args: readonly string[], base: Readonly<Record<string, string | undefined>>, o: { pluginRoot: string; files: PluginRunFiles; shared?: readonly string[] }): { cmd: string[]; env: Record<string, string> } {
  return { cmd: [pluginBun(), ...args], env: guardedPluginEnv(base, o) };
}

/** A plugin's stdio MCP server, as the runtime starts it (#234's checks 4 and 5). Every one, whatever its command, gets
 *  the guarded environment, as a hook does: Clover's flags in `BUN_OPTIONS`, the plugin's folder, the plugin Bun's
 *  folder first on the PATH (so `sh -c "bun server.ts"` runs guarded on it), and empties for what changes loading, so
 *  no merge of the runtime's own environment under it brings `NODE_OPTIONS`, `NODE_PATH`, `BUN_CONFIG_*` or another
 *  `BUN_OPTIONS` back; `BUN_BE_BUN` it never carries, and the guard deletes it. A Bun command runs on the plugin Bun (`pluginBun`); any other program
 *  is the plugin's own, which the OK covers and Clover doesn't confine. Every plugin-sourced stdio entry goes through
 *  this. */
export function guardedMcpServer<E extends { command: string; args?: string[]; env?: Record<string, string> }>(entry: E, pluginRoot: string, guard: PluginRunGuard): E {
  const own = entry.env ?? {};
  const env = guardedPluginEnv({ ...own, PATH: [guard.files.bin, own.PATH ?? process.env.PATH].filter((p) => p !== undefined && p !== "").join(delimiter) }, { pluginRoot, ...guard });
  // Never `BUN_BE_BUN`, not even empty: Bun may take it as set. The runtime's merge copies six baseline names only.
  for (const k of ["NODE_OPTIONS", "NODE_PATH", ...Object.keys(process.env).filter((k) => DROPPED_ENV.test(k) && k !== "BUN_OPTIONS" && k !== "BUN_BE_BUN")]) env[k] = "";
  return { ...entry, ...(isBunCommand(entry.command) ? { command: pluginBun() } : {}), env };
}

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
