// Lane D's methods of the protocol's usage area (packages/protocol/src/usage.ts): Clover's own rows, per bot and per
// session (`usageMethods`), and the user's own apps' plan readings (`usagePlansMethods`, over the inherited usage
// service's readers). Owner: lane D.
import { USAGE_METHODS } from "@waifucave/clover-protocol";
import { handler, type MethodHandler } from "../bots/rpc";
import type { UsageLedger } from "./ledger";
import { planWindowKey, staleness, type PlanReading as ServicePlanReading } from "./plan";
import type { PlanReading as WirePlanReading } from "@waifucave/clover-protocol";

export function usageMethods(deps: { ledger: UsageLedger }): Record<string, MethodHandler> {
  const M = USAGE_METHODS;
  return {
    [M.usageRows.name]: handler(M.usageRows, async (q) => deps.ledger.rows({
      since: q.since,
      ...(q.until === undefined ? {} : { until: q.until }),
      ...(q.computer === undefined ? {} : { computer: q.computer }),
      ...(q.source === undefined ? {} : { source: q.source }),
      ...(q.bot === undefined ? {} : { bot: q.bot }),
      ...(q.session === undefined ? {} : { session: q.session }),
      ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
      ...(q.limit === undefined ? {} : { limit: q.limit }),
    })),
    [M.usageSummary.name]: handler(M.usageSummary, async (q) => ({
      groups: deps.ledger.summary({
        from: q.from, to: q.to, groupBy: q.groupBy,
        ...(q.bot === undefined ? {} : { bot: q.bot }),
        ...(q.session === undefined ? {} : { session: q.session }),
      }),
    })),
  };
}

/** The plan readers `usage.plans` reads (the usage service's: each the user's own app, by its own install). */
export interface PlanReaders {
  codexPlan(): Promise<ServicePlanReading>;
  claudeCodePlan(): Promise<ServicePlanReading>;
  antigravityPlan(): Promise<ServicePlanReading>;
}

/** The sources that read nothing (the app isn't here, or the user turned it off). */
const NO_READING = new Set(["none", "disabled", "not-installed"]);

/** `usage.plans` (§12 "Usage"): the latest reading of each of the user's apps' plan windows on this computer, as the
 *  Usage tab and the island show them. A source that can't answer is left out, never an error.
 *
 *  It covers THIS computer only: the readers read the apps installed here, and `computer` names this one. Another
 *  computer's plans are that computer's own `usage.plans`; nothing here asks a peer or merges its readings. */
export function usagePlansMethods(deps: { readers: PlanReaders; computer(): string; now?(): number }): Record<string, MethodHandler> {
  const M = USAGE_METHODS;
  return {
    [M.usagePlans.name]: handler(M.usagePlans, async () => ({ readings: await planReadings(deps) })),
  };
}

export async function planReadings(deps: { readers: PlanReaders; computer(): string; now?(): number }): Promise<WirePlanReading[]> {
  const now = deps.now ?? (() => Date.now());
  const computer = deps.computer();
  const read = await Promise.all([
    // Each at the service's own pace (its throttle and its kept readings): asking never spawns an app every time.
    deps.readers.codexPlan().catch(() => undefined),
    deps.readers.claudeCodePlan().catch(() => undefined),
    deps.readers.antigravityPlan().catch(() => undefined),
  ]);
  const out: WirePlanReading[] = [];
  for (const r of read) {
    if (r === undefined || NO_READING.has(r.source)) continue;
    const readAt = r.at ?? now();
    for (const w of r.windows) {
      // Only a window still current: one whose reset has passed, or that was read longer ago than it lasts, describes
      // a window that is over, so it is left out rather than shown as now (the reader's verdict, and again at this
      // moment, since a kept reading ages).
      if (w.stale || staleness(readAt, w.windowMinutes, w.resetsAt, now()).stale) continue;
      out.push({
        source: r.provider,
        computer,
        plan: (r.planType ?? r.provider).slice(0, 128),
        window: (w.windowKey ?? planWindowKey(w)).slice(0, 32),
        usedPercent: Math.min(1000, Math.max(0, w.usedPercent)),
        ...(w.resetsAt === undefined ? {} : { resetsAt: Math.max(0, Math.round(w.resetsAt)) }),
        readAt: Math.max(0, Math.round(readAt)),
      });
    }
  }
  return out;
}
