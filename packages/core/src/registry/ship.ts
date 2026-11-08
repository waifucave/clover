// Building a plugin for shipping (the controller's ruling of November 6: bundled plugins ship BUILT; agreed with lane
// M, who wires it into the release and measures its output into the core's bundled-plugins manifest).
//
// `buildPluginForShipping(folder, { target })` turns a top-level plugin folder, its children included, into the tree
// an install carries, through the registry's own builder (`build.ts`):
//
// * each client entry becomes one ES module, with only `CLIENT_BARE_IMPORTS` left as imports, and the stylesheets its
//   CSS imports listed in `client.css`;
// * each host entry, and each program a `stdio` server or agent backend runs with `bun` or `node` (a file of the
//   plugin's, its first argument), becomes one ES module with its dependencies bundled in;
// * a native addon (a package with prebuilt platform packages, such as node-datachannel, or a `.node` of its own) is
//   left as an import and shipped in the plugin's own `node_modules`, with its dependencies and the prebuilt binary
//   for `target` (from this checkout's install when it is that one, else the registry's tarball, checked against the
//   lockfile's integrity), and reported in `natives`;
// * the manifests are rewritten to name the built files and marked `built: true`; a `package.json` is cut down to
//   what running needs (`type: module`, the natives); TypeScript sources, tests, `tsconfig`, `bunfig.toml`, lockfiles,
//   `.env` files and `node_modules` are left out, and every other file is copied as it is.
//
// The built tree is then validated as a plugin: an error the source tree doesn't have (a file the build dropped) fails
// the build. Nothing here runs plugin code: the builds run with Bun's macros off (build.ts), so a plugin file's
// `with { type: "macro" }` import fails the build instead of running in this process.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import { CLIENT_BARE_IMPORTS, MANIFEST_FILE, parseJsonc, validateTree } from "@waifucave/clover-plugin-sdk";
import type { ValidationIssue } from "@waifucave/clover-protocol";
import { buildMachineStrings, buildPluginModule, builtModulePath, forbiddenIn, isRuntimeBuiltin, packageOfSpecifier, PluginBuildError, runtimeLoadProblems, type BuildSide, type Forbidden } from "./build";
import { folderReader } from "./tree";

/** The platforms a release builds for (the daemon's targets). */
export const SHIP_TARGETS = ["darwin-arm64", "linux-x64", "linux-arm64", "windows-x64"] as const;
export type ShipTarget = (typeof SHIP_TARGETS)[number];

/** How a target reads in a package's `os`, `cpu` and `libc` (npm's names). Linux builds take glibc's binaries. */
const TARGET_PLATFORM: Readonly<Record<ShipTarget, { os: string; cpu: string; libc?: string }>> = {
  "darwin-arm64": { os: "darwin", cpu: "arm64" },
  "linux-x64": { os: "linux", cpu: "x64", libc: "glibc" },
  "linux-arm64": { os: "linux", cpu: "arm64", libc: "glibc" },
  "windows-x64": { os: "win32", cpu: "x64" },
};

/** The target this process runs on, or undefined. */
export function hostShipTarget(): ShipTarget | undefined {
  const t = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  return (SHIP_TARGETS as readonly string[]).includes(t) ? (t as ShipTarget) : undefined;
}

export interface ShipOptions {
  target: ShipTarget;
  /** The folder to write the built tree to; it must not exist, or be empty. Default: a new temp folder. */
  out?: string;
  /** Which of the folder's files (relative to it, with `/`) may be copied into the built tree: lane M passes the
   *  committed files. Default: all. The builds read what the entries import. */
  include?: (rel: string) => boolean;
  /** The lockfile that pins the natives' prebuilt packages (`bun.lock`). Default: the nearest one above the folder. */
  lockfile?: string;
  /** Downloads a prebuilt package's tarball. Default: `fetch`. */
  download?: (url: string) => Promise<Uint8Array>;
  /** A bundled tree (`clover`, `alpha`): validated with the bundled names, its manifests marked `built: true`, and its
   *  natives' prebuilt packages always downloaded and checked against the lockfile (#271's ruling M2). */
  bundled?: boolean;
  /** A development build (the dev daemon's stage): a native's platform package may come from this checkout's install,
   *  when its name and version are the lockfile's. Never for a release. */
  dev?: boolean;
}

/** A module of the built tree: its path in it (with `/`), which side runs it, and its text. `host` covers programs. */
export interface ShippedModule {
  file: string;
  kind: "client" | "host";
  source: string;
}

/** A native addon's binary in the built tree, for `target`. */
export interface ShippedNative {
  file: string;
  /** The package the plugin's code imports (`node-datachannel`). */
  package: string;
  target: ShipTarget;
}

export interface ShippedPlugin {
  /** The built tree. */
  dir: string;
  /** Every file in it, relative to it, with `/`, sorted. */
  files: string[];
  modules: ShippedModule[];
  natives: ShippedNative[];
}

/** Files and folders that never ship (lane M's release filter, plus sources and loader configs). */
/** `gallery` is a part's CI-only story renderer (docs/clover-layout.md "A gallery"), never part of what runs. */
const LEFT_OUT_DIRS = new Set(["node_modules", ".git", "test", "tests", "__tests__", "gallery"]);
const LEFT_OUT_FILE = /^(?:tsconfig.*\.json|bunfig\.toml|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.DS_Store|\.env.*|.*\.(?:test|spec)\.[cm]?[jt]sx?|.*\.(?:[cm]?ts|tsx|jsx))$/;
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** One plugin of the tree: the top-level one (`base` "") or a child (`plugins/<id>/`). */
interface Unit {
  base: string;
  manifest: Json;
}

/** Builds a plugin folder for shipping (see the file's header). Throws `PluginBuildError` naming every problem. */
export async function buildPluginForShipping(folder: string, o: ShipOptions): Promise<ShippedPlugin> {
  if (!(SHIP_TARGETS as readonly string[]).includes(o.target)) throw new PluginBuildError([`unknown target ${String(o.target)}; one of ${SHIP_TARGETS.join(", ")}`]);
  const src = realpathSync(folder);
  const out = prepareOut(o.out);
  try {
    return await ship(src, out, o);
  } catch (e) {
    rmSync(out, { recursive: true, force: true });
    const [, ...checkout] = checkoutRoots(src, o);
    throw scrubbed(e, [[src, "<plugin>"], [out, "<out>"], ...checkout.map((c) => [c, "<checkout>"] as [string, string]), [homedir(), "~"]]);
  }
}

/** The folders a build error may not name (#271's L5): the plugin's checkout, the plugin itself, the output. */
function checkoutRoots(src: string, o: ShipOptions): string[] {
  let lock: string | undefined;
  try {
    lock = dirname(o.lockfile ?? findLockfile(src));
  } catch {
    lock = undefined;
  }
  return [src, ...(lock === undefined ? [] : [lock])];
}

/** A build error with every absolute path under `roots` written relative (`<checkout>/…`), so a release log or
 *  artefact that carries it names no folder of the computer that built it. */
function scrubbed(e: unknown, roots: readonly (readonly [string, string])[]): unknown {
  const sorted = roots.flatMap(([r, label]) => [...new Set([r, r.replaceAll("\\", "/")])].map((v) => [v, label] as const)).filter(([r]) => r.length > 1).sort((a, b) => b[0].length - a[0].length);
  const scrub = (text: string) => sorted.reduce((t, [r, label]) => t.replaceAll(r, label), text);
  if (e instanceof PluginBuildError) return new PluginBuildError(e.problems.map(scrub));
  if (e instanceof Error) return new PluginBuildError([scrub(e.message)]);
  return e;
}

function prepareOut(out: string | undefined): string {
  if (out === undefined) return realpathSync(mkdtempSync(join(tmpdir(), "clover-ship-")));
  if (existsSync(out) && readdirSync(out).length > 0) throw new PluginBuildError([`${out} isn't empty; the built tree goes in a new folder`]);
  mkdirSync(out, { recursive: true });
  return realpathSync(out);
}

async function ship(src: string, out: string, o: ShipOptions): Promise<ShippedPlugin> {
  const natives = new NativeShipper(src, out, o);
  try {
    return await shipWith(src, out, o, natives);
  } finally {
    natives.cleanup();
  }
}

async function shipWith(src: string, out: string, o: ShipOptions, natives: NativeShipper): Promise<ShippedPlugin> {
  const units = readUnits(src);
  const include = o.include ?? (() => true);
  const sides = new Map<string, BuildSide>();
  const forbid = machineStrings(src, out, o);
  const modules: ShippedModule[] = [];
  const written = new Set<string>();
  const problems: string[] = [];

  for (const unit of units) {
    const m = unit.manifest;
    const build = async (entry: string, side: BuildSide): Promise<{ rel: string; css: string[] } | undefined> => {
      const rel = posix.normalize(`${unit.base}${entry.replace(/^\.\//, "")}`);
      if (rel.startsWith("../") || !CODE_FILE.test(rel)) {
        problems.push(`${unit.base}${MANIFEST_FILE}: ${entry} isn't a module of the plugin's`);
        return undefined;
      }
      const outRel = builtModulePath(rel);
      const had = sides.get(outRel);
      if (had === side) return { rel: outRel, css: [] };
      if (had !== undefined || written.has(outRel)) {
        problems.push(`${unit.base}${MANIFEST_FILE}: ${entry} would be built to ${outRel}, which another entry already is`);
        return undefined;
      }
      sides.set(outRel, side);
      try {
        const built = await buildPluginModule({
          entry: join(src, ...rel.split("/")),
          outFile: join(out, ...outRel.split("/")),
          side,
          forbid,
          keepExternal: side === "client" ? undefined : (spec, importer) => natives.keep(spec, importer, unit.base),
        });
        written.add(outRel);
        modules.push({ file: outRel, kind: side === "client" ? "client" : "host", source: built.source });
        const extra = [...built.css, ...built.assets].map((p) => relative(out, p).split(sep).join("/"));
        for (const x of extra) written.add(x);
        return { rel: outRel, css: built.css.map((p) => relative(join(out, ...unit.base.split("/").filter(Boolean)), p).split(sep).join("/")) };
      } catch (e) {
        if (e instanceof PluginBuildError) problems.push(...e.problems.map((p) => `${unit.base}${MANIFEST_FILE}: ${p}`));
        else throw e;
        return undefined;
      }
    };

    if (isObject(m.host) && typeof m.host.entry === "string") {
      const r = await build(m.host.entry, m.host.runtime === "node" ? "node" : "bun");
      if (r) m.host = { ...m.host, entry: r.rel.slice(unit.base.length) };
    }
    if (isObject(m.client) && typeof m.client.entry === "string") {
      const r = await build(m.client.entry, "client");
      if (r) {
        const css = Array.isArray(m.client.css) ? (m.client.css as unknown[]).filter((c): c is string => typeof c === "string") : [];
        m.client = { ...m.client, entry: r.rel.slice(unit.base.length), ...(css.length + r.css.length > 0 ? { css: [...css, ...r.css.filter((c) => !css.includes(c))] } : {}) };
      }
    }
    for (const prog of programs(m, unit.base, (rel) => existsSync(join(src, ...rel.split("/"))), problems)) {
      const arg = prog.args[prog.at]!;
      const r = await build(arg, prog.side);
      if (r) prog.args[prog.at] = r.rel.slice(unit.base.length);
    }
    if (o.bundled === true) m.built = true;
  }
  if (problems.length > 0) throw new PluginBuildError(problems);

  // The rest of the folder, as it is.
  copyTree(src, out, "", (rel) => include(rel) && !written.has(rel) && basename(rel) !== MANIFEST_FILE && basename(rel) !== "package.json", written);
  for (const unit of units) {
    const dir = join(out, ...unit.base.split("/").filter(Boolean));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(unit.manifest, null, 2)}\n`);
    written.add(`${unit.base}${MANIFEST_FILE}`);
  }
  const shippedNatives = await natives.finish(written);
  // JavaScript the folder ships as it is gets the built modules' checks too (#271's M1).
  const nativePackages = new Set(shippedNatives.map((n) => n.package));
  const copiedProblems: string[] = [];
  for (const rel of [...written].filter((f) => /\.[cm]?js$/.test(f) && !f.split("/").includes("node_modules") && !modules.some((m) => m.file === f)).sort()) {
    const text = readFileSync(join(out, ...rel.split("/")), "utf8");
    const allowed = (spec: string) => isRuntimeBuiltin(spec) || (CLIENT_BARE_IMPORTS as readonly string[]).includes(spec) || nativePackages.has(packageOfSpecifier(spec));
    for (const i of new Bun.Transpiler({ loader: "js", ...({ macro: false } as object) }).scanImports(text)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(i.path) && !i.path.startsWith("node:") && !i.path.startsWith("bun:")) copiedProblems.push(`${rel}: imports ${i.path}, a URL`);
      else if (!i.path.startsWith(".") && !i.path.startsWith("/") && !allowed(i.path)) copiedProblems.push(`${rel}: imports ${i.path}, which nothing in the shipped tree provides`);
      else if (i.path.startsWith("/")) copiedProblems.push(`${rel}: imports ${i.path}, an absolute path`);
    }
    copiedProblems.push(...runtimeLoadProblems(text, rel, { client: false, allowed }), ...forbiddenIn(text, rel, forbid));
  }
  if (copiedProblems.length > 0) throw new PluginBuildError(copiedProblems);
  for (const unit of units) writeRunPackage(src, out, unit, natives.dependenciesOf(unit.base), modules.some((x) => x.file.startsWith(unit.base) && (unit.base !== "" || !x.file.startsWith("plugins/"))), written);

  await checkBuiltTree(src, out, o.bundled === true);
  const files = listFiles(out);
  return { dir: out, files, modules: modules.sort((a, b) => (a.file < b.file ? -1 : 1)), natives: shippedNatives };
}

/** What no shipped file may hold: this computer's home folder and user name, the checkout, the plugin's folder and the
 *  output folder (#271's H1). */
function machineStrings(src: string, out: string, o: ShipOptions): Forbidden[] {
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    user = process.env.USER ?? process.env.USERNAME ?? "";
  }
  const folders = [{ path: src, label: "the plugin's folder" }, { path: out, label: "the output folder" }];
  for (const lock of checkoutRoots(src, o).slice(1)) folders.push({ path: lock, label: "the checkout" });
  return buildMachineStrings(folders, homedir(), user);
}

/** The top-level manifest and its children's (one level deep, `plugins/<id>/`), parsed. */
function readUnits(src: string): Unit[] {
  const read = (base: string): Unit => {
    const file = join(src, ...base.split("/").filter(Boolean), MANIFEST_FILE);
    const parsed = parseJsonc(readFileSync(file, "utf8"));
    if (!parsed.ok || !isObject(parsed.value)) throw new PluginBuildError([`${base}${MANIFEST_FILE}: not a JSON object`]);
    return { base, manifest: parsed.value };
  };
  if (!existsSync(join(src, MANIFEST_FILE))) throw new PluginBuildError([`${src} has no ${MANIFEST_FILE}`]);
  const units = [read("")];
  const children = join(src, "plugins");
  if (existsSync(children) && statSync(children).isDirectory()) {
    for (const name of readdirSync(children).sort()) {
      if (existsSync(join(children, name, MANIFEST_FILE))) units.push(read(`plugins/${name}/`));
    }
  }
  return units;
}

/** The flags of `bun` and `node` that take a module of the plugin's (built like the program itself), that take another
 *  value, and that take none, before the program's file (#271's L4). */
const MODULE_FLAGS = new Set(["--import", "--require", "-r", "--preload", "--loader", "--experimental-loader"]);
const VALUE_FLAGS = new Set(["--conditions", "-C", "--input-type", "--title", "--stack-size", "--max-old-space-size", "--env-file", "--config", "-c", "--tsconfig-override", "--define", "-d", "--port", "--inspect-port"]);
const BOOLEAN_FLAGS = new Set(["--smol", "--bun", "--no-warnings", "--enable-source-maps", "--no-deprecation", "--trace-warnings", "--experimental-strip-types", "--no-experimental-strip-types", "--expose-gc", "--silent", "--no-env-file", "--no-addons"]);

/** Programs a manifest runs with `bun` or `node` from files of the plugin's: a `stdio` server's or an agent backend's
 *  command. Each names the `args` positions to build: the program's file (`bun file`, `bun run file`, `node file`) and
 *  every module a flag before it preloads (`node --import x file`). A form this doesn't understand (another `bun`
 *  subcommand, `-e` code, an unknown flag before the file, a preloaded package rather than a file) fails the build
 *  rather than ship what it can't build. `args` is the manifest's own, so a rewrite lands in it. */
function programs(m: Json, base: string, exists: (rel: string) => boolean, problems: string[]): { args: string[]; at: number; side: BuildSide }[] {
  const out: { args: string[]; at: number; side: BuildSide }[] = [];
  const c = isObject(m.contributes) ? m.contributes : {};
  const entries = [
    ...(isObject(c.mcpServers) ? Object.entries(c.mcpServers).map(([k, v]) => [`mcpServers/${k}`, v] as const) : []),
    ...(Array.isArray(c.agentBackends) ? c.agentBackends.map((v, i) => [`agentBackends/${i}`, v] as const) : []),
  ];
  for (const [where, e] of entries) {
    if (!isObject(e) || typeof e.command !== "string") continue;
    if (e.type !== undefined && e.type !== "stdio") continue;
    const cmd = basename(e.command).toLowerCase().replace(/\.exe$/, "");
    if (cmd !== "bun" && cmd !== "node") continue;
    const side: BuildSide = cmd === "node" ? "node" : "bun";
    const args = (Array.isArray(e.args) ? e.args : []) as unknown[];
    const fail = (why: string) => problems.push(`${base}${MANIFEST_FILE}: ${where} runs ${cmd} ${args.map(String).join(" ")}: ${why}`);
    const own = (a: string) => CODE_FILE.test(a) && !a.startsWith("/") && !/^[A-Za-z]:/.test(a) && !a.split("/").includes("..") && exists(`${base}${a.replace(/^\.\//, "")}`);
    const found: { args: string[]; at: number; side: BuildSide }[] = [];
    let i = 0;
    let ok = true;
    if (cmd === "bun" && args[0] === "run") i = 1;
    for (; i < args.length; i++) {
      const a = args[i];
      if (typeof a !== "string") {
        ok = false;
        fail("an argument isn't a string");
        break;
      }
      const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
      if (MODULE_FLAGS.has(flag)) {
        if (inline !== undefined) {
          ok = false;
          fail(`write ${flag} and its module as two arguments`);
          break;
        }
        const v = args[i + 1];
        if (typeof v !== "string" || !own(v)) {
          ok = false;
          fail(`${flag} names ${String(v)}, which isn't a module in the plugin; a shipped program preloads only its own files`);
          break;
        }
        found.push({ args: args as string[], at: i + 1, side });
        i++;
        continue;
      }
      if (VALUE_FLAGS.has(flag)) {
        if (inline === undefined) i++;
        continue;
      }
      if (BOOLEAN_FLAGS.has(flag)) continue;
      if (a.startsWith("-")) {
        ok = false;
        fail(`${a} is a flag the release build doesn't know; it can't tell what the program runs`);
        break;
      }
      if (!own(a)) {
        ok = false;
        fail(`${a} isn't a module of the plugin's, so the program can't be built`);
        break;
      }
      found.push({ args: args as string[], at: i, side });
      break; // what follows is the program's own arguments
    }
    if (ok && i >= args.length) fail("it names no program file of the plugin's");
    else if (ok) out.push(...found);
  }
  return out;
}

/** Copies the folder's files that `keep` keeps, skipping what never ships. A symlink is refused: a shipped tree has
 *  none (lane M's staging refuses them too). */
function copyTree(srcRoot: string, outRoot: string, rel: string, keep: (rel: string) => boolean, written: Set<string>): void {
  const dir = join(srcRoot, ...rel.split("/").filter(Boolean));
  for (const name of readdirSync(dir).sort()) {
    const r = rel === "" ? name : `${rel}/${name}`;
    const st = lstatSync(join(dir, name));
    if (st.isDirectory()) {
      if (!LEFT_OUT_DIRS.has(name)) copyTree(srcRoot, outRoot, r, keep, written);
      continue;
    }
    if (LEFT_OUT_FILE.test(name) || !keep(r)) continue;
    if (st.isSymbolicLink()) throw new PluginBuildError([`${r} is a symlink; a shipped plugin has none`]);
    if (!st.isFile()) continue;
    const to = join(outRoot, ...r.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(dir, name), to);
    written.add(r);
  }
}

/** A unit's `package.json`, cut down to what running its built modules needs: ES modules, and the natives beside
 *  them. A unit with neither keeps none. */
function writeRunPackage(src: string, out: string, unit: Unit, deps: Record<string, string>, hasModules: boolean, written: Set<string>): void {
  if (!hasModules && Object.keys(deps).length === 0) return;
  let own: Json = {};
  try {
    const parsed = JSON.parse(readFileSync(join(src, ...unit.base.split("/").filter(Boolean), "package.json"), "utf8"));
    if (isObject(parsed)) own = parsed;
  } catch {
    /* none: write one */
  }
  const pkg: Json = { name: typeof own.name === "string" ? own.name : `clover-plugin-${unit.base === "" ? basename(src) : unit.base.split("/")[1]}` };
  for (const k of ["version", "license"]) if (typeof own[k] === "string") pkg[k] = own[k];
  pkg.private = true;
  pkg.type = "module";
  if (Object.keys(deps).length > 0) pkg.dependencies = Object.fromEntries(Object.entries(deps).sort());
  writeFileSync(join(out, ...unit.base.split("/").filter(Boolean), "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  written.add(`${unit.base}package.json`);
}

/** The built tree must validate as the source does: an error only it has (an entry that isn't JavaScript), or a file
 *  the manifest names that the build dropped (the icon's is only a warning), fails the build. */
async function checkBuiltTree(src: string, out: string, bundled: boolean): Promise<void> {
  const key = (i: ValidationIssue) => `${i.file}\u0000${i.code}\u0000${i.path}`;
  const errors = (r: Awaited<ReturnType<typeof validateTree>>) => r.issues.concat(r.top.issues, ...r.children.map((c) => c.report.issues)).filter((i) => i.severity === "error" || i.code === "file_missing");
  const folderName = basename(src);
  const before = new Set(errors(await validateTree(folderReader(src), { folderName, bundled })).map(key));
  const after = errors(await validateTree(folderReader(out), { folderName, bundled }));
  const added = after.filter((i) => !before.has(key(i)));
  if (added.length > 0) throw new PluginBuildError(added.map((i) => `the built tree: ${i.file}: ${i.message} (${i.code})`));
}

function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, ...rel.split("/").filter(Boolean))).sort()) {
    const r = rel === "" ? name : `${rel}/${name}`;
    const st = lstatSync(join(root, ...r.split("/")));
    if (st.isDirectory()) out.push(...listFiles(root, r));
    else out.push(r);
  }
  return out.sort();
}

// -------------------------------------------------------------------------------------------------
// Natives
// -------------------------------------------------------------------------------------------------

/** A package the lockfile pins: its version, where its tarball comes from, its `os`/`cpu`/`libc`, its integrity. */
interface LockedPackage {
  name: string;
  version: string;
  registry: string;
  meta: Json;
  integrity: string;
}

/** A native addon a host or program imports, and the unit whose `node_modules` ships it. */
interface NativeUse {
  name: string;
  dir: string;
  version: string;
  base: string;
}

const NPM_REGISTRY = "https://registry.npmjs.org/";

class NativeShipper {
  private readonly verdicts = new Map<string, boolean>();
  private readonly uses = new Map<string, NativeUse>();
  private lock: Map<string, LockedPackage[]> | undefined;
  private readonly downloads: string[] = [];

  constructor(private readonly src: string, private readonly out: string, private readonly o: ShipOptions) {}

  private lockfile(): string {
    return this.o.lockfile ?? findLockfile(this.src);
  }

  /** `keepExternal` for one unit's builds: true for a native addon, which ships beside the module instead. */
  keep(spec: string, importer: string, base: string): boolean {
    const name = packageOfSpecifier(spec);
    const dir = packageDir(name, dirname(importer));
    if (dir === undefined) return false; // the bundler names what it can't resolve
    let native = this.verdicts.get(dir);
    if (native === undefined) {
      native = this.platformPackages(dir).length > 0 || hasOwnBinary(dir);
      this.verdicts.set(dir, native);
    }
    if (!native) return false;
    const version = String(readPackage(dir).version ?? "");
    const key = `${base}\u0000${name}`;
    const had = this.uses.get(key);
    if (had !== undefined && had.dir !== dir) throw new PluginBuildError([`${base}: two copies of the native ${name} (${had.version}, ${version}); a plugin ships one`]);
    this.uses.set(key, { name, dir, version, base });
    return true;
  }

  /** The `dependencies` a unit's run package.json names: its natives. */
  dependenciesOf(base: string): Record<string, string> {
    return Object.fromEntries([...this.uses.values()].filter((u) => u.base === base).map((u) => [u.name, u.version]));
  }

  /** Copies each native, its dependencies and its prebuilt binary for the target into its unit's `node_modules`. */
  async finish(written: Set<string>): Promise<ShippedNative[]> {
    const shipped: ShippedNative[] = [];
    for (const use of [...this.uses.values()].sort((a, b) => (`${a.base}${a.name}` < `${b.base}${b.name}` ? -1 : 1))) {
      const modules = `${use.base}node_modules`;
      const placed = new Map<string, string>();
      const place = (name: string, dir: string) => {
        const version = String(readPackage(dir).version ?? "");
        const had = placed.get(name);
        if (had !== undefined) {
          if (had !== version) throw new PluginBuildError([`${use.base}: ${use.name} needs ${name} ${had} and ${version}; a plugin's node_modules holds one`]);
          return false;
        }
        placed.set(name, version);
        copyPackage(dir, this.out, `${modules}/${name}`, written);
        return true;
      };
      const platform = this.platformPackages(use.dir);
      const wanted = platform.filter((p) => matchesTarget(p.meta, this.o.target));
      if (platform.length > 0 && wanted.length === 0) throw new PluginBuildError([`${use.base}: ${use.name} has no prebuilt package for ${this.o.target}`]);
      if (platform.length === 0 && (this.o.dev !== true || this.o.target !== hostShipTarget())) {
        throw new PluginBuildError([`${use.base}: ${use.name} is a native addon built on this computer, with no prebuilt package the lockfile pins for ${this.o.target}; only a dev build for this computer ships one`]);
      }
      // The package and what it depends on (not its optional platform packages: only the target's ships, below).
      // The installed tree says which packages and versions; what ships is, for a release, the lockfile's download of
      // each, checked against its integrity (#271's ruling M2), and in a dev build the installed copy.
      const queue: [string, string][] = [[use.name, use.dir]];
      while (queue.length > 0) {
        const [name, dir] = queue.shift()!;
        if (!place(name, await this.shippable(name, String(readPackage(dir).version ?? ""), dir))) continue;
        for (const dep of Object.keys((readPackage(dir).dependencies as Json | undefined) ?? {})) {
          const depDir = packageDir(dep, dir);
          if (depDir === undefined) throw new PluginBuildError([`${use.base}: ${name} depends on ${dep}, which isn't installed`]);
          queue.push([dep, depDir]);
        }
      }
      for (const p of wanted) place(p.name, await this.shippable(p.name, p.version, this.o.dev === true ? packageDir(p.name, use.dir) : undefined));
      for (const rel of [...written].filter((f) => f.startsWith(`${modules}/`) && f.endsWith(".node")).sort()) {
        if (!shipped.some((s) => s.file === rel)) shipped.push({ file: rel, package: use.name, target: this.o.target });
      }
      if (!shipped.some((s) => s.package === use.name && s.file.startsWith(`${modules}/`))) {
        throw new PluginBuildError([`${use.base}: ${use.name} shipped no .node binary for ${this.o.target}`]);
      }
    }
    return shipped;
  }

  /** Removes the downloaded packages' folders. */
  cleanup(): void {
    for (const d of this.downloads.splice(0)) rmSync(d, { recursive: true, force: true });
  }

  /** The optional dependencies of a package that the lockfile marks as for one platform (`os` or `cpu`). */
  private platformPackages(dir: string): LockedPackage[] {
    const optional = (readPackage(dir).optionalDependencies as Json | undefined) ?? {};
    const out: LockedPackage[] = [];
    for (const [name, range] of Object.entries(optional)) {
      const locked = this.locked(name, String(range));
      if (locked !== undefined && (locked.meta.os !== undefined || locked.meta.cpu !== undefined)) out.push(locked);
    }
    return out;
  }

  private locked(name: string, version: string): LockedPackage | undefined {
    if (this.lock === undefined) this.lock = readLock(this.lockfile());
    const all = this.lock.get(name) ?? [];
    return all.find((p) => p.version === version);
  }

  /** The folder a package ships from: in a dev build the installed copy (`installed`) when its name and version are
   *  the lockfile's; otherwise, and always for a release, the lockfile's download of exactly that version (L1). */
  private async shippable(name: string, version: string, installed: string | undefined): Promise<string> {
    const p = this.locked(name, version);
    if (p === undefined) throw new PluginBuildError([`${name}@${version} isn't in the lockfile, so it can't be checked`]);
    if (this.o.dev === true && installed !== undefined) {
      const pkg = readPackage(installed);
      if (pkg.name === p.name && pkg.version === p.version) return installed;
    }
    return await this.fetchPackage(p);
  }

  /** Downloads a package's tarball, checks it against the lockfile's integrity, and unpacks it. */
  private async fetchPackage(p: LockedPackage): Promise<string> {
    const url = `${p.registry === "" ? NPM_REGISTRY : p.registry.endsWith("/") ? p.registry : `${p.registry}/`}${p.name}/-/${p.name.split("/").pop()}-${p.version}.tgz`;
    const bytes = await (this.o.download ?? defaultDownload)(url);
    const [algo, want] = p.integrity.split(/-(.*)/s, 2) as [string, string | undefined];
    if (!["sha512", "sha384", "sha256"].includes(algo) || want === undefined) throw new PluginBuildError([`${p.name}@${p.version}: the lockfile has no integrity to check its download against`]);
    const got = createHash(algo).update(bytes).digest("base64");
    if (got !== want) throw new PluginBuildError([`${p.name}@${p.version}: the download from ${url} isn't what the lockfile pins (${algo} differs)`]);
    const tmp = mkdtempSync(join(tmpdir(), "clover-ship-native-"));
    this.downloads.push(tmp);
    const dir = join(tmp, "package");
    for (const f of untarGz(bytes, `${p.name}@${p.version}`)) {
      const to = join(dir, ...f.path.split("/"));
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, f.bytes, { mode: f.mode & 0o755 });
    }
    if (!existsSync(join(dir, "package.json"))) throw new PluginBuildError([`${p.name}@${p.version}: its tarball holds no package.json`]);
    const pkg = readPackage(dir);
    if (pkg.name !== p.name || pkg.version !== p.version) throw new PluginBuildError([`${p.name}@${p.version}: its tarball is ${String(pkg.name)}@${String(pkg.version)}, not the package the lockfile pins`]);
    return dir;
  }
}

/** A package tarball's files (npm's `.tgz`: gzip over ustar, one top folder, which is dropped). Only regular files
 *  and folders: a link, a device or a path with `..` refuses the package. */
export function untarGz(gz: Uint8Array, what: string): { path: string; mode: number; bytes: Uint8Array }[] {
  const fail = (why: string): never => {
    throw new PluginBuildError([`${what}: its tarball ${why}`]);
  };
  let tar: Uint8Array;
  try {
    tar = Bun.gunzipSync(gz as Uint8Array<ArrayBuffer>);
  } catch {
    return fail("isn't gzip");
  }
  const text = (a: number, b: number, at: number) => new TextDecoder().decode(tar.subarray(at + a, at + b)).replace(/\0.*$/s, "");
  const octal = (a: number, b: number, at: number) => parseInt(text(a, b, at).trim() || "0", 8);
  const out: { path: string; mode: number; bytes: Uint8Array }[] = [];
  let longName: string | undefined;
  for (let h = 0; h + 512 <= tar.length; ) {
    if (tar.subarray(h, h + 512).every((b) => b === 0)) break;
    const size = octal(124, 136, h);
    if (!Number.isSafeInteger(size) || size < 0) fail("has a header it can't read");
    const type = String.fromCharCode(tar[h + 156]!);
    const body = tar.subarray(h + 512, h + 512 + size);
    if (body.length !== size) fail("is cut short");
    const ustar = text(257, 262, h) === "ustar";
    const header = { name: text(0, 100, h), prefix: ustar ? text(345, 500, h) : "", mode: octal(100, 108, h) };
    h += 512 + Math.ceil(size / 512) * 512;
    if (type === "x" || type === "L") {
      const v = new TextDecoder().decode(body);
      longName = type === "L" ? v.replace(/\0.*$/s, "") : (/(?:^|\n)\d+ path=([^\n]*)\n/.exec(v)?.[1] ?? longName);
      continue;
    }
    if (type === "g") continue;
    const name = longName ?? (header.prefix !== "" ? `${header.prefix}/${header.name}` : header.name);
    longName = undefined;
    if (type === "5") continue;
    if (type !== "0" && type !== "\0") fail(`holds ${name}, which isn't a regular file`);
    const parts = name.split("/").filter((x) => x !== "" && x !== ".");
    if (parts.length < 2 || name.startsWith("/") || parts.some((x) => x === ".." || x.includes("\\") || x.includes(":"))) fail(`holds ${name}, outside its package folder`);
    out.push({ path: parts.slice(1).join("/"), mode: header.mode, bytes: body });
  }
  return out;
}

async function defaultDownload(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new PluginBuildError([`${url}: ${res.status} ${res.statusText}`]);
  return new Uint8Array(await res.arrayBuffer());
}

function matchesTarget(meta: Json, target: ShipTarget): boolean {
  const want = TARGET_PLATFORM[target];
  const fits = (field: unknown, value: string | undefined): boolean => {
    if (field === undefined) return true;
    const list = (Array.isArray(field) ? field : [field]).filter((x): x is string => typeof x === "string");
    if (value === undefined) return list.length === 0;
    const denied = list.filter((x) => x.startsWith("!")).map((x) => x.slice(1));
    const allowed = list.filter((x) => !x.startsWith("!"));
    return !denied.includes(value) && (allowed.length === 0 || allowed.includes(value));
  };
  return fits(meta.os, want.os) && fits(meta.cpu, want.cpu) && (meta.libc === undefined || fits(meta.libc, want.libc));
}

/** A package with a binary of its own: a `.node` file in it (outside its `node_modules`), or a node-gyp build. */
function hasOwnBinary(dir: string): boolean {
  const pkg = readPackage(dir);
  if (pkg.gypfile === true || existsSync(join(dir, "binding.gyp"))) return true;
  const walk = (d: string, depth: number): boolean => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && depth < 6 && walk(join(d, e.name), depth + 1)) return true;
      } else if (e.name.endsWith(".node")) return true;
    }
    return false;
  };
  return walk(dir, 0);
}

/** Node's lookup: `node_modules/<name>` in `from` or a folder above it, as a real path. */
function packageDir(name: string, from: string): string | undefined {
  for (let d = from; ; d = dirname(d)) {
    const candidate = join(d, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(d) === d) return undefined;
  }
}

function readPackage(dir: string): Json {
  try {
    const v = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return isObject(v) ? v : {};
  } catch {
    return {};
  }
}

/** Copies a package's files to `rel` in the built tree, leaving out its own `node_modules`, TypeScript, tests and
 *  source maps. A symlink is refused. */
function copyPackage(dir: string, out: string, rel: string, written: Set<string>): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() ? LEFT_OUT_DIRS.has(e.name) : LEFT_OUT_FILE.test(e.name) || e.name.endsWith(".map")) continue;
    const from = join(dir, e.name);
    const r = `${rel}/${e.name}`;
    if (e.isSymbolicLink()) throw new PluginBuildError([`${r}: a symlink in a native package; a shipped plugin has none`]);
    if (e.isDirectory()) copyPackage(from, out, r, written);
    else if (e.isFile()) {
      const to = join(out, ...r.split("/"));
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      written.add(r);
    }
  }
}

function findLockfile(from: string): string {
  for (let d = from; ; d = dirname(d)) {
    if (existsSync(join(d, "bun.lock"))) return join(d, "bun.lock");
    if (dirname(d) === d) throw new PluginBuildError([`no bun.lock above ${from}, to pin the natives' prebuilt packages`]);
  }
}

/** `bun.lock`'s packages, by name: each entry is `[ "name@version", registry, meta, integrity ]`. */
function readLock(file: string): Map<string, LockedPackage[]> {
  const parsed = parseJsonc(readFileSync(file, "utf8"));
  if (!parsed.ok || !isObject(parsed.value) || !isObject(parsed.value.packages)) throw new PluginBuildError([`${file}: not a bun.lock`]);
  const out = new Map<string, LockedPackage[]>();
  for (const v of Object.values(parsed.value.packages)) {
    if (!Array.isArray(v) || typeof v[0] !== "string") continue;
    const at = v[0].lastIndexOf("@");
    if (at <= 0) continue;
    const name = v[0].slice(0, at);
    const p: LockedPackage = { name, version: v[0].slice(at + 1), registry: typeof v[1] === "string" ? v[1] : "", meta: isObject(v[2]) ? v[2] : {}, integrity: typeof v[3] === "string" ? v[3] : "" };
    const list = out.get(name) ?? [];
    if (!list.some((x) => x.version === p.version)) list.push(p);
    out.set(name, list);
  }
  return out;
}
