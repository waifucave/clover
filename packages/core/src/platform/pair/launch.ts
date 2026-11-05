// How the daemon starts the app through the OS (spec §3.1), never as its own child, so a daemon
// restart never takes the app down (S7 §5):
//   macOS:   open -n -g -a <Clover.app> (Launch Services; -g keeps it in the background, so the app
//            comes up in the menu bar with no window). The bundle is `CLOVER_APP` (the installer
//            writes it into the login item) or the bundle the daemon's own binary sits in.
//   Linux:   systemctl --user start clover-app.service, once the graphical session is up (the user
//            manager has DISPLAY or WAYLAND_DISPLAY); before that, "not-ready", which is not a crash.
//   Windows: schtasks /Run /TN \Clover\clover-app (the app's on-demand task).
// `resolveAppLauncher` answers null where no app is installed (a server, a cloud computer, a dev
// checkout): the daemon then runs alone.
import { existsSync } from "node:fs";
import { posix } from "node:path";
import type { CloverProfile } from "../../profile";
import type { Runner } from "../login/live";
import { appTaskName, appUnitName, systemdUserDir } from "../login/render";
import type { DaemonPlatform } from "../transport";
import type { AppStartOutcome, AppStartWhy } from "./policy";
import { writeAppStart, type RunFileDeps } from "./run-files";

// macOS and Linux paths are POSIX whatever OS renders them (a test on Windows, say).
const join = posix.join;

export interface AppLauncher {
  readonly how: string;
  start(): Promise<AppStartOutcome>;
}

export interface AppLauncherInput {
  readonly os: DaemonPlatform;
  readonly profile: CloverProfile;
  /** The daemon's own executable (`process.execPath`). */
  readonly execPath: string;
  readonly env: Record<string, string | undefined>;
  readonly homedir?: string;
  readonly exists?: (path: string) => boolean;
}

/** The `.app` bundle a path sits in (macOS), or null. */
export function appBundleOf(path: string): string | null {
  const i = path.indexOf(".app/");
  if (i >= 0) return path.slice(0, i + 4);
  return path.endsWith(".app") ? path : null;
}

/** Where systemd looks for a user unit the app's package may have installed. */
export function appUnitCandidates(input: Pick<AppLauncherInput, "profile" | "homedir">): string[] {
  const name = appUnitName(input.profile);
  return [join(systemdUserDir(input), name), join("/etc/systemd/user", name), join("/usr/lib/systemd/user", name), join("/usr/local/lib/systemd/user", name)];
}

/** Whether `systemctl --user show-environment` output carries a graphical session. */
export function hasGraphicalSession(showEnvironment: string): boolean {
  return /^(DISPLAY|WAYLAND_DISPLAY)=\S/m.test(showEnvironment);
}

export async function resolveAppLauncher(input: AppLauncherInput, run: Runner): Promise<AppLauncher | null> {
  const exists = input.exists ?? existsSync;
  if (input.os === "darwin") {
    const fromEnv = input.env.CLOVER_APP ? appBundleOf(input.env.CLOVER_APP) : null;
    const bundle = fromEnv !== null && exists(fromEnv) ? fromEnv : appBundleOf(input.execPath);
    if (bundle === null || !exists(bundle)) return null;
    return {
      how: `open -n -g -a ${bundle}`,
      async start() { return (await run(["open", "-n", "-g", "-a", bundle])).ok ? "started" : "failed"; },
    };
  }
  if (input.os === "linux") {
    if (!appUnitCandidates(input).some(exists)) return null;
    const unit = appUnitName(input.profile);
    return {
      how: `systemctl --user start ${unit}`,
      async start() {
        const env = await run(["systemctl", "--user", "show-environment"]);
        if (env.ok && !hasGraphicalSession(env.out)) return "not-ready";
        return (await run(["systemctl", "--user", "start", unit])).ok ? "started" : "failed";
      },
    };
  }
  const task = appTaskName(input.profile);
  if (!(await run(["schtasks", "/Query", "/TN", task])).ok) return null;
  return {
    how: `schtasks /Run /TN ${task}`,
    async start() { return (await run(["schtasks", "/Run", "/TN", task])).ok ? "started" : "failed"; },
  };
}

/** The pair policy's `startApp`: write `<run>/app-start.json` (who started the app, and whether in
 *  safe mode), then start the app through the OS. The boot start is "login" (the daemon came up at
 *  login, or the CLI started it); a restart is "daemon". A start file that can't be written doesn't
 *  stop the start: the app then takes it as the user's, and `pair.status` still says safe mode. */
export function appStarter(
  launcher: AppLauncher, runDir: string,
  deps: RunFileDeps & { now(): number; safeMode(): boolean },
): (why: AppStartWhy) => Promise<AppStartOutcome> {
  return async (why) => {
    try { await writeAppStart(runDir, { by: why === "boot" ? "login" : "daemon", safeMode: deps.safeMode(), at: deps.now() }, deps); }
    catch { /* see above */ }
    return launcher.start();
  };
}
