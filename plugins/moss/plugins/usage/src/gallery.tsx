// The usage plugin in every state, for lane G's gallery (rendered to PNGs in CI, never on a desk): the Usage section of
// Settings in light and dark (its Usage tab inside the open island is the look gallery's, which draws parts together). Sample data at a fixed "now".

import type { ReactElement, ReactNode } from "react";
import { memoryUsage } from "./fake";
import { NOW, SAMPLE_PLANS, sampleRows } from "./fixtures";
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

function SettingsPage({ children }: { children: ReactNode }): ReactElement {
  return (
    <div style={{ boxSizing: "border-box", width: "100%", height: "100%", padding: 24, background: "var(--moss-color-surface, #FFFFFF)", overflow: "hidden" }}>
      <h3 style={{ margin: "0 0 12px", font: "400 15px var(--moss-font-sans, system-ui, sans-serif)", color: "var(--moss-color-text, #1C1B22)" }}>Usage</h3>
      {children}
    </div>
  );
}

export const USAGE_STORIES: UsageStory[] = [
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
