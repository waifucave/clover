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

export interface LaunchArgs {
  /** `--clover-smoke`: start headless, draw the default shell, report what it is on stdout, and quit (the UI test). */
  smoke: boolean;
  /** `--clover-headless` (or the smoke run): no window is ever shown, no Dock icon, no tray, no focus taken; the
   *  tests and local checks run this way (plan §8: nothing on the owner's screen). */
  headless: boolean;
  /** `--clover-capture=<png>`: in a headless run, draw offscreen and save the main window's pixels there. */
  capture?: string;
  /** `--safe-mode`: only the app's own plugins (§5.8). */
  safeMode: boolean;
  /** `--quit`: a second instance's way to ask the running app to Quit (the launcher's Quit on Linux). */
  quit: boolean;
}

export function parseLaunchArgs(argv: readonly string[], env: Record<string, string | undefined> = {}): LaunchArgs {
  const smoke = argv.includes("--clover-smoke");
  const capture = argv.find((a) => a.startsWith("--clover-capture="))?.slice("--clover-capture=".length);
  return {
    smoke,
    headless: smoke || argv.includes("--clover-headless") || env.CLOVER_APP_HEADLESS === "1",
    ...(capture !== undefined && capture !== "" ? { capture } : {}),
    safeMode: argv.includes("--safe-mode"),
    quit: argv.includes("--quit"),
  };
}

/** The line the smoke run prints, parsed back by the UI test. */
export const SMOKE_PREFIX = "CLOVER_SMOKE ";

/** The UI session's partition: in memory, so layers keep nothing between runs (state is the core's, decision 77). */
export const UI_PARTITION = "clover-ui";
