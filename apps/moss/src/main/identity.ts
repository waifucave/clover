// Who this MOSS instance is (spec §2, item 120): the bots app, `com.waifucave.moss` (dev: `com.waifucave.moss.dev`),
// named "MOSS" (dev: "MOSS Dev"), a program of its own on the shared engine, never MOSS Code's identity. Pure (no
// Electron import), so the tests drive it under Bun.
import { homedir } from "node:os";
import { join } from "node:path";
import { PROGRAM_IDENTIFIERS } from "@waifucave/moss-protocol";

export type AppProfile = "dist" | "dev";

export interface MossIdentity {
  profile: AppProfile;
  /** The bundle id / AppUserModelID, the `moss` program's (protocol `PROGRAM_IDENTIFIERS`). */
  appId: string;
  /** The app's name; it also names its own user-data folder, so dev and dist never share one. */
  productName: string;
}

/** `MOSS_PROFILE=dev` is the dev app; anything else is the dist app (the engine's own rule). */
export function resolveProfile(env: Record<string, string | undefined>): AppProfile {
  return env.MOSS_PROFILE === "dev" ? "dev" : "dist";
}

export function mossIdentity(profile: AppProfile): MossIdentity {
  return { profile, appId: PROGRAM_IDENTIFIERS.moss[profile], productName: profile === "dev" ? "MOSS Dev" : "MOSS" };
}

/** The engine's home: `MOSS_HOME`, else `~/.moss` (the engine's own rule). Both apps share it (spec §3.1). */
export function engineHome(env: Record<string, string | undefined>, home: string = homedir()): string {
  return env.MOSS_HOME !== undefined && env.MOSS_HOME !== "" ? env.MOSS_HOME : join(home, ".moss");
}

export interface LaunchArgs {
  /** `--moss-headless`: no window is ever shown, no Dock icon, no focus taken (the tests; nothing on the screen). */
  headless: boolean;
  /** `--moss-smoke=<file>`: a headless run that writes what it drew to the file and quits (the UI test). Test builds. */
  smoke?: string;
  /** `--moss-render=<dir>`: a headless run that draws the window offscreen, scene by scene, into PNGs. Test builds. */
  render?: string;
}

export function parseLaunchArgs(argv: readonly string[]): LaunchArgs {
  const value = (flag: string): string | undefined => {
    const v = argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
    return v === undefined || v === "" ? undefined : v;
  };
  const smoke = value("--moss-smoke");
  const render = value("--moss-render");
  return {
    headless: smoke !== undefined || render !== undefined || argv.includes("--moss-headless"),
    ...(smoke !== undefined ? { smoke } : {}),
    ...(render !== undefined ? { render } : {}),
  };
}

/** The window's one stable id in presence reports and placements (`WindowId`): MOSS has one window. */
export const MAIN_WINDOW_ID = "main";

/** The window's in-memory session: nothing kept between runs (the engine holds every state). */
export const WINDOW_PARTITION = "moss-window";
