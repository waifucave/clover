// The update's idle gate (spec §3.1: "An update waits until the daemon is between turns and no agent runs, then
// stops the pair, installs both and starts them again", as the Sparkle gate did). An update downloads in the background
// but installs only while nothing is busy. "Busy" is a registry each lane adds its own work to:
//   turns       a turn in flight in any session (the Clover drivers)
//   agents      a background agent still running
//   approvals   a card waiting for an answer
//   questions, elicitations, workflows   pending questions and URL elicitations, workflow runs
//   …           K's runners, routines, live Bash runners and the bots register theirs (`register`, on the
//               daemon's gate: `RunningDaemon.updateGate`)
//   TODO(lane D): the bots' DurableSessionHost runs turns of its own, outside the Clover drivers. When it is wired
//               into the daemon it must register its running turns here and refuse a new turn while `closed`
//               (in `#accept`), as the drivers' pre-turn gate does.
// The app asks over the socket (`update.status`'s `idle` and `busy`), and so does the daemon's own self-update
// (server installs). The gate never stops work: it only says when stopping would cut nothing.
//
// Between "idle" and the stop there is a window (the steps before a restart, the app stopping its side): the gate
// CLOSES for it (`close`), and while it is closed no new turn starts (the session drivers' pre-turn gate asks `closed`
// and refuses with a retry: "Clover is restarting for an update"). Whoever closes it checks idle again after the
// steps before the restart, and reopens it if work started meanwhile; a close that no restart follows reopens by
// itself after `reopenAfterMs`, so a lost app never leaves turns refused. Once the restart is under way (the app's
// `pair.exiting{update}` accepted, a server's binaries swapped) the gate COMMITS: closed for the rest of the process,
// however long the drain takes.
//
// A restart for an update does NOT hand the bots' lease over (it is not Hand over and quit, which releases it): it is
// a short restart, and the lease's own grace covers it. Just before the restart the gate runs its `beforeRestart`
// hooks, where the lease renews (lane H registers it), so another computer could take over only after a full TTL
// with this one down: under H's timings (a 30 s lease, its holder stopping 5 s early) a 10-20 s restart leaves the
// lease held here, and the new daemon renews it under the same epoch (test/update/gate.test.ts checks both).

/** The message a turn refused while the gate closes is given (the drivers' and the bots' alike). */
export const UPDATE_RESTARTING_MESSAGE = "Clover is restarting for an update; send it again in a moment";

/** A turn refused while the gate closes for a restart: typed like the drivers' (`daemon_shutting_down`, reason
 *  `update-restarting`), and a retry — nothing was appended, and the same request works once the gate reopens or the
 *  daemon is back. */
export class UpdateRestartingRefusal extends Error {
  readonly code = "daemon_shutting_down" as const;
  readonly reason = "update-restarting" as const;
  readonly retry = true as const;
  constructor() {
    super(UPDATE_RESTARTING_MESSAGE);
    this.name = "UpdateRestartingRefusal";
  }
}

/** Whether `err` is a turn refused for an update's restart (an `UpdateRestartingRefusal`, or a driver's refusal
 *  carrying its reason). */
export function isUpdateRestarting(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { reason?: unknown }).reason === "update-restarting";
}

/** One kind of work the gate waits for: how many of it run now. */
export interface BusySource {
  readonly name: string;
  count(): number;
}

export interface GateVerdict {
  idle: boolean;
  /** `name:count` for each busy source, in registration order. */
  busy: string[];
}

export class UpdateGate {
  private readonly sources = new Map<string, BusySource>();
  #closed = false;
  #committed = false;
  readonly #reopenListeners = new Set<() => void>();
  #reopenTimer: ReturnType<typeof setTimeout> | undefined;

  /** Whether the gate is closing for a restart: no new turn may start. */
  get closed(): boolean {
    return this.#closed;
  }

  /** The one pre-turn check (the session drivers', the bots' host): throws `UpdateRestartingRefusal` while closed. */
  beforeTurn(): void {
    if (this.#closed) throw new UpdateRestartingRefusal();
  }

  /** Called each time the gate opens again after a close (work started, the steps failed, or no restart came), so
   *  held turns and routines can go on without polling; returns its removal. Never after `commit`. */
  onReopen(cb: () => void): () => void {
    this.#reopenListeners.add(cb);
    return () => void this.#reopenListeners.delete(cb);
  }

  /** Closes the gate for a restart; it reopens by itself after `reopenAfterMs` unless the process is gone by then. */
  close(reopenAfterMs = 60_000): void {
    this.#closed = true;
    if (this.#reopenTimer) clearTimeout(this.#reopenTimer);
    this.#reopenTimer = setTimeout(() => this.reopen(), reopenAfterMs);
    this.#reopenTimer.unref?.();
  }

  /** The restart is under way: the gate stays closed for the rest of the process (no reopen timer, no reopen). */
  commit(): void {
    this.#closed = true;
    this.#committed = true;
    if (this.#reopenTimer) clearTimeout(this.#reopenTimer);
    this.#reopenTimer = undefined;
  }

  get committed(): boolean {
    return this.#committed;
  }

  /** Opens the gate again: the restart isn't happening (work started, or no one followed up). Not after `commit`. */
  reopen(): void {
    if (this.#committed) return;
    const was = this.#closed;
    this.#closed = false;
    if (this.#reopenTimer) clearTimeout(this.#reopenTimer);
    this.#reopenTimer = undefined;
    if (!was) return;
    for (const cb of [...this.#reopenListeners]) {
      try {
        cb();
      } catch {
        // a listener's own failure is its own
      }
    }
  }

  /**
   * The whole closing: idle now, close, the steps before a restart, and idle still. True with the gate left closed
   * (the restart may go ahead); false with it open again (busy before, or work that started during the steps).
   */
  async closeForRestart(opts: { reopenAfterMs?: number; timeoutMs?: number; log?: (line: string) => void } = {}): Promise<boolean> {
    if (!this.verdict().idle) {
      this.reopen();
      return false;
    }
    this.close(opts.reopenAfterMs);
    await this.prepareRestart(opts.timeoutMs, opts.log);
    if (this.verdict().idle) return true;
    this.reopen();
    return false;
  }

  /** Adds a source (a lane's work); returns its removal. A second source under the same name replaces the first. */
  register(source: BusySource): () => void {
    this.sources.set(source.name, source);
    return () => {
      if (this.sources.get(source.name) === source) this.sources.delete(source.name);
    };
  }

  names(): string[] {
    return [...this.sources.keys()];
  }

  /** Busy while any source counts something; a source that throws counts as busy (never install over the unknown). */
  verdict(): GateVerdict {
    const busy: string[] = [];
    for (const s of this.sources.values()) {
      let n: number;
      try {
        n = s.count();
      } catch {
        n = 1;
      }
      if (!Number.isFinite(n) || n > 0) busy.push(`${s.name}:${Number.isFinite(n) ? n : "?"}`);
    }
    return { idle: busy.length === 0, busy };
  }

  private readonly restartHooks = new Set<() => Promise<void> | void>();

  /** Work to do just before an update's restart (lane H: renew the lease, so the restart runs inside a full TTL);
   *  returns its removal. */
  beforeRestart(fn: () => Promise<void> | void): () => void {
    this.restartHooks.add(fn);
    return () => void this.restartHooks.delete(fn);
  }

  /** Runs every `beforeRestart` hook, each bounded by `timeoutMs`; a hook that fails or hangs is logged, never
   *  fatal (the restart is short either way). */
  async prepareRestart(timeoutMs = 5_000, log: (line: string) => void = () => {}): Promise<void> {
    await Promise.all([...this.restartHooks].map(async (fn) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(fn),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`took over ${timeoutMs} ms`)), timeoutMs); }),
        ]);
      } catch (err) {
        log(`update: a step before the restart failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }));
  }

  /** Resolves at the first idle verdict, polled every `everyMs`; `signal` stops the wait (rejects). */
  whenIdle(everyMs = 1000, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = (): void => {
        if (signal?.aborted) return reject(new Error("the wait for an idle moment was stopped"));
        if (this.verdict().idle) return resolve();
        const t = setTimeout(check, everyMs);
        t.unref?.();
      };
      check();
    });
  }
}

