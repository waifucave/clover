// The daemon's side of the pair, put together for `daemon.ts`: the policy (`policy.ts`), the OS start
// of the app (`launch.ts`) with its start file, and this run's app token (`run-files.ts`). The daemon
// creates it once it listens, and feeds it the `app` connections (hello with its features, close),
// `pair.exiting`, `pair.quit` and SIGTERM; `status()` is the policy's half of `pair.status`.
import { bunRunner, windowsUserSid, type Runner } from "../login/live";
import type { CloverProfile } from "../../profile";
import type { DaemonPlatform } from "../transport";
import { appStarter, resolveAppLauncher, type AppLauncher } from "./launch";
import { DaemonPair, type DaemonPairOptions, type PairStopReason } from "./policy";
import { lockRunDir, mintAppToken, removeAppToken } from "./run-files";

export interface DaemonPairSideInput {
  readonly runDir: string;
  readonly os: DaemonPlatform;
  readonly profile: CloverProfile;
  readonly execPath: string;
  readonly env: Record<string, string | undefined>;
  /** Send `app.quit{reason}` to these app connections. */
  tellAppQuit(reason: PairStopReason, connIds: readonly string[]): void;
  /** Stop the daemon on purpose (exit 0). */
  stopDaemon(why: string): void;
  log?(line: string): void;
  /** Test seams. */
  readonly run?: Runner;
  readonly launcher?: AppLauncher | null;
  readonly now?: () => number;
  readonly after?: (ms: number, fn: () => void) => () => void;
  readonly options?: Omit<DaemonPairOptions, "desktop">;
}

export interface DaemonPairSide {
  readonly pair: DaemonPair;
  /** This run's `app` token, to check the app's hello against. Never logged. */
  readonly appToken: string;
  /** How the daemon starts the app, or null when it runs alone (no app installed). */
  readonly launcher: AppLauncher | null;
  /** Stop the timers and remove the token file (the daemon is stopping). */
  dispose(): void;
}

const realAfter = (ms: number, fn: () => void): (() => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

/** Mint the token, find the app, and start the policy (on a desktop, the 2 s grace for the app). */
export async function startDaemonPairSide(input: DaemonPairSideInput): Promise<DaemonPairSide> {
  const run = input.run ?? bunRunner;
  const userSid = input.os === "win32" ? await windowsUserSid(run) : undefined;
  const files = { os: input.os, run, ...(userSid ? { userSid } : {}) };
  await lockRunDir(input.runDir, files);
  const appToken = await mintAppToken(input.runDir, files);
  const launcher = input.launcher !== undefined
    ? input.launcher
    : await resolveAppLauncher({ os: input.os, profile: input.profile, execPath: input.execPath, env: input.env }, run);
  const now = input.now ?? Date.now;
  let pair: DaemonPair | undefined;
  const startApp = launcher === null
    ? async () => "failed" as const
    : appStarter(launcher, input.runDir, { ...files, now, safeMode: () => pair?.status().safeMode ?? false });
  pair = new DaemonPair({
    now,
    after: input.after ?? realAfter,
    startApp,
    tellAppQuit: input.tellAppQuit,
    stopDaemon: input.stopDaemon,
    ...(input.log ? { log: input.log } : {}),
  }, { ...input.options, desktop: launcher !== null });
  input.log?.(`[pair] ${launcher === null ? "no app installed: the daemon runs alone" : `the app starts with: ${launcher.how}`}`);
  pair.start();
  return {
    pair,
    appToken,
    launcher,
    dispose() { pair!.dispose(); removeAppToken(input.runDir); },
  };
}
