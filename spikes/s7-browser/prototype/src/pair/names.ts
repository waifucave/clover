// The pair's names, all derived from the home folder, so several homes (CI runs, a dev profile) never collide.
// Pure. Clover's real names would be com.waifucave.clover.core[.dev] and clover-core[-dev]; the spike adds ".s7" and
// a short hash of the home.
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface PairNames {
  suffix: string;
  /** macOS launchd label. */
  label: string;
  /** systemd --user units. */
  coreUnit: string;
  appUnit: string;
  /** Windows Task Scheduler paths. */
  coreTask: string;
  appTask: string;
  /** The daemon's socket (macOS, Linux) or named pipe (Windows). */
  socket: string;
  lockFile: string;
  pidFile: string;
  bootsFile: string;
  appStartFile: string;
  appLog: string;
  configFile: string;
  logsDir: string;
}

export function pairNames(home: string, platform: string = process.platform): PairNames {
  const suffix = createHash("sha256").update(home).digest("hex").slice(0, 8);
  const run = join(home, "run");
  return {
    suffix,
    label: `com.waifucave.clover.s7.core.${suffix}`,
    coreUnit: `clover-s7-core-${suffix}.service`,
    appUnit: `clover-s7-app-${suffix}.service`,
    coreTask: `\\Clover S7\\core-${suffix}`,
    appTask: `\\Clover S7\\app-${suffix}`,
    socket: platform === "win32" ? `\\\\.\\pipe\\clover-s7-core-${suffix}` : join(run, "core.sock"),
    lockFile: join(run, "core.lock"),
    pidFile: join(run, "core.pid"),
    bootsFile: join(run, "boots.jsonl"),
    appStartFile: join(run, "app-start.json"),
    appLog: join(run, "app.jsonl"),
    configFile: join(home, "pair.json"),
    logsDir: join(home, "logs"),
  };
}

/** What the installer writes and both halves read: where the other half is and how to start it. */
export interface PairConfig {
  home: string;
  daemonBin: string;
  /** The Electron executable (macOS: the .app bundle is found from it). */
  electron: string;
  /** The app's folder (its package.json and main.cjs). */
  appDir: string;
  /** How long a freshly started daemon waits for an app before it starts one. */
  appGraceMs: number;
  /** Windows: how the daemon starts the app — through its own scheduled task, or a detached child. */
  windowsAppStart: "task" | "spawn";
  /** Windows: the task runs `supervise` (which restarts a crashed daemon) instead of `daemon`. */
  windowsSupervise?: boolean;
  /** Linux: the display the app should use (the session's, imported into the user manager). */
  display?: string;
}

/** The crash-restart policy: the delay before restart n (1-based) and whether it starts in safe mode. Pure. */
export function restartPlan(crashTimes: readonly number[], now: number): { delayMs: number; safeMode: boolean } {
  const recent = crashTimes.filter((t) => now - t <= 120_000).length;
  const delays = [1000, 2000, 4000, 8000, 16_000, 30_000];
  return { delayMs: delays[Math.min(delays.length - 1, Math.max(0, recent - 1))]!, safeMode: recent >= 3 };
}
