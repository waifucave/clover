// `clover-core supervise`: the restart loop the OS login unit runs (§3.1). It starts the daemon and
// restarts it after a crash with growing back-off; a clean daemon exit (a Quit, which the daemon
// reports) ends the loop, so the OS unit — crash-only — does not bring it back until the next login.
// On Windows this loop is the daemon's only restart mechanism, because Task Scheduler does not
// restart a process the task spawned.
//
// A daemon that exits with UPDATE_RESTART_EXIT_CODE (lane M: a server's daemon that swapped in its update, or rolled
// one back) is started again at once, and that start is not a crash.
//
// The app is not the supervisor's business: the daemon starts and restarts the app itself, through
// the OS (`platform/pair`), so a daemon restarted here starts the app again if it went with it.

/** One supervised run of the daemon. `exitCode` 0 (or a recorded clean stop) is not a crash. */
export interface DaemonRun {
  /** Resolves when the daemon process exits, with its code (null = killed by signal). */
  readonly exited: Promise<number | null>;
  /** Ask the daemon to stop (SIGTERM); the loop then ends on a clean exit. */
  stop(): void;
}

export interface SuperviseDeps {
  /** Start one daemon process (`<bin> daemon run`). */
  spawnDaemon(): DaemonRun;
  /** Sleep for the back-off, cancellable; resolves true normally, false if the loop should stop. */
  wait(ms: number): Promise<boolean>;
  /** Whether the loop should keep going (false after a stop signal). */
  shouldContinue(): boolean;
  /** For logging; defaults to console.error. */
  log?(line: string): void;
  /** A clean daemon exit code — the daemon reports it stopped on purpose (a Quit). Default: 0. */
  isCleanExit?(code: number | null): boolean;
  /** The clock, for the crash window. Default: Date.now. */
  now?(): number;
}

/** Lane M (M-M2): the daemon's exit for "start me again now": its own update is in place, or rolled back. */
export const UPDATE_RESTART_EXIT_CODE = 76;

/** Crashes older than this no longer raise the back-off, so a daemon that ran for hours and then
 *  crashed is restarted after 0.5 s again (the same two minutes as the app's restarts). */
export const SUPERVISE_CRASH_WINDOW_MS = 120_000;

export interface SuperviseResult {
  readonly starts: number;
  readonly crashes: number;
  /** Why the loop ended: the daemon stopped cleanly, or the supervisor was asked to stop. */
  readonly ended: "clean-exit" | "stopped";
}

/** Back-off after the nth crash in the window: 0.5 s, 1 s, 2 s, 4 s… capped at 30 s (S7 §5 measured
 *  the supervised daemon back in 0.6 s, then 1.2 s). */
export function backoffMs(consecutiveCrashes: number): number {
  return Math.min(30_000, 500 * 2 ** Math.max(0, consecutiveCrashes - 1));
}

/** Run the supervise loop. Returns when the daemon exits cleanly or a stop is requested. */
export async function superviseLoop(deps: SuperviseDeps): Promise<SuperviseResult> {
  const log = deps.log ?? ((l: string) => console.error(`[supervise] ${l}`));
  const isClean = deps.isCleanExit ?? ((code: number | null) => code === 0);
  const now = deps.now ?? Date.now;
  const recent: number[] = [];
  let starts = 0, crashes = 0;
  while (deps.shouldContinue()) {
    starts++;
    const run = deps.spawnDaemon();
    const code = await run.exited;
    if (isClean(code)) { log("daemon exited cleanly; not restarting until next login"); return { starts, crashes, ended: "clean-exit" }; }
    if (code === UPDATE_RESTART_EXIT_CODE) { log("daemon restarts for its update"); continue; }
    crashes++;
    const t = now();
    recent.push(t);
    while (recent.length > 0 && t - recent[0]! > SUPERVISE_CRASH_WINDOW_MS) recent.shift();
    if (!deps.shouldContinue()) break;
    const delay = backoffMs(recent.length);
    log(`daemon crashed (code ${code}); restarting in ${delay}ms`);
    if (!(await deps.wait(delay))) break;
  }
  return { starts, crashes, ended: "stopped" };
}
