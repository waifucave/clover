// `moss-core engine install --app <bundle path> [--build <id>]` (spec §3.1 "Where the copies are found"; RL). What an app
// runs, with its OWN bundled engine, before it starts anything through the OS: it puts that engine, the files that sit beside
// it (the plugin Bun, the link sidecar, the process holder: `engineSidecars`) and the bundled tree beside them under the home,
// at `<home>/bin/daemon/` and `<home>/bin/plugins`, UNDER THE INSTALL LOCK and only when it is newer than what is there (a
// newer release, or the same release and a newer build: this build's own stamp, `ENGINE_BUILD`, unless `--build` names one),
// or is the very copy that is there and its set is not whole (a sidecar missing or failing its check: placed again). The loser
// of two apps starting at once finds the winner's copy in place and just uses it. It prints one JSON line, `{ installed,
// binary, release, build? }`: the binary the login item and the apps start the engine from, whichever copy won.
//
// Nothing here reads a path from anyone but the caller's own command line: the source is the running binary
// (`process.execPath`), the named files in its own folder and the tree beside it, and the checks the engine makes of any
// staged copy (`verifyStagedEngine` and `verifyStagedSidecar`: on macOS each file's code requirement, on every OS that the
// engine says it is this release) apply to them too.
import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { APP_RECORDS_DIR, ENGINE_INSTALL_LOCK, MOSS_PROGRAMS } from "@waifucave/moss-protocol";
import { tryFileLock } from "../lock";
import { CORE_VERSION } from "../version";
import { ENGINE_BUILD } from "../engine-build";
import { resolveMossProfile } from "../profile";
import { SystemClock } from "../clock/system-clock";
import { codesignCheck, engineBinaryPath, engineCopyRequirement, engineTreePath, ENGINE_MARKER, installedSetProblem, placeEngine, verifyStagedEngine, verifyStagedSidecar, type CodeCheck, type CopyPolicy } from "./engine-copy";
import { EngineReleaseHome } from "./release-home";
import { appPeerRequirement } from "../platform/peer-signature";
import { endpointAnswers, resolveEndpoint } from "../platform/transport";
import { DEVELOPER_ID_CLAUSES, engineSidecars } from "../bundled-identities";

export const ENGINE_INSTALL_USAGE = "usage: moss-core engine install --app <the app's bundle path> [--build <id>]";

export interface EngineInstallEnv {
  home: string;
  execPath?: string;
  release?: string;
  platform?: NodeJS.Platform;
  /** Test seam: whether an engine answers on this home (default: a dial of its socket). */
  engineRunning?: () => Promise<boolean>;
  /** Test seam: the code check (default: `codesign --verify`), used on macOS only. */
  check?: CodeCheck;
  /** Test seam: the staged copy's check (default: `verifyStagedEngine`). */
  verify?: (staged: string, release: string) => void;
  out(line: string): void;
  err(line: string): void;
}

export async function runEngineInstall(argv: readonly string[], env: EngineInstallEnv): Promise<number> {
  const at = (flag: string) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
  const app = at("--app"), asked = at("--build"), build = asked ?? ENGINE_BUILD;
  if (app === undefined || !isAbsolute(app) || (argv.includes("--build") && (asked === undefined || !/^\d{1,20}$/.test(asked)))) { env.err(ENGINE_INSTALL_USAGE); return 2; }
  const release = env.release ?? CORE_VERSION;
  const platform = env.platform ?? process.platform;
  const exec = realpathSync(env.execPath ?? process.execPath);
  const dest = engineBinaryPath(env.home, platform);
  const profile = resolveMossProfile();
  try {
    const policy: CopyPolicy = { platform, profile, developerId: platform === "darwin" && appPeerRequirement(profile).includes(DEVELOPER_ID_CLAUSES), records: () => [], ...(env.check ? { check: env.check } : {}) };
    // The app is about to start the home's binary: on macOS it must meet the engine's code requirement (the one a staged copy
    // meets), or the app says so and starts its own bundled engine instead. Checked here, in this binary's own process, so the
    // app (which carries no copy of the requirement) never executes an unchecked file from the home.
    const unsafe = (): boolean => platform === "darwin" && existsSync(dest) && !(env.check ?? codesignCheck)(dest, engineCopyRequirement(profile, policy.developerId));
    // A running engine reads its bundled tree and is the one to be swapped, by `release.bring` once nothing is mid-work: the app
    // that starts beside it never places a copy under it (the engine's tree is checked file by file against its own manifest).
    const running = await (env.engineRunning ?? (() => endpointAnswers(resolveEndpoint(join(env.home, "run"), platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux").path)))();
    if (running) {
      const have = new EngineReleaseHome({ home: env.home, engine: release, clock: new SystemClock(), place: () => {} }).installed();
      env.out(JSON.stringify({ installed: false, deferred: true, binary: dest, release: have?.release ?? release, ...(have?.build !== undefined ? { build: have.build } : {}), ...(unsafe() ? { unsafe: true } : {}) }));
      return 0;
    }
    const home = new EngineReleaseHome({
      home: env.home, engine: release, clock: new SystemClock(),
      place: (copy) => {
        const tree = join(dirname(dirname(exec)), "plugins");
        const sidecars = engineSidecars(platform).map((s) => join(dirname(exec), s.file));
        placeEngine(env.home, { binary: exec, sidecars, ...(existsSync(tree) ? { tree } : {}) }, copy, platform, (staged) => (env.verify ?? ((s, r) => verifyStagedEngine(s, r, policy)))(staged, copy.release), (staged, file) => verifyStagedSidecar(staged, file, policy));
      },
      intact: () => installedSetProblem(env.home, policy) === undefined,
    });
    // Already running from the home's own copy: there is nothing to put anywhere.
    let installed = false;
    if (!(existsSync(dest) && realpathSync(dest) === exec)) installed = (await home.install({ release, from: app, ...(build !== undefined ? { build } : {}) })).installed;
    const current = home.installed();
    env.out(JSON.stringify({ installed, binary: dest, release: current?.release ?? release, ...(current?.build !== undefined ? { build: current.build } : {}), ...(unsafe() ? { unsafe: true } : {}) }));
    return 0;
  } catch (err) {
    env.err(`engine install: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export const ENGINE_RESET_USAGE = "usage: moss-core engine reset";

/**
 * `moss-core engine reset` (run by the person): takes the installed engine, its bundled tree, its marker and the apps' records
 * out of the home, so the next app start installs its own engine. For the app that can never connect: the engine under the home
 * is newer than anything the app can update to (a rollback, a channel change, a build with no update feed). It refuses while an
 * engine answers (stop MOSS first), runs under the install lock, and touches only what an install writes under `bin/` and
 * `apps/`: nothing else in the home (no conversation, setting, key or plugin).
 */
export async function runEngineReset(env: Pick<EngineInstallEnv, "home" | "platform" | "engineRunning" | "out" | "err">): Promise<number> {
  const platform = env.platform ?? process.platform;
  const running = await (env.engineRunning ?? (() => endpointAnswers(resolveEndpoint(join(env.home, "run"), platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux").path)))();
  if (running) { env.err("engine reset: MOSS is running; quit MOSS Code (and MOSS) first, then run this again"); return 1; }
  const lock = tryFileLock(join(env.home, ENGINE_INSTALL_LOCK));
  if (lock === undefined) { env.err("engine reset: an engine install is running; try again in a moment"); return 1; }
  const removed: string[] = [];
  try {
    const bin = engineBinaryPath(env.home, platform);
    const tree = engineTreePath(env.home);
    const sidecars = engineSidecars(platform).flatMap((s) => { const f = join(dirname(bin), s.file); return [f, `${f}.new`, `${f}.old`]; });
    const targets = [bin, `${bin}.new`, `${bin}.old`, ...sidecars, tree, `${tree}.new`, `${tree}.old`, join(env.home, ENGINE_MARKER), join(env.home, "bin", ".restarted-into.json"), ...MOSS_PROGRAMS.map((p) => join(env.home, APP_RECORDS_DIR, `${p}.json`))];
    try { for (const e of readdirSync(join(env.home, "bin"))) if (e.startsWith(".verify-")) targets.push(join(env.home, "bin", e)); } catch { /* no bin/ */ }
    for (const t of targets) if (existsSync(t)) { rmSync(t, { recursive: true, force: true }); removed.push(t.slice(env.home.length + 1)); }
    env.out(JSON.stringify({ reset: true, removed }));
    return 0;
  } catch (err) {
    env.err(`engine reset: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    lock.release();
  }
}
