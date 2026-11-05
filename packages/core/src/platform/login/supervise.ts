// `clover-core supervise`: the restart loop the OS login unit runs (§3.1). It starts the daemon and
// restarts it after a crash with growing back-off; a clean daemon exit (a Quit, which the daemon
// reports) ends the loop, so the OS unit — crash-only — does not bring it back until the next login.
// On Windows this loop is the daemon's only restart mechanism, because Task Scheduler does not
// restart a process the task spawned.
//
// The app side of the pair (starting and restarting the Electron app) is lane E's, over B's "the
// app and the pair" protocol; `onDaemonStarted` is the seam C hands E, wired in a later step once
// the handshake is agreed. Here the supervisor keeps the daemon up; the pure policy is tested with
// an injected spawn and clock.

/** One supervised run of the daemon. `exitCode` 0 (or a recorded clean stop) is not a crash. */
export interface DaemonRun {
  /** Resolves when the daemon process exits, with its code (null = killed by signal). */
  readonly exited: Promise<number | null>;
  /** Ask the daemon to stop (SIGTERM); the loop then ends on a clean exit. */
  stop(): void;
}

export interface SuperviseDeps {
  /** Start one daemon process (`<bin> daemon run`). */
  startDaemon(): DaemonRun;
  /** Sleep for the back-off, cancellable; resolves true normally, false if the loop should stop. */
  wait(ms: number): Promise<boolean>;
  /** Whether the loop should keep going (false after a stop signal). */
  shouldContinue(): boolean;
  /** For logging; defaults to console.error. */
  log?(line: string): void;
  /** A clean daemon exit code — the daemon reports it stopped on purpose (a Quit). Default: 0. */
  isCleanExit?(code: number | null): boolean;
}

export interface SuperviseResult {
  readonly starts: number;
  readonly crashes: number;
  /** Why the loop ended: the daemon stopped cleanly, or the supervisor was asked to stop. */
  readonly ended: "clean-exit" | "stopped";
}

/** Back-off after the nth consecutive crash: 0.5 s, 1 s, 2 s, 4 s… capped at 30 s (S7 §5 measured the
 *  supervised daemon back in 0.6 s, then 1.2 s). */
export function backoffMs(consecutiveCrashes: number): number {
  return Math.min(30_000, 500 * 2 ** Math.max(0, consecutiveCrashes - 1));
}

/** Run the supervise loop. Returns when the daemon exits cleanly or a stop is requested. */
export async function superviseLoop(deps: SuperviseDeps): Promise<SuperviseResult> {
  const log = deps.log ?? ((l: string) => console.error(`[supervise] ${l}`));
  const isClean = deps.isCleanExit ?? ((code: number | null) => code === 0);
  let starts = 0, crashes = 0, consecutive = 0;
  while (deps.shouldContinue()) {
    starts++;
    const run = deps.startDaemon();
    const code = await run.exited;
    if (isClean(code)) { log("daemon exited cleanly; not restarting until next login"); return { starts, crashes, ended: "clean-exit" }; }
    crashes++; consecutive++;
    if (!deps.shouldContinue()) break;
    const delay = backoffMs(consecutive);
    log(`daemon crashed (code ${code}); restarting in ${delay}ms`);
    if (!(await deps.wait(delay))) break;
  }
  return { starts, crashes, ended: "stopped" };
}
