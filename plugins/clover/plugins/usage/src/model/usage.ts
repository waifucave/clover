// The usage views' model (spec §12 "Usage tracking"): plan readings and usage totals as the island's Usage tab and the
// Usage section of Settings show them. The data is `usage.read`'s, mirrored here from lane B's protocol
// (`packages/protocol/src/usage.ts` on `lane/b-m0`) until #157 merges and the parts import it. Pure: every function
// takes `now`, and nothing here reads a clock, a file or the network.

import { isEnglish, language, t } from "../strings";

export const USAGE_SOURCES = ["clover", "codex", "claude-code", "opencode", "antigravity"] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export interface UsageRow {
  id: string;
  computer: string;
  source: UsageSource;
  at: number;
  provider?: string;
  model?: string;
  bot?: string;
  session?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Absent for a subscription or an unpriced model. */
  costUsd?: number;
}

/** A plan reading from one of the user's own apps, by its own install. */
export interface PlanReading {
  source: UsageSource;
  computer: string;
  plan: string;
  /** The window's name as the reader gives it: `5h`, `weekly`, `7d`, `monthly`… */
  window: string;
  /** 0 to 100, over 100 when the app lets the user run past it. */
  usedPercent: number;
  resetsAt?: number;
  readAt: number;
}

export type GroupBy = "source" | "model" | "bot" | "computer" | "day" | "session";

export interface UsageGroup {
  /** The group's key; `day` is the UTC date (`2026-11-05`); a row with no bot or session groups under `-`. */
  key: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

/** `usage.read`, as lane B's plugin API gives it (`UsageApi`). */
export interface UsageApi {
  rows(query: { since: number; until?: number; computer?: string; source?: UsageSource; bot?: string; session?: string; cursor?: string; limit?: number }): Promise<{ rows: UsageRow[]; next?: string }>;
  plans(): Promise<PlanReading[]>;
  summary(query: { from: number; to: number; groupBy: GroupBy; bot?: string; session?: string }): Promise<UsageGroup[]>;
  /** New rows arrived; views re-read from `since`. */
  watch(listener: (since: number) => void): () => void;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function sourceTitle(source: string): string {
  return USAGE_SOURCES.includes(source as UsageSource) ? t(`clover.usage.source.${source}`) : source;
}

/** 950, 1.2k, 34k, 1.2M, 3.4B: tokens as the eye reads them. */
export function compactCount(n: number): string {
  const v = Math.max(0, Math.round(n));
  // Another language takes its own compact forms (German "1234" as "1234", Japanese "1.2万"), cut down, never up.
  if (!isEnglish()) return numberFormat(language(), { notation: "compact", maximumFractionDigits: 1, roundingMode: "trunc" }).format(v);
  if (v < 1000) return String(v);
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [size, unit] of units) {
    if (v >= size) {
      const x = v / size;
      const text = x < 10 ? (Math.floor(x * 10) / 10).toFixed(1).replace(/\.0$/, "") : String(Math.floor(x));
      // 999.95k reads as 999k, never 1000k.
      return `${text}${unit}`;
    }
  }
  return String(v);
}

/** $0.42, <$0.01, $12.30, $1,234: never more digits than the figure is worth; in the user's language's own
 *  currency format (US dollars, which is what the providers price in). */
export function formatCost(usd: number | undefined): string {
  if (usd === undefined) return t("clover.usage.unpriced");
  const money = (value: number, digits: number) => numberFormat(isEnglish() ? "en-US" : language(), { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  if (usd === 0) return money(0, 0);
  if (usd < 0.01) return `<${money(0.01, 2)}`;
  if (usd < 1000) return money(usd, 2);
  return money(Math.round(usd), 0);
}

const formats = new Map<string, Intl.NumberFormat>();

/** One formatter per language and options, made once; an unknown language falls back to English. */
function numberFormat(lang: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${lang} ${JSON.stringify(options)}`;
  let f = formats.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(lang, options);
    } catch {
      f = new Intl.NumberFormat("en-US", options);
    }
    formats.set(key, f);
  }
  return f;
}

/** How full a plan is, as a state with words (never colour alone): within it, nearing the limit, at it. */
export type PlanLevel = "ok" | "near" | "high" | "out";

export function planLevel(usedPercent: number): PlanLevel {
  if (usedPercent >= 100) return "out";
  if (usedPercent >= 90) return "high";
  if (usedPercent >= 75) return "near";
  return "ok";
}

/** A reading older than this is shown quieter, with its age. */
export const STALE_AFTER = 6 * HOUR;

export function windowTitle(window: string): string {
  const w = window.toLowerCase();
  if (/^\d+h$/.test(w)) return t("clover.usage.window.hours", { count: Number(w.slice(0, -1)) });
  if (w === "weekly" || w === "7d" || w === "week") return t("clover.usage.window.weekly");
  if (w === "daily" || w === "1d" || w === "day") return t("clover.usage.window.daily");
  if (w === "monthly" || w === "30d" || w === "month") return t("clover.usage.window.monthly");
  return window;
}

/** "in 2 h 14 min", "in 3 days", "tomorrow at 09:00" would need a locale clock; the island keeps to the relative. */
export function inWords(at: number, now: number): string {
  const ms = Math.max(0, at - now);
  const minutes = Math.ceil(ms / MINUTE);
  if (minutes < 60) return t("clover.usage.inMinutes", { count: Math.max(1, minutes) });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes - hours * 60;
    return rest === 0 ? t("clover.usage.inHours", { count: hours }) : t("clover.usage.inHoursMinutes", { hours, minutes: rest });
  }
  return t("clover.usage.inDays", { count: Math.round(hours / 24) });
}

export function agoWords(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / MINUTE);
  if (minutes < 1) return t("clover.usage.justNow");
  if (minutes < 60) return t("clover.usage.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("clover.usage.hoursAgo", { count: hours });
  return t("clover.usage.daysAgo", { count: Math.floor(hours / 24) });
}

export interface PlanRow {
  id: string;
  /** "Codex · Pro". */
  title: string;
  /** "5-hour", and the computer when the readings come from more than one. */
  side: string;
  /** 0 to 1 for the bar; a plan past its limit fills it. */
  fraction: number;
  level: PlanLevel;
  /** "62% used". */
  status: string;
  /** "Resets in 2 h 14 min", or "Read 7 h ago" for a stale one. */
  detail: string | null;
  stale: boolean;
}

/** The plans, the fullest first; a stale reading after the fresh ones. */
export function planRows(readings: readonly PlanReading[], now: number): PlanRow[] {
  const computers = new Set(readings.map((r) => r.computer));
  const rows = readings.map((r): PlanRow => {
    const stale = now - r.readAt > STALE_AFTER;
    const level = planLevel(r.usedPercent);
    const used = Math.round(r.usedPercent);
    const status = level === "out" ? t("clover.usage.limitReached") : t("clover.usage.used", { percent: used });
    let detail: string | null = null;
    if (stale) detail = t("clover.usage.read", { ago: agoWords(r.readAt, now) });
    else if (r.resetsAt !== undefined && r.resetsAt > now) detail = t("clover.usage.resets", { when: inWords(r.resetsAt, now) });
    return {
      id: `${r.computer}:${r.source}:${r.plan}:${r.window}`,
      title: `${sourceTitle(r.source)} · ${r.plan}`,
      side: computers.size > 1 ? `${windowTitle(r.window)} · ${r.computer}` : windowTitle(r.window),
      fraction: Math.min(1, Math.max(0, r.usedPercent / 100)),
      level,
      status,
      detail,
      stale,
    };
  });
  return rows.sort((a, b) => Number(a.stale) - Number(b.stale) || b.fraction - a.fraction || a.title.localeCompare(b.title));
}

export type UsageRange = "day" | "week" | "month" | "all";
export const RANGES: readonly UsageRange[] = ["day", "week", "month", "all"];

/** The period a range covers, ending now. "All" starts at the first row the core keeps (from 0). */
export function rangeOf(range: UsageRange, now: number): { from: number; to: number } {
  const span = range === "day" ? DAY : range === "week" ? 7 * DAY : range === "month" ? 30 * DAY : now;
  return { from: Math.max(0, now - span), to: now };
}

/** Local midnight today, for the island's "Today". */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export type Metric = "cost" | "tokens";

export function tokensOf(g: { inputTokens: number; outputTokens: number }): number {
  return g.inputTokens + g.outputTokens;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** Absent when no group was priced. */
  costUsd?: number;
  /** Some groups were priced and some weren't: the cost is a floor. */
  partlyPriced: boolean;
}

export function totals(groups: readonly UsageGroup[]): UsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cost: number | undefined;
  let unpriced = 0;
  for (const g of groups) {
    inputTokens += g.inputTokens;
    outputTokens += g.outputTokens;
    if (g.costUsd === undefined) unpriced++;
    else cost = (cost ?? 0) + g.costUsd;
  }
  return { inputTokens, outputTokens, costUsd: cost, partlyPriced: cost !== undefined && unpriced > 0 };
}

export interface DayBar {
  /** The UTC date. */
  key: string;
  at: number;
  value: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

/** Every UTC day from `from` to `to`, a day with no rows at 0: the chart's bars, oldest first. At most `maxDays`, the
 *  latest ones (an "all" range of years still draws a readable chart). */
export function dayBars(groups: readonly UsageGroup[], from: number, to: number, metric: Metric, maxDays = 60): DayBar[] {
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const first = Math.max(Math.floor(from / DAY), Math.floor(to / DAY) - (maxDays - 1));
  const last = Math.floor(to / DAY);
  const bars: DayBar[] = [];
  for (let day = first; day <= last; day++) {
    const at = day * DAY;
    const key = new Date(at).toISOString().slice(0, 10);
    const g = byKey.get(key);
    const value = !g ? 0 : metric === "cost" ? (g.costUsd ?? 0) : tokensOf(g);
    bars.push({ key, at, value, inputTokens: g?.inputTokens ?? 0, outputTokens: g?.outputTokens ?? 0, costUsd: g?.costUsd });
  }
  return bars;
}

export interface BreakdownRow {
  key: string;
  title: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  /** Its share of the metric over the period, 0 to 1. */
  share: number;
}

/** A group's key as words: a source by its name, `-` as "no bot" or "no session", a model as it is. */
export function groupTitle(key: string, by: GroupBy): string {
  if (by === "source") return sourceTitle(key);
  if (key === "-") return t(by === "bot" ? "clover.usage.noBot" : by === "session" ? "clover.usage.noSession" : "clover.usage.unknown");
  return key;
}

/** The largest groups by the metric, the rest folded into "Other" past `limit`. */
export function breakdown(groups: readonly UsageGroup[], by: GroupBy, metric: Metric, limit = 8): BreakdownRow[] {
  const value = (g: UsageGroup) => (metric === "cost" ? (g.costUsd ?? 0) : tokensOf(g));
  const sorted = [...groups].sort((a, b) => value(b) - value(a) || tokensOf(b) - tokensOf(a) || a.key.localeCompare(b.key));
  const sum = sorted.reduce((s, g) => s + value(g), 0);
  const head = sorted.length > limit ? sorted.slice(0, limit - 1) : sorted;
  const tail = sorted.length > limit ? sorted.slice(limit - 1) : [];
  const rows = head.map((g): BreakdownRow => ({ key: g.key, title: groupTitle(g.key, by), inputTokens: g.inputTokens, outputTokens: g.outputTokens, costUsd: g.costUsd, share: sum > 0 ? value(g) / sum : 0 }));
  if (tail.length > 0) {
    const rest = totals(tail);
    const v = tail.reduce((s, g) => s + value(g), 0);
    rows.push({ key: "\u0000other", title: t("clover.usage.other", { count: tail.length }), inputTokens: rest.inputTokens, outputTokens: rest.outputTokens, costUsd: rest.costUsd, share: sum > 0 ? v / sum : 0 });
  }
  return rows;
}

/** "1.2M tokens · $3.40", the island's line for a source today. */
export function amountWords(g: { inputTokens: number; outputTokens: number; costUsd?: number }): string {
  const tokens = t("clover.usage.tokens", { count: compactCount(tokensOf(g)) });
  return g.costUsd === undefined ? tokens : `${tokens} · ${formatCost(g.costUsd)}`;
}
