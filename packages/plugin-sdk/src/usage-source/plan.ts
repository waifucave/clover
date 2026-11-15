import type { PlanWindow, PlanWindowKind } from "./types";

// The pure helpers every source's plan reading uses, and the core's own judging of one: a window's stable key and its
// staleness (spec §12 "Usage sources").

/** PURE: a window kind from its length (300 min = 5 h, 10 080 = a week). */
export function kindOfMinutes(minutes: number | undefined): PlanWindowKind {
  if (minutes === 300) return "five_hour";
  if (minutes === 10_080) return "weekly";
  return "other";
}

/** The model families a scope is keyed by. */
export const PLAN_SCOPE_FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;

/** PURE: a scope's key: the model family it names ("Claude Opus 4.5", "opus", "seven_day_opus" gives "opus"), else the
 *  scope itself, trimmed and lower-cased ("Gemini" gives "gemini"). */
export function planScopeKey(scope: string): string {
  const lower = scope.trim().toLowerCase();
  return PLAN_SCOPE_FAMILIES.find((f) => lower.includes(f)) ?? lower;
}

/** PURE: a window's stable key: its kind and, when it has one, its scope (lower-cased): the same window whichever rung
 *  read it and whatever index the tool gave it ("five_hour", "weekly", "weekly_scoped:fable", "weekly:gemini"). A window
 *  of another length adds its minutes ("other@1440"). */
export function planWindowKey(w: Pick<PlanWindow, "kind" | "scope" | "windowMinutes">): string {
  const base = w.kind === "other" && w.windowMinutes !== undefined ? `other@${Math.round(w.windowMinutes)}` : w.kind;
  const scope = w.scope === undefined ? "" : planScopeKey(w.scope);
  return scope.length === 0 ? base : `${base}:${scope}`;
}

/**
 * PURE: the staleness rule. A reading is stale when it was measured longer ago than its own window (it can no longer
 * describe that window), or when its reset time has passed (the window it describes is over).
 */
export function staleness(at: number | undefined, windowMinutes: number | undefined, resetsAt: number | undefined, now: number):
  { stale: boolean; staleReason?: "older_than_window" | "reset_passed" } {
  if (resetsAt !== undefined && resetsAt <= now) return { stale: true, staleReason: "reset_passed" };
  if (at !== undefined && windowMinutes !== undefined && windowMinutes > 0 && now - at > windowMinutes * 60_000) {
    return { stale: true, staleReason: "older_than_window" };
  }
  return { stale: false };
}

export const percentOf = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : undefined;

/** PURE: seconds or ms or ISO as epoch ms. */
export function resetMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === "string" && v.length > 0) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

export const shortStr = (v: unknown, max = 64): string | undefined => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined);

/** PURE: an ISO timestamp (or epoch number) as epoch ms. */
export const timeOf = resetMs;

export const tokenCount = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
