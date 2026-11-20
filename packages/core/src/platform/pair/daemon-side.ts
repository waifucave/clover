// The daemon's side of the pair, put together for `daemon.ts`: the policy (`policy.ts`), the OS start
// of the app (`launch.ts`) with its start file, and this run's app token (`run-files.ts`). The daemon
// creates it once it listens, and feeds it the `app` connections (hello with its features, close),
// `pair.exiting`, `pair.quit` and SIGTERM; `status()` is the policy's half of `pair.status`.
import { bunRunner, windowsUserSid, type Runner } from "../login/live";
import type { MossProfile } from "../../profile";
import type { DaemonPlatform } from "../transport";
import { appStarter, resolveAppLauncher, type AppLauncher } from "./launch";
import { DaemonPair, type DaemonPairOptions, type PairStopReason } from "./policy";
import { lockRunDir, markAppKept, mintAppToken, removeAppToken, takeAppKept } from "./run-files";

export interface DaemonPairSideInput {
  readonly runDir: string;
  readonly os: DaemonPlatform;
  readonly profile: MossProfile;
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
  /** Lane HS: while a background host owns the screen, the pair starts no app (its start is "not ready yet", tried again
   *  later and never a crash), so no app window opens by itself and a quit window isn't brought back (§3.1, item 116). A
   *  stand-in until the pair is retired (lanes RT, RL, then HS). */
  appStartHeld?(): boolean;
}

export interface DaemonPairSide {
  readonly pair: DaemonPair;
  /** This run's `app` token, to check the app's hello against. Never logged. */
  readonly appToken: string;
  /** How the daemon starts the app, or null when it runs alone (no app installed). */
  readonly launcher: AppLauncher | null;
  /** Stop the timers and remove the token file (the daemon is stopping). */
  dispose(): void;
  /** The daemon stops to start again at once and leaves the app open: the next one's pair waits for it to come back. */
  keepApp(): void;
}

/** The test-marked build's label (scripts/test-build.ts): `false` in every real build, a string only in a test one. */
declare const __MOSS_TEST_BUILD__: string | false | undefined;

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
  // A test-marked build never starts the app (it would open a window): the daemon runs alone, whoever connects.
  const launcher = typeof __MOSS_TEST_BUILD__ === "string" ? null : input.launcher !== undefined
    ? input.launcher
    : await resolveAppLauncher({ os: input.os, profile: input.profile, execPath: input.execPath, env: input.env }, run);
  const now = input.now ?? Date.now;
  let pair: DaemonPair | undefined;
  const started = launcher === null
    ? async () => "failed" as const
    : appStarter(launcher, input.runDir, { ...files, now, safeMode: () => pair?.status().safeMode ?? false });
  // lane HS: held while a host owns the screen.
  const startApp: typeof started = async (why) => (input.appStartHeld?.() === true ? "not-ready" : started(why));
  pair = new DaemonPair({
    now,
    after: input.after ?? realAfter,
    startApp,
    tellAppQuit: input.tellAppQuit,
    stopDaemon: input.stopDaemon,
    ...(input.log ? { log: input.log } : {}),
  }, { ...input.options, desktop: launcher !== null });
  input.log?.(`[pair] ${typeof __MOSS_TEST_BUILD__ === "string" ? "a test-marked build: the daemon never starts the app" : launcher === null ? "the daemon starts no app: no app bundle holds this engine and MOSS_APP names none (the apps start the engine, and the engine starts the host)" : `the app starts with: ${launcher.how}`}`);
  pair.start({ appKept: takeAppKept(input.runDir, now()) });
  return {
    pair,
    appToken,
    launcher,
    dispose() { pair!.dispose(); removeAppToken(input.runDir); },
    keepApp() { markAppKept(input.runDir, now()); },
  };
}
