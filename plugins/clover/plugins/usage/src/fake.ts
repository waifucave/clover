// An in-memory `usage.read`, for the gallery and the tests: the rows and readings lane D's core will serve, summed the
// way `usage.summary` sums them (`day` is the UTC date; no bot or session groups under `-`). Replaced by the plugin
// API's `usage` once lane E's runtime hands it to components.

import type { GroupBy, PlanReading, UsageApi, UsageGroup, UsageRow } from "./model/usage";

export interface MemoryUsage extends UsageApi {
  /** Adds rows and tells the watchers, as `usage_changed` does. */
  add(rows: readonly UsageRow[]): void;
  setPlans(readings: readonly PlanReading[]): void;
}

function keyOf(row: UsageRow, by: GroupBy): string {
  switch (by) {
    case "source": return row.source;
    case "model": return row.model ?? "-";
    case "bot": return row.bot ?? "-";
    case "computer": return row.computer;
    case "session": return row.session ?? "-";
    case "day": return new Date(row.at).toISOString().slice(0, 10);
  }
}

export function memoryUsage(rows: readonly UsageRow[] = [], plans: readonly PlanReading[] = []): MemoryUsage {
  let all = [...rows];
  let readings = [...plans];
  const listeners = new Set<(since: number) => void>();
  return {
    async rows(q) {
      const list = all
        .filter((r) => r.at >= q.since && (q.until === undefined || r.at < q.until) && (!q.computer || r.computer === q.computer) && (!q.source || r.source === q.source) && (!q.bot || r.bot === q.bot) && (!q.session || r.session === q.session))
        .sort((a, b) => a.at - b.at);
      return { rows: list.slice(0, q.limit ?? 1000) };
    },
    async plans() {
      return [...readings];
    },
    async summary(q) {
      const groups = new Map<string, UsageGroup>();
      for (const r of all) {
        if (r.at < q.from || r.at >= q.to || (q.bot && r.bot !== q.bot) || (q.session && r.session !== q.session)) continue;
        const key = keyOf(r, q.groupBy);
        const g = groups.get(key) ?? { key, inputTokens: 0, outputTokens: 0 };
        g.inputTokens += r.inputTokens;
        g.outputTokens += r.outputTokens;
        if (r.costUsd !== undefined) g.costUsd = (g.costUsd ?? 0) + r.costUsd;
        groups.set(key, g);
      }
      return [...groups.values()];
    },
    watch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    add(more) {
      all = [...all, ...more];
      const since = Math.min(...more.map((r) => r.at));
      for (const l of listeners) l(since);
    },
    setPlans(next) {
      readings = [...next];
      for (const l of listeners) l(Date.now());
    },
  };
}
