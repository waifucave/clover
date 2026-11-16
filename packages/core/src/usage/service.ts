import { randomUUID } from "node:crypto";
import { type AlarmProvider, type FiredUsageAlarm, type Subscription, type SyntheticRow, type UsageAlarm, type UsageDb, type UsageRecordInput, type UsageRow, type UsageSource } from "./db";
import { planWindowKey, staleness, type PlanReading, type PlanStatusWindow } from "./plan";
import type { UsagePricer } from "./pricing";
import {
  INGEST_CALL_TIMEOUT_MS, PLAN_CALL_TIMEOUT_MS, SOURCE_ID, cleanIngestReply, cleanPlanReply, cleanReading, priceRecord, type UsageSourceEntry, type UsageSourcePort,
} from "./sources";

// The usage service (spec §12 "Usage sources"): records MOSS's own turns as they end, ingests the user's other apps'
// usage ON DEMAND (when a Usage surface asks — no watcher, no timer: an idle daemon does nothing), reads their plans, keeps
// the user's one-shot plan alarms (every plan read judges them; a background beat reads the plans — `startBackground`), and
// answers the `usage.*` RPCs. It reads NO app itself: every Codex, Claude Code, OpenCode or Antigravity number comes from a
// `usage.sources` entry's handler (a plugin's), asked through `deps.sources`.

export type UsageRange = "1h" | "24h" | "7d" | "30d" | "all";
export const USAGE_RANGES: readonly UsageRange[] = ["1h", "24h", "7d", "30d", "all"];

/** Which sources the user lets MOSS read (`settings.usage`): by the source's name in camel case (`claudeCode`); a source
 *  with no switch is on. */
export type UsageTracking = Record<string, boolean>;

/** A source's switch: its name in camel case. */
/** Where usage.db keeps which plugin holds each source id. */
const SOURCE_OWNERS_KEY = "usage-source-owners";
/** The most passes in a row a source's `more: true` may ask for; then the throttle applies again. */
export const MORE_PASSES_MAX = 6;
export const trackingKey = (id: string): string => id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export interface UsageServiceDeps {
  db: UsageDb;
  pricer: UsagePricer;
  /** LIVE: which external sources the user lets MOSS read (`settings.usage`). */
  tracking: () => UsageTracking;
  /** The `usage.sources` entries and how to call them. Absent: no source (nothing external is read). */
  sources?: UsageSourcePort;
  /** What MOSS's own sessions reported about limits, by name (`"codex-oauth"`): handed to every source as data. */
  reports?: () => Readonly<Record<string, readonly PlanStatusWindow[]>>;
  /** A fired alarm's notice goes out through the general notify door. */
  notify?: (notice: { title: string; body: string }) => void;
  now?: () => number;
  log?: { warn?: (msg: string, meta?: Record<string, unknown>) => void; info?: (msg: string, meta?: Record<string, unknown>) => void };
  /** Throttles (ms) — tests shorten them. */
  ingestEveryMs?: number;
  /** A source's plan reads: at least this far apart, whatever its entry says (tests shorten it). */
  planEveryMs?: number;
  /** How long a plan read waits for a call still running before answering with what it has (default 2 s — a client's
   *  request times out at 5 s; the call finishes in the background and the next ask gets it). */
  planWaitMs?: number;
  /** The background plan checks (`startBackground`): every plan every `backgroundEveryMs` (default 30 min), and a plan with
   *  an alarm on its own beat (`alarmBeatMs`; default its entry's throttle). Tests shorten them. */
  backgroundEveryMs?: number;
  alarmBeatMs?: Record<string, number>;
  /** Test seam: a repeating timer; returns its cancel. */
  setInterval?: (fn: () => void, ms: number) => () => void;
}

/** The background beat's period (user 2026-10-18: every installed and tracked plan, alarm or not). */
export const USAGE_BACKGROUND_EVERY_MS = 30 * 60_000;
/** A fast beat's spawn floor sits this far under its period. */
export const FAST_BEAT_SLACK_MS = 5_000;
/** The shortest time between two plan reads when an entry names none. */
export const DEFAULT_PLAN_EVERY_MS = 300_000;

/** PURE: a fast beat's spawn floor — the period less `FAST_BEAT_SLACK_MS`, never under half the period. */
export function fastBeatFloor(periodMs: number): number {
  return Math.max(periodMs / 2, periodMs - FAST_BEAT_SLACK_MS);
}

const defaultInterval = (fn: () => void, ms: number): (() => void) => {
  const t = setInterval(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearInterval(t);
};


/** A stored synthetic row against a planned one: any token count, the cost or its basis changed. */
function differs(s: SyntheticRow, r: UsageRecordInput): boolean {
  const cost = r.costBasis === "unknown" || r.costUsd === undefined ? null : r.costUsd;
  return s.input !== r.input || s.output !== r.output || s.cacheRead !== r.cacheRead || s.cacheWrite !== r.cacheWrite || s.costBasis !== r.costBasis
    || (cost === null) !== (s.costUsd === null) || (cost !== null && s.costUsd !== null && Math.abs(cost - s.costUsd) > 1e-9)
    || Math.abs((s.cacheSavingsUsd ?? 0) - (r.cacheSavingsUsd ?? 0)) > 1e-9;
}


/** Where each plan's last good reading from its source is kept (`sourceState`, filed under "winter"): shown, its staleness
 *  judged afresh, until a fresh read lands (user 2026-10-19: "show the cached usage limits until the fresh re-fetch
 *  arrives") — through a failed call and across a restart. */
export const PLAN_READINGS_KEY = "plans:last-readings";
/** A source's own state between calls, its history note and whether the store's older records were handed over. */
export const SOURCE_STATE_PREFIX = "usage-source:";
const PLAN_STATE_PREFIX = "usage-plan:";

/** PURE: the kept readings, validated — anything malformed is dropped, never trusted. */
export function parseKeptReadings(state: Record<string, unknown> | undefined): Map<string, PlanReading> {
  const out = new Map<string, PlanReading>();
  for (const [id, raw] of Object.entries(state ?? {})) {
    if (!SOURCE_ID.test(id)) continue;
    const r = cleanReading(id, raw);
    if (r !== undefined && r.at !== undefined && r.windows.length > 0) out.set(id, r);
  }
  return out;
}

/** Wait for `p`, at most `ms`. */
async function within(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p, new Promise<void>((r) => { timer = setTimeout(r, ms); timer.unref?.(); })]);
  if (timer !== undefined) clearTimeout(timer);
}

export interface MossTurnRow {
  model: string;
  canonicalModel?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  costBasis?: "list";
}

export interface UsageTotals {
  costUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  unpricedTokens: number;
  cacheSavingsUsd: number;
  records: number;
  /** Of `records`, how many are Claude Code `/stats` estimates (no transcript left for that day). */
  syntheticRecords: number;
}

/** Where the Claude Code history came from: days before `before` (UTC noon of that day, epoch ms) are Claude Code's
 *  own `/stats` totals; `from` is the first such day. */
export type UsageHistory = { claudeCodeStats?: { from: number; before: number } } & Record<string, unknown>;

export interface UsageModelRow extends UsageTotals {
  source: UsageSource;
  provider: string;
  model: string;
  /** `list` (the runtime's own price), `estimate` (MOSS's list-price estimate), `reported` (the other app's own
   *  figure — OpenCode), `mixed`, or `unknown`. */
  costBasis: "list" | "estimate" | "reported" | "mixed" | "unknown";
}

export interface UsageBucket { start: number; costUsd: number; tokens: number; bySource: Partial<Record<UsageSource, number>>; models: Array<{ source: UsageSource; model: string; costUsd: number; tokens: number }> }

const EMPTY = (): UsageTotals => ({ costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, unpricedTokens: 0, cacheSavingsUsd: 0, records: 0, syntheticRecords: 0 });

function add(t: UsageTotals, r: UsageRow): void {
  t.costUsd += r.costUsd; t.input += r.input; t.output += r.output; t.cacheRead += r.cacheRead; t.cacheWrite += r.cacheWrite;
  t.reasoning += r.reasoning; t.unpricedTokens += r.unpricedTokens; t.cacheSavingsUsd += r.cacheSavingsUsd; t.records += r.records;
  t.syntheticRecords += r.syntheticRecords;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function localMidnight(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** PURE: a range's window and bucket size. `earliest` is the oldest hour on record (for `all`). */
export function rangeWindow(range: UsageRange, nowMs: number, earliest?: number): { from: number; to: number; bucketMs: number; fromRecords: boolean } {
  // `to` is exclusive in the queries: one past now, so a record stamped this very millisecond counts.
  const now = nowMs + 1;
  switch (range) {
    case "1h": return { from: now - HOUR, to: now, bucketMs: 5 * 60_000, fromRecords: true };
    case "24h": return { from: now - DAY, to: now, bucketMs: HOUR, fromRecords: true };
    case "7d": { const from = Math.floor((now - 7 * DAY) / HOUR) * HOUR; return { from, to: now, bucketMs: 6 * HOUR, fromRecords: false }; }
    case "30d": return { from: localMidnight(now - 29 * DAY), to: now, bucketMs: DAY, fromRecords: false };
    case "all": {
      const from = localMidnight(Math.min(earliest ?? now, now - 29 * DAY));
      const days = Math.ceil((now - from) / DAY);
      return { from, to: now, bucketMs: Math.max(1, Math.ceil(days / 60)) * DAY, fromRecords: false };
    }
  }
}

/** PURE: the next renewal, the current cycle's start and the monthly cost of a plan. */
export function subscriptionCycle(s: Pick<Subscription, "cadence" | "renewalDay" | "renewalMonth" | "price">, now: number): { nextRenewal: number; cycleStart: number; monthlyCost: number } {
  const at = (y: number, m: number): number => {
    const dim = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(Math.max(1, s.renewalDay), dim)).getTime();
  };
  const today = new Date(localMidnight(now));
  if (s.cadence === "yearly") {
    const month = Math.min(12, Math.max(1, s.renewalMonth ?? 1)) - 1;
    let next = at(today.getFullYear(), month);
    if (next <= today.getTime()) next = at(today.getFullYear() + 1, month);
    const prev = at(new Date(next).getFullYear() - 1, month);
    return { nextRenewal: next, cycleStart: prev, monthlyCost: s.price / 12 };
  }
  let y = today.getFullYear();
  let m = today.getMonth();
  let next = at(y, m);
  if (next <= today.getTime()) { m += 1; if (m > 11) { m = 0; y += 1; } next = at(y, m); }
  let py = y;
  let pm = m - 1;
  if (pm < 0) { pm = 11; py -= 1; }
  return { nextRenewal: next, cycleStart: at(py, pm), monthlyCost: s.price };
}

interface PlanCache { at: number; reading?: PlanReading; failure?: string; everyMs?: number; notInstalled?: boolean }

export class UsageService {
  private readonly now: () => number;
  private ingestRun: Promise<void> | undefined;
  private lastIngestAt = 0;
  private ingestMore = false;
  /** Consecutive passes each source answered `more` (see `MORE_PASSES_MAX`). */
  private readonly morePasses = new Map<string, number>();
  private lastTracking: UsageTracking | undefined;
  /** The sources that could be read at the last pass: one that has come up since (a plugin's yes, a restart of its
   *  process) is news too, never held back by the throttle. */
  private lastSources = "";
  /** Each source's last plan call (its throttle) and the call still running. */
  private readonly planCache = new Map<string, PlanCache>();
  private readonly planRuns = new Map<string, Promise<void>>();
  /** Each plan's last good reading (`PLAN_READINGS_KEY`), loaded once. */
  private keptReadings: Map<string, PlanReading> | undefined;
  /** Each source's last stored state row (JSON), so an unchanged one is not written again. */
  private readonly stateText = new Map<string, string>();
  /** Where each source's history note (the Usage window's footnote) is, by source, loaded once. */
  private readonly histories = new Map<string, Record<string, unknown>>();
  /** Sources whose last call said the tool is not on this computer. */
  private readonly missing = new Set<string>();
  /** The background beat (`startBackground`): the slow one's cancel, and each alarmed plan's fast one. */
  private cancelSlowBeat: (() => void) | undefined;
  private readonly fastBeats = new Map<AlarmProvider, () => void>();

  constructor(private readonly deps: UsageServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ── the entries ─────────────────────────────────────────────────────────────────────────────────

  /**
   * The entries now, one per source id. A source id BELONGS to the plugin that first held it (recorded in usage.db, so it
   * holds across restarts and while that plugin is off): an entry of another plugin naming the same id is refused, said
   * once in the log, and never called, so it cannot file rows under that name or replace the rows stored there. A bundled
   * plugin's entry wins over an installed one (it takes the id over, and the installed one is refused); among installed
   * ones the first to hold it keeps it. (Chosen over keying stored rows by plugin id: the Usage page's names and the
   * alarms' providers are source ids, and one tool's history must stay one history.)
   */
  private entries(): UsageSourceEntry[] {
    let all: UsageSourceEntry[];
    try { all = this.deps.sources?.entries() ?? []; } catch { return []; }
    const owners = this.owners();
    let changed = false;
    const out: UsageSourceEntry[] = [];
    const seen = new Set<string>();
    // Bundled first, so a bundled entry takes an id before an installed one listed ahead of it.
    for (const e of [...all].sort((a, b) => Number(b.bundled === true) - Number(a.bundled === true))) {
      if (!SOURCE_ID.test(e.id) || e.id === "winter") continue;
      let owner = owners[e.id];
      if (owner === undefined || (owner.pluginId !== e.pluginId && e.bundled === true && owner.bundled !== true)) {
        owner = owners[e.id] = { pluginId: e.pluginId, ...(e.bundled === true ? { bundled: true } : {}) };
        changed = true;
      }
      if (owner.pluginId !== e.pluginId) {
        const said = `${e.pluginId}/${e.id}`;
        if (!this.refusedIds.has(said)) {
          this.refusedIds.add(said);
          this.deps.log?.warn?.(`[usage] ${e.pluginId} source "${e.id}" is refused: that name belongs to ${owner.pluginId}`);
        }
        continue;
      }
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
    if (changed) {
      try { this.deps.db.setSourceState(SOURCE_OWNERS_KEY, "winter", { owners }, this.now()); } catch { /* held in memory; the next pass writes it */ }
    }
    // The order the entries came in, as before.
    const order = new Map(all.map((e, i) => [`${e.pluginId}/${e.id}`, i]));
    return out.sort((a, b) => (order.get(`${a.pluginId}/${a.id}`) ?? 0) - (order.get(`${b.pluginId}/${b.id}`) ?? 0));
  }

  private ownersMap: Record<string, { pluginId: string; bundled?: boolean }> | undefined;
  private readonly refusedIds = new Set<string>();
  private owners(): Record<string, { pluginId: string; bundled?: boolean }> {
    if (this.ownersMap === undefined) {
      const raw = this.deps.db.sourceState(SOURCE_OWNERS_KEY)?.owners;
      const map: Record<string, { pluginId: string; bundled?: boolean }> = {};
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
          const o = v as { pluginId?: unknown; bundled?: unknown } | null;
          if (o !== null && typeof o === "object" && typeof o.pluginId === "string") map[id] = { pluginId: o.pluginId, ...(o.bundled === true ? { bundled: true } : {}) };
        }
      }
      this.ownersMap = map;
    }
    return this.ownersMap;
  }

  private entry(id: string): UsageSourceEntry | undefined {
    return this.entries().find((e) => e.id === id);
  }

  /** Every source that gives a plan, in the order the entries came. */
  planSources(): string[] {
    return this.entries().filter((e) => e.provides.includes("plan")).map((e) => e.id);
  }

  private tracked(id: string): boolean {
    return this.deps.tracking()[trackingKey(id)] ?? true;
  }

  // ── MOSS's own turns ─────────────────────────────────────────────────────────────────────────

  /** A projected turn's per-model rows (`onTurnUsage`). A runtime-priced row keeps its price (`list`); an unpriced
   *  one (a subscription row) gets MOSS's list-price estimate at its API twin, or none. */
  recordMossTurn(sessionId: string, mode: string | undefined, sourceId: string, rows: readonly MossTurnRow[]): void {
    const at = this.now();
    const records: UsageRecordInput[] = rows.map((r) => {
      const slash = r.model.indexOf("/");
      const provider = r.provider !== undefined && slash < 0 ? r.provider : slash > 0 ? r.model.slice(0, slash) : r.provider;
      const usage = { input: r.inputTokens, output: r.outputTokens, cacheRead: r.cacheReadTokens, cacheWrite: r.cacheWriteTokens };
      const base = {
        dedupe: `winter:${sessionId}:${sourceId}:${r.model}`, source: "winter" as const, at, sessionId,
        ...(mode === undefined ? {} : { mode }), ...(provider === undefined ? {} : { provider }), model: r.model,
        input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
      };
      if (r.costBasis === "list" && r.costUsd !== undefined) {
        return { ...base, costUsd: r.costUsd, costBasis: "list" as const, cacheSavingsUsd: this.deps.pricer.savingsFor(provider, r.canonicalModel ?? r.model, usage.cacheRead) };
      }
      const est = this.deps.pricer.price(provider, r.canonicalModel ?? r.model, usage);
      return est === undefined ? { ...base, costBasis: "unknown" as const } : { ...base, costUsd: est.costUsd, costBasis: "estimate" as const, cacheSavingsUsd: est.cacheSavingsUsd };
    });
    try { this.deps.db.insert(records); } catch (err) { this.deps.log?.warn?.("[usage] could not record a turn", { error: String(err) }); }
  }

  // ── the external ingest (on demand) ────────────────────────────────────────────────────────────

  /** Start (or join) an ingest pass unless one ran within the throttle; resolves when the pass is done. */
  ingest(force = false): Promise<void> {
    if (this.ingestRun !== undefined) return this.ingestRun;
    const every = this.deps.ingestEveryMs ?? 20_000;
    // A tracking switch flipped since the last pass is news: never held back by the throttle.
    const tracking = this.deps.tracking();
    const sources = this.entries().filter((e) => e.provides.includes("usage")).map((e) => e.id).sort().join(",");
    const switched = this.lastTracking === undefined || JSON.stringify(this.lastTracking) !== JSON.stringify(tracking) || (sources !== "" && sources !== this.lastSources);
    if (!force && !switched && !this.ingestMore && this.now() - this.lastIngestAt < every) return Promise.resolve();
    this.lastTracking = tracking;
    if (sources !== "") this.lastSources = sources;
    this.ingestRun = this.ingestPass().finally(() => { this.ingestRun = undefined; this.lastIngestAt = this.now(); });
    return this.ingestRun;
  }

  /**
   * The background catch-up (user 2026-10-18: keep Claude Code's usage past its own 30-day transcript cleanup). Rows are
   * never deleted here, but they exist only once ingested — so a few minutes after boot and every few hours, ingest
   * EVERYTHING new (a chunked first import runs to its end), whether or not a Usage screen is open. Each switch still
   * applies: a source turned off is not read. Bounded: at most `maxPasses` passes per catch-up.
   */
  async catchUp(maxPasses = 200): Promise<void> {
    for (let i = 0; i < maxPasses; i++) {
      await this.ingest(true);
      if (!this.ingestMore) return;
    }
  }

  ingestState(): { running: boolean; lastAt?: number } {
    return { running: this.ingestRun !== undefined, ...(this.lastIngestAt > 0 ? { lastAt: this.lastIngestAt } : {}) };
  }

  private async ingestPass(): Promise<void> {
    let more = false;
    for (const entry of this.entries()) {
      if (!entry.provides.includes("usage") || !this.tracked(entry.id)) continue;
      try {
        if (await this.ingestSource(entry)) more = this.moreAllowed(entry.id) || more;
        else this.morePasses.delete(entry.id);
      } catch (err) {
        this.deps.log?.warn?.("[usage] ingest failed", { source: entry.id, error: err instanceof Error ? err.name : "error" });
      }
    }
    this.ingestMore = more;
  }

  /** A source "more" is honoured for at most `MORE_PASSES_MAX` passes in a row; then it waits for the throttle like any other. */
  private moreAllowed(id: string): boolean {
    const n = (this.morePasses.get(id) ?? 0) + 1;
    if (n >= MORE_PASSES_MAX) { this.morePasses.delete(id); return false; }
    this.morePasses.set(id, n);
    return true;
  }

  private stateKey(id: string): string { return `${SOURCE_STATE_PREFIX}${id}`; }

  /** A source's stored row: the state it keeps, whether its older records were handed over, and its history note. */
  private stateRow(id: string): { state?: unknown; seeded: boolean; history?: Record<string, unknown> } {
    const row = this.deps.db.sourceState(this.stateKey(id));
    if (row === undefined) return { seeded: false };
    this.stateText.set(id, JSON.stringify(row));
    const history = typeof row.history === "object" && row.history !== null && !Array.isArray(row.history) ? row.history as Record<string, unknown> : undefined;
    return { ...("state" in row ? { state: row.state } : {}), seeded: row.seeded === true, ...(history === undefined ? {} : { history }) };
  }

  /** One call of a source's `ingest`: hand it its state, the store's summary of what it already read, and (the first time)
   *  what the store held before the state moved to the source; store the answer in ONE transaction. Returns `more`. */
  private async ingestSource(entry: UsageSourceEntry): Promise<boolean> {
    const id = entry.id;
    const db = this.deps.db;
    const row = this.stateRow(id);
    const days = db.dailyRealTotals(id, 0);
    const firstAt = db.earliestReal(id);
    const raw = await this.deps.sources!.call(entry, "ingest", {
      now: this.now(), ...("state" in row ? { state: row.state } : {}),
      ...(row.seeded ? {} : { legacy: db.legacyRows(id, SOURCE_STATE_PREFIX) }),
      stored: { days, ...(firstAt === undefined ? {} : { firstAt }) },
    }, INGEST_CALL_TIMEOUT_MS);
    const a = cleanIngestReply(raw);
    for (const line of a.log) this.deps.log?.info?.(`[usage] ${id}: ${line}`);
    if (a.notInstalled) this.missing.add(id); else this.missing.delete(id);
    const records = a.records.map((r) => priceRecord(this.deps.pricer, id, r));
    const estimates = a.estimates?.map((r) => priceRecord(this.deps.pricer, id, { ...r, synthetic: true }));
    const history = a.history ?? row.history;
    const next: Record<string, unknown> = { seeded: true, ...(a.state === "keep" ? ("state" in row ? { state: row.state } : {}) : { state: a.state }), ...(history === undefined ? {} : { history }) };
    const text = JSON.stringify(next);
    const touched = records.length > 0 || a.replace.length > 0 || estimates !== undefined || this.stateText.get(id) !== text;
    const brought = records.length > 0 || a.replace.length > 0 || (estimates?.length ?? 0) > 0;
    if (!touched) return a.more && brought;
    db.db.transaction(() => {
      db.insert(records);
      for (const span of a.replace) this.replaceSpan(id, span.from, span.to, span.records.map((r) => priceRecord(this.deps.pricer, id, r)));
      if (estimates !== undefined) this.reconcileEstimates(id, estimates);
      if (this.stateText.get(id) !== text) db.setSourceState(this.stateKey(id), id, next, this.now());
    })();
    this.stateText.set(id, text);
    if (history !== undefined) this.histories.set(id, history); else this.histories.delete(id);
    return a.more && brought;
  }

  /** Replace one span of a source's rows — written only when something differs (a re-read of an unchanged span writes nothing). */
  private replaceSpan(id: string, from: number, to: number, rows: readonly UsageRecordInput[]): void {
    const stored = new Map(this.deps.db.storedRows(id, false, from, to).map((r) => [r.dedupe, r]));
    if (stored.size === rows.length && rows.every((r) => { const s = stored.get(r.dedupe); return s !== undefined && !differs(s, r); })) return;
    this.deps.db.replaceDay(id, from, to, rows);
  }

  /** Make the stored estimated rows (`synthetic`) the source's wanted set, writing only what differs. */
  private reconcileEstimates(id: string, wanted: readonly UsageRecordInput[]): void {
    const stored = new Map(this.deps.db.syntheticRows(id).map((r) => [r.dedupe, r]));
    const keep = new Set(wanted.map((r) => r.dedupe));
    const remove = [...stored.keys()].filter((d) => !keep.has(d));
    const upsert = wanted.filter((r) => { const s = stored.get(r.dedupe); return s === undefined || differs(s, r); });
    const { removed, added } = remove.length + upsert.length > 0 ? this.deps.db.reconcileSynthetic(id, remove, upsert) : { removed: 0, added: 0 };
    if (removed + added > 0) this.deps.log?.info?.(`[usage] ${id} history updated`, { added, removed });
  }

  /** Where the history came from (the Usage window's footnote): what the sources said about it, merged. */
  history(): UsageHistory {
    const out: UsageHistory = {};
    for (const e of this.entries()) {
      let h = this.histories.get(e.id);
      if (h === undefined) { h = this.stateRow(e.id).history; if (h !== undefined) this.histories.set(e.id, h); }
      if (h !== undefined) Object.assign(out, h);
    }
    return out;
  }

  // ── plans ───────────────────────────────────────────────────────────────────────────────────────

  /** A plan's last good reading — kept through a failed call and across a restart; undefined before the first. */
  private kept(id: string): PlanReading | undefined {
    this.keptReadings ??= parseKeptReadings(this.deps.db.sourceState(PLAN_READINGS_KEY));
    return this.keptReadings.get(id);
  }

  /** A source gave a reading it wants kept: keep it (memory and usage.db — a failed write keeps it in memory). */
  private keep(reading: PlanReading): void {
    if (reading.at === undefined) return;
    this.kept(reading.provider);
    this.keptReadings!.set(reading.provider, reading);
    try {
      this.deps.db.setSourceState(PLAN_READINGS_KEY, "winter", Object.fromEntries(this.keptReadings!), this.now());
    } catch { /* kept in memory; the next reading tries again */ }
  }

  /** A reading as of now: each window's staleness judged afresh from when it was measured. */
  private judged(r: PlanReading): PlanReading {
    return { ...r, windows: r.windows.map((w) => ({ ...w, ...staleness(r.at, w.windowMinutes, w.resetsAt, this.now()) })) };
  }

  /**
   * One source's plan: its entry's handler, asked at most once per its throttle (`planEveryMs`), one call at a time, the
   * answer waited for `planWaitMs` and else the last one given. The source owns its ladder (which program, which file, in
   * what order); what the core owns is the throttle, the last good reading kept across a failed call and a restart, the
   * staleness verdict and the alarms. Every answer judges the plan's alarms. `minAgeMs`: a fast beat's own floor.
   */
  async sourcePlan(id: string, minAgeMs?: number): Promise<PlanReading> {
    return this.answered(await this.readPlan(id, minAgeMs));
  }

  private async readPlan(id: string, minAgeMs?: number): Promise<PlanReading> {
    const none = (source: "none" | "disabled" | "not-installed"): PlanReading => ({ provider: id, source, windows: [] });
    const entry = this.entry(id);
    if (entry === undefined || !entry.provides.includes("plan")) return none("not-installed");
    if (!this.tracked(id)) return none("disabled");
    const now = this.now();
    const cached = this.planCache.get(id);
    const own = minAgeMs ?? this.deps.planEveryMs ?? entry.planEveryMs ?? DEFAULT_PLAN_EVERY_MS;
    // A source that asked for a pause (a program that outlived its own timeout) is not asked before it, whatever a beat's floor.
    const every = cached?.everyMs !== undefined ? Math.max(own, cached.everyMs) : own;
    const running = this.planRuns.get(id);
    if (running !== undefined) {
      await within(running, this.deps.planWaitMs ?? 2_000);
    } else if (cached === undefined || now - cached.at >= every) {
      const run = this.callPlan(entry).finally(() => { this.planRuns.delete(id); });
      this.planRuns.set(id, run);
      await within(run, this.deps.planWaitMs ?? 2_000);
    }
    const latest = this.planCache.get(id);
    if (latest?.notInstalled === true) return none("not-installed");
    // The latest call's reading; else the last good one (a failed call, a restart).
    const reading = latest?.reading ?? this.kept(id);
    return reading === undefined ? none("none") : this.judged(reading);
  }

  private async callPlan(entry: UsageSourceEntry): Promise<void> {
    const id = entry.id;
    const stateKey = `${PLAN_STATE_PREFIX}${id}`;
    const state = this.deps.db.sourceState(stateKey);
    let cache: PlanCache = { at: this.now(), failure: "spawn-failed" };
    try {
      const raw = await this.deps.sources!.call(entry, "plan", {
        now: this.now(), ...(this.kept(id) === undefined ? {} : { kept: this.kept(id) }), reports: this.deps.reports?.() ?? {},
        ...(state !== undefined && "v" in state ? { state: state.v } : {}),
      }, PLAN_CALL_TIMEOUT_MS);
      const a = cleanPlanReply(id, raw);
      for (const line of a.log) this.deps.log?.info?.(`[usage] ${id}: ${line}`);
      cache = {
        at: this.now(), ...(a.reading === undefined ? {} : { reading: a.reading }), ...(a.failure === undefined ? {} : { failure: a.failure }),
        ...(a.retryAfterMs === undefined ? {} : { everyMs: a.retryAfterMs }), ...(a.notInstalled ? { notInstalled: true } : {}),
      };
      if (a.notInstalled) this.missing.add(id); else this.missing.delete(id);
      if ("state" in a) { try { this.deps.db.setSourceState(stateKey, id, { v: a.state ?? null }, this.now()); } catch { /* the next call starts from what it has */ } }
      if (a.reading !== undefined && a.keep) this.keep(a.reading);
      this.planCache.set(id, cache);
      // Judged as it lands: a read that stopped waiting (`planWaitMs` — a background beat's) answered the cache before.
      this.judgeAlarms(a.reading === undefined ? undefined : this.judged(a.reading), entry);
    } catch (err) {
      this.planCache.set(id, cache);
      this.deps.log?.info?.(`[usage] ${id}: plan call failed`, { error: err instanceof Error ? err.name : "error" });
    }
  }

  /** A reading as answered: each window carries its stable key, and the plan's alarms are judged against it. */
  private answered(reading: PlanReading): PlanReading {
    const keyed: PlanReading = { ...reading, windows: reading.windows.map((w) => ({ ...w, windowKey: planWindowKey(w) })) };
    this.judgeAlarms(keyed);
    return keyed;
  }

  // ── plan alarms ─────────────────────────────────────────────────────────────────────────────────

  /** Every ARMED alarm, oldest first (a fired one waiting for its acknowledgement is not a tick any more). */
  alarms(): UsageAlarm[] {
    return this.deps.db.alarms();
  }

  /** Every fired alarm whose notice no client has acknowledged yet, in the order they fired — from the DB, so a
   *  restart or an app away for hours never loses one. */
  firedAlarms(): FiredUsageAlarm[] {
    try { return this.deps.db.firedAlarms(); } catch { return []; }
  }

  /** A client acknowledged a fired alarm's notice (dismissed it, opened it, or showed it its full time): the row goes. */
  ackAlarm(id: string): boolean {
    return this.deps.db.ackAlarm(id);
  }

  /** Set an alarm (whole percent); one already set for the same window and threshold is answered instead. The plan's
   *  fast beat starts with its first alarm. Whether the window is already past it is the client's rule: the daemon
   *  keeps it, and the next fresh reading that meets it fires it. */
  setAlarm(input: { provider: AlarmProvider; windowKey: string; thresholdPercent: number }): UsageAlarm {
    const alarm = this.deps.db.addAlarm({
      id: randomUUID(), provider: input.provider, windowKey: input.windowKey,
      thresholdPercent: Math.min(100, Math.max(1, Math.round(input.thresholdPercent))), createdAt: this.now(),
    });
    this.rescheduleBeats();
    return alarm;
  }

  /** Remove an alarm; the plan's fast beat stops with its last one. */
  removeAlarm(id: string): boolean {
    const removed = this.deps.db.removeAlarm(id);
    this.rescheduleBeats();
    return removed;
  }

  /**
   * Fire the alarms a reading meets — ONCE each: a window that is not stale, in a reading measured no earlier than the
   * alarm was set (an older one is no news about it), whose used share is at the threshold or above. The alarm is
   * MARKED fired with its notice (`UsageDb.fireAlarm`: `fired_at` set only where it was null) and counts only when THIS
   * call marked it, so two reads of the same reading — a call landing while a client's read answers the cache,
   * concurrent asks — fire it once. The row then waits, persisted, for a client to acknowledge its notice, and the
   * notice goes out through the notify door. Not installed or tracking off: the reading has no windows, nothing fires,
   * the alarms stay armed.
   */
  private judgeAlarms(reading: PlanReading | undefined, entry?: UsageSourceEntry): void {
    if (reading === undefined || reading.at === undefined || reading.windows.length === 0) return;
    let alarms: UsageAlarm[];
    try { alarms = this.deps.db.alarms().filter((a) => a.provider === reading.provider); } catch { return; }
    let fired = false;
    for (const a of alarms) {
      if (reading.at < a.createdAt) continue;
      const w = reading.windows.find((x) => !x.stale && planWindowKey(x) === a.windowKey && x.usedPercent >= a.thresholdPercent);
      if (w === undefined) continue;
      const notice = {
        kind: w.kind, ...(w.scope === undefined ? {} : { scope: w.scope }), ...(w.windowMinutes === undefined ? {} : { windowMinutes: w.windowMinutes }),
        usedPercent: w.usedPercent, ...(w.resetsAt === undefined ? {} : { resetsAt: w.resetsAt }),
      };
      try { if (!this.deps.db.fireAlarm(a.id, this.now(), notice)) continue; } catch { continue; }
      fired = true;
      this.deps.log?.info?.("[usage] plan alarm fired", { provider: a.provider, window: a.windowKey, threshold: a.thresholdPercent });
      const name = (entry ?? this.entry(a.provider))?.name ?? a.provider;
      try {
        this.deps.notify?.({ title: `${name} plan at ${Math.round(w.usedPercent)}%`, body: `${w.scope === undefined ? a.windowKey : `${w.scope} (${a.windowKey})`} reached ${a.thresholdPercent}%.` });
      } catch { /* the fired row still waits for a client */ }
    }
    if (fired) this.rescheduleBeats();
  }

  // ── the background plan checks ──────────────────────────────────────────────────────────────────

  /**
   * The background beat (user 2026-10-18, reversing "no background plan polling"): every plan is read every
   * `backgroundEveryMs` (30 min), alarm or not; a plan with at least one alarm is ALSO read on its own fast beat — its
   * throttle — which stops with its last alarm. Each read is the source's own ladder (not installed or tracking off answers
   * at once: nothing called, nothing fired), and every read judges the alarms. Unref'd timers: they never hold the daemon.
   * No read at start.
   */
  startBackground(): void {
    if (this.cancelSlowBeat !== undefined) return;
    this.cancelSlowBeat = this.interval(() => { void this.checkPlans(this.planSources()); }, this.deps.backgroundEveryMs ?? USAGE_BACKGROUND_EVERY_MS);
    this.rescheduleBeats();
  }

  stopBackground(): void {
    this.cancelSlowBeat?.();
    this.cancelSlowBeat = undefined;
    for (const cancel of this.fastBeats.values()) cancel();
    this.fastBeats.clear();
  }

  /** Test seam: the background beat is running. */
  get backgroundRunning(): boolean {
    return this.cancelSlowBeat !== undefined;
  }

  /** Test seam: the plans on a fast beat now. */
  get beating(): AlarmProvider[] {
    return this.planSources().filter((p) => this.fastBeats.has(p));
  }

  /** Read these plans now (each answer judges their alarms) — the beats' entry; a failure is the next beat's to retry.
   *  `fast`: a fast beat ticks just as its cache comes of age (a call's own run time ends its age early), so its floor
   *  is the period less `FAST_BEAT_SLACK_MS` (5 s; at most half the period) — each tick reads, and a client's read in
   *  between rarely adds a second call to a period. */
  async checkPlans(providers: readonly AlarmProvider[], fast = false): Promise<void> {
    await Promise.all(providers.map((p) => this.sourcePlan(p, fast ? fastBeatFloor(this.beatMs(p)) : undefined).catch(() => undefined)));
  }

  private beatMs(p: AlarmProvider): number {
    return this.deps.alarmBeatMs?.[p] ?? this.deps.planEveryMs ?? this.entry(p)?.planEveryMs ?? DEFAULT_PLAN_EVERY_MS;
  }

  private interval(fn: () => void, ms: number): () => void {
    return (this.deps.setInterval ?? defaultInterval)(fn, ms);
  }

  /** A fast beat for each plan with an alarm, none for the rest — only while the background runs. */
  private rescheduleBeats(): void {
    if (this.cancelSlowBeat === undefined) return;
    let wanted: Set<AlarmProvider>;
    try { wanted = new Set(this.deps.db.alarms().map((a) => a.provider)); } catch { wanted = new Set(); }
    for (const [p, cancel] of [...this.fastBeats]) {
      if (!wanted.has(p)) { cancel(); this.fastBeats.delete(p); }
    }
    for (const p of this.planSources()) {
      if (wanted.has(p) && !this.fastBeats.has(p)) this.fastBeats.set(p, this.interval(() => { void this.checkPlans([p], true); }, this.beatMs(p)));
    }
  }

  // ── queries ─────────────────────────────────────────────────────────────────────────────────────

  private rows(range: UsageRange, sources: readonly UsageSource[]): { from: number; to: number; bucketMs: number; rows: Array<UsageRow & { at: number }> } {
    const now = this.now();
    const w = rangeWindow(range, now, range === "all" ? this.deps.db.earliest(sources) : undefined);
    const rows = w.fromRecords
      ? this.deps.db.recordsGrouped(w.from, w.to, sources, w.bucketMs).map((r) => ({ ...r, at: r.bucket }))
      : this.deps.db.hourly(w.from, w.to, sources).map((r) => ({ ...r, at: r.hour }));
    return { from: w.from, to: w.to, bucketMs: w.bucketMs, rows };
  }

  series(range: UsageRange, sourcesIn?: readonly UsageSource[]): {
    range: UsageRange; from: number; to: number; bucketMs: number; buckets: UsageBucket[]; models: UsageModelRow[];
    totals: UsageTotals; bySource: Array<{ source: UsageSource } & UsageTotals>; history: UsageHistory;
  } {
    const sources = sourcesIn ?? this.deps.db.knownSources();
    const { from, to, bucketMs, rows } = this.rows(range, sources);
    const count = Math.max(1, Math.ceil((to - from) / bucketMs));
    const buckets: UsageBucket[] = Array.from({ length: count }, (_, i) => ({ start: from + i * bucketMs, costUsd: 0, tokens: 0, bySource: {}, models: [] }));
    const models = new Map<string, UsageModelRow>();
    const bySource = new Map<UsageSource, UsageTotals>();
    const totals = EMPTY();
    for (const r of rows) {
      const i = Math.min(count - 1, Math.max(0, Math.floor((r.at - from) / bucketMs)));
      const b = buckets[i]!;
      const tokens = r.input + r.output + r.cacheRead + r.cacheWrite;
      b.costUsd += r.costUsd;
      b.tokens += tokens;
      b.bySource[r.source] = (b.bySource[r.source] ?? 0) + r.costUsd;
      const m = b.models.find((x) => x.source === r.source && x.model === r.model);
      if (m === undefined) b.models.push({ source: r.source, model: r.model, costUsd: r.costUsd, tokens });
      else { m.costUsd += r.costUsd; m.tokens += tokens; }
      const key = `${r.source}\u0000${r.provider}\u0000${r.model}`;
      let row = models.get(key);
      if (row === undefined) { row = { source: r.source, provider: r.provider, model: r.model, costBasis: "unknown", ...EMPTY() }; models.set(key, row); }
      add(row, r);
      const prevBasis = row.costBasis;
      const kinds = ([["list", r.listRecords], ["estimate", r.estimateRecords], ["reported", r.reportedRecords]] as const).filter(([, c]) => c > 0);
      const basis = kinds.length === 1 ? kinds[0]![0] : kinds.length > 1 ? "mixed" : "unknown";
      row.costBasis = prevBasis === "unknown" ? basis : basis === "unknown" || basis === prevBasis ? prevBasis : "mixed";
      let s = bySource.get(r.source);
      if (s === undefined) { s = EMPTY(); bySource.set(r.source, s); }
      add(s, r);
      add(totals, r);
    }
    return {
      range, from, to, bucketMs, buckets, history: this.history(),
      models: [...models.values()].sort((a, b) => b.costUsd - a.costUsd || (b.input + b.output + b.cacheRead) - (a.input + a.output + a.cacheRead)),
      totals, bySource: [...bySource.entries()].map(([source, t]) => ({ source, ...t })),
    };
  }

  async summary(range: UsageRange, sources?: readonly UsageSource[], opts: { plans?: boolean; waitMs?: number } = {}) {
    // The ingest and the plan reads run side by side; each answers within its own short wait.
    const ids = opts.plans === false ? [] : this.planSources();
    const [, ...read] = await Promise.all([this.ingestWithin(opts.waitMs ?? 1_500), ...ids.map((id) => this.sourcePlan(id))]);
    const s = this.series(range, sources);
    const plans = opts.plans === false ? undefined : Object.fromEntries(ids.map((id, i) => [id, read[i]!]));
    return {
      range: s.range, from: s.from, to: s.to, bucketMs: s.bucketMs, totals: s.totals, bySource: s.bySource,
      topModels: s.models.slice(0, 5),
      spark: s.buckets.map((b) => b.costUsd), sparkTokens: s.buckets.map((b) => b.tokens),
      ...(plans === undefined ? {} : { plans }),
      tracking: this.deps.tracking(), ingest: this.ingestState(), history: s.history,
      // The plan alarms, so both surfaces draw their ticks from the answer they already ask for.
      alarms: this.alarmsSafe(),
      // Each source's toggle shows only when its tool is on this Mac (a call said it is not: false).
      installed: Object.fromEntries(this.entries().map((e) => [e.id, !this.missing.has(e.id)])),
    };
  }

  private alarmsSafe(): UsageAlarm[] {
    try { return this.deps.db.alarms(); } catch { return []; }
  }

  /** Run (or join) an ingest pass, waiting at most `ms` for it — what is stored by then is answered. */
  async ingestWithin(ms: number): Promise<void> {
    const run = this.ingest();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([run, new Promise<void>((r) => { timer = setTimeout(r, ms); timer.unref?.(); })]);
    if (timer !== undefined) clearTimeout(timer);
  }

  // ── subscriptions ───────────────────────────────────────────────────────────────────────────────

  subscriptions() {
    const now = this.now();
    return this.deps.db.subscriptions().map((s) => {
      const cycle = subscriptionCycle(s, now);
      const usage = this.deps.db.costFor(cycle.cycleStart, now, s.covers);
      return { ...s, ...cycle, usageThisCycleUsd: usage.costUsd, usageThisCycleTokens: usage.tokens, unpricedTokens: usage.unpricedTokens };
    });
  }

  setSubscription(input: Omit<Subscription, "id" | "createdAt" | "updatedAt"> & { id?: string }): Subscription {
    const now = this.now();
    const existing = input.id === undefined ? undefined : this.deps.db.subscriptions().find((s) => s.id === input.id);
    const sub: Subscription = {
      id: input.id ?? randomUUID(), name: input.name, provider: input.provider, price: input.price, currency: input.currency,
      cadence: input.cadence, renewalDay: input.renewalDay, ...(input.renewalMonth === undefined ? {} : { renewalMonth: input.renewalMonth }),
      covers: input.covers, createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    this.deps.db.upsertSubscription(sub);
    return sub;
  }

  removeSubscription(id: string): boolean {
    return this.deps.db.removeSubscription(id);
  }
}
