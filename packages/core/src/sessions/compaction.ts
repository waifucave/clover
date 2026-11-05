// Cache-timed compaction (spec §6.3 "Compaction", §6.1 "When the cache has already expired"). Owner: lane D; lane A's
// runtime does the compacting (`CompactingDriver`), and this decides when.
//
// * **When:** a bot's conversation compacts just before its cached prompt expires, once its context is over about
//   100k tokens. Reading the long context then costs cached prices, and the next message starts from a short summary
//   instead of paying full price to read 100k+ tokens of expired cache. The cache's life is measured from the last
//   model call (the end of the last turn, or the last compaction), and each turn restarts it.
// * **The numbers** come from the model's cache lifetime and are settings (`policy`): the cache's life, the threshold
//   and the lead (how long before expiry to start, enough to read the context while it is still cached).
// * **A user message during compaction** drops a cache-timed one (the host does that) and it is tried again at the next
//   idle moment, which is the end of the turn that message starts: the cache is warm again then.
// * **A cold cache:** when the cache has already expired, the next turn rebuilds the system prompt's harness blocks
//   without compacting, since there is no cache left to save (`cacheCold`, which the driver reads as a turn starts).
// * Only bots' own conversations compact on the clock. Side threads are short; agents compact themselves.
import type { SessionView } from "@waifucave/clover-protocol";
import type { Clock, TimerHandle } from "../contracts/clock";
import type { Unsubscribe } from "../contracts/common";
import type { SessionRecord } from "../contracts/session-host";
import type { CompactOutcome, CompactReason, DurableSessionHost } from "./durable-host";

export interface CompactionPolicy {
  /** How long the model's prompt cache lives after its last use. */
  cacheTtlMs: number;
  /** The context, in tokens, from which a cache-timed compaction pays. */
  thresholdTokens: number;
  /** How long before the cache expires the compaction starts. */
  leadMs: number;
}

/** The spec's numbers, for a model whose cache lives five minutes (Anthropic's default cache, and about OpenAI's). */
export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = { cacheTtlMs: 5 * 60_000, thresholdTokens: 100_000, leadMs: 30_000 };

/** How far back from a log's end a start looks for the last turn, to know the cache's age after a restart. */
const PRIME_SCAN = 500;

export interface CacheTimedCompactionOptions {
  host: Pick<DurableSessionHost, "tap" | "compact" | "get" | "list" | "history" | "length">;
  clock: Clock;
  /** A session's policy (its model's cache lifetime, and the settings); undefined: it never compacts on the clock. */
  policy?: (view: SessionView) => CompactionPolicy | undefined;
  warn?: (message: string) => void;
}

interface Tracked {
  /** When the cache was last used. */
  lastCallAt: number;
  /** The context's size after that call, in tokens. */
  contextTokens: number;
  timer?: TimerHandle;
}

export class CacheTimedCompaction {
  readonly #o: CacheTimedCompactionOptions;
  readonly #sessions = new Map<string, Tracked>();
  readonly #off: Unsubscribe;
  readonly #outcomes: { id: string; outcome: CompactOutcome }[] = [];

  constructor(opts: CacheTimedCompactionOptions) {
    this.#o = opts;
    for (const view of opts.host.list({ kind: "bot" })) this.#prime(view);
    this.#off = opts.host.tap(({ record, view }) => this.#on(record, view));
  }

  /** Whether the session's cached prompt has expired: true when no model call is known since the start. */
  cacheCold(id: string): boolean {
    const t = this.#sessions.get(id);
    const view = this.#o.host.get(id);
    const policy = view === undefined ? undefined : this.#policy(view);
    if (t === undefined || policy === undefined) return true;
    return this.#o.clock.now() >= t.lastCallAt + policy.cacheTtlMs;
  }

  /** When the next cache-timed compaction is due, for the tests and the CLI. */
  dueAt(id: string): number | undefined {
    const t = this.#sessions.get(id);
    const view = this.#o.host.get(id);
    const policy = view === undefined ? undefined : this.#policy(view);
    if (t?.timer === undefined || policy === undefined) return undefined;
    return t.lastCallAt + policy.cacheTtlMs - policy.leadMs;
  }

  /** What each cache-timed compaction came to, oldest first (the tests'). */
  outcomes(): readonly { id: string; outcome: CompactOutcome }[] {
    return this.#outcomes;
  }

  close(): void {
    this.#off();
    for (const t of this.#sessions.values()) if (t.timer !== undefined) this.#o.clock.clearTimeout(t.timer);
    this.#sessions.clear();
  }

  #policy(view: SessionView): CompactionPolicy | undefined {
    if (view.kind !== "bot") return undefined;
    return this.#o.policy === undefined ? DEFAULT_COMPACTION_POLICY : this.#o.policy(view);
  }

  /** After a restart: the last turn's end tells how old the cache is and how large the context was. */
  #prime(view: SessionView): void {
    const length = this.#o.host.length(view.id);
    const records = this.#o.host.history(view.id, { afterSeq: Math.max(-1, length - PRIME_SCAN - 1) });
    for (const record of records) this.#apply(record);
    this.#arm(view.id, view);
  }

  #on(record: SessionRecord, view: SessionView): void {
    if (view.kind !== "bot") return;
    this.#apply(record);
    if (record.type === "turn_started") this.#disarm(view.id);
    // Armed at a turn's end only: a compaction that failed is tried again after the next turn, never in a loop.
    else if (record.type === "turn_ended") this.#arm(view.id, view);
  }

  #apply(record: SessionRecord): void {
    if (record.type === "turn_ended") {
      const t = this.#track(record.sessionId, record.ts);
      t.lastCallAt = record.ts;
      if (record.end.usage !== undefined) t.contextTokens = record.end.usage.inputTokens + record.end.usage.outputTokens;
    } else if (isCompactionEnd(record) && record.event["outcome"] === "compacted") {
      // A compaction is a model call on the short context that follows it.
      const t = this.#track(record.sessionId, record.ts);
      t.lastCallAt = record.ts;
      t.contextTokens = 0;
    }
  }

  #track(id: string, at: number): Tracked {
    let t = this.#sessions.get(id);
    if (t === undefined) {
      t = { lastCallAt: at, contextTokens: 0 };
      this.#sessions.set(id, t);
    }
    return t;
  }

  #disarm(id: string): void {
    const t = this.#sessions.get(id);
    if (t?.timer === undefined) return;
    this.#o.clock.clearTimeout(t.timer);
    delete t.timer;
  }

  #arm(id: string, view: SessionView): void {
    this.#disarm(id);
    const t = this.#sessions.get(id);
    const policy = this.#policy(view);
    if (t === undefined || policy === undefined || t.contextTokens < policy.thresholdTokens) return;
    const now = this.#o.clock.now();
    // Already expired: nothing cached is left to save, and the next turn rebuilds without compacting.
    if (now >= t.lastCallAt + policy.cacheTtlMs) return;
    const due = t.lastCallAt + policy.cacheTtlMs - policy.leadMs;
    t.timer = this.#o.clock.setTimeout(() => {
      delete t.timer;
      void this.#fire(id);
    }, Math.max(0, due - now));
  }

  async #fire(id: string): Promise<void> {
    const reason: CompactReason = "cache";
    try {
      const outcome = await this.#o.host.compact(id, reason);
      this.#outcomes.push({ id, outcome });
    } catch (err) {
      this.#o.warn?.(`session ${id}: a cache-timed compaction didn't start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function isCompactionEnd(record: SessionRecord): record is Extract<SessionRecord, { type: "driver" }> {
  return record.type === "driver" && record.event.type === "compaction" && record.event["phase"] === "ended";
}
