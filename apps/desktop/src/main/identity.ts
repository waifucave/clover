// Who this app instance is (spec §2): the dist and dev identities, and the window every instance opens.
// Pure — no Electron import — so it is unit-tested under Bun (test/identity.test.ts).
import { homedir } from "node:os";
import { join } from "node:path";

export type AppProfile = "dist" | "dev";

export interface AppIdentity {
  profile: AppProfile;
  /** The bundle id / AppUserModelID: `com.waifucave.moss.code` (dev: `.dev`). */
  appId: string;
  /** The app's name, which also names its user-data folder, so dev and dist never share one. */
  productName: string;
}

/** `MOSS_PROFILE=dev` is the dev app; anything else is the dist app (the daemon's own rule, `profile.ts`). */
export function resolveAppProfile(env: Record<string, string | undefined>): AppProfile {
  return env.MOSS_PROFILE === "dev" ? "dev" : "dist";
}

export function appIdentity(profile: AppProfile): AppIdentity {
  return profile === "dev"
    ? { profile, appId: "com.waifucave.moss.code.dev", productName: "MOSS Code Dev" }
    : { profile, appId: "com.waifucave.moss.code", productName: "MOSS Code" };
}

/** The daemon home this app's daemon uses: `MOSS_HOME`, else `~/.moss` — the daemon's own rule
 *  (`moss-dir.ts`), which is why the dev scripts always set both `MOSS_HOME` and `MOSS_PROFILE`. */
export function daemonHome(env: Record<string, string | undefined>, home: string = homedir()): string {
  return env.MOSS_HOME !== undefined && env.MOSS_HOME !== "" ? env.MOSS_HOME : join(home, ".moss");
}

export interface LaunchArgs {
  /** `--moss-smoke`: start headless, draw the default shell, report what it is on stdout, and quit (the UI test). */
  smoke: boolean;
  /** `--moss-headless` (or the smoke run): no window is ever shown, no Dock icon, no tray, no focus taken; the
   *  tests and local checks run this way (plan §8: nothing on the owner's screen). */
  headless: boolean;
  /** `--moss-capture=<png>`: in a headless run, draw offscreen and save the main window's pixels there. */
  capture?: string;
  /** `--safe-mode`: only the app's own plugins (§5.8). */
  safeMode: boolean;
  /** `--quit`: a second instance's way to ask the running app to Quit (the launcher's Quit on Linux). */
  quit: boolean;
}

export function parseLaunchArgs(argv: readonly string[], env: Record<string, string | undefined> = {}): LaunchArgs {
  const smoke = argv.includes("--moss-smoke");
  const capture = argv.find((a) => a.startsWith("--moss-capture="))?.slice("--moss-capture=".length);
  return {
    smoke,
    headless: smoke || argv.includes("--moss-headless") || env.MOSS_APP_HEADLESS === "1",
    ...(capture !== undefined && capture !== "" ? { capture } : {}),
    safeMode: argv.includes("--safe-mode"),
    quit: argv.includes("--quit"),
  };
}

/** The line the smoke run prints, parsed back by the UI test. */
export const SMOKE_PREFIX = "MOSS_SMOKE ";

/** The UI session's partition: in memory, so layers keep nothing between runs (state is the core's, decision 77). */
export const UI_PARTITION = "moss-ui";
