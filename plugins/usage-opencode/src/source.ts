import type { HandlerContext } from "@waifucave/moss-plugin-sdk";
import type { UsageIngestArgs, UsageIngestReply, UsageRecord } from "@waifucave/moss-plugin-sdk/usage-source";
import {
  OPENCODE_ALL_ARGS, OPENCODE_SETTLE_AFTER_DAY_MS, currentTimeZone, dayMinus, daysBefore, localDay, localDayEnd, localDayStart, localNoon, opencodeDayRecords,
  opencodeDaysArgs, opencodeDifference, opencodeFingerprint, runOpencodeStats, sameOpencodeStats, type OpencodeStats,
} from "./opencode";

// The OpenCode source (spec §12 "Usage sources"): its tokens and cost from its own `opencode stats`. Its plan limits
// live on its web console, so there is no plan. Each day's rows are REPLACED as a whole when OpenCode's figure for the
// day changes; the day-pair finalization below is OpenCode's own accounting, so it lives here and not in the core.

export interface OpencodeSourceOptions {
  /** At most one batch per this long (default 10 min). */
  everyMs?: number;
  /** At most this many `opencode stats` runs per call (default 40; a backfill that needs more continues next call). */
  spawnBudget?: number;
  timeoutMs?: number;
}

interface Progress {
  done: string[];
  pending: string[];
  listed: boolean;
  reads: Record<string, { fp: string; at: number }>;
  lastToday?: string;
  /** When the last batch began, epoch ms; and whether it left work behind. */
  at: number;
  more: boolean;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function progressOf(v: unknown): Progress {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const reads: Progress["reads"] = {};
  if (typeof o.reads === "object" && o.reads !== null && !Array.isArray(o.reads)) {
    for (const [d, r] of Object.entries(o.reads as Record<string, unknown>)) {
      const x = r as { fp?: unknown; at?: unknown } | null;
      if (x !== null && typeof x === "object" && typeof x.fp === "string" && typeof x.at === "number") reads[d] = { fp: x.fp, at: x.at };
    }
  }
  return {
    done: strings(o.done), pending: strings(o.pending), listed: o.listed === true, reads,
    ...(typeof o.lastToday === "string" ? { lastToday: o.lastToday } : {}),
    at: typeof o.at === "number" ? o.at : 0, more: o.more === true,
  };
}

/** The first call: the progress the core's store held before it moved here. */
const fromLegacy = (args: UsageIngestArgs): unknown => args.legacy?.["opencode:progress"]?.state;

export async function ingest(args: UsageIngestArgs, ctx: Pick<HandlerContext, "api">, o: OpencodeSourceOptions = {}): Promise<UsageIngestReply> {
  const outside = ctx.api.outside;
  if (outside === undefined) return {};
  const saved = progressOf(args.state ?? fromLegacy(args));
  const now = args.now;
  const everyMs = o.everyMs ?? 600_000;
  // At most one batch per throttle, unless the last one ran out of budget.
  if (!saved.more && saved.at > 0 && now - saved.at < everyMs) return {};
  const log: string[] = [];
  const startedReal = Date.now();
  const tz = currentTimeZone();
  const today = localDay(now, tz);
  const done = new Set(saved.done);
  let pending = saved.pending;
  let listed = saved.listed;
  const reads = new Map(Object.entries(saved.reads));
  const settleMs = everyMs / 2;
  let budget = o.spawnBudget ?? 40;
  let more = false;
  let missing = false;
  let allRun: OpencodeStats | undefined;
  const run = async (a: readonly string[]): Promise<OpencodeStats | undefined> => {
    budget -= 1;
    const r = await runOpencodeStats(outside, a, o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs });
    if (r.failure === "not-installed") missing = true;
    if (r.stats === undefined && r.failure !== "not-installed") log.push(`opencode stats gave no reading: ${r.failure ?? "no-json"}`);
    return r.stats;
  };
  const all = async (): Promise<OpencodeStats | undefined> => (allRun ??= await run(OPENCODE_ALL_ARGS));
  const days = (k: number): Promise<OpencodeStats | undefined> => run(opencodeDaysArgs(k));
  // Today's latest run: every pair is judged against the one before it and the one after it.
  let current = await days(1);
  if (current === undefined) return { ...(missing ? { notInstalled: true as const } : {}), log };
  let failed = false;
  if (!listed) {
    const a = await all();
    if (a === undefined) failed = true;
    else { pending = a.activity.filter((d) => d < today && !done.has(d)); listed = true; }
  }
  const due = new Set(pending);
  const yesterday = dayMinus(today, 1);
  due.add(yesterday);
  if (saved.lastToday !== undefined) due.add(saved.lastToday);
  for (const d of reads.keys()) due.add(d);
  // Asleep for days (no batch since before yesterday): the active days in between are asked for once, via `--all`.
  if (!failed && saved.lastToday !== undefined && saved.lastToday < yesterday) {
    const a = await all();
    if (a === undefined) failed = true;
    for (const d of a?.activity ?? []) if (d > saved.lastToday && d < today && !done.has(d)) due.add(d);
  }
  const writes: Array<{ day: string; rows: UsageRecord[] }> = [];
  let moved = false;
  for (const day of [...due].filter((d) => d < today && !done.has(d)).sort().reverse()) {
    if (failed) break;
    const prior = reads.get(day);
    // Read moments ago (a catch-up pass): its next read must be a batch apart, so it waits — not counted as `more`.
    if (prior !== undefined && now - prior.at < settleMs) continue;
    const k = daysBefore(day, today);
    // The pair, and today's run after it (yesterday's narrow run is that run).
    if (budget < (k === 1 ? 2 : 3)) { more = true; break; }
    const before = current;
    const wide = await days(k + 1);
    const narrow = wide === undefined ? undefined : await days(k);
    const after = narrow === undefined ? undefined : k === 1 ? narrow : await days(1);
    if (wide === undefined || narrow === undefined || after === undefined) { failed = true; break; }
    current = after;
    if (!sameOpencodeStats(before, after)) { moved = true; continue; }
    const diff = opencodeDifference(wide, narrow);
    const fp = opencodeFingerprint(diff);
    writes.push({ day, rows: opencodeDayRecords(diff, day, localNoon(day, tz)) });
    // Final only when it read the same twice AND the day ended two hours ago or more.
    const settled = now >= localDayEnd(day, tz) + OPENCODE_SETTLE_AFTER_DAY_MS;
    if (prior !== undefined && prior.fp === fp) {
      if (settled) { done.add(day); reads.delete(day); }
    } else reads.set(day, { fp, at: now });
  }
  // Every `--days` run counts from the local midnight of its moment: across a midnight the differences are wrong, so the
  // batch is discarded whole and asked again at once.
  if (localDay(now + (Date.now() - startedReal), tz) !== today) return { more: true, state: { ...saved, at: 0, more: false } satisfies Progress, log };
  const span = (day: string, rows: UsageRecord[]) => ({ from: localDayStart(day, tz), to: localDayEnd(day, tz), records: rows });
  const replace = [span(today, opencodeDayRecords(current, today, Math.min(localNoon(today, tz), now))), ...writes.map((w) => span(w.day, w.rows))];
  if (moved) log.push("opencode was in use during the read; some finished days are read again next time");
  if (failed) more = false;
  const keepFrom = dayMinus(today, 14);
  const state: Progress = {
    done: [...done].filter((d) => d >= keepFrom).sort(), pending: pending.filter((d) => !done.has(d)), listed,
    reads: Object.fromEntries([...reads].filter(([d]) => !done.has(d))),
    // A day not finalized yet stays "the last today" until it is — so it is asked for again.
    lastToday: saved.lastToday !== undefined && saved.lastToday < today && !done.has(saved.lastToday) ? saved.lastToday : today,
    at: now, more,
  };
  return { replace, more, state, log };
}
