// What a `usage.sources` entry's handler is called with and answers (spec §12 "Usage sources"). The Usage plugin
// declares the point; a plugin that reads a tool installed on the computer (Codex, Claude Code, OpenCode, Antigravity,
// or any other) fills it, from a folder, with no change outside that folder. The core calls the handler on THIS computer
// only, for a plan reading (`plan`) and for the numbers the tool's own files hold (`ingest`).
//
// The core owns what is general: when to ask (a throttle, one call at a time, the last good reading kept across a
// failed call and a restart), the price of a record (the catalog's), the store, the staleness verdict and the alarms.
// The source owns what is the tool's: which of its programs and files to read, how, and in what order (its ladder),
// and what it must remember between calls (`state`, handed back to it as it left it, kept by the core).
//
// A source never reads the tool's tokens: it asks the tool's own program (`api.outside.run`, named in `host.outside`)
// or reads the numbers in the tool's own session files. The plugin fence keeps every sign-in file unreadable inside a
// folder the source names.

import type { HandlerContext } from "../api/plugin-api";

export type PlanWindowKind = "five_hour" | "weekly" | "weekly_scoped" | "other";

/** One window of a plan: how full it is, and when it resets. */
export interface PlanWindow {
  id: string;
  kind: PlanWindowKind;
  /** The window's length when the tool said it. */
  windowMinutes?: number;
  /** 0 to 100. */
  usedPercent: number;
  /** Epoch ms. */
  resetsAt?: number;
  /** A per-model window's model, or the model group a window belongs to. */
  scope?: string;
  /** The tool's own severity word, when it gave one. */
  severity?: string;
  /** The reader's verdict when it read (`staleness`); the core judges it again each time it answers. */
  stale: boolean;
  staleReason?: "older_than_window" | "reset_passed";
  /** Set by the core on every reading it answers. */
  windowKey?: string;
}

/** A status-only window (no percentage): what MOSS's own sessions reported about a provider's limits. */
export interface PlanStatusWindow {
  rateLimitType?: string;
  status: string;
  resetsAt?: number;
  at: number;
}

/** A plan reading, as a source gives it. `source` names the rung that answered (`"codex-app-server"`, any short
 *  lower-case word of the source's own). */
export interface UsagePlanReading {
  source: string;
  /** When the numbers were measured (epoch ms): a call's time, or the record's own time. */
  at?: number;
  windows: PlanWindow[];
  statusOnly?: PlanStatusWindow[];
  planType?: string;
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string };
  limitReached?: string;
  /** Why a rung could not answer, in words safe to show (never content from another app's file). */
  note?: string;
}

export interface UsagePlanArgs {
  /** The core's clock, epoch ms. */
  now: number;
  /** The last good reading the core kept for this source (`keep`), for a ladder's "newer of the two". */
  kept?: UsagePlanReading;
  /** What MOSS's own sessions reported about limits, by name (`"codex-oauth"`): data the source may use as a last rung. */
  reports: Readonly<Record<string, readonly PlanStatusWindow[]>>;
  /** What the source gave back last time (`state`); undefined the first time. */
  state?: unknown;
}

export interface UsagePlanReply {
  reading?: UsagePlanReading;
  /** The core keeps this reading as the source's last good one (across a failed call and a restart): only a reading the
   *  tool itself gave, not one read from a file it left behind. */
  keep?: boolean;
  /** The tool is not on this computer: the source has no slot at all. */
  notInstalled?: true;
  /** Why there is no reading, in a few words safe to log (never content from another app's file). */
  failure?: string;
  /** Not called again for a plan reading before this many ms (a program that outlived its own timeout). */
  retryAfterMs?: number;
  /** Replaces the stored state; omitted, it stays. */
  state?: unknown;
  /** Lines for the core's log, each a few words with no content of the tool's. */
  log?: readonly string[];
}

/** One usage record: numbers, a model, a provider, a time and an opaque id, nothing else from the tool's files. The
 *  core prices it (the catalog's list price) unless the tool recorded its own figure (`costUsd`). */
export interface UsageRecord {
  /** Never counted twice: a record whose `dedupe` the store knows is skipped. */
  dedupe: string;
  /** Epoch ms. */
  at: number;
  sessionId?: string;
  mode?: string;
  provider?: string;
  model: string;
  /** Tokens in MOSS's shape: `input` EXCLUDES cache reads and writes. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The one-hour-lifetime SUBSET of `cacheWrite`. */
  cacheWrite1h?: number;
  reasoning?: number;
  /** The figure the tool itself recorded, taken as it is (its row is "reported"). */
  costUsd?: number;
  /** The catalog name to price (or take cache savings for) when it differs from `provider` and `model`. */
  priceAs?: { provider?: string; model: string };
  /** When the catalog has no price for the model: this much per token (the tool's own per-token cost). */
  usdPerToken?: number;
  /** Never priced, not even at the catalog's price (tokens whose split is not known). */
  noPrice?: boolean;
  /** A row estimated from a summary, not read from a record (shown as an estimate). */
  synthetic?: boolean;
}

/** What the core's store already holds for this source, so a source can tell what a summary still lacks. */
export interface UsageStored {
  /** The records that were read (not estimated), summed per UTC day (`YYYY-MM-DD`) and model: `all` counts the four
   *  kinds of tokens, `io` input and output only. */
  days: ReadonlyArray<{ day: string; model: string; all: number; io: number }>;
  /** The oldest record that was read, epoch ms. */
  firstAt?: number;
}

export interface UsageIngestArgs {
  now: number;
  /** What the source gave back last time (`state`); undefined the first time. */
  state?: unknown;
  /** The first time only: what the core's store held for this source before its state moved to the source (its read
   *  offsets and progress records, by key, each with `inode`, `offset`, `state` and `updatedAt`). */
  legacy?: Readonly<Record<string, { inode: number; offset: number; state: Record<string, unknown>; updatedAt: number }>>;
  stored: UsageStored;
}

export interface UsageIngestReply {
  /** The tool is not on this computer: the Usage settings do not offer its switch. */
  notInstalled?: true;
  /** New records to add (a record the store knows is skipped). */
  records?: readonly UsageRecord[];
  /** Spans whose records are REPLACED as a whole (a day's total that grows through the day); written only when they
   *  differ from what is stored. */
  replace?: ReadonlyArray<{ from: number; to: number; records: readonly UsageRecord[] }>;
  /** The whole set of estimated rows (`synthetic`) the source wants stored now; the store makes its own match it,
   *  writing only what differs. Omitted: they stay as they are. */
  estimates?: readonly UsageRecord[];
  /** More is waiting (a budget ran out): the core asks again at once in a catch-up. */
  more?: boolean;
  /** Replaces the stored state, in the same step as the records; omitted, it stays. */
  state?: unknown;
  /** What the Usage surfaces say about where the history came from, by name (`claudeCodeStats`). */
  history?: Readonly<Record<string, unknown>>;
  log?: readonly string[];
}

/** What a `usage.sources` entry's handler exports: an object with either method (the entry's `provides` names which). */
export interface UsageSourceHandler {
  plan?(args: UsagePlanArgs, ctx: HandlerContext): UsagePlanReply | Promise<UsagePlanReply>;
  ingest?(args: UsageIngestArgs, ctx: HandlerContext): UsageIngestReply | Promise<UsageIngestReply>;
}
