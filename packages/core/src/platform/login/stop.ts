// Stopping the running daemon cleanly, for `autostart disable --stop` and `autostart remove`: an
// uninstaller needs the daemon's files free (on Windows a running binary can't be replaced or
// deleted). The clean way is the pair's quit: the daemon tells the app, stops, and exits 0, so the
// crash-only login unit leaves it down and `supervise` ends too. Only if it doesn't go in time does the
// caller fall back to the OS's stop (`stopThroughOs`: launchctl kill SIGTERM, systemctl --user stop,
// schtasks /End).

export type CleanStopResult = "not-running" | "stopped" | "timed-out";

export interface CleanStopDeps {
  /** Whether a daemon answers on this home's endpoint. */
  answers(): Promise<boolean>;
  /** Whether the daemon's process is still there (its files are held until it has exited). */
  stillRunning(): boolean;
  /** Ask the running daemon to quit the pair (it exits 0). False when it couldn't be asked. */
  requestQuit(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export async function stopDaemonCleanly(deps: CleanStopDeps, timeoutMs = 10_000, pollMs = 200): Promise<CleanStopResult> {
  if (!(await deps.answers())) return "not-running";
  if (!(await deps.requestQuit())) return "timed-out";
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    await deps.sleep(pollMs);
    if (!deps.stillRunning() && !(await deps.answers())) return "stopped";
  }
  return "timed-out";
}
