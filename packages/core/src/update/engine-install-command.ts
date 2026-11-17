// `moss-core engine install --app <bundle path> [--build <id>]` (spec §3.1 "Where the copies are found"; RL). What an app
// runs, with its OWN bundled engine, before it starts anything through the OS: it puts that engine (and the bundled tree
// beside it) under the home, at `<home>/bin/daemon/moss-core` and `<home>/bin/plugins`, UNDER THE INSTALL LOCK and only
// when it is newer than what is there (a newer release, or the same release and a newer build). The loser of two apps
// starting at once finds the winner's copy in place and just uses it. It prints one JSON line, `{ installed, binary,
// release, build? }`: the binary the login item and the apps start the engine from, whichever copy won.
//
// Nothing here reads a path from anyone but the caller's own command line: the source is the running binary
// (`process.execPath`) and the tree beside it, and the check the engine makes of any staged copy (`verifyStagedEngine`: on
// macOS its code requirement, on every OS that it says it is this release) applies to it too.
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { CORE_VERSION } from "../version";
import { resolveMossProfile } from "../profile";
import { SystemClock } from "../clock/system-clock";
import { engineBinaryPath, placeEngine, verifyStagedEngine, type CopyPolicy } from "./engine-copy";
import { EngineReleaseHome } from "./release-home";
import { appPeerRequirement } from "../platform/peer-signature";
import { endpointAnswers, resolveEndpoint } from "../platform/transport";
import { DEVELOPER_ID_CLAUSES } from "../bundled-identities";

export const ENGINE_INSTALL_USAGE = "usage: moss-core engine install --app <the app's bundle path> [--build <id>]";

export interface EngineInstallEnv {
  home: string;
  execPath?: string;
  release?: string;
  platform?: NodeJS.Platform;
  /** Test seam: whether an engine answers on this home (default: a dial of its socket). */
  engineRunning?: () => Promise<boolean>;
  /** Test seam: the staged copy's check (default: `verifyStagedEngine`). */
  verify?: (staged: string, release: string) => void;
  out(line: string): void;
  err(line: string): void;
}

export async function runEngineInstall(argv: readonly string[], env: EngineInstallEnv): Promise<number> {
  const at = (flag: string) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
  const app = at("--app"), build = at("--build");
  if (app === undefined || !isAbsolute(app) || (argv.includes("--build") && (build === undefined || build === "" || build.length > 64))) { env.err(ENGINE_INSTALL_USAGE); return 2; }
  const release = env.release ?? CORE_VERSION;
  const platform = env.platform ?? process.platform;
  const exec = realpathSync(env.execPath ?? process.execPath);
  const dest = engineBinaryPath(env.home, platform);
  try {
    // A running engine reads its bundled tree and is the one to be swapped, by `release.bring` once nothing is mid-work: the app
    // that starts beside it never places a copy under it (the engine's tree is checked file by file against its own manifest).
    const running = await (env.engineRunning ?? (() => endpointAnswers(resolveEndpoint(join(env.home, "run"), platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux").path)))();
    if (running) {
      const have = new EngineReleaseHome({ home: env.home, engine: release, clock: new SystemClock(), place: () => {} }).installed();
      env.out(JSON.stringify({ installed: false, deferred: true, binary: dest, release: have?.release ?? release, ...(have?.build !== undefined ? { build: have.build } : {}) }));
      return 0;
    }
    const profile = resolveMossProfile();
    const policy: CopyPolicy = { platform, profile, developerId: platform === "darwin" && appPeerRequirement(profile).includes(DEVELOPER_ID_CLAUSES), records: () => [] };
    const home = new EngineReleaseHome({
      home: env.home, engine: release, clock: new SystemClock(),
      place: (copy) => {
        const tree = join(dirname(dirname(exec)), "plugins");
        placeEngine(env.home, { binary: exec, ...(existsSync(tree) ? { tree } : {}) }, copy, platform, (staged) => (env.verify ?? ((s, r) => verifyStagedEngine(s, r, policy)))(staged, copy.release));
      },
    });
    // Already running from the home's own copy: there is nothing to put anywhere.
    let installed = false;
    if (!(existsSync(dest) && realpathSync(dest) === exec)) installed = (await home.install({ release, from: app, ...(build !== undefined ? { build } : {}) })).installed;
    const current = home.installed();
    env.out(JSON.stringify({ installed, binary: dest, release: current?.release ?? release, ...(current?.build !== undefined ? { build: current.build } : {}) }));
    return 0;
  } catch (err) {
    env.err(`engine install: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
