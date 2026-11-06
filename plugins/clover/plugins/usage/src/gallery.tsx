// The usage plugin in every state, for lane G's gallery (rendered to PNGs in CI, never on a desk): the island's Usage
// tab in the open island, and the Usage section of Settings in light and dark. Sample data at a fixed "now".

import type { ReactElement, ReactNode } from "react";
import { IslandDesktop, ISLAND_TABS } from "@waifucave/clover-plugin-island/gallery";
import { NOTCH, NO_NOTCH } from "@waifucave/clover-plugin-island/fixtures";
import { OpenIsland, Strip, tabState } from "@waifucave/clover-plugin-island";
import { memoryUsage } from "./fake";
import { NOW, SAMPLE_PLANS, sampleRows } from "./fixtures";
import { UsageTab } from "./ui/UsageTab";
import { UsageView } from "./ui/UsageView";

export interface UsageStory {
  id: string;
  title: string;
  width: number;
  height: number;
  theme?: string;
  render: () => ReactNode;
  ready?: () => Promise<void>;
}

const ROWS = sampleRows();
const now = () => NOW;
/** The reads are promises: a few frames for them to answer and the view to draw. */
const loaded = () => new Promise<void>((resolve) => setTimeout(resolve, 150));
const USAGE_INDEX = ISLAND_TABS.findIndex((tab) => tab.id === "usage");

function SettingsPage({ children }: { children: ReactNode }): ReactElement {
  return (
    <div style={{ boxSizing: "border-box", width: "100%", height: "100%", padding: 24, background: "var(--clover-color-surface, #FFFFFF)", overflow: "hidden" }}>
      <h3 style={{ margin: "0 0 12px", font: "400 15px var(--clover-font-sans, system-ui, sans-serif)", color: "var(--clover-color-text, #1C1B22)" }}>Usage</h3>
      {children}
    </div>
  );
}

export const USAGE_STORIES: UsageStory[] = [
  {
    id: "usage/island-tab",
    title: "Island: Usage, the plans the fullest first, then today by source; one plan under the pointer",
    width: 640,
    height: 220,
    ready: loaded,
    render: () => (
      <IslandDesktop shape={NOTCH} width={640} height={220}>
        <Strip shape={NOTCH} counts={{ waiting: 0, working: 1 }} />
        <OpenIsland shape={NOTCH} tabs={tabState(ISLAND_TABS, USAGE_INDEX)}>
          <UsageTab api={memoryUsage(ROWS, SAMPLE_PLANS)} now={now} hovered="Studio:codex:Pro:5h" />
        </OpenIsland>
      </IslandDesktop>
    ),
  },
  {
    id: "usage/island-tab-no-plans",
    title: "Island: Usage with no plan read yet, on a screen with no housing",
    width: 640,
    height: 220,
    ready: loaded,
    render: () => (
      <IslandDesktop shape={NO_NOTCH} width={640} height={220}>
        <OpenIsland shape={NO_NOTCH} tabs={tabState(ISLAND_TABS, USAGE_INDEX)}>
          <UsageTab api={memoryUsage(ROWS, [])} now={now} />
        </OpenIsland>
      </IslandDesktop>
    ),
  },
  {
    id: "usage/island-tab-empty",
    title: "Island: Usage before anything was used",
    width: 640,
    height: 220,
    ready: loaded,
    render: () => (
      <IslandDesktop shape={NOTCH} width={640} height={220}>
        <OpenIsland shape={NOTCH} tabs={tabState(ISLAND_TABS, USAGE_INDEX)}>
          <UsageTab api={memoryUsage()} now={now} />
        </OpenIsland>
      </IslandDesktop>
    ),
  },
  {
    id: "usage/settings-week-light",
    title: "Settings → Usage: 7 days by source, cost, light; a day under the pointer",
    width: 720,
    height: 760,
    theme: "base-light",
    ready: loaded,
    render: () => (
      <SettingsPage>
        <UsageView api={memoryUsage(ROWS, SAMPLE_PLANS)} now={now} hoveredDay={5} />
      </SettingsPage>
    ),
  },
  {
    id: "usage/settings-month-models-dark",
    title: "Settings → Usage: 30 days by model, tokens, dark",
    width: 720,
    height: 820,
    theme: "base-dark",
    ready: loaded,
    render: () => (
      <SettingsPage>
        <UsageView api={memoryUsage(ROWS, SAMPLE_PLANS)} now={now} range="month" metric="tokens" by="model" />
      </SettingsPage>
    ),
  },
  {
    id: "usage/settings-bots-light",
    title: "Settings → Usage: 30 days by bot, cost (a row with no bot is the user's own apps)",
    width: 720,
    height: 700,
    theme: "base-light",
    ready: loaded,
    render: () => (
      <SettingsPage>
        <UsageView api={memoryUsage(ROWS, SAMPLE_PLANS)} now={now} range="month" by="bot" />
      </SettingsPage>
    ),
  },
  {
    id: "usage/settings-empty-dark",
    title: "Settings → Usage: nothing used yet, no plans, dark",
    width: 720,
    height: 260,
    theme: "base-dark",
    ready: loaded,
    render: () => (
      <SettingsPage>
        <UsageView api={memoryUsage()} now={now} />
      </SettingsPage>
    ),
  },
];
