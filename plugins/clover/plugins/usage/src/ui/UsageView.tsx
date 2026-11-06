// The Usage section of Settings (spec §12): a `settings.section` entry. Over a period: the total, a chart of each
// day, a table grouped by source, model, bot or computer, and every plan reading. One series in the chart, so one
// hue and no legend; the table is the chart's numbers as text; plan states come with words, never colour alone.

import { useState, type ReactElement } from "react";
import {
  breakdown,
  compactCount,
  dayBars,
  formatCost,
  planRows,
  rangeOf,
  RANGES,
  totals,
  type GroupBy,
  type Metric,
  type PlanLevel,
  type UsageApi,
  type UsageRange,
} from "../model/usage";
import { t } from "../strings";
import { useUsageRead } from "./data";
import { useUsageStyles } from "./styles";

const GROUPINGS: readonly GroupBy[] = ["source", "model", "bot", "computer"];
const METRICS: readonly Metric[] = ["cost", "tokens"];

export interface UsageViewProps {
  api: UsageApi;
  now?: () => number;
  range?: UsageRange;
  metric?: Metric;
  by?: GroupBy;
  /** The gallery's: a day shown as under the pointer, by its index from the oldest. */
  hoveredDay?: number;
}

function Segments<T extends string>({ label, values, value, title, onChange }: { label: string; values: readonly T[]; value: T; title: (v: T) => string; onChange: (v: T) => void }): ReactElement {
  return (
    <div className="cl-usage__segments" role="group" aria-label={label}>
      {values.map((v) => (
        <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>
          {title(v)}
        </button>
      ))}
    </div>
  );
}

/** A small mark beside a plan's words when it nears or reaches its limit: the words say it, the mark backs them. */
function LevelGlyph({ level }: { level: PlanLevel }): ReactElement | null {
  if (level === "ok") return null;
  if (level === "out")
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M3.4 8.6 8.6 3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1.2 11 10.4H1z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6 4.6v2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="6" cy="8.7" r="0.75" fill="currentColor" />
    </svg>
  );
}

function shortDate(at: number): string {
  const d = new Date(at);
  return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCDate()}`;
}

export function UsageView(props: UsageViewProps): ReactElement {
  useUsageStyles();
  const { api, now = Date.now } = props;
  const [range, setRange] = useState<UsageRange>(props.range ?? "week");
  const [metric, setMetric] = useState<Metric>(props.metric ?? "cost");
  const [by, setBy] = useState<GroupBy>(props.by ?? "source");
  const [hovered, setHovered] = useState<number | null>(props.hoveredDay ?? null);

  const state = useUsageRead(
    api,
    async (a) => {
      const at = now();
      const period = rangeOf(range, at);
      const [days, groups, plans] = await Promise.all([a.summary({ ...period, groupBy: "day" }), a.summary({ ...period, groupBy: by }), a.plans()]);
      return { days, groups, plans, period, at };
    },
    `${range}:${by}`,
  );

  const filters = (
    <div className="cl-usage__filters">
      <Segments label={t("clover.usage.rangeLabel")} values={RANGES} value={range} title={(r) => t(`clover.usage.range.${r}`)} onChange={setRange} />
      <Segments label={t("clover.usage.metricLabel")} values={METRICS} value={metric} title={(m) => t(`clover.usage.metric.${m}`)} onChange={setMetric} />
      <Segments label={t("clover.usage.byLabel")} values={GROUPINGS} value={by} title={(b) => t(`clover.usage.by.${b}`)} onChange={setBy} />
    </div>
  );

  if (!state.data) {
    return (
      <div className="cl-usage">
        {filters}
        <p className="cl-usage__empty">{t(state.error ? "clover.usage.failed" : "clover.usage.loading")}</p>
      </div>
    );
  }

  const { days, groups, plans, period, at } = state.data;
  const sum = totals(groups);
  const bars = dayBars(days, period.from, period.to, metric);
  const max = Math.max(...bars.map((b) => b.value), 0);
  const rows = breakdown(groups, by, metric);
  const plansShown = planRows(plans, at);
  const amount = (v: number) => (metric === "cost" ? formatCost(v) : t("clover.usage.tokens", { count: compactCount(v) }));
  const hero = metric === "cost" ? formatCost(sum.costUsd) : t("clover.usage.tokens", { count: compactCount(sum.inputTokens + sum.outputTokens) });

  return (
    <div className="cl-usage">
      {filters}

      <div className="cl-usage__totals">
        <span className="cl-usage__hero">{hero}</span>
        <span className="cl-usage__muted">
          {t("clover.usage.totalIn", { count: compactCount(sum.inputTokens) })} · {t("clover.usage.totalOut", { count: compactCount(sum.outputTokens) })}
          {metric === "tokens" && sum.costUsd !== undefined ? ` · ${formatCost(sum.costUsd)}` : ""}
        </span>
        {metric === "cost" && sum.partlyPriced ? <span className="cl-usage__muted">{t("clover.usage.partlyPriced")}</span> : null}
      </div>

      {groups.length === 0 ? (
        <p className="cl-usage__empty">{t("clover.usage.none")}</p>
      ) : (
        <>
          <section className="cl-usage__chart" aria-label={t(`clover.usage.perDay.${metric}`)}>
            <h4 className="cl-usage__subhead">{t(`clover.usage.perDay.${metric}`)}</h4>
            <div className="cl-usage__plot" role="list" onMouseLeave={() => setHovered(null)}>
              {bars.map((bar, i) => {
                const words = t("clover.usage.dayTip", { date: shortDate(bar.at), amount: amount(bar.value) });
                return (
                  <div key={bar.key} className="cl-usage__day" role="listitem" aria-label={words} data-hovered={hovered === i || undefined} onMouseEnter={() => setHovered(i)}>
                    <span style={{ height: max > 0 && bar.value > 0 ? `max(${(bar.value / max) * 100}%, 2px)` : 0 }} />
                  </div>
                );
              })}
              {hovered !== null && bars[hovered] ? (
                <div className="cl-usage__tip" style={{ left: `${((hovered + 0.5) / bars.length) * 100}%` }}>
                  {t("clover.usage.dayTip", { date: shortDate(bars[hovered]!.at), amount: amount(bars[hovered]!.value) })}
                </div>
              ) : null}
            </div>
            <div className="cl-usage__axis" aria-hidden="true">
              <span>{bars[0] ? shortDate(bars[0].at) : ""}</span>
              <span>{bars.length > 1 ? shortDate(bars[bars.length - 1]!.at) : ""}</span>
            </div>
          </section>

          <section aria-label={t(`clover.usage.by.${by}`)}>
            <table className="cl-usage__table">
              <thead>
                <tr>
                  <th scope="col">{t(`clover.usage.by.${by}`)}</th>
                  <th scope="col">{t("clover.usage.column.input")}</th>
                  <th scope="col">{t("clover.usage.column.output")}</th>
                  <th scope="col">{t("clover.usage.column.cost")}</th>
                  <th scope="col">{t("clover.usage.column.share")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td title={row.title}>{row.title}</td>
                    <td>{compactCount(row.inputTokens)}</td>
                    <td>{compactCount(row.outputTokens)}</td>
                    <td>{formatCost(row.costUsd)}</td>
                    <td>
                      <span className="cl-usage__share" aria-hidden="true">
                        <span style={{ width: `${row.share * 100}%` }} />
                      </span>
                      {Math.round(row.share * 100)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      <section aria-label={t("clover.usage.plans")}>
        <h4 className="cl-usage__subhead">{t("clover.usage.plans")}</h4>
        {plansShown.length === 0 ? <p className="cl-usage__empty">{t("clover.usage.noPlans")}</p> : null}
        <div className="cl-usage__plans">
          {plansShown.map((row) => (
            <div key={row.id} className="cl-usage__plan" data-stale={row.stale || undefined}>
              <span>
                {row.title} <span className="cl-usage__muted">· {row.side}</span>
              </span>
              <span className="cl-usage__status">
                <LevelGlyph level={row.level} />
                {row.status}
              </span>
              <span className="cl-usage__meter" data-level={row.level} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(row.fraction * 100)} aria-label={`${row.title}, ${row.side}`}>
                <span style={{ width: `${row.fraction * 100}%` }} />
              </span>
              {row.detail ? <span className="cl-usage__muted">{row.detail}</span> : null}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
