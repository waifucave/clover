// Clover protocol area: usage (spec §12 "Usage tracking", §5.8). Owner: lane D (`packages/core/src/usage/`); the
// island's Usage tab and the usage views are lane G's. Pinned by lane B at M0.
//
// The core counts Clover's own turns. Each computer reads its own apps' usage (Codex, Claude Code, OpenCode,
// Antigravity) and syncs append-only rows to the main. The readers take only numbers, never content. Plugins with
// `usage.read` read rows and plan readings.
import { z } from "zod";
import { BotId, ComputerName, Cursor, Empty, SessionId, Timestamp } from "./common";
import { coreEvent, defineEvent, defineMethod } from "./rpc";

export const UsageSource = z.enum(["clover", "codex", "claude-code", "opencode", "antigravity"]);
export type UsageSource = z.infer<typeof UsageSource>;

export const UsageRow = z.object({
  /** Unique per computer: `<computer>:<n>`, so rows synced from several computers never clash. */
  id: z.string().min(1).max(200),
  computer: ComputerName,
  source: UsageSource,
  at: Timestamp,
  provider: z.string().max(128).optional(),
  model: z.string().max(200).optional(),
  bot: BotId.optional(),
  session: SessionId.optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  /** What the catalog prices it at; absent for a subscription or an unpriced model. */
  costUsd: z.number().nonnegative().optional(),
});
export type UsageRow = z.infer<typeof UsageRow>;

/** A plan reading from one of the user's own apps, by its own install (Winter's plan usage readers). */
export const PlanReading = z.object({
  source: UsageSource,
  computer: ComputerName,
  plan: z.string().max(128),
  window: z.string().max(32),
  usedPercent: z.number().min(0).max(1000),
  resetsAt: Timestamp.optional(),
  readAt: Timestamp,
});
export type PlanReading = z.infer<typeof PlanReading>;

const Read = { roles: ["app", "cli", "layer", "plugin-host"] as const, capability: "usage.read" };

export const USAGE_METHODS = {
  usageRows: defineMethod({
    name: "usage.rows", owner: "D", ...Read,
    params: z.object({
      since: Timestamp, until: Timestamp.optional(), computer: ComputerName.optional(), source: UsageSource.optional(),
      cursor: Cursor.optional(), limit: z.number().int().min(1).max(10_000).optional(),
    }),
    result: z.object({ rows: z.array(UsageRow), next: Cursor.optional() }),
    doc: "Usage rows from every computer, oldest first.",
  }),
  usagePlans: defineMethod({
    name: "usage.plans", owner: "D", ...Read,
    params: Empty, result: z.object({ readings: z.array(PlanReading) }),
    doc: "The latest plan reading of each of the user's apps on each computer.",
  }),
  usageSummary: defineMethod({
    name: "usage.summary", owner: "D", roles: ["app", "cli", "remote", "layer", "plugin-host"], capability: "usage.read",
    params: z.object({ from: Timestamp, to: Timestamp, groupBy: z.enum(["source", "model", "bot", "computer", "day"]) }),
    result: z.object({
      groups: z.array(z.object({
        key: z.string().max(256),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        costUsd: z.number().nonnegative().optional(),
      })),
    }),
    doc: "Totals over a period, grouped, for the island's Usage tab and the usage views.",
  }),
} as const;

export const UsageChangedEvent = coreEvent("usage_changed", { since: Timestamp });
export const PlanAlarmEvent = coreEvent("plan_alarm", { reading: PlanReading, threshold: z.number().min(0).max(1000) });

export const USAGE_EVENTS = {
  usageChanged: defineEvent({
    type: "usage_changed", owner: "D", ...Read, schema: UsageChangedEvent,
    fixture: { type: "usage_changed", ts: 1781270000000, since: 1781269000000 },
    doc: "New usage rows arrived; views re-read from `since`.",
  }),
  planAlarm: defineEvent({
    type: "plan_alarm", owner: "D", roles: ["app", "remote"], schema: PlanAlarmEvent,
    fixture: { type: "plan_alarm", ts: 1781270000000, threshold: 90, reading: { source: "codex", computer: "Studio", plan: "pro", window: "5h", usedPercent: 91.5, resetsAt: 1781280000000, readAt: 1781270000000 } },
    doc: "A plan reading crossed an alarm the user set.",
  }),
} as const;
