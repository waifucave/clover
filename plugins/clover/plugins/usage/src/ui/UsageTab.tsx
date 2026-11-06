// The island's Usage tab (spec §8, §12): an `island.tab` entry. Each plan the user's own apps report, the fullest
// first, with a thin bar, how much is used in words and when it resets; then today's usage by source. In the
// island's row language (`LiftRow`, `GroupTitle`): quiet at rest, the details under the pointer.

import { useState, type ReactElement } from "react";
import { EmptyTab, GroupTitle, LiftRow, RowWords, StatusWord, TabScroll, type StatusMark } from "@waifucave/clover-plugin-island";
import { amountWords, planRows, sourceTitle, startOfDay, tokensOf, totals, type PlanLevel, type UsageApi } from "../model/usage";
import { t } from "../strings";
import { useUsageRead } from "./data";
import { useUsageStyles } from "./styles";

const LEVEL_COLOR: Record<PlanLevel, string> = {
  ok: "var(--clover-island-working, #4180E3)",
  near: "var(--clover-island-attention, #FFC747)",
  high: "var(--clover-island-danger, #FF6B70)",
  out: "var(--clover-island-danger, #FF6B70)",
};

export interface UsageTabProps {
  api: UsageApi;
  now?: () => number;
  /** Opens the Usage section of Settings. */
  onOpenDetails?: () => void;
  /** The gallery's: a row shown as under the pointer. */
  hovered?: string;
}

export function UsageTab({ api, now = Date.now, onOpenDetails, hovered: initial }: UsageTabProps): ReactElement {
  useUsageStyles();
  const [hovered, setHovered] = useState<string | null>(initial ?? null);
  const state = useUsageRead(
    api,
    async (a) => {
      const at = now();
      const [plans, today] = await Promise.all([a.plans(), a.summary({ from: startOfDay(at), to: at, groupBy: "source" })]);
      return { plans, today, at };
    },
    "island-tab",
  );
  if (!state.data) return <EmptyTab line={t(state.error ? "clover.usage.failed" : "clover.usage.loading")} />;
  const { plans, today, at } = state.data;
  if (plans.length === 0 && today.length === 0) return <EmptyTab line={t("clover.usage.none")} />;
  const rows = planRows(plans, at);
  const sources = [...today].sort((a, b) => tokensOf(b) - tokensOf(a));
  const hover = (id: string) => (on: boolean) => setHovered(on ? id : null);
  return (
    <TabScroll>
      <div className="clv-rows">
        {rows.length > 0 ? <GroupTitle title={t("clover.usage.plans")} /> : null}
        {rows.map((row) => {
          const mark: StatusMark = { kind: "dot", color: LEVEL_COLOR[row.level] };
          return (
            <LiftRow
              key={row.id}
              title={row.title}
              side={row.side}
              quiet={row.stale}
              hovered={hovered === row.id}
              onHover={hover(row.id)}
              trailing={<StatusWord mark={mark} word={row.status} />}
              below={
                <span className="clv-usage-plan">
                  <span className="clv-usage-bar" data-level={row.level} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(row.fraction * 100)} aria-label={`${row.title}, ${row.side}`}>
                    <span style={{ width: `${row.fraction * 100}%` }} />
                  </span>
                  {(hovered === row.id || row.stale) && row.detail ? <RowWords text={row.detail} /> : null}
                </span>
              }
            />
          );
        })}
        <GroupTitle title={t("clover.usage.today")} meta={sources.length > 0 ? amountWords(totals(sources)) : undefined} />
        {sources.length === 0 ? <RowWords text={t("clover.usage.noneToday")} /> : null}
        {sources.map((g) => (
          <LiftRow
            key={g.key}
            title={sourceTitle(g.key)}
            hovered={hovered === `today:${g.key}`}
            onHover={hover(`today:${g.key}`)}
            trailing={<span className="clv-status-word">{amountWords(g)}</span>}
            onClick={onOpenDetails}
          />
        ))}
      </div>
    </TabScroll>
  );
}
