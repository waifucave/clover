// The update's idle gate (spec §3.1: "An update waits until the daemon is between turns and no agent runs, then
// stops the pair, installs both and starts them again"; Winter's Sparkle gate). An update downloads in the background
// but installs only while nothing is busy. "Busy" is a registry each lane adds its own work to:
//   turns       a turn in flight in any session (the Clover drivers)
//   agents      a background agent still running
//   approvals   a card waiting for an answer
//   …           K's runners, routines, live Bash runners and the bots register theirs (`register`, on the
//               daemon's gate: `RunningDaemon.updateGate`)
// The app asks over the socket (`update.status`'s `idle` and `busy`), and so does the daemon's own self-update
// (server installs). The gate never stops work: it only says when stopping would cut nothing.
//
// A restart for an update does NOT hand the bots' lease over (it is not Hand over and quit, which releases it): it is
// a short restart, and the lease's own grace covers it. Just before the restart the gate runs its `beforeRestart`
// hooks, where the lease renews (lane H registers it), so another computer could take over only after a full TTL
// with this one down: under H's timings (a 30 s lease, its holder stopping 5 s early) a 10-20 s restart leaves the
// lease held here, and the new daemon renews it under the same epoch (test/update/gate.test.ts checks both).

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

