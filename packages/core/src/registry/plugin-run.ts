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
// * no `.env` loading (`--no-env-file`), no Bun macros (`--no-macros`, and the guard in every worker), and no
//   inherited `NODE_OPTIONS`, `BUN_OPTIONS` or `NODE_PATH`;
// * Clover's guard preloaded (`--preload`): a Bun plugin whose `onLoad` sees every file the process loads, by its real
//   path after links, and refuses one outside the plugin's tree and Clover's shared packages, whatever its name or
//   loader; `process.dlopen` (native addons) held to the same rule; every worker (`Worker`, `node:worker_threads`)
//   preloading the guard first, pinned to the same plugin folder; and no `ShadowRealm`.
//
// The flags go in `BUN_OPTIONS` too, so a `bun` a hook's shell command starts gets them, whatever its cwd (measured on
// Bun 1.4.4: a plugin folder's `.env` `NODE_OPTIONS=--require <file>` and bunfig `preload` both run without them, and
// neither does with them). The static check (`loaderReach`) stays as `clover plugin validate`'s early error.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync, type Stats } from "node:fs";
import { RESERVED_ENV } from "@waifucave/clover-plugin-sdk";
import { fencedCommand, fencedSpawn, pluginFenceAvailable, SPAWN_TRAMPOLINE_FILE, SPAWN_TRAMPOLINE_SOURCE, toolFence, type ProjectAccess } from "./plugin-fence";
import { PLUGIN_BUN_FILE, pluginBunRequirement } from "../bundled-identities";
import { resolveCloverHome } from "../clover-dir";
import { resolveCloverProfile } from "../profile";
import { checkRunFiles, sha256Hex, writeRunFile, type RunFileCheck } from "../plugin-host/run-file";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";

/** Clover's bunfig for plugin processes: nothing installed at run time. */
export const PLUGIN_BUNFIG = `# Clover's own config for plugin processes; a plugin's bunfig.toml never applies.\n[install]\nauto = "disable"\n`;

/** The guard, preloaded into every plugin process. It reads its plugin's root and the shared roots from the env. */
const GUARD_TEMPLATE = String.raw`// Clover's load guard for a __CLOVER_GUARD_KIND__ (registry/plugin-run.ts). Generated; do not edit.
import { realpathSync, statSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
// Through require, never an ESM import: the plugin's own ESM imports of it then see the wrapped Worker below (measured
// on Bun 1.4.4; an ESM import here would fix its named exports before the wrap).
const workerThreads = createRequire(import.meta.url)("node:worker_threads");
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const fail = (why) => { throw new Error("clover: " + why); };
// What this thread was started with, pinned before any plugin code runs: a worker gets these, never process.env's.
// Never Bun's "be Bun" switch in a plugin's process, whatever started it (#234's check 5, K2).
delete process.env.BUN_BE_BUN;
// One guard per thread: a second one (the host's guard named in a plugin process's arguments, or the plugin's after the
// host's) refuses, so the process ends, whichever loads first.
const GUARDED = Symbol.for("clover.loadGuard");
if (Object.prototype.hasOwnProperty.call(globalThis, GUARDED)) fail("a thread runs one load guard; a second one was preloaded");
Object.defineProperty(globalThis, GUARDED, { value: true, writable: false, configurable: false, enumerable: false });
const guardFile = fileURLToPath(import.meta.url);
// A plugin-host process's own thread (B-M2) runs Clover's code only, never a plugin's, and starts one worker per plugin,
// each pinned to that plugin's folder. Host mode is this file's, not an environment variable's (#322's review, B1): the
// host's guard is a separate file that only the daemon's launch names, and it holds only on a process's main thread
// whose entry is the host bundle beside it. A worker always gets the plugin guard.
const hostThread = __CLOVER_HOST_MODE__;
if (hostThread) {
  if (!workerThreads.isMainThread) fail("the plugin host's guard runs on its process's own thread only");
  if (real(Bun.main) !== real(join(dirname(guardFile), "plugin-host.js"))) fail("the plugin host's guard runs only the plugin host (" + Bun.main + " isn't it)");
}
const rootEnv = hostThread ? undefined : process.env.CLOVER_PLUGIN_ROOT;
const sharedEnv = process.env.CLOVER_PLUGIN_SHARED ?? "[]";
if (!hostThread && (typeof rootEnv !== "string" || rootEnv === "")) fail("a plugin process starts only with its plugin's folder");
if (hostThread) delete process.env.CLOVER_PLUGIN_ROOT;
// A process that holds more than one plugin (the bundled clover tree's) runs no native code of a plugin's (#322's
// review, B3): a worker's bun:ffi or a native addon could read every other worker's memory. The daemon says so to the
// host process alone, and its guard hands it to each worker.
const noNatives = process.env.CLOVER_PLUGIN_NO_NATIVES === "1";
delete process.env.CLOVER_PLUGIN_NO_NATIVES;
if (noNatives && !hostThread) {
  // A preload's onResolve never sees a Bun builtin, so the module itself is disarmed: every export a throwing stub,
  // then frozen (measured on Bun 1.4.4: require and import, static and dynamic, get the stubs, in every thread).
  const ffi = createRequire(import.meta.url)("bun:ffi");
  const none = () => fail("bun:ffi isn't available in a process that holds more than one plugin");
  for (const k of Object.keys(ffi)) Object.defineProperty(ffi, k, { value: typeof ffi[k] === "function" ? none : undefined, writable: false, configurable: false });
  Object.freeze(ffi);
}
const root = hostThread ? undefined : realpathSync(rootEnv);
// The guard's own folder (its run files) loads too: a worker preloads the guard from there.
const shared = [...JSON.parse(sharedEnv), dirname(guardFile)].map(real);
const inside = (p, r) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
// No Bun macros, in every thread (#289): a macro runs its module's code while the file importing it is transpiled. The
// process's --no-macros (and a bunfig's) holds its main thread only: a Worker runs a macro whatever the process was
// started with (measured on Bun 1.4.4), and a plugin host's plugins run in workers. A macro's module resolves from a
// "macro//" importer, which this refuses before it loads. Every other import falls through untouched.
Bun.plugin({
  name: "clover-no-macros",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (/^macro:?\/\//.test(args.importer ?? "")) fail("refused " + args.path + ": a Bun macro (an import with { type: \"macro\" }) runs code while its file loads, and Clover runs none");
      return undefined;
    });
  },
});
// The guard stays registered.
Object.defineProperty(Bun.plugin, "clearAll", { value: () => fail("the load guard stays"), writable: false, configurable: false });
if (!hostThread) {
// A node_modules above the plugin's folder is where Bun looks for a dependency the plugin doesn't ship, and a file there
// without an extension skips onLoad (#234's check 6, L4): this process doesn't start beside one, unless it holds
// Clover's shared packages.
for (let d = dirname(root); ; d = dirname(d)) {
  const nm = d.endsWith(sep) ? d + "node_modules" : d + sep + "node_modules";
  let found = false;
  try { found = statSync(nm).isDirectory(); } catch {}
  if (found && !shared.some((s) => inside(s, real(nm)))) fail("a node_modules folder at " + nm + " is above the plugin's folder; remove or move it (or move the plugin)");
  if (dirname(d) === d) break;
}
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
// A native addon loads through process.dlopen: held to the same rule; refused outright where natives are off; and a
// bundled plugin's checked against the digest its staging verified (the worker publishes the check, S2).
const dlopen = process.dlopen.bind(process);
const verifiedNative = (filename) => {
  const check = globalThis[Symbol.for("clover.verifiedFile")];
  if (typeof check === "function") check(filename);
};
Object.defineProperty(process, "dlopen", {
  value: (module, filename, ...rest) => {
    if (noNatives) fail("refused " + filename + ": a native addon doesn't load in a process that holds more than one plugin");
    if (!allowed(filename)) refuse(filename);
    verifiedNative(filename);
    return dlopen(module, filename, ...rest);
  },
  writable: false, configurable: false,
});
}
// Every worker runs the guard first, with this thread's plugin folder (never one the plugin set in process.env). A
// host thread's worker is one plugin's: the host names its folder (the option cloverPluginRoot), and it is required.
const guarded = (opts) => {
  const o = opts !== null && typeof opts === "object" ? { ...opts } : {};
  const named = o.cloverPluginRoot;
  delete o.cloverPluginRoot;
  const workerRoot = hostThread ? named : rootEnv;
  if (typeof workerRoot !== "string" || workerRoot === "") fail("a plugin host's worker starts only with its plugin's folder");
  const own = o.preload === undefined ? [] : [].concat(o.preload);
  const env = { ...(o.env !== null && typeof o.env === "object" ? o.env : process.env) };
  // A host's worker runs the plugin guard (never the host's), and a Bun its plugin starts gets the plugin flags.
  if (hostThread) env.BUN_OPTIONS = __CLOVER_WORKER_BUN_OPTIONS__;
  if (hostThread && noNatives) env.CLOVER_PLUGIN_NO_NATIVES = "1";
  return { ...o, preload: [hostThread ? __CLOVER_WORKER_GUARD__ : guardFile, ...own], env: { ...env, CLOVER_PLUGIN_ROOT: workerRoot, CLOVER_PLUGIN_SHARED: sharedEnv } };
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

const fill = (template: string, values: Record<string, string>): string =>
  Object.entries(values).reduce((text, [k, v]) => text.split(k).join(v), template);

/** The guard preloaded into every plugin process and every plugin's worker. */
export const PLUGIN_GUARD_SOURCE = fill(GUARD_TEMPLATE, {
  __CLOVER_GUARD_KIND__: "plugin process", __CLOVER_HOST_MODE__: "false", __CLOVER_WORKER_BUN_OPTIONS__: "undefined", __CLOVER_WORKER_GUARD__: "undefined",
});

/** The plugin host's guard (B-M2): preloaded by the host process's own arguments only (`hostProcessLaunch`). Its
 *  workers get the plugin guard (`files.guard`) and the plugin flags. */
export function pluginHostGuardSource(files: Pick<PluginRunFiles, "guard" | "bunfig">): string {
  return fill(GUARD_TEMPLATE, {
    __CLOVER_GUARD_KIND__: "plugin-host process", __CLOVER_HOST_MODE__: "true",
    __CLOVER_WORKER_BUN_OPTIONS__: JSON.stringify(pluginBunFlags(files).join(" ")), __CLOVER_WORKER_GUARD__: JSON.stringify(files.guard),
  });
}

export interface PluginRunFiles {
  bunfig: string;
  guard: string;
  /** The plugin host's guard (`pluginHostGuardSource`), named only in the host process's arguments. */
  hostGuard: string;
  /** The Clover home whose `bin/` holds the dev plugin Bun (`pluginBun`): the daemon's own. */
  cloverHome: string;
  /** A folder holding `bun`, a link to the plugin Bun (`pluginBun`): first on a hook's and an MCP server's PATH, so
   *  their `bun` is it. */
  bin: string;
}

/** True inside a `bun build --compile` binary, whose modules live under `/$bunfs/` (`B:/~BUN/` on Windows). */
const compiled = () => import.meta.path.startsWith("/$bunfs/") || import.meta.path.includes("~BUN");

/** The plugin Bun's file name (`bundled-identities.ts`). */
export const PLUGIN_BUN_NAME = PLUGIN_BUN_FILE;

/** Where plugin code runs (#234's checks 5 and 6, the controller's rulings; lane M's layout): a Bun of its own,
 *  `clover-plugin-bun`, the core's version, signed under its own identifier, so no Keychain item's access list (which
 *  names `clover-core` alone) lets plugin code in. Never the core's own binary, never with `BUN_BE_BUN`, never a `bun`
 *  the plugin or the PATH names.
 *  - a packaged core (compiled, the dist profile): the one beside it (`<resources>/daemon/`, or `<home>/bin/` for a
 *    server), signed by Clover's team under `com.waifucave.clover.plugin-bun`;
 *  - from source with a test Keychain service (the test preloads set `CLOVER_KEYCHAIN_SERVICE` to one): the Bun it
 *    runs on, which no access list names;
 *  - otherwise (the dev daemon, compiled or under plain Bun): `<Clover home>/bin/clover-plugin-bun`, which
 *    `dev:daemon` makes and whose digest (macOS: its cdhash) it records beside it, inside the home no runner writes.
 *  Every one is checked (`checkPluginBun`) once per process and again whenever the file changes, and a failed check
 *  refuses: plugin code doesn't run. */
export function pluginBun(cloverHome: string = resolveCloverHome()): string {
  return pluginBunFor({
    compiled: compiled(), execPath: process.execPath, profile: resolveCloverProfile(), keychainService: process.env.CLOVER_KEYCHAIN_SERVICE,
    cloverHome,
  });
}

/** Whether a Keychain service is a test one (the test preloads' `…core.test-isolated`). */
export const isTestKeychainService = (service: string | undefined): boolean => service !== undefined && /(^|[.-])test([.-]|$)/.test(service);

export interface PluginBunOptions {
  compiled: boolean;
  execPath: string;
  profile: "dist" | "dev";
  keychainService?: string;
  cloverHome: string;
  platform?: NodeJS.Platform;
  /** The macOS requirement a shipped copy must meet (`pluginBunRequirement()` by default; tests pass their own). */
  requirement?: string;
}

/** `pluginBun`'s rule for a given process (tests). */
export function pluginBunFor(o: PluginBunOptions): string {
  const platform = o.platform ?? process.platform;
  if (!o.compiled && isTestKeychainService(o.keychainService)) return o.execPath;
  const file = platform === "win32" ? `${PLUGIN_BUN_FILE}.exe` : PLUGIN_BUN_FILE;
  const shipped = o.compiled && o.profile === "dist";
  const folder = shipped ? dirname(o.execPath) : join(o.cloverHome, "bin");
  const path = join(folder, file);
  checkPluginBun({ path, folder, core: o.execPath, platform, kind: shipped ? "shipped" : "dev", requirement: o.requirement ?? pluginBunRequirement() });
  return path;
}

/** The checks' results, by what the file and the core were when checked: a check runs once per process and again only
 *  when either changes (inode, size, times). */
const checked = new Map<string, string>();
/** Windows: each plugin Bun's SHA-256 as first accepted in this process; a later launch re-hashes it and refuses a
 *  change, since there the times can't be trusted to show one. */
const acceptedOnWindows = new Map<string, string>();

/** Refuses (throws) unless `path` is a plugin Bun Clover made: a plain file (never a link) whose real path sits in
 *  `folder`, sharing no inode or content with the core, and either signed by Clover's team under the plugin Bun's
 *  identifier (`shipped`, macOS) or matching the digest `dev:daemon` recorded beside it (`dev`). */
export function checkPluginBun(o: { path: string; folder: string; core: string; platform: NodeJS.Platform; kind: "shipped" | "dev"; requirement: string }): void {
  const refuse = (why: string): never => {
    throw new Error(`${PLUGIN_BUN_FILE} at ${o.path} ${why}; plugin code can't run`);
  };
  let st: Stats;
  try {
    st = lstatSync(o.path);
  } catch {
    return refuse("is missing");
  }
  if (st.isSymbolicLink() || !st.isFile()) refuse("isn't a plain file");
  const coreReal = realpathSync(o.core);
  const core = statSync(coreReal);
  const digestFile = `${o.path}.digest`;
  let digestStat: Stats | undefined;
  try {
    digestStat = lstatSync(digestFile);
  } catch {
    digestStat = undefined;
  }
  const key = JSON.stringify([o, st.ino, st.dev, st.size, st.mtimeMs, st.ctimeMs, core.ino, core.mtimeMs, digestStat?.ino, digestStat?.mtimeMs, digestStat?.ctimeMs]);
  // On Windows a user can set a file's NTFS ChangeTime, so the times don't prove it unchanged: there every launch checks
  // again, hashing the file (the dev copy's digest, the shipped copy against the core's), with no cache.
  if (o.platform !== "win32" && checked.get(o.path) === key) return;
  checked.delete(o.path);
  if (dirname(realpathSync(o.path)) !== realpathSync(o.folder)) refuse(`isn't in ${o.folder}`);
  if (st.ino === core.ino && st.dev === core.dev) refuse("is the core's own binary (a hard link)");
  if (st.size === core.size && sha256File(o.path) === sha256File(coreReal)) refuse("is a copy of the core's own binary");
  // A shipped copy's signature is checked on macOS only: on Linux and Windows a shipped plugin Bun has no signature
  // check, which is acceptable because no secret there is tied to a code identity (the Secret Service and the
  // Credential Manager don't admit a process by its signature), so a swapped binary gains no secret the user's own
  // processes couldn't already reach. The file checks above still hold there.
  if (o.kind === "shipped") {
    if (o.platform === "darwin" && !codesignSatisfies(o.path, o.requirement)) refuse("isn't signed by Clover's team as the plugin Bun");
  } else {
    if (digestStat === undefined || digestStat.isSymbolicLink() || !digestStat.isFile()) refuse("has no digest recorded beside it (run `bun run dev:daemon`)");
    const recorded = readFileSync(digestFile, "utf8").trim();
    const actual = pluginBunDigest(o.path, o.platform);
    if (actual === undefined || recorded !== actual) refuse("isn't the copy `dev:daemon` made (its digest doesn't match the one recorded)");
  }
  if (o.platform === "win32") {
    const hash = sha256File(o.path);
    const first = acceptedOnWindows.get(o.path);
    if (first !== undefined && first !== hash) refuse("changed since this process first accepted it");
    acceptedOnWindows.set(o.path, hash);
  } else checked.set(o.path, key);
}

/** A plugin Bun's digest as `dev:daemon` records it: on macOS its cdhash, once its signature verifies (`cdhash:<hex>`);
 *  elsewhere its SHA-256 (`sha256:<hex>`). Undefined when the signature doesn't verify. */
export function pluginBunDigest(path: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "darwin") return `sha256:${sha256File(path)}`;
  if (spawnSync("/usr/bin/codesign", ["--verify", "--strict", path], { stdio: "ignore" }).status !== 0) return undefined;
  const shown = spawnSync("/usr/bin/codesign", ["-dvvv", path], { encoding: "utf8" });
  const m = /^CDHash=([0-9a-f]{40,64})$/m.exec(`${shown.stdout ?? ""}\n${shown.stderr ?? ""}`);
  return m === null ? undefined : `cdhash:${m[1]}`;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** macOS: whether the signature verifies (`--strict`) and meets `requirement`. */
function codesignSatisfies(path: string, requirement: string): boolean {
  return spawnSync("/usr/bin/codesign", ["--verify", "--strict", `-R=${requirement}`, path], { stdio: "ignore" }).status === 0;
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
  /** The plugin-process fence (`plugin-fence.ts`, 2f): on by default where the OS has one; false runs unfenced (tests
   *  of what the load guard alone holds); `userHome` names the home it denies (tests pass a temp one). */
  fence?: false | { userHome?: string };
  /** A plugin tree's network proxy (2g, `startPluginHost`'s `proxyFor`): a fenced process reaches the network only
   *  through it; with none, not at all. */
  proxyFor?: (pluginId: string) => { port: number; env: Record<string, string> } | undefined;
}

/** Writes Clover's bunfig and guard for plugin processes into `dir` (the daemon's run folder), and returns their paths.
 *  `BUN_OPTIONS` splits on spaces and takes no quotes (measured on Bun 1.4.4), so the run folder's path may have none:
 *  a Clover home whose path has a space starts no plugin process, and says why. Never a folder in the shared temp
 *  folder, where one plugin's process could rewrite the guard the others load (#345's review). */
export function ensurePluginRunFiles(dir: string, o: { cloverHome: string }): PluginRunFiles {
  const folder = join(dir, "plugin-run");
  if (/\s/.test(folder)) throw new Error(`plugin processes can't start: the Clover home's run folder (${folder}) has a space in its path, which Bun's options can't carry`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  // The guard is only as good as its file: the folder must be a real one of this user's that no one else can write.
  const st = lstatSync(folder);
  const uid = process.getuid?.();
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o022) !== 0) {
    throw new Error(`${folder} is not a private folder of this user's; plugin processes can't start`);
  }
  // Always named by the caller, never `~/.clover` by default: a fenced process's temp and data folders are made under
  // it, so a default would put a test's folders in the real home (#345).
  const cloverHome = o.cloverHome;
  // Every run file by its real path (`/var` is `/private/var` on macOS): a fenced process can't resolve a link through
  // a folder it may only stat, so what it's handed must need no resolving (2f).
  const real = realpathSync(folder);
  const files: PluginRunFiles = { bunfig: join(real, "bunfig.toml"), guard: join(real, "guard.mjs"), hostGuard: join(real, "host-guard.mjs"), bin: join(real, "bin"), cloverHome };
  mkdirSync(files.bin, { recursive: true, mode: 0o700 });
  const bunLink = join(files.bin, process.platform === "win32" ? "bun.exe" : "bun");
  let linked: string | undefined;
  try {
    linked = readlinkSync(bunLink);
  } catch {
    linked = undefined;
  }
  const bun = pluginBun(cloverHome);
  if (linked !== bun) {
    try {
      unlinkSync(bunLink);
    } catch {
      /* none yet */
    }
    symlinkSync(bun, bunLink);
  }
  // Written whole, never through a planted link (plugin-host/run-file.ts); `pluginRunFileChecks` names what each
  // start then checks.
  for (const [path, text] of [[files.bunfig, PLUGIN_BUNFIG], [files.guard, PLUGIN_GUARD_SOURCE], [files.hostGuard, pluginHostGuardSource(files)], [join(real, SPAWN_TRAMPOLINE_FILE), SPAWN_TRAMPOLINE_SOURCE]] as const) {
    writeRunFile(path, text);
  }
  return files;
}

/** The run files a plugin process starts from, with the SHA-256 of the text Clover writes into each: the bunfig and
 *  the plugin guard for every plugin process (and each host worker), the host guard too for a host process. Checked
 *  (`checkRunFiles`) immediately before the start, so a file a plugin rewrote refuses it (#312's review, S1). */
export function pluginRunFileChecks(files: PluginRunFiles, o: { host?: boolean } = {}): RunFileCheck[] {
  return [
    { path: files.bunfig, sha256: sha256Hex(PLUGIN_BUNFIG) },
    { path: files.guard, sha256: sha256Hex(PLUGIN_GUARD_SOURCE) },
    // The spawn trampoline a fenced start runs through (#357), beside the guard.
    { path: join(dirname(files.guard), SPAWN_TRAMPOLINE_FILE), sha256: sha256Hex(SPAWN_TRAMPOLINE_SOURCE) },
    ...(o.host === true ? [{ path: files.hostGuard, sha256: sha256Hex(pluginHostGuardSource(files)) }] : []),
  ];
}

/** The Bun flags every plugin process runs with. */
export function pluginBunFlags(files: Pick<PluginRunFiles, "bunfig" | "guard">): string[] {
  return [`--config=${files.bunfig}`, "--no-env-file", "--no-macros", `--preload=${files.guard}`];
}

/** The plugin host process's flags: the plugin flags with the host's guard in place of the plugin guard. */
export function pluginHostBunFlags(files: PluginRunFiles): string[] {
  return [`--config=${files.bunfig}`, "--no-env-file", "--no-macros", `--preload=${files.hostGuard}`];
}

/** Variables a plugin process never inherits: they change what Bun or Node loads, or they're what Clover's guard and
 *  host read, which only Clover sets (#322's review, B1). */
const DROPPED_ENV_SOURCE = "^(NODE_OPTIONS|BUN_OPTIONS|NODE_PATH|BUN_BE_BUN|BUN_CONFIG_.+|NODE_EXTRA_CA_CERTS_.+|CLOVER_PLUGIN_(HOST|ROOT|SHARED|WORKER|NO_NATIVES))$";
/** On Windows environment names are case-insensitive (`node_options` is NODE_OPTIONS), so there they match without case. */
export const droppedEnv = (platform: NodeJS.Platform = process.platform): RegExp => new RegExp(DROPPED_ENV_SOURCE, platform === "win32" ? "i" : "");
const DROPPED_ENV = droppedEnv();

/** Names a plugin's manifest never sets in a process's environment (#322's review, B1): Clover's own (`CLOVER_*`), and
 *  what changes how Bun, Node or the dynamic loader loads code. `NODE_ENV` and `NODE_NO_WARNINGS` load nothing. The
 *  SDK's validation refuses the same (`reserved_env`). */
export const RESERVED_PLUGIN_ENV = RESERVED_ENV;

/** Throws, naming each one, when `env` (a plugin manifest's) sets a reserved name (`RESERVED_PLUGIN_ENV`). */
export function refuseReservedPluginEnv(env: Readonly<Record<string, string>> | undefined, what: string): void {
  const reserved = Object.keys(env ?? {}).filter((k) => RESERVED_PLUGIN_ENV.test(k)).sort();
  if (reserved.length > 0) throw new Error(`${what} sets ${reserved.join(", ")} in its environment, which only Clover sets; it doesn't start`);
}

/** How a plugin's Bun process starts (a supervised host): the plugin Bun with `args`, and the guarded environment.
 *  The supervisor and the compiled-core probe (`packages/cli/src/plugin-run-probe.ts`) share it. */
export function pluginBunLaunch(args: readonly string[], base: Readonly<Record<string, string | undefined>>, o: { pluginRoot: string; files: PluginRunFiles; shared?: readonly string[] }): { cmd: string[]; env: Record<string, string> } {
  return { cmd: [pluginBun(o.files.cloverHome), ...args], env: guardedPluginEnv(base, o) };
}

/** A plugin's stdio MCP server, as the runtime starts it (#234's checks 4 and 5). Every one, whatever its command, gets
 *  the guarded environment, as a hook does: Clover's flags in `BUN_OPTIONS`, the plugin's folder, the plugin Bun's
 *  folder first on the PATH (so `sh -c "bun server.ts"` runs guarded on it), and empties for what changes loading, so
 *  no merge of the runtime's own environment under it brings `NODE_OPTIONS`, `NODE_PATH`, `BUN_CONFIG_*` or another
 *  `BUN_OPTIONS` back; `BUN_BE_BUN` it never carries, and the guard deletes it. A Bun command runs on the plugin Bun (`pluginBun`); any other program
 *  is the plugin's own, which the OK covers and Clover doesn't confine. Every plugin-sourced stdio entry goes through
 *  this. */
export function guardedMcpServer<E extends { command: string; args?: string[]; env?: Record<string, string> }>(entry: E, pluginRoot: string, guard: PluginRunGuard, pluginId?: string, project?: ProjectAccess): E {
  const own = entry.env ?? {};
  refuseReservedPluginEnv(own, `the plugin MCP server at ${pluginRoot} (${basename(entry.command)})`);
  // The runtime starts the server later; this is the last moment Clover holds it: the bunfig and guard it will preload
  // are checked here (#312's review, S1), so a rewritten one refuses the hand-off.
  checkRunFiles(pluginRunFileChecks(guard.files), `the plugin MCP server at ${pluginRoot}`);
  const env = guardedPluginEnv({ ...own, PATH: [guard.files.bin, own.PATH ?? process.env.PATH].filter((p) => p !== undefined && p !== "").join(delimiter) }, { pluginRoot, ...guard });
  // Never `BUN_BE_BUN`, not even empty: Bun may take it as set. The runtime's merge copies six baseline names only.
  for (const k of ["NODE_OPTIONS", "NODE_PATH", ...Object.keys(process.env).filter((k) => DROPPED_ENV.test(k) && k !== "BUN_OPTIONS" && k !== "BUN_BE_BUN")]) env[k] = "";
  const command = isBunCommand(entry.command) ? pluginBun(guard.files.cloverHome) : entry.command;
  // Under the fence (2f): the command runs through sandbox-exec with a profile for this plugin.
  if (guard.fence !== false && pluginFenceAvailable()) {
    const proxy = pluginId !== undefined ? guard.proxyFor?.(pluginId) : undefined;
    const { fence, env: toolEnv } = toolFence({ files: guard.files, shared: guard.shared ?? cloverSharedRoots(), pluginRoot, ...(pluginId !== undefined ? { pluginId } : {}), ...(guard.fence?.userHome ? { userHome: guard.fence.userHome } : {}), name: `mcp-${pluginId ?? basename(pluginRoot)}`, ...(project !== undefined ? { project } : {}), ...(proxy !== undefined ? { proxyPort: proxy.port } : {}) });
    Object.assign(env, toolEnv, proxy?.env ?? {});
    // Started by the runtime, in the folder it chooses; the trampoline makes it its own TCC-responsible process.
    const spawned = fencedSpawn({ cmd: [command, ...(entry.args ?? [])], env, fence, files: guard.files });
    const [cmd, ...args] = spawned.cmd;
    return { ...entry, command: cmd!, args, env: spawned.env };
  }
  return { ...entry, command, env };
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

/** The first `node_modules` folder above `pluginRoot`, to the filesystem root, that doesn't hold one of Clover's shared
 *  package roots, or undefined (#234's check 6, L4). Bun looks there for a dependency a plugin doesn't ship, including
 *  one a computed `import()` names, which no static check can read, so a plugin process doesn't start beside one. */
export function nodeModulesAbove(pluginRoot: string, shared: readonly string[]): string | undefined {
  let root: string;
  try {
    root = realpathSync(pluginRoot);
  } catch {
    root = resolve(pluginRoot);
  }
  const holds = (folder: string) => shared.some((s) => s === folder || s.startsWith(folder.endsWith(sep) ? folder : folder + sep));
  for (let d = dirname(root); ; d = dirname(d)) {
    const nm = join(d, "node_modules");
    let real: string | undefined;
    try {
      real = statSync(nm).isDirectory() ? realpathSync(nm) : undefined;
    } catch {
      real = undefined;
    }
    if (real !== undefined && !holds(real)) return nm;
    if (dirname(d) === d) return undefined;
  }
}

/** Throws, naming the folder, when a `node_modules` sits above the plugin's folder (`nodeModulesAbove`). */
export function refuseNodeModulesAbove(pluginRoot: string, shared: readonly string[]): void {
  const nm = nodeModulesAbove(pluginRoot, shared);
  if (nm !== undefined) {
    throw new Error(`a node_modules folder at ${nm} is above the plugin's folder ${pluginRoot}: Bun would look there for a dependency the plugin doesn't ship, so its code doesn't run. Remove or move ${nm}, or move the plugin (a development folder) somewhere without one above it`);
  }
}

/** `base` without the dropped names. On Windows, where a name's case doesn't matter, each name is written in capitals
 *  first, so `Path` and `PATH` (or `node_options` and the guard's own names) can't both reach the process and leave which
 *  one wins to the OS (#322's reviewer); the later one in `base` wins. */
export function envWithoutDropped(base: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = {};
  const dropped = platform === process.platform ? DROPPED_ENV : droppedEnv(platform);
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || dropped.test(k)) continue;
    env[platform === "win32" ? k.toUpperCase() : k] = v;
  }
  return env;
}

/** A plugin process's environment: `base` without what changes loading, Clover's flags in `BUN_OPTIONS`, and what the
 *  guard reads. `pluginRoot` is the plugin's top-level folder. */
export function guardedPluginEnv(base: Readonly<Record<string, string | undefined>>, o: { pluginRoot: string; files: PluginRunFiles; shared?: readonly string[] }): Record<string, string> {
  const env = envWithoutDropped(base);
  env.BUN_OPTIONS = pluginBunFlags(o.files).join(" ");
  let root: string;
  try {
    root = realpathSync(o.pluginRoot);
  } catch {
    root = resolve(o.pluginRoot); // missing: the guard's own realpath fails, and the process loads nothing
  }
  env.CLOVER_PLUGIN_ROOT = root;
  const shared = o.shared ?? cloverSharedRoots();
  refuseNodeModulesAbove(root, shared);
  env.CLOVER_PLUGIN_SHARED = JSON.stringify(shared);
  return env;
}
