// Who this app instance is (spec §2): the dist and dev identities, and the window every instance opens.
// Pure — no Electron import — so it is unit-tested under Bun (test/identity.test.ts).
import { homedir } from "node:os";
import { join } from "node:path";

export type AppProfile = "dist" | "dev";

export interface AppIdentity {
  profile: AppProfile;
  /** The bundle id / AppUserModelID: `com.waifucave.clover` (dev: `.dev`). */
  appId: string;
  /** The app's name, which also names its user-data folder, so dev and dist never share one. */
  productName: string;
}

/** `CLOVER_PROFILE=dev` is the dev app; anything else is the dist app (the daemon's own rule, `profile.ts`). */
export function resolveAppProfile(env: Record<string, string | undefined>): AppProfile {
  return env.CLOVER_PROFILE === "dev" ? "dev" : "dist";
}

export function appIdentity(profile: AppProfile): AppIdentity {
  return profile === "dev"
    ? { profile, appId: "com.waifucave.clover.dev", productName: "Clover Dev" }
    : { profile, appId: "com.waifucave.clover", productName: "Clover" };
}

/** The daemon home this app's daemon uses: `CLOVER_HOME`, else `~/.clover` — the daemon's own rule
 *  (`clover-dir.ts`), which is why the dev scripts always set both `CLOVER_HOME` and `CLOVER_PROFILE`. */
export function daemonHome(env: Record<string, string | undefined>, home: string = homedir()): string {
  return env.CLOVER_HOME !== undefined && env.CLOVER_HOME !== "" ? env.CLOVER_HOME : join(home, ".clover");
}

/** The daemon's socket in that home (the app does not connect yet: lane E's E-M1). */
export function daemonSocketPath(home: string): string {
  return join(home, "run", "core.sock");
}

export interface LaunchArgs {
  /** `--clover-smoke`: open the window, report what it is on stdout, and quit (the UI test, CI only). */
  smoke: boolean;
}

export function parseLaunchArgs(argv: readonly string[]): LaunchArgs {
  return { smoke: argv.includes("--clover-smoke") };
}

/** The renderer's locked-down preferences: sandboxed, isolated, no Node, no remote content (spec §5.5, §12.1). */
export const WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  spellcheck: false,
} as const;

/** The one window the skeleton opens. Hidden until its page is ready, so it never flashes empty. */
export function windowOptions(identity: AppIdentity): { width: number; height: number; title: string; show: boolean; webPreferences: typeof WEB_PREFERENCES } {
  return { width: 960, height: 640, title: identity.productName, show: false, webPreferences: WEB_PREFERENCES };
}

/** The line the smoke run prints, parsed back by the UI test. */
export const SMOKE_PREFIX = "CLOVER_SMOKE ";
