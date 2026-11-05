// The stall watchdog (spec §9.3 "Stalled agents", spike S5 §7): an agent that makes no progress for 10 minutes is
// stopped, and its bot gets a task notification saying so.
//
// Progress is any message from the agent. A running command sends nothing on the wire in either agent S5 ran, so
// while a tool call of kind `execute` is in progress, a live process under the agent that **started after the call
// began** also counts, up to the command limit. Processes from before the call never count: the agent's MCP servers,
// the bridge included, live under it for the whole session. Neither agent puts a limit for the command on the wire,
// so the limit is Clover's own: a per-computer maximum for one agent command, by default the same 10 minutes as a
// bot's own `Bash` (Winter's maximum).
//
// It checks once a minute on the session's clock, only while a turn runs.
import { AGENT_STALL_MS } from "../contracts/agent-backend";
import type { Clock, TimerHandle } from "../contracts/clock";
import { descendantsOf, readProcessTable, type ProcessTableReader } from "./process/table";

export const STALL_CHECK_EVERY_MS = 60_000;
/** One agent command's longest run, by default (Winter's `Bash` maximum). */
export const AGENT_COMMAND_MAX_MS = 10 * 60_000;

/** What the watchdog reads from a session. */
export interface Watched {
  /** On the session's clock. */
  lastProgressAt(): number;
  /** True while a turn runs. */
  busy(): boolean;
  /** The agent's root pid, or 0 for none (a fake). */
  readonly pid: number;
  /** Execute calls still running, with their wall-clock start. */
  runningCommands(): { id: string; startedAtWall: number }[];
}

export interface StallWatchdogOptions {
  clock: Clock;
  stallMs?: number;
  checkEveryMs?: number;
  commandMaxMs?: number;
  table?: ProcessTableReader;
  /** Wall-clock now, for the process table; `Date.now` by default. */
  wallNow?: () => number;
}

export class StallWatchdog {
  readonly #clock: Clock;
  readonly #stallMs: number;
  readonly #every: number;
  readonly #commandMax: number;
  readonly #table: ProcessTableReader;
  readonly #wallNow: () => number;
  readonly #watched = new Map<Watched, { onStall: () => void; timer?: TimerHandle }>();

  constructor(opts: StallWatchdogOptions) {
    this.#clock = opts.clock;
    this.#stallMs = opts.stallMs ?? AGENT_STALL_MS;
    this.#every = opts.checkEveryMs ?? STALL_CHECK_EVERY_MS;
    this.#commandMax = opts.commandMaxMs ?? AGENT_COMMAND_MAX_MS;
    this.#table = opts.table ?? readProcessTable;
    this.#wallNow = opts.wallNow ?? Date.now;
  }

  /** Watches a session until the returned function is called; `onStall` runs at most once. */
  watch(w: Watched, onStall: () => void): () => void {
    const entry = { onStall } as { onStall: () => void; timer?: TimerHandle };
    this.#watched.set(w, entry);
    this.#schedule(w);
    return () => this.#unwatch(w);
  }

  #unwatch(w: Watched): void {
    const e = this.#watched.get(w);
    if (e?.timer) this.#clock.clearTimeout(e.timer);
    this.#watched.delete(w);
  }

  #schedule(w: Watched): void {
    const e = this.#watched.get(w);
    if (!e) return;
    e.timer = this.#clock.setTimeout(() => void this.#check(w), this.#every);
  }

  /** Whether the session has stalled now. */
  async stalled(w: Watched): Promise<boolean> {
    if (!w.busy()) return false;
    if (this.#clock.now() - w.lastProgressAt() < this.#stallMs) return false;
    const commands = w.runningCommands();
    if (commands.length === 0 || w.pid <= 0) return true;
    const wall = this.#wallNow();
    const live = commands.filter((c) => wall - c.startedAtWall < this.#commandMax);
    if (live.length === 0) return true;
    const since = Math.min(...live.map((c) => c.startedAtWall));
    const rows = await this.#table().catch(() => []);
    // `ps` gives start times to the second: a process from the same second as the call counts.
    return !descendantsOf(rows, w.pid).some((r) => r.startedAt >= since - 1_000);
  }

  async #check(w: Watched): Promise<void> {
    const e = this.#watched.get(w);
    if (!e) return;
    if (await this.stalled(w)) {
      this.#unwatch(w);
      e.onStall();
      return;
    }
    this.#schedule(w);
  }
}
