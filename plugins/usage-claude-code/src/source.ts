import { statSync } from "node:fs";
import { join } from "node:path";
import type { HandlerContext } from "@waifucave/moss-plugin-sdk";
import {
  fileKey, readFiles, runOutside, type FileCursor, type Outside, type UsageIngestArgs, type UsageIngestReply, type UsagePlanArgs, type UsagePlanReply, type UsageRecord,
} from "@waifucave/moss-plugin-sdk/usage-source";
import {
  CLAUDE_USAGE_TIMEOUT_MS, claudeCodeRecordOf, claudeCodeTranscripts, claudePlanFromCli, claudeSubscriptionType, readCapped,
} from "./claude-code";
import {
  CLAUDE_STATS_FILE, CLAUDE_STATS_MAX_BYTES, CLAUDE_TRANSCRIPT_RETENTION_DAYS, PASS_NOTE_EVERY_MS, addGap, estimateKey, isPartialDay, overlapFrom, parseClaudeStats,
  parseStatsHistory, refreshEstimates, statsRows, utcDay, utcNoon, type ClaudeStatsHistory, type RealDayTotal, type StatsCoverage,
} from "./claude-stats";

// The Claude Code source (spec §12 "Usage sources"): its plan windows from its own `/usage` and the plan's name from
// its own `auth status`; its token counts from its transcripts, `~/.claude/projects`; and the days its transcripts no
// longer hold, from its own `/stats` cache, `~/.claude/stats-cache.json` (the two paths the manifest names).

const DAY = 86_400_000;

/** Where Claude Code keeps its files: the user's home is the host process's `HOME`. */
export const claudeHomeOf = (env: Readonly<Record<string, string | undefined>> = process.env): string => join(env.HOME ?? "/nonexistent-home", ".claude");

export interface ClaudeSourceOptions {
  /** Claude Code's config folder; the user's `~/.claude` unless a test names another. */
  home?: () => string;
  cliTimeoutMs?: number;
  statsMaxBytes?: number;
  fileBudgetBytes?: number;
  maxLineBytes?: number;
  maxRecords?: number;
}

// ── the plan ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface PlanState {
  /** Claude Code's version when its `/usage` once reached the model loop; asked again only when it changes. */
  latched?: { version: string; reason: string };
  /** The plan's name (`auth status`'s `subscriptionType`), asked hourly. */
  planName?: { at: number; value?: string };
}

const stateOf = (v: unknown): PlanState => {
  const s: PlanState = {};
  if (typeof v !== "object" || v === null) return s;
  const o = v as Record<string, unknown>;
  const l = o.latched as Record<string, unknown> | undefined;
  if (typeof l === "object" && l !== null && typeof l.version === "string" && typeof l.reason === "string") s.latched = { version: l.version, reason: l.reason };
  const n = o.planName as Record<string, unknown> | undefined;
  if (typeof n === "object" && n !== null && typeof n.at === "number") s.planName = { at: n.at, ...(typeof n.value === "string" ? { value: n.value } : {}) };
  return s;
};

async function versionOf(outside: Outside): Promise<string> {
  const r = await runOutside(outside, "claude", ["--version"], { timeoutMs: 8_000 });
  return r.kind === "exited" ? (r.stdout.split("\n")[0] ?? "").trim().slice(0, 80) : "";
}

const PLAN_NAME_EVERY_MS = 3_600_000;

export async function plan(args: UsagePlanArgs, ctx: Pick<HandlerContext, "api">, o: ClaudeSourceOptions = {}): Promise<UsagePlanReply> {
  const outside = ctx.api.outside;
  if (outside === undefined) return { failure: "no-outside" };
  const state = stateOf(args.state);
  const log: string[] = [];
  if (state.latched !== undefined) {
    if (state.latched.version === (await versionOf(outside))) return { failure: "latched" };
    delete state.latched;
  }
  // The plan's name (Max, Pro…), from Claude Code's own offline `auth status` — hourly.
  if (state.planName === undefined || args.now - state.planName.at >= PLAN_NAME_EVERY_MS) {
    const value = await claudeSubscriptionType(outside);
    state.planName = { at: args.now, ...(value === undefined ? {} : { value }) };
  }
  const r = await claudePlanFromCli(outside, { now: () => args.now, timeoutMs: o.cliTimeoutMs ?? CLAUDE_USAGE_TIMEOUT_MS });
  if (r.failure === "not-installed") return { notInstalled: true };
  if (r.failure === "guard" || r.failure === "guard-model-turn") {
    state.latched = { version: await versionOf(outside), reason: r.failure };
    log.push("claude /usage did not come back as the local command; not asked again until Claude Code changes");
  } else if (r.failure !== undefined) {
    log.push(`claude /usage gave no plan reading: ${r.failure}`);
  }
  // Kept with the plan's name (a restart forgets `auth status` until its next run).
  const name = state.planName.value;
  const reading = r.reading === undefined ? undefined : name === undefined || r.reading.planType !== undefined ? r.reading : { ...r.reading, planType: name };
  return { ...(reading === undefined ? {} : { reading, keep: true }), ...(r.failure === undefined ? {} : { failure: r.failure }), state, log };
}

// ── the token counts and the history ────────────────────────────────────────────────────────────────────────────────

/** Where Claude Code's `/stats` history kept its state in the core's store before it moved here. */
const LEGACY_STATS_KEY = "claude-code:stats-history";

interface IngestState {
  v: 1;
  /** Each transcript's read cursor, by the hash of its path. */
  files: Record<string, FileCursor>;
  firstPassAt?: number;
  lastPassAt?: number;
  gaps: Array<[string, string]>;
  estimates: Record<string, unknown>;
  planned: boolean;
  /** The last estimates' inputs (the cache file's stamp and the coverage): unchanged, nothing to do. */
  sig?: string;
  /** The last rows' inputs (the estimates, the coverage, the transcript totals on partial days): unchanged, nothing to do. */
  rowsSig?: string;
  /** The first and last day an estimate stands in for, epoch ms (the footnote's). */
  span?: { first: number; last: number };
}

function loadState(args: UsageIngestArgs): { files: Record<string, FileCursor>; h: ClaudeStatsHistory; sig?: string; rowsSig?: string; span?: { first: number; last: number }; legacyFirst?: number } {
  const s = args.state as Partial<IngestState> | undefined;
  if (typeof s === "object" && s !== null && typeof s.files === "object" && s.files !== null) {
    const files: Record<string, FileCursor> = {};
    for (const [k, c] of Object.entries(s.files)) {
      if (typeof c === "object" && c !== null && typeof c.inode === "number" && typeof c.offset === "number") {
        files[k] = { inode: c.inode, offset: c.offset, ...(c.skipping === true ? { skipping: true } : {}) };
      }
    }
    return {
      files, h: parseStatsHistory(s as Record<string, unknown>),
      ...(typeof s.sig === "string" ? { sig: s.sig } : {}), ...(typeof s.rowsSig === "string" ? { rowsSig: s.rowsSig } : {}),
      ...(s.span !== undefined && typeof s.span.first === "number" && typeof s.span.last === "number" ? { span: s.span } : {}),
    };
  }
  // The first call: what the core's store held for this source (the read offsets and the history's own record).
  const files: Record<string, FileCursor> = {};
  let legacyFirst: number | undefined;
  for (const [k, row] of Object.entries(args.legacy ?? {})) {
    if (!k.startsWith("claude-code:") || k === LEGACY_STATS_KEY) continue;
    legacyFirst = Math.min(legacyFirst ?? row.updatedAt, row.updatedAt);
    if (row.offset > 0) files[k] = { inode: row.inode, offset: row.offset, ...(row.state.__skipping === true ? { skipping: true } : {}) };
  }
  return { files, h: parseStatsHistory(args.legacy?.[LEGACY_STATS_KEY]?.state), ...(legacyFirst === undefined ? {} : { legacyFirst }) };
}

/** Per UTC day and model, what was read: the store's and this call's together. */
class RealTotals {
  private readonly map = new Map<string, { model: string; day: string; all: number; io: number }>();
  firstAt: number | undefined;
  constructor(args: UsageIngestArgs, records: readonly UsageRecord[]) {
    for (const d of args.stored.days) this.map.set(`${d.day}|${d.model}`, { ...d });
    this.firstAt = args.stored.firstAt;
    for (const r of records) {
      if (r.synthetic === true) continue;
      const day = utcDay(r.at);
      const key = `${day}|${r.model}`;
      const e = this.map.get(key) ?? { model: r.model, day, all: 0, io: 0 };
      e.all += r.input + r.output + r.cacheRead + r.cacheWrite;
      e.io += r.input + r.output;
      this.map.set(key, e);
      if (this.firstAt === undefined || r.at < this.firstAt) this.firstAt = r.at;
    }
  }
  /** Totals of the days from `fromDay` (inclusive). */
  since(fromDay: string): RealDayTotal[] {
    return [...this.map.values()].filter((e) => e.day >= fromDay).map((e) => ({ model: e.model, day: e.day, all: e.all, io: e.io }));
  }
  between(fromDay: string, toDay: string): Array<{ model: string; day: string; all: number }> {
    return [...this.map.values()].filter((e) => e.day >= fromDay && e.day <= toDay);
  }
}

/** A line said once per process (per folder): the same unreadable file is not told again every call. */
const told = new Set<string>();
const once = (log: string[], key: string, line: string): void => { if (!told.has(key)) { told.add(key); log.push(line); } };

export async function ingest(args: UsageIngestArgs, o: ClaudeSourceOptions = {}): Promise<UsageIngestReply> {
  const home = (o.home ?? claudeHomeOf)();
  const loaded = loadState(args);
  const log: string[] = [];
  const passAt = args.now;
  const found = await claudeCodeTranscripts(home);
  const read = await readFiles({
    files: found, cursors: loaded.files, keyOf: (f) => fileKey("claude-code", f.path),
    recordOf: (line, _st, file) => claudeCodeRecordOf(line, file.mtimeMs),
    ...(o.fileBudgetBytes === undefined ? {} : { fileBudgetBytes: o.fileBudgetBytes }), ...(o.maxLineBytes === undefined ? {} : { maxLineBytes: o.maxLineBytes }),
    ...(o.maxRecords === undefined ? {} : { maxRecords: o.maxRecords }),
  });
  const complete = !read.more;
  const h = loaded.h;
  const real = new RealTotals(args, read.records);
  let dirty = false;

  // Note when the transcripts were first read in full, and the spans between reads too far apart.
  if (h.firstPassAt === undefined) { h.firstPassAt = Math.min(loaded.legacyFirst ?? passAt, passAt); dirty = true; }
  const lost = passAt - CLAUDE_TRANSCRIPT_RETENTION_DAYS * DAY;
  if (h.lastPassAt !== undefined && lost > h.lastPassAt) {
    const gaps = addGap(h.gaps, utcDay(h.lastPassAt), utcDay(lost));
    if (gaps !== undefined) { h.gaps = gaps; dirty = true; }
  }
  if (complete && (h.lastPassAt === undefined || passAt - h.lastPassAt >= PASS_NOTE_EVERY_MS)) { h.lastPassAt = passAt; dirty = true; }

  const coverage = (): StatsCoverage => ({
    ...(real.firstAt === undefined ? {} : { firstTranscriptDay: utcDay(real.firstAt) }),
    ...(h.firstPassAt === undefined ? {} : { partialThrough: utcDay(h.firstPassAt - CLAUDE_TRANSCRIPT_RETENTION_DAYS * DAY) }),
    gaps: h.gaps,
  });
  const cov = coverage();
  const coverageKey = JSON.stringify(cov);
  let sig = loaded.sig;
  let rowsSig = loaded.rowsSig;
  let span = loaded.span;

  // Backfill the history from Claude Code's own `/stats` cache for the days its transcripts may no longer hold in full.
  if (complete) {
    const path = join(home, CLAUDE_STATS_FILE);
    let stamp: string | undefined;
    let size = 0;
    try { const st = statSync(path); stamp = `${Math.floor(st.mtimeMs)}:${st.size}`; size = st.size; } catch { /* no cache */ }
    if (stamp !== undefined && `${stamp}|${coverageKey}` !== sig) {
      const cap = o.statsMaxBytes ?? CLAUDE_STATS_MAX_BYTES;
      const text = size > cap ? "over-cap" : await readCapped(path, cap);
      const stats = text === undefined || text === "over-cap" ? undefined : parseClaudeStats(text);
      if (text === "over-cap") once(log, `${home}|over-cap`, "Claude Code's stats cache is over the size cap; its history is not read");
      else if (text !== undefined && stats === undefined) once(log, `${home}|corrupt`, "Claude Code's stats cache could not be read; its history is not imported");
      if (stats !== undefined) {
        const from = overlapFrom(passAt);
        const r = refreshEstimates(h.estimates, { stats, coverage: cov, today: utcDay(passAt), real: real.since(from), overlapFromDay: from });
        if (r.changed || !h.planned) { h.estimates = r.estimates; h.planned = true; dirty = true; rowsSig = undefined; }
      }
      sig = `${stamp}|${coverageKey}`; // read, or judged unreadable: not tried again until the file or the coverage changes
    }
  }
  let estimates: UsageRecord[] | undefined;
  if (h.planned) {
    // What each partial day's surviving transcripts already count, keyed like the estimates.
    const spans: Array<[string, string]> = [];
    if (cov.partialThrough !== undefined) spans.push(["0000-00-00", cov.partialThrough]);
    for (const [a, b] of cov.gaps) spans.push([a, b]);
    const partial = new Map<string, number>();
    for (const [a, b] of spans) for (const e of real.between(a, b)) if (isPartialDay(cov, e.day)) partial.set(estimateKey(e.model, e.day), e.all);
    const rs = `${coverageKey}|${[...partial].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(",")}`;
    if (rs !== rowsSig) {
      estimates = statsRows(h.estimates, cov, partial);
      rowsSig = rs;
      span = estimates.length === 0 ? undefined : { first: Math.min(...estimates.map((e) => e.at)), last: Math.max(...estimates.map((e) => e.at)) };
      dirty = true;
    }
  }
  const files = Object.fromEntries(Object.entries(read.cursors).filter(([k]) => found.some((f) => fileKey("claude-code", f.path) === k)));
  const state: IngestState = {
    v: 1, files, ...(h.firstPassAt === undefined ? {} : { firstPassAt: h.firstPassAt }), ...(h.lastPassAt === undefined ? {} : { lastPassAt: h.lastPassAt }),
    gaps: h.gaps, estimates: Object.fromEntries(h.estimates), planned: h.planned,
    ...(sig === undefined ? {} : { sig }), ...(rowsSig === undefined ? {} : { rowsSig }), ...(span === undefined ? {} : { span }),
  };
  void dirty;
  // Where the history came from (the Usage window's footnote): its first day, and the first day after the partial ones.
  let history: Record<string, unknown> | undefined;
  if (span !== undefined) {
    const c = coverage();
    let before: string;
    if (c.firstTranscriptDay === undefined) before = utcDay(span.last + DAY);
    else {
      const afterPartial = c.partialThrough === undefined ? c.firstTranscriptDay : utcDay(Date.parse(`${c.partialThrough}T00:00:00Z`) + DAY);
      before = afterPartial > c.firstTranscriptDay ? afterPartial : c.firstTranscriptDay;
    }
    history = { claudeCodeStats: { from: span.first, before: utcNoon(before) } };
  }
  return { records: read.records, more: read.more, state, ...(estimates === undefined ? {} : { estimates, history: history ?? {} }), log };
}
