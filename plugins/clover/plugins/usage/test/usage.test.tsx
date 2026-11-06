import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  agoWords,
  amountWords,
  breakdown,
  compactCount,
  dayBars,
  formatCost,
  inWords,
  planLevel,
  planRows,
  rangeOf,
  sourceTitle,
  startOfDay,
  totals,
  windowTitle,
  type UsageApi,
  type UsageGroup,
} from "../src/model/usage";
import { memoryUsage } from "../src/fake";
import { NOW, SAMPLE_PLANS, sampleRows } from "../src/fixtures";
import { UsageTab } from "../src/ui/UsageTab";
import { UsageView } from "../src/ui/UsageView";
import { UsageHostContext, UsageSection, UsageTabEntry } from "../src/ui/host";
import manifest from "../clover.json" with { type: "json" };
import * as client from "../client/index";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("words and numbers", () => {
  test("tokens as the eye reads them", () => {
    expect([0, 950, 1000, 1234, 9_999, 34_567, 999_950, 1_200_000, 3_400_000_000].map(compactCount)).toEqual(["0", "950", "1k", "1.2k", "9.9k", "34k", "999k", "1.2M", "3.4B"]);
  });

  test("cost: never more digits than it is worth; unpriced says so", () => {
    expect([0, 0.004, 0.42, 12.3, 1234.4].map(formatCost)).toEqual(["$0", "<$0.01", "$0.42", "$12.30", "$1,234"]);
    expect(formatCost(undefined)).toBe("not priced");
  });

  test("sources and windows by their names", () => {
    expect(sourceTitle("claude-code")).toBe("Claude Code");
    expect(sourceTitle("someone-else")).toBe("someone-else");
    expect(["5h", "weekly", "7d", "daily", "monthly", "session"].map(windowTitle)).toEqual(["5-hour", "Weekly", "Weekly", "Daily", "Monthly", "session"]);
  });

  test("relative times", () => {
    expect(inWords(NOW + 20_000, NOW)).toBe("in 1 min");
    expect(inWords(NOW + 45 * 60_000, NOW)).toBe("in 45 min");
    expect(inWords(NOW + 2 * HOUR, NOW)).toBe("in 2 h");
    expect(inWords(NOW + 2 * HOUR + 14 * 60_000, NOW)).toBe("in 2 h 14 min");
    expect(inWords(NOW + 3 * DAY, NOW)).toBe("in 3 days");
    expect(agoWords(NOW - 10_000, NOW)).toBe("just now");
    expect(agoWords(NOW - 9 * HOUR, NOW)).toBe("9 h ago");
    expect(agoWords(NOW - 2 * DAY, NOW)).toBe("2 days ago");
  });
});

describe("plans", () => {
  test("levels: within, nearing at 75%, high at 90%, out at 100%", () => {
    expect([0, 74.9, 75, 89, 90, 99.9, 100, 140].map(planLevel)).toEqual(["ok", "ok", "near", "near", "high", "high", "out", "out"]);
  });

  test("the fullest first, a stale reading last and quieter, with when it was read", () => {
    const rows = planRows(SAMPLE_PLANS, NOW);
    expect(rows.map((r) => [r.title, r.side, r.status, r.level])).toEqual([
      ["Claude Code · Max", "Weekly", "94% used", "high"],
      ["Codex · Pro", "5-hour", "81% used", "near"],
      ["Codex · Pro", "Weekly", "46% used", "ok"],
      ["Claude Code · Max", "5-hour", "23% used", "ok"],
      ["Antigravity · Free", "Daily", "Limit reached", "out"],
    ]);
    expect(rows[1]!.detail).toBe("Resets in 2 h 14 min");
    expect(rows[4]).toMatchObject({ stale: true, detail: "Read 9 h ago", fraction: 1 });
  });

  test("readings from two computers name the computer", () => {
    const rows = planRows([SAMPLE_PLANS[0]!, { ...SAMPLE_PLANS[0]!, computer: "Pocket laptop", usedPercent: 12 }], NOW);
    expect(rows.map((r) => r.side)).toEqual(["5-hour · Studio", "5-hour · Pocket laptop"]);
  });
});

describe("totals, days and the breakdown", () => {
  const groups: UsageGroup[] = [
    { key: "clover", inputTokens: 1000, outputTokens: 200, costUsd: 0.5 },
    { key: "codex", inputTokens: 5000, outputTokens: 800 },
    { key: "opencode", inputTokens: 100, outputTokens: 10, costUsd: 0.02 },
  ];

  test("a cost that leaves some groups unpriced is a floor, and says so", () => {
    expect(totals(groups)).toEqual({ inputTokens: 6100, outputTokens: 1010, costUsd: 0.52, partlyPriced: true });
    expect(totals([groups[1]!])).toEqual({ inputTokens: 5000, outputTokens: 800, costUsd: undefined, partlyPriced: false });
  });

  test("every day of the period, an empty one at 0, at most 60", () => {
    const bars = dayBars([{ key: "2026-11-04", inputTokens: 10, outputTokens: 5, costUsd: 1 }], NOW - 3 * DAY, NOW, "tokens");
    expect(bars.map((b) => [b.key, b.value])).toEqual([
      ["2026-11-02", 0],
      ["2026-11-03", 0],
      ["2026-11-04", 15],
      ["2026-11-05", 0],
    ]);
    expect(dayBars([], 0, NOW, "cost")).toHaveLength(60);
  });

  test("biggest first by the metric, shares summing to 1, the rest folded into Other", () => {
    const byCost = breakdown(groups, "source", "cost");
    expect(byCost.map((r) => r.title)).toEqual(["Clover", "OpenCode", "Codex"]);
    expect(byCost.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1);
    const byTokens = breakdown(groups, "source", "tokens");
    expect(byTokens.map((r) => r.key)).toEqual(["codex", "clover", "opencode"]);
    const many = Array.from({ length: 12 }, (_, i): UsageGroup => ({ key: `m${i}`, inputTokens: 100 * (12 - i), outputTokens: 0 }));
    const folded = breakdown(many, "model", "tokens", 8);
    expect(folded).toHaveLength(8);
    expect(folded.at(-1)).toMatchObject({ title: "5 others", inputTokens: 100 * (5 + 4 + 3 + 2 + 1) });
    expect(breakdown([{ key: "-", inputTokens: 1, outputTokens: 0 }], "bot", "tokens")[0]!.title).toBe("No bot");
  });

  test("ranges end now; a day's line", () => {
    expect(rangeOf("week", NOW)).toEqual({ from: NOW - 7 * DAY, to: NOW });
    expect(rangeOf("all", NOW)).toEqual({ from: 0, to: NOW });
    expect(amountWords({ inputTokens: 1_000_000, outputTokens: 200_000, costUsd: 3.4 })).toBe("1.2M tokens · $3.40");
    expect(amountWords({ inputTokens: 900, outputTokens: 0 })).toBe("900 tokens");
  });
});

describe("the in-memory usage.read", () => {
  test("sums the way usage.summary does, and tells the watchers about new rows", async () => {
    const rows = sampleRows();
    const api = memoryUsage(rows, SAMPLE_PLANS);
    const all = await api.summary({ from: 0, to: NOW + 1, groupBy: "source" });
    expect(all.reduce((s, g) => s + g.inputTokens, 0)).toBe(rows.reduce((s, r) => s + r.inputTokens, 0));
    expect(all.find((g) => g.key === "codex")?.costUsd).toBeUndefined();
    const bots = await api.summary({ from: 0, to: NOW + 1, groupBy: "bot" });
    expect(bots.map((g) => g.key).sort()).toEqual(["-", "alpha", "scout"]);
    let heard = 0;
    const stop = api.watch(() => heard++);
    api.add([{ id: "x:1", computer: "Studio", source: "clover", at: NOW, inputTokens: 1, outputTokens: 1 }]);
    stop();
    api.add([{ id: "x:2", computer: "Studio", source: "clover", at: NOW, inputTokens: 1, outputTokens: 1 }]);
    expect(heard).toBe(1);
  });
});

const settle = () => act(async () => {});

describe("the island's Usage tab", () => {
  test("plans with their bars and words, then today by source", async () => {
    const api = memoryUsage(sampleRows(), SAMPLE_PLANS);
    const { container } = render(<UsageTab api={api} now={() => NOW} />);
    await settle();
    expect([...container.querySelectorAll(".clv-group-title > span:first-child")].map((e) => e.textContent)).toEqual(["Plans", "Today"]);
    const meters = [...container.querySelectorAll(".clv-usage-bar")];
    expect(meters.map((m) => [m.getAttribute("data-level"), m.getAttribute("aria-valuenow")])).toEqual([
      ["high", "94"],
      ["near", "81"],
      ["ok", "46"],
      ["ok", "23"],
      ["out", "100"],
    ]);
    expect(screen.getByText("Limit reached")).toBeTruthy();
    // The stale reading says when it was read, at rest; a fresh one's reset shows under the pointer.
    expect(screen.getByText("Read 9 h ago")).toBeTruthy();
    expect(screen.queryByText("Resets in 2 h 14 min")).toBeNull();
    fireEvent.mouseEnter(meters[1]!.closest(".clv-row")!);
    expect(screen.getByText("Resets in 2 h 14 min")).toBeTruthy();
    const today = await api.summary({ from: startOfDay(NOW), to: NOW, groupBy: "source" });
    expect(container.querySelectorAll(".clv-row")).toHaveLength(5 + today.length);
  });

  test("re-reads when new usage arrives; nothing yet says so", async () => {
    const api = memoryUsage([], []);
    const { container } = render(<UsageTab api={api} now={() => NOW} />);
    await settle();
    expect(screen.getByText("No usage yet")).toBeTruthy();
    await act(async () => api.add([{ id: "x:1", computer: "Studio", source: "codex", at: NOW - 60_000, inputTokens: 1200, outputTokens: 300 }]));
    expect(container.querySelector(".clv-row .clv-row-title")?.textContent).toBe("Codex");
    expect(screen.getAllByText("1.5k tokens")).toHaveLength(2);
  });

  test("a read that fails says so", async () => {
    const api: UsageApi = { ...memoryUsage(), plans: () => Promise.reject(new Error("down")) };
    render(<UsageTab api={api} now={() => NOW} />);
    await settle();
    expect(screen.getByText("Usage could not be read")).toBeTruthy();
  });
});

describe("the Usage section of Settings", () => {
  test("the total, a bar a day with its words, the table, and the plans", async () => {
    const rows = sampleRows();
    const api = memoryUsage(rows, SAMPLE_PLANS);
    const { container } = render(<UsageView api={api} now={() => NOW} />);
    await settle();
    const week = rows.filter((r) => r.at >= NOW - 7 * DAY && r.at < NOW);
    const cost = week.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    expect(container.querySelector(".cl-usage__hero")?.textContent).toBe(formatCost(cost));
    // Codex and Claude Code run on plans, so the week's cost is a floor.
    expect(screen.getByText("Some of it is not priced: the cost is at least this")).toBeTruthy();
    const days = container.querySelectorAll(".cl-usage__day");
    expect(days).toHaveLength(8);
    expect(days[0]!.getAttribute("aria-label")).toMatch(/^Oct 29: \$\d+\.\d\d$/);
    expect(container.querySelectorAll(".cl-usage__table tbody tr").length).toBe(new Set(week.map((r) => r.source)).size);
    expect(container.querySelectorAll(".cl-usage__plan")).toHaveLength(5);
    expect(container.querySelector('.cl-usage__plan[data-stale="true"]')).toBeTruthy();
  });

  test("the period, the metric and the grouping change what it reads", async () => {
    const api = memoryUsage(sampleRows(), SAMPLE_PLANS);
    const { container } = render(<UsageView api={api} now={() => NOW} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "30 days" }));
    await settle();
    expect(container.querySelectorAll(".cl-usage__day")).toHaveLength(31);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await settle();
    expect(container.querySelector(".cl-usage__table th")?.textContent).toBe("Model");
    expect(screen.getByText("claude-sonnet-4-6")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tokens" }));
    await settle();
    expect(container.querySelector(".cl-usage__hero")?.textContent).toMatch(/ tokens$/);
    expect(screen.getByRole("button", { name: "Tokens" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("a bar under the pointer shows its day", async () => {
    const api = memoryUsage(sampleRows(), SAMPLE_PLANS);
    const { container } = render(<UsageView api={api} now={() => NOW} />);
    await settle();
    expect(container.querySelector(".cl-usage__tip")).toBeNull();
    const last = [...container.querySelectorAll(".cl-usage__day")].at(-1)!;
    fireEvent.mouseEnter(last);
    expect(container.querySelector(".cl-usage__tip")?.textContent).toBe(last.getAttribute("aria-label") ?? "");
  });
});

describe("the entries the manifest names", () => {
  test("every component is an export of the client entry, and the plugin asks only for usage.read", () => {
    for (const entry of manifest.contributes.ui) expect(typeof (client as Record<string, unknown>)[entry.component]).toBe("function");
    expect(manifest.capabilities).toEqual(["usage.read"]);
  });

  test("they read the host; without one they draw nothing", async () => {
    expect(render(<UsageTabEntry props={{ expanded: true }} />).container.innerHTML).toBe("");
    const api = memoryUsage(sampleRows(), SAMPLE_PLANS);
    const { container } = render(
      <UsageHostContext.Provider value={{ usage: api, now: () => NOW }}>
        <UsageTabEntry props={{ expanded: true }} />
        <UsageSection props={{}} />
      </UsageHostContext.Provider>,
    );
    await settle();
    expect(container.querySelector(".clv-usage-bar")).toBeTruthy();
    expect(container.querySelector(".cl-usage__hero")).toBeTruthy();
  });
});
