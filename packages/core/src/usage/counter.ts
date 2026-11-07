// Counting Clover's own turns (spec §12, §5.8): the counter reads every session's log and writes a usage row per
// model per turn into the ledger, with the session's bot, so usage adds up per bot and per session. Owner: lane D.
//
// Where the numbers come from, in order:
// 1. A `turn_usage` event the runtime records in the turn (lane A's embedded runtime, one per model per turn):
//    `{ type: "turn_usage", model, provider?, inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?,
//    costUsd? }`. `inputTokens` leaves out cache reads and writes, which have their own counts, as the inherited usage
//    database counts them. It never reaches clients (sessions/wire.ts).
// 2. Otherwise the turn's own `TurnEnd.usage` (what ACP agents report, spike S5 §8), under the session's model.
//
// The counter reads live through the host's tap, and on start catches up each session's log from its cursor, so a
// turn that ended while the daemon was going down is still counted, once (the ledger's dedupe keys).
import type { SessionRecord } from "../contracts/session-host";
import type { Unsubscribe } from "../contracts/common";
import { isCopiedRecord, type DurableSessionHost } from "../sessions/durable-host";
import type { LedgerRowInput, UsageLedger } from "./ledger";

export interface TurnUsageEvent {
  type: "turn_usage";
  model?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

/** A list price for tokens the runtime didn't price (the inherited `UsagePricer`, over the model catalogs). */
export type Pricer = (row: { provider?: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) => number | undefined;

/** How many records the catch-up reads at a time. */
const CATCH_UP_PAGE = 1_000;

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export function isTurnUsage(event: { type: string; [key: string]: unknown }): event is TurnUsageEvent & { [key: string]: unknown } {
  return event.type === "turn_usage" && isCount(event.inputTokens) && isCount(event.outputTokens)
    && (event.cacheReadTokens === undefined || isCount(event.cacheReadTokens))
    && (event.cacheWriteTokens === undefined || isCount(event.cacheWriteTokens))
    && (event.costUsd === undefined || (typeof event.costUsd === "number" && Number.isFinite(event.costUsd) && event.costUsd >= 0))
    && (event.model === undefined || typeof event.model === "string")
    && (event.provider === undefined || typeof event.provider === "string");
}

function providerOf(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : undefined;
}

interface SessionInfo {
  bot?: string;
  model?: string;
}

export class CloverUsageCounter {
  readonly #ledger: UsageLedger;
  readonly #host: DurableSessionHost;
  readonly #price: Pricer | undefined;
  readonly #onChange: ((since: number) => void) | undefined;
  readonly #warn: (message: string) => void;
  /** Sessions whose current turn has its own `turn_usage` events. */
  readonly #turnHasUsage = new Set<string>();
  #off: Unsubscribe | undefined;

  constructor(opts: { ledger: UsageLedger; host: DurableSessionHost; price?: Pricer; onChange?: (since: number) => void; warn?: (message: string) => void }) {
    this.#ledger = opts.ledger;
    this.#host = opts.host;
    this.#price = opts.price;
    this.#onChange = opts.onChange;
    this.#warn = opts.warn ?? (() => {});
  }

  /** Catches up every session's log, then counts live. */
  start(): void {
    if (this.#off) return;
    this.#off = this.#host.tap(({ record, view }) => this.#count(record, { ...(view.bot === undefined ? {} : { bot: view.bot }), ...(view.model === undefined ? {} : { model: view.model }) }));
    for (const view of this.#host.list()) {
      const cursor = this.#ledger.cursor(view.id);
      // An ended session counted up to a turn's end has nothing left to count, and its log needn't be read.
      if ((view.status === "stopped" || view.status === "failed") && cursor !== undefined) continue;
      const length = this.#host.length(view.id);
      let from = 0;
      if (cursor !== undefined) {
        // The cursor rests on a turn's end, by its seq and its time. Anything else there means the log was cut back
        // (a repair) and written again: it is counted again from the start, and the dedupe keys, which hold each
        // record's time, keep what was counted already from counting twice.
        const at = cursor.seq < length ? this.#host.history(view.id, { afterSeq: cursor.seq - 1, limit: 1 })[0] : undefined;
        if (at?.type === "turn_ended" && at.ts === cursor.ts) from = cursor.seq + 1;
      }
      if (from >= length) continue;
      const info: SessionInfo = { ...(view.bot === undefined ? {} : { bot: view.bot }), ...(view.model === undefined ? {} : { model: view.model }) };
      // Starting after a whole turn, so whether a turn had its own `turn_usage` is known by its end; a page at a time.
      for (let after = from - 1; after < length - 1; after += CATCH_UP_PAGE) {
        for (const record of this.#host.history(view.id, { afterSeq: after, limit: CATCH_UP_PAGE })) this.#count(record, info);
      }
    }
  }

  stop(): void {
    this.#off?.();
    this.#off = undefined;
  }

  #count(record: SessionRecord, info: SessionInfo): void {
    try {
      // A copy from the computer that ran the turn (sessions' `ingest`) is counted there; only the cursor moves here.
      const rows = isCopiedRecord(record) ? [] : this.#rowsFor(record, info);
      // The cursor moves at a turn's end, so a catch-up never starts inside a turn.
      const cursor = record.type === "turn_ended" ? { session: record.sessionId, seq: record.seq, ts: record.ts } : undefined;
      if (rows.length === 0 && cursor === undefined) return;
      const added = this.#ledger.add(rows, cursor);
      if (added.length > 0) this.#onChange?.(Math.min(...added.map((r) => r.at)));
    } catch (err) {
      this.#warn(`usage for session ${record.sessionId} (record ${record.seq}) wasn't counted: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #rowsFor(record: SessionRecord, info: SessionInfo): LedgerRowInput[] {
    const base = { source: "clover" as const, at: record.ts, session: record.sessionId, ...(info.bot === undefined ? {} : { bot: info.bot }) };
    if (record.type === "turn_started") {
      this.#turnHasUsage.delete(record.sessionId);
      return [];
    }
    if (record.type === "driver" && isTurnUsage(record.event)) {
      this.#turnHasUsage.add(record.sessionId);
      const e = record.event;
      const model = e.model ?? info.model;
      return [this.#priced({
        ...base, dedupe: `${record.sessionId}:${record.seq}:${record.ts}`,
        ...(model === undefined ? {} : { model }),
        ...((e.provider ?? providerOf(model)) === undefined ? {} : { provider: e.provider ?? providerOf(model)! }),
        inputTokens: e.inputTokens, outputTokens: e.outputTokens,
        ...(e.cacheReadTokens === undefined ? {} : { cacheReadTokens: e.cacheReadTokens }),
        ...(e.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: e.cacheWriteTokens }),
        ...(e.costUsd === undefined ? {} : { costUsd: e.costUsd }),
      })];
    }
    if (record.type === "turn_ended") {
      const had = this.#turnHasUsage.has(record.sessionId);
      this.#turnHasUsage.delete(record.sessionId);
      const usage = record.end.usage;
      if (had || usage === undefined || (usage.inputTokens === 0 && usage.outputTokens === 0)) return [];
      if (!isCount(usage.inputTokens) || !isCount(usage.outputTokens)) return [];
      return [this.#priced({
        ...base, dedupe: `${record.sessionId}:${record.seq}:${record.ts}`,
        ...(info.model === undefined ? {} : { model: info.model }),
        ...(providerOf(info.model) === undefined ? {} : { provider: providerOf(info.model)! }),
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      })];
    }
    return [];
  }

  #priced(row: LedgerRowInput): LedgerRowInput {
    if (row.costUsd !== undefined || this.#price === undefined || row.model === undefined) return row;
    const cost = this.#price({
      ...(row.provider === undefined ? {} : { provider: row.provider }),
      model: row.model, inputTokens: row.inputTokens, outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens ?? 0, cacheWriteTokens: row.cacheWriteTokens ?? 0,
    });
    return cost === undefined ? row : { ...row, costUsd: cost };
  }
}
