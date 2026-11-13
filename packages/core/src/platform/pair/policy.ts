// The daemon's side of the always-on pair (spec §3.1, §5.8; plan §4 C M1). On a desktop the app and
// the daemon are one pair: starting either starts the other, the daemon restarts a crashed app, and
// Quit stops both. Lane E builds the app's side over B's "the app and the pair" protocol
// (`pair.status`, `pair.quit`, `pair.exiting`, `app.quit`); this is the daemon's policy, pure, with
// the clock, the timers, the OS start and the RPC sends injected. Spike S7 §5 measured these rules on
// all three OSes:
//   - no app within `graceMs` (2 s) of the daemon's start: start one through the OS;
//   - an app connection that drops without `pair.exiting` first is a crash: start it again after 1, 2,
//     4 s… (crashes in the last two minutes), and the start after the third crash in two minutes is in
//     safe mode, which the app reads from `pair.status` (§5.8);
//   - a side that leaves on purpose says so first: the app's `pair.exiting{quit|update}` and the
//     daemon's `app.quit{reason}` stop the pair (exit 0, so the crash-only login unit leaves it down);
//     `pair.exiting{restart}` is the app restarting itself, which is not a crash, and leaves safe mode;
//   - an app that stops answering `app.ping` for 15 s (sent every 5 s; ruling R9) is ended, and its
//     restart is in safe mode (`appHung`);
//   - the app that asked for `pair.quit` exits once it has the answer, so `app.quit` goes only to the
//     other app connections, and only to those whose hello listed the `app.quit` feature (agreed with
//     lane E, E-M1 #168). An app that can't be told is waited for, then the daemon stops anyway.
// An app that the OS refused to start, or that never connected within `connectTimeoutMs`, counts as a
// crash, so a broken start backs off rather than looping. A start the OS can't make yet (Linux before
// the graphical session is up) is retried every `notReadyRetryMs` and is not a crash.

export type AppExitReason = "quit" | "update" | "restart";
export type PairStopReason = "quit" | "update";
export type AppStartWhy = "boot" | "crash" | "restart";
/** What the OS said to a start: done, not possible yet (no graphical session), or refused. */
export type AppStartOutcome = "started" | "not-ready" | "failed";

export interface DaemonPairDeps {
  now(): number;
  /** Run `fn` after `ms`; returns a cancel. */
  after(ms: number, fn: () => void): () => void;
  /** Start the app through the OS (Launch Services, the app's unit, the app's task), never as the
   *  daemon's child. */
  startApp(why: AppStartWhy): Promise<AppStartOutcome>;
  /** Send `app.quit{reason}` to these app connections. Best-effort. */
  tellAppQuit(reason: PairStopReason, connIds: readonly string[]): void;
  /** Stop the daemon on purpose (exit 0). Called once. */
  stopDaemon(why: string): void;
  /** The last app connection left (closed, hung, or leaving): whoever runs the tabs ends their
   *  streams (lane E's appGone — lane INT passes the browser service's own `appGone`, which ends each
   *  stream with `failed`). */
  onAppGone?(): void;
  log?(line: string): void;
}

export interface DaemonPairOptions {
  /** Whether this computer runs the app at all. False on a server, a cloud computer or a checkout
   *  with no app installed: the daemon runs alone and never starts one. */
  readonly desktop: boolean;
  /** How long after the daemon's start an app may take to connect before the daemon starts one. */
  readonly graceMs?: number;
  /** After `pair.exiting{restart}`, how long the app may take to come back before the daemon starts it. */
  readonly restartGraceMs?: number;
  /** How long an app the daemon started may take to connect before the start counts as a crash. */
  readonly connectTimeoutMs?: number;
  /** How often a start the OS can't make yet is retried. */
  readonly notReadyRetryMs?: number;
  /** After telling the app to quit, how long the daemon waits for it to go before stopping anyway. */
  readonly quitTimeoutMs?: number;
  readonly crashWindowMs?: number;
  /** The crash count (within the window) whose restart is in safe mode. */
  readonly safeModeAfter?: number;
  /** The delay before restarting after the nth crash in the window (the last repeats). */
  readonly delaysMs?: readonly number[];
}

export const PAIR_DEFAULTS = {
  graceMs: 2_000,
  restartGraceMs: 10_000,
  connectTimeoutMs: 20_000,
  notReadyRetryMs: 3_000,
  quitTimeoutMs: 3_000,
  crashWindowMs: 120_000,
  safeModeAfter: 3,
  delaysMs: [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
} as const;

/** The restart after a crash: its delay and whether it is in safe mode (S7's `restartPlan`). */
export function appRestartPlan(
  crashTimes: readonly number[], now: number,
  opts: Pick<DaemonPairOptions, "crashWindowMs" | "safeModeAfter" | "delaysMs"> = {},
): { delayMs: number; safeMode: boolean; recent: number } {
  const window = opts.crashWindowMs ?? PAIR_DEFAULTS.crashWindowMs;
  const delays = opts.delaysMs ?? PAIR_DEFAULTS.delaysMs;
  const recent = crashTimes.filter((t) => now - t <= window).length;
  const delayMs = delays[Math.min(delays.length - 1, Math.max(0, recent - 1))]!;
  return { delayMs, safeMode: recent >= (opts.safeModeAfter ?? PAIR_DEFAULTS.safeModeAfter), recent };
}

/** What the daemon's side reports (the policy's half of `pair.status`). */
export interface DaemonPairStatus {
  readonly desktop: boolean;
  readonly appConnected: boolean;
  /** The app runs, or will start, in safe mode (§5.8). */
  readonly safeMode: boolean;
  readonly crashesInWindow: number;
  /** A start of the app is scheduled (after a crash, or the start-up grace). */
  readonly startPending: AppStartWhy | null;
  readonly stopping: PairStopReason | null;
}

interface AppConn { leaving?: AppExitReason; canQuit: boolean; hung?: boolean }

export class DaemonPair {
  private readonly apps = new Map<string, AppConn>();
  private readonly crashes: number[] = [];
  private safeMode = false;
  private pending: { why: AppStartWhy; cancel: () => void } | null = null;
  private watchdog: (() => void) | null = null;
  private stopping: { reason: PairStopReason; cancel: (() => void) | null } | null = null;
  private stopped = false;
  private readonly o: Required<Omit<DaemonPairOptions, "delaysMs">> & { delaysMs: readonly number[] };

  constructor(private readonly deps: DaemonPairDeps, opts: DaemonPairOptions) {
    this.o = { ...PAIR_DEFAULTS, ...opts, delaysMs: opts.delaysMs ?? PAIR_DEFAULTS.delaysMs };
  }

  private log(line: string): void { this.deps.log?.(`[pair] ${line}`); }

  /** The daemon is up and listening. On a desktop, start the app if none connects within the grace. */
  start(): void {
    if (this.o.desktop) this.schedule("boot", this.o.graceMs);
  }

  /** A connection said hello as `app`, with the features its hello listed (`app.quit`, `app.show`,
   *  `layers`). */
  appConnected(connId: string, features: readonly string[] = ["app.quit"]): void {
    this.apps.set(connId, { canQuit: features.includes("app.quit") });
    this.cancelPending();
    this.cancelWatchdog();
    // An app that connects while the pair is stopping is told to go too.
    if (this.stopping) this.tell(this.stopping.reason, [connId]);
  }

  /** `pair.exiting{reason}` from an app connection: it is leaving on purpose. */
  appExiting(connId: string, reason: AppExitReason): void {
    const app = this.apps.get(connId);
    if (!app) return;
    app.leaving = reason;
    if (reason === "restart") {
      // The user's restart (Restart normally from safe mode, or the app relaunching itself) starts fresh.
      this.safeMode = false;
      this.crashes.length = 0;
      return;
    }
    // The app is quitting or being updated: the pair stops with it (§3.1), once it has gone.
    this.beginStop(reason, false);
  }

  /** The app stopped answering the heartbeat (`app.ping`; ruling R9): the daemon ends it, and its
   *  restart is in safe mode whatever the crash count. */
  appHung(connId: string): void {
    const app = this.apps.get(connId);
    if (!app || this.stopping) return;
    app.hung = true;
    this.log(`the app stopped answering (${connId}): it restarts in safe mode`);
  }

  /** An app connection closed. */
  appDisconnected(connId: string): void {
    const app = this.apps.get(connId);
    if (!app) return;
    this.apps.delete(connId);
    if (this.apps.size > 0) return; // another app connection is still up (a reconnect overlapping)
    // The tabs' app is gone: whoever runs them ends their streams. Never lets a throwing hook break
    // the restart path below (a crash still schedules, a stop still finishes).
    try {
      this.deps.onAppGone?.();
    } catch (err) {
      this.log(`appGone threw, ignored (${err instanceof Error ? err.message.slice(0, 160) : "refused"})`);
    }
    if (this.stopping) { this.finishStop(`the app went (${this.stopping.reason})`); return; }
    if (!this.o.desktop) return;
    if (app.leaving === "restart") { this.schedule("restart", this.o.restartGraceMs); return; }
    if (app.hung) { this.safeMode = true; this.crashed("hung, and was ended"); return; }
    this.crashed("went away without pair.exiting");
  }

  /** Stop the pair: `pair.quit` (from the app or the CLI), an update, or SIGTERM. Tells the apps to
   *  quit (not `requester`, an app that asked and is leaving with the answer), waits up to
   *  `quitTimeoutMs` for them to go, then stops the daemon. */
  quit(reason: PairStopReason, requester?: string): void {
    const app = requester === undefined ? undefined : this.apps.get(requester);
    if (app) app.leaving = reason;
    this.beginStop(reason, true);
  }

  status(): DaemonPairStatus {
    const now = this.deps.now();
    return {
      desktop: this.o.desktop,
      appConnected: this.apps.size > 0,
      safeMode: this.safeMode,
      crashesInWindow: this.crashes.filter((t) => now - t <= this.o.crashWindowMs).length,
      startPending: this.pending?.why ?? null,
      stopping: this.stopping?.reason ?? null,
    };
  }

  /** Cancel every timer (the daemon is going away for another reason). */
  dispose(): void {
    this.cancelPending();
    this.cancelWatchdog();
    this.stopping?.cancel?.();
  }

  private crashed(why: string): void {
    const now = this.deps.now();
    this.crashes.push(now);
    const plan = appRestartPlan(this.crashes, now, this.o);
    if (plan.safeMode) this.safeMode = true;
    this.log(`the app ${why}: starting it again in ${plan.delayMs} ms${this.safeMode ? " in safe mode" : ""} (${plan.recent} in the window)`);
    this.schedule("crash", plan.delayMs);
  }

  private schedule(why: AppStartWhy, ms: number): void {
    this.cancelPending();
    const cancel = this.deps.after(ms, () => {
      this.pending = null;
      if (this.apps.size > 0 || this.stopping) return;
      void this.launch(why);
    });
    this.pending = { why, cancel };
  }

  private async launch(why: AppStartWhy): Promise<void> {
    this.log(`starting the app (${why}${this.safeMode ? ", safe mode" : ""})`);
    let outcome: AppStartOutcome;
    try { outcome = await this.deps.startApp(why); } catch { outcome = "failed"; }
    if (this.apps.size > 0 || this.stopping) return; // it connected while the OS was starting it
    if (outcome === "not-ready") { this.schedule(why, this.o.notReadyRetryMs); return; }
    if (outcome === "failed") { this.crashed("could not be started by the OS"); return; }
    this.cancelWatchdog();
    this.watchdog = this.deps.after(this.o.connectTimeoutMs, () => {
      this.watchdog = null;
      if (this.apps.size === 0 && !this.stopping) this.crashed(`did not connect within ${this.o.connectTimeoutMs} ms`);
    });
  }

  private beginStop(reason: PairStopReason, tellApp: boolean): void {
    if (this.stopping || this.stopped) return;
    this.cancelPending();
    this.cancelWatchdog();
    this.stopping = { reason, cancel: null };
    if (this.apps.size === 0) { this.finishStop(`${reason}, no app connected`); return; }
    if (tellApp) this.tell(reason, [...this.apps.keys()].filter((id) => this.apps.get(id)!.leaving === undefined));
    this.stopping.cancel = this.deps.after(this.o.quitTimeoutMs, () => this.finishStop(`${reason}, the app did not go within ${this.o.quitTimeoutMs} ms`));
  }

  private finishStop(why: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopping?.cancel?.();
    this.log(`stopping the daemon: ${why}`);
    this.deps.stopDaemon(why);
  }

  /** `app.quit` to those of `connIds` whose hello said they handle it. */
  private tell(reason: PairStopReason, connIds: readonly string[]): void {
    const to = connIds.filter((id) => this.apps.get(id)?.canQuit === true);
    if (to.length > 0) this.deps.tellAppQuit(reason, to);
  }

  private cancelPending(): void { this.pending?.cancel(); this.pending = null; }
  private cancelWatchdog(): void { this.watchdog?.(); this.watchdog = null; }
}
