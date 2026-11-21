// Where an engine copy lives, how one is placed under the home, and which copies the engine will take (spec §3.1 "Where
// the copies are found", ruling D). RL's.
//
// The layout is the server install's (`packages/cli/src/server-install.ts`): the engine at `<home>/bin/daemon/moss-core`,
// the files that sit beside it, and its bundled tree at `<home>/bin/plugins`, which `bundledPluginsDir` finds as `../plugins`
// beside the binary and whose files the compiled-in manifest checks one by one. The files beside the engine are the
// SIDECARS (`bundled-identities.ts`'s `engineSidecars`: the plugin Bun, the link sidecar and, on macOS, the process holder):
// the engine looks for each in its own folder and nowhere else, so an engine placed without them runs with no plugin code,
// no links and no process holder. The marker `<home>/bin/engine.json` names the release and build of what was placed, and
// is written LAST: a crash before it leaves the old marker, so the next install of a newer copy places it again.
//
// WHAT A HALF-PLACED SET MEANS (the guarantee, extended from the engine to the set): everything is staged first (each
// file as `<name>.new`, the tree as `plugins.new`) and every staged file is checked before the first rename, so a copy that
// would be refused is refused with the installed set untouched. The renames then go sidecars, tree, engine, marker; one
// that fails is undone in reverse (the `.old` put back), so an error leaves the old set as it was. What no code can undo
// is the process being killed between two renames: that leaves the marker old, and the next install of a newer copy (or of
// the same one, when `intact` says the set is not whole) places the set again. Renaming each file, never the folder, is
// deliberate: Windows cannot rename a folder that holds a running executable, and a release switch places a copy while
// the old engine still runs.
//
// WHAT DECIDES WHICH BINARY RUNS (the reviewer's list):
//   * `engineBinaryPath`: the login item and the apps start the engine from here, never from an app's own resources.
//   * `isNewerCopy`: a copy replaces the installed one only with a newer release, or the same release and a newer build
//     (a stamped build is newer than an unstamped one; an unstamped copy never replaces anything of its release).
//   * `copyAcceptable`: a path an app or a record names is taken only when it passes this (macOS: its code requirement;
//     elsewhere: a path an app recorded).
//   * the sidecars: only the names `engineSidecars` lists, each a regular file whose real path is the same folder as the
//     engine's own (a link out of the bundle, or to another name, names nothing), each checked on its staged bytes against
//     its own identifier's requirement on macOS. Nothing in the bundle's folder that the list doesn't name is placed.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { compareReleases, type AppInstallRecord } from "@waifucave/moss-protocol";
import { DEVELOPER_ID_CLAUSES, MOSS_TEAM_ID, engineSidecars } from "../bundled-identities";
import { TEST_KEYCHAIN_ENV } from "../auth/test-isolation";
import type { MossProfile } from "../profile";
import type { EngineCopy } from "../contracts/release-home";

export const ENGINE_MARKER = join("bin", "engine.json");
const MAX_MARKER_BYTES = 4096;

export function engineBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "moss-core.exe" : "moss-core";
}

/** `<home>/bin/daemon/moss-core`: the one place the engine runs from once it is installed. */
export function engineBinaryPath(home: string, platform: NodeJS.Platform = process.platform): string {
  return join(home, "bin", "daemon", engineBinaryName(platform));
}

/** `<home>/bin/plugins`: the bundled tree of the installed engine. */
export function engineTreePath(home: string): string {
  return join(home, "bin", "plugins");
}

/** The installed copy's marker, read strictly and bounded; undefined for anything that isn't one. */
export function readEngineMarker(home: string): EngineCopy | undefined {
  try {
    const path = join(home, ENGINE_MARKER);
    if (lstatSync(path).size > MAX_MARKER_BYTES) return undefined;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
    if (raw === null || typeof raw !== "object" || typeof raw.release !== "string" || typeof raw.from !== "string") return undefined;
    compareReleases(raw.release, raw.release);
    if (raw.build !== undefined && typeof raw.build !== "string") return undefined;
    // A build is digits only (a stamp): anything else would sort above every stamp and hold its release for ever, so it reads as none.
    return { release: raw.release, from: raw.from, ...(typeof raw.build === "string" && /^\d{1,20}$/.test(raw.build) ? { build: raw.build } : {}) };
  } catch {
    return undefined;
  }
}

function writeEngineMarker(home: string, copy: EngineCopy): void {
  const path = join(home, ENGINE_MARKER);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ release: copy.release, ...(copy.build !== undefined ? { build: copy.build } : {}), from: copy.from })}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Order of two builds of one release: digit strings (the build stamp, `ENGINE_BUILD`: UTC time of the build, fixed width) by
 *  number; anything else by numeric-aware text. Negative when `a` is older. */
export function compareBuilds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const x = a.replace(/^0+(?=\d)/, ""), y = b.replace(/^0+(?=\d)/, "");
    return x.length !== y.length ? x.length - y.length : x < y ? -1 : x > y ? 1 : 0;
  }
  return a.localeCompare(b, "en", { numeric: true });
}

/** Whether `a` should replace `b`: a newer release, or the same release and a newer build. A build with a stamp is newer
 *  than one with none (a copy placed before builds were stamped); a copy with none replaces nothing of its release. */
export function isNewerCopy(a: EngineCopy, b: EngineCopy | undefined): boolean {
  if (b === undefined) return true;
  const c = compareReleases(a.release, b.release);
  if (c !== 0) return c > 0;
  if (a.build === undefined) return false;
  return b.build === undefined || compareBuilds(a.build, b.build) > 0;
}

/** Whether two copies are the same one: the same release and the same build (neither stamped counts as the same). */
export function isSameCopy(a: EngineCopy, b: EngineCopy): boolean {
  return compareReleases(a.release, b.release) === 0 && (a.build === b.build || (a.build !== undefined && b.build !== undefined && compareBuilds(a.build, b.build) === 0));
}

/** Where an app bundle keeps its engine and tree (electron-builder's `extraResources`, the same places
 *  `locateDaemonBinary` reads): macOS `<app>/Contents/Resources`, Windows and a deb's folder `<dir>/resources`. An AppImage
 *  is a file: its engine can't be read from outside, so the app installs it itself (`moss-core engine install`). */
export function locateEngineIn(bundlePath: string, platform: NodeJS.Platform = process.platform): { binary: string; tree: string; sidecars: string[] } | undefined {
  if (!isAbsolute(bundlePath)) return undefined;
  const resources = platform === "darwin" ? join(bundlePath, "Contents", "Resources") : join(bundlePath, "resources");
  return { binary: join(resources, "daemon", engineBinaryName(platform)), tree: join(resources, "plugins"), sidecars: engineSidecars(platform).map((s) => join(resources, "daemon", s.file)) };
}

/** `<home>/bin/daemon/<file>` of every sidecar of this OS: what the copy places beside the engine. */
export function engineSidecarPaths(home: string, platform: NodeJS.Platform = process.platform): string[] {
  return engineSidecars(platform).map((s) => join(dirname(engineBinaryPath(home, platform)), s.file));
}

/** What a copy is placed from: the engine, the files beside it, the bundled tree, and the folder every real path must stay in. */
export interface EngineSource { binary: string; tree?: string; root?: string; sidecars?: readonly string[] }

/** The source's files as real paths, refused unless each is what it says: a regular file whose real path is inside `root` (when
 *  given), and, for a sidecar, in the engine's own folder under its own name. A link out of the bundle, or to another file,
 *  names nothing. Throws, naming the file, before anything is copied. */
function resolveSource(src: EngineSource): { binary: string; tree: string | undefined; sidecars: { file: string; from: string }[] } {
  const root = src.root === undefined ? undefined : realpathSync(src.root);
  const inside = (p: string): string => {
    const real = realpathSync(p);
    if (root !== undefined && real !== root && !real.startsWith(root + sep)) throw new Error(`${p} leads outside ${src.root}`);
    return real;
  };
  const binary = inside(src.binary);
  if (!lstatSync(binary).isFile()) throw new Error(`${src.binary} is not a file`);
  const sidecars = (src.sidecars ?? []).map((p) => {
    const file = basename(p);
    if (!existsSync(p)) throw new Error(`${file} is missing from the bundle: the engine would run without it`);
    const real = inside(p);
    if (dirname(real) !== dirname(binary) || basename(real) !== file) throw new Error(`${file} isn't a file beside the engine (it leads elsewhere)`);
    if (!lstatSync(real).isFile()) throw new Error(`${file} is not a file`);
    return { file, from: real };
  });
  return { binary, tree: src.tree !== undefined && existsSync(src.tree) ? inside(src.tree) : undefined, sidecars };
}

/** Places a copy: stages `moss-core.new`, each sidecar's `.new` and `plugins.new` beside their places, checks every staged file
 *  (`verifyStaged` the engine, `verifySidecar` each sidecar: the bytes that will run are the ones checked), moves the old ones
 *  aside (`.old`, kept until the next install, which makes them room: a running binary can be renamed on every OS but not
 *  overwritten on Windows), moves the new ones in (sidecars, tree, engine) and writes the marker. Synchronous: a half-placed
 *  copy is never visible to a second caller, which waits on the install lock. The sources must be regular files whose real
 *  paths are inside `root` (a link out of the bundle names nothing) and a sidecar must sit beside the engine. Throws on any
 *  failure, leaving the old set as it was (a failed rename is undone) or restorable from `.old`. */
export function placeEngine(home: string, src: EngineSource, copy: EngineCopy, platform: NodeJS.Platform = process.platform, verifyStaged?: (staged: string) => void, verifySidecar?: (staged: string, file: string) => void): void {
  const from = resolveSource(src);
  const bin = engineBinaryPath(home, platform);
  const plugins = engineTreePath(home);
  const sidecars = from.sidecars.map((s) => ({ ...s, dest: join(dirname(bin), s.file) }));
  mkdirSync(dirname(bin), { recursive: true });
  const staged = [bin, ...sidecars.map((s) => s.dest), plugins];
  const clear = (suffix: string): void => { for (const d of staged) rmSync(`${d}${suffix}`, { recursive: true, force: true }); };
  clear(".new");
  clear(".old");
  try {
    cpSync(from.binary, `${bin}.new`);
    chmodSync(`${bin}.new`, 0o755);
    // The bytes that will run are the ones checked: the staged copy, not the path it came from.
    verifyStaged?.(`${bin}.new`);
    for (const s of sidecars) {
      cpSync(s.from, `${s.dest}.new`);
      chmodSync(`${s.dest}.new`, 0o755);
      verifySidecar?.(`${s.dest}.new`, s.file);
    }
    if (from.tree !== undefined) cpSync(from.tree, `${plugins}.new`, { recursive: true, verbatimSymlinks: true });
  } catch (err) {
    clear(".new");
    throw err;
  }
  const swaps = [...sidecars.map((s) => s.dest), ...(from.tree !== undefined ? [plugins] : []), bin];
  const done: { dest: string; hadOld: boolean }[] = [];
  try {
    for (const dest of swaps) {
      const hadOld = existsSync(dest);
      if (hadOld) renameSync(dest, `${dest}.old`);
      done.push({ dest, hadOld });
      renameSync(`${dest}.new`, dest);
    }
    writeEngineMarker(home, copy);
  } catch (err) {
    for (const d of done.reverse()) {
      try {
        rmSync(d.dest, { recursive: true, force: true });
        if (d.hadOld) renameSync(`${d.dest}.old`, d.dest);
      } catch { /* what could not be put back stays as `.old`, which the next install makes room of */ }
    }
    clear(".new");
    throw err;
  }
}

// ---- which copies are taken ----

/** The requirement an engine binary must meet on macOS: its own identifier, Apple's chain, MOSS's team, and for the dist
 *  build a Developer ID leaf (without it only when this daemon is itself not Developer ID signed: a checkout or the dev-
 *  signed alpha, which would otherwise refuse every copy). */
export function engineCopyRequirement(profile: MossProfile, developerId: boolean, identifier: { readonly dist: string; readonly dev: string } = { dist: "com.waifucave.moss.core", dev: "com.waifucave.moss.core.dev" }): string {
  const id = profile === "dist" ? identifier.dist : identifier.dev;
  return `identifier "${id}" and anchor apple generic${developerId ? ` and ${DEVELOPER_ID_CLAUSES}` : ""} and certificate leaf[subject.OU] = "${MOSS_TEAM_ID}"`;
}

/** The requirement a sidecar must meet on macOS: the engine's, under the sidecar's own identifier. */
export function sidecarCopyRequirement(profile: MossProfile, developerId: boolean, file: string, platform: NodeJS.Platform = "darwin"): string {
  const spec = engineSidecars(platform).find((s) => s.file === file);
  if (spec === undefined) throw new Error(`${file} isn't one of the files placed beside the engine`);
  return engineCopyRequirement(profile, developerId, spec.identifier);
}

/** The requirement an app bundle must meet on macOS before the host is launched from it: either app's identifier. */
export function appBundleRequirement(profile: MossProfile, developerId: boolean): string {
  const ids = profile === "dist" ? ["com.waifucave.moss", "com.waifucave.moss.code"] : ["com.waifucave.moss.dev", "com.waifucave.moss.code.dev"];
  return `(${ids.map((i) => `identifier "${i}"`).join(" or ")}) and anchor apple generic${developerId ? ` and ${DEVELOPER_ID_CLAUSES}` : ""} and certificate leaf[subject.OU] = "${MOSS_TEAM_ID}"`;
}

/** `codesign --verify` of a path against a requirement: a STATIC check of the file as it is on disk (`--strict`), the one
 *  macOS gives for a path no process runs yet. False on any failure, never throws. */
export type CodeCheck = (path: string, requirement: string) => boolean;

export const codesignCheck: CodeCheck = (path, requirement) => {
  try {
    const r = spawnSync("/usr/bin/codesign", ["--verify", "--strict", `-R=${requirement}`, path], { timeout: 30_000, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
    return r.status === 0;
  } catch {
    return false;
  }
};

export interface CopyPolicy {
  platform: NodeJS.Platform;
  profile: MossProfile;
  /** True when this daemon is Developer ID signed (so a dist copy must be too). */
  developerId: boolean;
  /** The apps' records (`ReleaseHome.apps()`), which every OS holds a path to. */
  records(): readonly AppInstallRecord[];
  check?: CodeCheck;
  /** `<binary> --version`'s first line, or undefined (default: runs it with PATH alone, for at most 10 s). */
  versionOf?(binary: string): string | undefined;
}

/**
 * Whether the engine may take an engine copy from, or start the host from, `bundlePath`: an absolute path that exists and
 * is the bundle some app RECORDED; for the host on macOS also one whose signature meets the requirement (the bundle
 * itself). An engine copy's signature and version are checked on the STAGED file (`verifyStagedEngine`, so the bytes
 * checked are the bytes that run). Windows and Linux have no signature to ask of a path (peer-signature.ts says why), so a
 * recorded path is the whole check there: a record is written only by the app or by the engine for a connected app
 * (`release.record`), and the home's default-deny keeps every runner from writing it. `reason` is for the log and the
 * refusal, never a path's content.
 */
export function copyAcceptable(bundlePath: string, what: "engine" | "host", policy: CopyPolicy): { ok: true } | { ok: false; reason: string } {
  if (!isAbsolute(bundlePath) || !existsSync(bundlePath)) return { ok: false, reason: "that path isn't there" };
  if (!policy.records().some((r) => r.bundlePath === bundlePath)) return { ok: false, reason: "no app recorded that path" };
  if (what === "host" && policy.platform === "darwin" && !(policy.check ?? codesignCheck)(bundlePath, appBundleRequirement(policy.profile, policy.developerId))) {
    return { ok: false, reason: "its code signature isn't MOSS's" };
  }
  return { ok: true };
}

/** The check on a staged engine binary, before it takes the engine's place: on macOS its code requirement, on every OS
 *  that it says it is `release` (`moss <release>`, the way a server update checks its new binary). Throws the refusal. */
export function verifyStagedEngine(staged: string, release: string, policy: CopyPolicy): void {
  if (policy.platform === "darwin" && !(policy.check ?? codesignCheck)(staged, engineCopyRequirement(policy.profile, policy.developerId))) {
    throw new Error("the engine copy's code signature isn't MOSS's");
  }
  const said = (policy.versionOf ?? engineVersionOf)(staged);
  const m = said === undefined ? null : /^moss (\S+)/.exec(said);
  if (m === null || m[1] !== release) throw new Error(`the engine copy says ${said === undefined ? "nothing" : JSON.stringify(said.slice(0, 60))}, not release ${release}`);
}

/** The check on a staged sidecar, before the set takes its place: on macOS its own code requirement (`policy.check`, the same
 *  seam as the engine's). Elsewhere there is no signature to ask of a file (the engine's own check says why), and the
 *  source rules of `placeEngine` are the check. Throws the refusal. */
export function verifyStagedSidecar(staged: string, file: string, policy: CopyPolicy): void {
  if (policy.platform === "darwin" && !(policy.check ?? codesignCheck)(staged, sidecarCopyRequirement(policy.profile, policy.developerId, file, policy.platform))) {
    throw new Error(`${file}'s code signature isn't MOSS's`);
  }
}

/** Why the set under `<home>/bin/daemon/` is not whole, or undefined when it is: every file a copy places is there as a plain
 *  file (never a link) and, on macOS, meets its code requirement as it sits on disk. What decides that an installed copy of the
 *  same release and build is placed again (`EngineReleaseHome`'s `intact`). */
export function installedSetProblem(home: string, policy: CopyPolicy): string | undefined {
  const check = policy.check ?? codesignCheck;
  const files = [
    { path: engineBinaryPath(home, policy.platform), name: engineBinaryName(policy.platform), requirement: engineCopyRequirement(policy.profile, policy.developerId) },
    ...engineSidecars(policy.platform).map((s) => ({ path: join(dirname(engineBinaryPath(home, policy.platform)), s.file), name: s.file, requirement: sidecarCopyRequirement(policy.profile, policy.developerId, s.file, policy.platform) })),
  ];
  for (const f of files) {
    let plain = false;
    try { const st = lstatSync(f.path); plain = st.isFile() && !st.isSymbolicLink(); } catch { /* missing */ }
    if (!plain) return `${f.name} is missing from ${dirname(f.path)}`;
    if (policy.platform === "darwin" && !check(f.path, f.requirement)) return `${f.name}'s code signature isn't MOSS's`;
  }
  return undefined;
}

declare const __MOSS_TEST_BUILD__: string | false | undefined;

/** The environment `<binary> --version` runs in: PATH alone (a staged file is given nothing of this process's). A TEST-MARKED build
 *  also hands on the two variables a test-marked engine needs to start at all (its throwaway keychain file and the temp HOME:
 *  startup-guard.ts `testBuildStartRefusal`, which refuses even `--version` without them), so the real install path can be run on
 *  a packaged test pair; a release build is compiled without that branch (`__MOSS_TEST_BUILD__` is false there). */
export function engineVersionEnv(source: Record<string, string | undefined>, testBuild: boolean = typeof __MOSS_TEST_BUILD__ === "string", platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = { PATH: source.PATH ?? source.Path ?? "" };
  if (platform === "win32") { for (const k of ["SystemRoot", "windir"]) if (source[k] !== undefined) env[k] = source[k]!; }
  if (testBuild) { for (const k of [TEST_KEYCHAIN_ENV, "HOME"]) if (source[k] !== undefined && source[k] !== "") env[k] = source[k]!; }
  return env;
}

/** `<binary> --version`, run in `engineVersionEnv` for at most 10 s: its first line, or undefined when it failed. */
export function engineVersionOf(binary: string): string | undefined {
  try {
    const r = spawnSync(binary, ["--version"], { env: engineVersionEnv(process.env), timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim().split("\n")[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stages the engine a bundle carries, and every file beside it, in a scratch folder under the home's `bin/` and runs the
 * staged-copy checks on them (the code requirement on macOS for each, and `--version` saying the release for the engine),
 * then removes the scratch. `release.bring` runs it BEFORE it waits for idle or stops anything, so a copy that would be
 * refused is refused at once, not after the person has waited or pressed "Switch now". The swap checks the bytes again at
 * `placeEngine` (the bytes that run are the ones checked last). Throws the refusal.
 */
export function verifyBundleEngine(home: string, bundlePath: string, release: string, policy: CopyPolicy): void {
  const src = locateEngineIn(bundlePath, policy.platform);
  if (src === undefined) throw new Error("no engine to find in that bundle");
  const scratch = join(home, "bin", `.verify-${process.pid}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  try {
    const from = resolveSource({ binary: src.binary, sidecars: src.sidecars, root: bundlePath });
    const staged = join(scratch, engineBinaryName(policy.platform));
    cpSync(from.binary, staged);
    chmodSync(staged, 0o755);
    verifyStagedEngine(staged, release, policy);
    for (const s of from.sidecars) {
      const sidecar = join(scratch, s.file);
      cpSync(s.from, sidecar);
      chmodSync(sidecar, 0o755);
      verifyStagedSidecar(sidecar, s.file, policy);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
