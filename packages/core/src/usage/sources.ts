import type { UsageRecordInput } from "./db";
import type { PlanReading, PlanStatusWindow, PlanWindow } from "./plan";
import type { UsagePricer } from "./pricing";

// The `usage.sources` point's door (spec §12 "Usage sources"): what an entry is, what a handler may answer, and what the
// core makes of the answer. The core holds NO reader: it asks an entry's handler (a plugin's, on this computer) for a plan
// reading (`plan`) and for the numbers its tool's files hold (`ingest`), and keeps what is general: the throttle, the last
// good reading, staleness, alarms, the price, the store. Everything a reply says is untrusted: it is validated here, field
// by field, and anything malformed is dropped.

/** One entry of the `usage.sources` point: a tool's usage, by the plugin that reads it. */
export interface UsageSourceEntry {
  pluginId: string;
  /** The plugin is one the build ships (it wins a source id another plugin also declares). */
  bundled?: boolean;
  /** The source's name: its records' `source`, its plan's `provider`, an alarm's provider. */
  id: string;
  name: string;
  handler: string;
  provides: ReadonlyArray<"plan" | "usage">;
  /** The shortest time between two plan reads (default 5 min). */
  planEveryMs?: number;
}

/** How the core reaches the entries: the daemon's plugin registry and host (a test hands its own). */
export interface UsageSourcePort {
  /** The active entries now (a plugin that is off or blocked has none). */
  entries(): UsageSourceEntry[];
  /** Call the entry's handler method; rejects on any failure. */
  call(entry: UsageSourceEntry, method: "plan" | "ingest", args: unknown, timeoutMs: number): Promise<unknown>;
}

/** The ids an entry may have: lower-case words with dashes, as a tracking switch or an alarm names them. */
export const SOURCE_ID = /^[a-z][a-z0-9-]{0,39}$/;

export const MAX_RECORDS_PER_CALL = 20_000;
export const MAX_REPLACE_SPANS = 64;
export const MAX_ESTIMATES = 20_000;
export const MAX_STATE_BYTES = 8 * 1024 * 1024;
export const PLAN_CALL_TIMEOUT_MS = 90_000;
export const INGEST_CALL_TIMEOUT_MS = 5 * 60_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
const count = (v: unknown): number => { const n = finite(v); return n === undefined || n < 0 ? 0 : Math.min(Math.round(n), 1e13); };

const WINDOW_KINDS = new Set(["five_hour", "weekly", "weekly_scoped", "other"]);

/** A plan reading from a source (or from the kept store), validated: windows with a bad id, kind or share are dropped.
 *  A stored `stale` or `windowKey` is ignored (both are judged afresh on every answer). */
export function cleanReading(provider: string, raw: unknown): PlanReading | undefined {
  if (!isObj(raw)) return undefined;
  const source = str(raw.source, 60);
  if (source === undefined || !Array.isArray(raw.windows)) return undefined;
  const windows: PlanWindow[] = [];
  for (const w of raw.windows.slice(0, 40)) {
    if (!isObj(w)) continue;
    const id = str(w.id, 120);
    const used = finite(w.usedPercent);
    if (id === undefined || typeof w.kind !== "string" || !WINDOW_KINDS.has(w.kind) || used === undefined || used < 0 || used > 100) continue;
    const windowMinutes = finite(w.windowMinutes);
    const resetsAt = finite(w.resetsAt);
    const scope = str(w.scope, 120);
    const severity = str(w.severity, 40);
    windows.push({
      id, kind: w.kind as PlanWindow["kind"], usedPercent: used, stale: false,
      ...(windowMinutes === undefined ? {} : { windowMinutes }), ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(scope === undefined ? {} : { scope }), ...(severity === undefined ? {} : { severity }),
    });
  }
  const statusOnly: PlanStatusWindow[] = [];
  if (Array.isArray(raw.statusOnly)) {
    for (const s of raw.statusOnly.slice(0, 20)) {
      if (!isObj(s)) continue;
      const status = str(s.status, 60);
      const at = finite(s.at);
      if (status === undefined || at === undefined) continue;
      const rateLimitType = str(s.rateLimitType, 60);
      const resetsAt = finite(s.resetsAt);
      statusOnly.push({ status, at, ...(rateLimitType === undefined ? {} : { rateLimitType }), ...(resetsAt === undefined ? {} : { resetsAt }) });
    }
  }
  if (windows.length === 0 && statusOnly.length === 0) return undefined;
  const at = finite(raw.at);
  const planType = str(raw.planType, 40);
  const limitReached = str(raw.limitReached, 200);
  const note = str(raw.note, 200);
  const c = raw.credits;
  const credits = isObj(c) ? (() => {
    const balance = str(c.balance, 40);
    return {
      ...(typeof c.hasCredits === "boolean" ? { hasCredits: c.hasCredits } : {}), ...(typeof c.unlimited === "boolean" ? { unlimited: c.unlimited } : {}),
      ...(balance === undefined ? {} : { balance }),
    };
  })() : undefined;
  return {
    provider, source, windows, ...(at === undefined ? {} : { at }), ...(statusOnly.length === 0 ? {} : { statusOnly }),
    ...(planType === undefined ? {} : { planType }), ...(limitReached === undefined ? {} : { limitReached }),
    ...(credits === undefined ? {} : { credits }), ...(note === undefined ? {} : { note }),
  };
}

export interface PlanAnswer {
  reading?: PlanReading;
  keep: boolean;
  notInstalled: boolean;
  failure?: string;
  retryAfterMs?: number;
  /** Present: the new state (JSON, size-capped). */
  state?: unknown;
  log: string[];
}

/** What a handler answered a `plan` call with, validated. */
export function cleanPlanReply(id: string, raw: unknown): PlanAnswer {
  const o = isObj(raw) ? raw : {};
  const reading = cleanReading(id, o.reading);
  const retry = finite(o.retryAfterMs);
  const failure = str(o.failure, 80);
  return {
    ...(reading === undefined ? {} : { reading }), keep: o.keep === true && reading !== undefined, notInstalled: o.notInstalled === true,
    ...(failure === undefined ? {} : { failure }),
    ...(retry === undefined || retry < 0 ? {} : { retryAfterMs: Math.min(retry, 7 * 24 * 3_600_000) }),
    ...("state" in o ? { state: cappedState(o.state) } : {}), log: logLines(o.log),
  };
}

export interface SpanAnswer { from: number; to: number; records: SourceRecord[] }

export interface IngestAnswer {
  records: SourceRecord[];
  replace: SpanAnswer[];
  /** undefined: leave the stored estimates. */
  estimates?: SourceRecord[];
  more: boolean;
  notInstalled: boolean;
  /** `"keep"`: the stored state stays. */
  state: unknown | "keep";
  history?: Record<string, unknown>;
  log: string[];
}

/** A record as a source gives it, validated (numbers whole and non-negative, strings capped). */
export interface SourceRecord {
  dedupe: string;
  at: number;
  sessionId?: string;
  mode?: string;
  provider?: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  costUsd?: number;
  priceAs?: { provider?: string; model: string };
  usdPerToken?: number;
  noPrice?: boolean;
  synthetic?: boolean;
}

export function cleanRecord(raw: unknown): SourceRecord | undefined {
  if (!isObj(raw)) return undefined;
  const dedupe = str(raw.dedupe, 300);
  const model = str(raw.model, 200);
  const at = finite(raw.at);
  if (dedupe === undefined || model === undefined || at === undefined || at < 0) return undefined;
  const sessionId = str(raw.sessionId, 200);
  const mode = str(raw.mode, 40);
  const provider = str(raw.provider, 80);
  const cost = finite(raw.costUsd);
  const perToken = finite(raw.usdPerToken);
  const pa = isObj(raw.priceAs) ? raw.priceAs : undefined;
  const paModel = pa === undefined ? undefined : str(pa.model, 200);
  const paProvider = pa === undefined ? undefined : str(pa.provider, 80);
  const w1 = count(raw.cacheWrite1h);
  const reasoning = count(raw.reasoning);
  return {
    dedupe, at, model, input: count(raw.input), output: count(raw.output), cacheRead: count(raw.cacheRead), cacheWrite: count(raw.cacheWrite),
    ...(sessionId === undefined ? {} : { sessionId }), ...(mode === undefined ? {} : { mode }), ...(provider === undefined ? {} : { provider }),
    ...(w1 > 0 ? { cacheWrite1h: w1 } : {}), ...(reasoning > 0 ? { reasoning } : {}),
    ...(cost === undefined || cost < 0 ? {} : { costUsd: cost }), ...(perToken === undefined || perToken <= 0 ? {} : { usdPerToken: perToken }),
    ...(paModel === undefined ? {} : { priceAs: { model: paModel, ...(paProvider === undefined ? {} : { provider: paProvider }) } }),
    ...(raw.noPrice === true ? { noPrice: true } : {}), ...(raw.synthetic === true ? { synthetic: true } : {}),
  };
}

function cleanRecords(v: unknown, max: number): SourceRecord[] {
  if (!Array.isArray(v)) return [];
  const out: SourceRecord[] = [];
  for (const r of v.slice(0, max)) { const c = cleanRecord(r); if (c !== undefined) out.push(c); }
  return out;
}

function logLines(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((l): l is string => typeof l === "string").slice(0, 20).map((l) => l.slice(0, 300)) : [];
}

/** State is JSON the source keeps between calls; over the cap it is dropped (the source starts over) rather than stored. */
function cappedState(v: unknown): unknown {
  try {
    const text = JSON.stringify(v ?? null);
    return text.length > MAX_STATE_BYTES ? null : (JSON.parse(text) as unknown);
  } catch { return null; }
}

export function cleanIngestReply(raw: unknown): IngestAnswer {
  const o = isObj(raw) ? raw : {};
  const replace: SpanAnswer[] = [];
  if (Array.isArray(o.replace)) {
    for (const s of o.replace.slice(0, MAX_REPLACE_SPANS)) {
      if (!isObj(s)) continue;
      const from = finite(s.from);
      const to = finite(s.to);
      if (from === undefined || to === undefined || to <= from) continue;
      replace.push({ from, to, records: cleanRecords(s.records, MAX_RECORDS_PER_CALL) });
    }
  }
  const history = isObj(o.history) ? (cappedState(o.history) as Record<string, unknown> | null) ?? undefined : undefined;
  return {
    records: cleanRecords(o.records, MAX_RECORDS_PER_CALL), replace,
    ...(Array.isArray(o.estimates) ? { estimates: cleanRecords(o.estimates, MAX_ESTIMATES) } : {}),
    more: o.more === true, notInstalled: o.notInstalled === true,
    state: "state" in o ? cappedState(o.state) : "keep",
    ...(history === undefined ? {} : { history }), log: logLines(o.log),
  };
}

/** A record as a row the store takes: the price is the catalog's list price of the tokens, unless the tool recorded its
 *  own figure (`reported`), or the catalog has none and the tool gave a per-token cost; else unknown, never a guess. */
export function priceRecord(pricer: UsagePricer, source: string, r: SourceRecord): UsageRecordInput {
  const base = {
    dedupe: r.dedupe, source, at: r.at, ...(r.sessionId === undefined ? {} : { sessionId: r.sessionId }), ...(r.mode === undefined ? {} : { mode: r.mode }),
    ...(r.provider === undefined ? {} : { provider: r.provider }), model: r.model, input: r.input, output: r.output, cacheRead: r.cacheRead,
    cacheWrite: r.cacheWrite, ...(r.reasoning === undefined ? {} : { reasoning: r.reasoning }), ...(r.synthetic === true ? { synthetic: true } : {}),
  };
  if (r.noPrice === true) return { ...base, costBasis: "unknown" };
  const priceProvider = r.priceAs?.provider ?? r.provider;
  const priceModel = r.priceAs?.model ?? (r.provider !== undefined && r.model.startsWith(`${r.provider}/`) ? r.model.slice(r.provider.length + 1) : r.model);
  if (r.costUsd !== undefined) {
    return { ...base, costUsd: r.costUsd, costBasis: "reported", cacheSavingsUsd: pricer.savingsFor(priceProvider, priceModel, r.cacheRead) };
  }
  const priced = pricer.price(priceProvider, priceModel, {
    input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, ...(r.cacheWrite1h === undefined ? {} : { cacheWrite1h: r.cacheWrite1h }),
  });
  if (priced !== undefined) return { ...base, costUsd: priced.costUsd, costBasis: "estimate", cacheSavingsUsd: priced.cacheSavingsUsd };
  if (r.usdPerToken !== undefined) {
    return { ...base, costUsd: r.usdPerToken * (r.input + r.output + r.cacheRead + r.cacheWrite), costBasis: "estimate", cacheSavingsUsd: 0 };
  }
  return { ...base, costBasis: "unknown" };
}
