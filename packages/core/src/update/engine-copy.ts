// Where an engine copy lives, how one is placed under the home, and which copies the engine will take (spec §3.1 "Where
// the copies are found", ruling D). RL's.
//
// The layout is the server install's (`packages/cli/src/server-install.ts`): the engine at `<home>/bin/daemon/moss-core`
// and its bundled tree at `<home>/bin/plugins`, which `bundledPluginsDir` finds as `../plugins` beside the binary and
// whose files the compiled-in manifest checks one by one. The marker `<home>/bin/engine.json` names the release and build
// of what was placed, and is written LAST: a crash between the two renames leaves the old marker, so the next install of
// the same copy places it again.
//
// WHAT DECIDES WHICH BINARY RUNS (the reviewer's list):
//   * `engineBinaryPath`: the login item and the apps start the engine from here, never from an app's own resources.
//   * `isNewerCopy`: a copy replaces the installed one only with a newer release, or the same release and a newer build.
//   * `copyAcceptable`: a path an app or a record names is taken only when it passes this (macOS: its code requirement;
//     elsewhere: a path an app recorded).
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { compareReleases, type AppInstallRecord } from "@waifucave/moss-protocol";
import { DEVELOPER_ID_CLAUSES, MOSS_TEAM_ID } from "../bundled-identities";
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
    return { release: raw.release, from: raw.from, ...(typeof raw.build === "string" ? { build: raw.build } : {}) };
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

/** Whether `a` should replace `b`: a newer release, or the same release and a newer build (both named, numeric order). */
export function isNewerCopy(a: EngineCopy, b: EngineCopy | undefined): boolean {
  if (b === undefined) return true;
  const c = compareReleases(a.release, b.release);
  if (c !== 0) return c > 0;
  return a.build !== undefined && b.build !== undefined && a.build.localeCompare(b.build, "en", { numeric: true }) > 0;
}

/** Where an app bundle keeps its engine and tree (electron-builder's `extraResources`, the same places
 *  `locateDaemonBinary` reads): macOS `<app>/Contents/Resources`, Windows and a deb's folder `<dir>/resources`. An AppImage
 *  is a file: its engine can't be read from outside, so the app installs it itself (`moss-core engine install`). */
export function locateEngineIn(bundlePath: string, platform: NodeJS.Platform = process.platform): { binary: string; tree: string } | undefined {
  if (!isAbsolute(bundlePath)) return undefined;
  const resources = platform === "darwin" ? join(bundlePath, "Contents", "Resources") : join(bundlePath, "resources");
  return { binary: join(resources, "daemon", engineBinaryName(platform)), tree: join(resources, "plugins") };
}

/** Places a copy: stages `moss-core.new` and `plugins.new` beside their places, moves the old ones aside (`.old`, kept
 *  until the next install, which makes them room: a running binary can be renamed on every OS but not overwritten on
 *  Windows), moves the new ones in, and writes the marker. Synchronous: a half-placed copy is never visible to a second
 *  caller, which waits on the install lock. The source must be a regular file whose real path is inside `root` (a link out
 *  of the bundle names nothing). Throws on any failure, leaving the old copy as it was or restorable from `.old`. */
export function placeEngine(home: string, src: { binary: string; tree?: string; root?: string }, copy: EngineCopy, platform: NodeJS.Platform = process.platform, verifyStaged?: (staged: string) => void): void {
  const root = src.root === undefined ? undefined : realpathSync(src.root);
  const inside = (p: string): string => {
    const real = realpathSync(p);
    if (root !== undefined && real !== root && !real.startsWith(root + sep)) throw new Error(`${p} leads outside ${src.root}`);
    return real;
  };
  const binary = inside(src.binary);
  if (!lstatSync(binary).isFile()) throw new Error(`${src.binary} is not a file`);
  const tree = src.tree !== undefined && existsSync(src.tree) ? inside(src.tree) : undefined;
  const bin = engineBinaryPath(home, platform);
  const plugins = engineTreePath(home);
  mkdirSync(dirname(bin), { recursive: true });
  for (const p of [`${bin}.new`, `${bin}.old`, `${plugins}.new`, `${plugins}.old`]) rmSync(p, { recursive: true, force: true });
  cpSync(binary, `${bin}.new`);
  chmodSync(`${bin}.new`, 0o755);
  // The bytes that will run are the ones checked: the staged copy, not the path it came from.
  try { verifyStaged?.(`${bin}.new`); } catch (err) { rmSync(`${bin}.new`, { force: true }); throw err; }
  if (tree !== undefined) cpSync(tree, `${plugins}.new`, { recursive: true, verbatimSymlinks: true });
  if (existsSync(bin)) renameSync(bin, `${bin}.old`);
  renameSync(`${bin}.new`, bin);
  if (tree !== undefined) {
    if (existsSync(plugins)) renameSync(plugins, `${plugins}.old`);
    renameSync(`${plugins}.new`, plugins);
  }
  writeEngineMarker(home, copy);
}

// ---- which copies are taken ----

/** The requirement an engine binary must meet on macOS: its own identifier, Apple's chain, MOSS's team, and for the dist
 *  build a Developer ID leaf (without it only when this daemon is itself not Developer ID signed: a checkout or the dev-
 *  signed alpha, which would otherwise refuse every copy). */
export function engineCopyRequirement(profile: MossProfile, developerId: boolean): string {
  const id = profile === "dist" ? "com.waifucave.moss.core" : "com.waifucave.moss.core.dev";
  return `identifier "${id}" and anchor apple generic${developerId ? ` and ${DEVELOPER_ID_CLAUSES}` : ""} and certificate leaf[subject.OU] = "${MOSS_TEAM_ID}"`;
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

/** `<binary> --version`, run with PATH alone for at most 10 s: its first line, or undefined when it failed. */
export function engineVersionOf(binary: string): string | undefined {
  try {
    const env: Record<string, string> = { PATH: process.env.PATH ?? process.env.Path ?? "" };
    if (process.platform === "win32") { for (const k of ["SystemRoot", "windir"]) if (process.env[k] !== undefined) env[k] = process.env[k]!; }
    const r = spawnSync(binary, ["--version"], { env, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim().split("\n")[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stages the engine a bundle carries in a scratch folder under the home's `bin/` and runs the staged-copy check on it (the
 * code requirement on macOS, `--version` saying the release), then removes the scratch. `release.bring` runs it BEFORE it waits
 * for idle or stops anything, so a copy that would be refused is refused at once, not after the person has waited or pressed
 * "Switch now". The swap checks the bytes again at `placeEngine` (the bytes that run are the ones checked last). Throws the refusal.
 */
export function verifyBundleEngine(home: string, bundlePath: string, release: string, policy: CopyPolicy): void {
  const src = locateEngineIn(bundlePath, policy.platform);
  if (src === undefined) throw new Error("no engine to find in that bundle");
  const scratch = join(home, "bin", `.verify-${process.pid}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  try {
    const real = realpathSync(src.binary), root = realpathSync(bundlePath);
    if (real !== root && !real.startsWith(root + sep)) throw new Error("the engine leads outside its bundle");
    if (!lstatSync(real).isFile()) throw new Error("the bundle's engine is not a file");
    const staged = join(scratch, engineBinaryName(policy.platform));
    cpSync(real, staged);
    chmodSync(staged, 0o755);
    verifyStagedEngine(staged, release, policy);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
