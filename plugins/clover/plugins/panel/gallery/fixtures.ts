// Mock session data for the gallery and the tests.
import type { SessionViewProps } from "../client/types";

const noop = () => undefined;

export const SESSION: SessionViewProps = {
  agents: [
    { id: "agent-island", title: "Rebuild the island as a plugin", backend: "Codex", status: "running" },
    { id: "agent-lint", title: "Fix the lint warnings", backend: "OpenCode", status: "needs-you" },
  ],
  onOpenAgent: noop,
  environment: {
    computer: "Studio",
    here: true,
    level: { label: "Ask before risky", onChange: noop },
    folders: [
      { name: "clover · ~/projects", path: "/Users/sam/projects/clover" },
      { name: "garden-planner", path: "/Users/sam/projects/garden-planner" },
    ],
    branch: "lane/f-m1",
  },
  context: { used: 0.14, detail: "28,000 of 200,000 tokens. Older turns are summarized near the limit." },
  connectors: { total: 7, needSignIn: 2, onOpen: noop },
  outputs: {
    items: [
      { id: "o1", name: "Panel layout review", kind: "page" },
      { id: "o2", name: "Gallery screens, light and dark", kind: "page" },
      { id: "o3", name: "window-1440.png", kind: "image" },
      { id: "o4", name: "spots-for-lane-b.md", kind: "file" },
    ],
    onOpen: noop,
    more: 6,
    onShowMore: noop,
  },
  changes: {
    label: "lane/f-m1",
    added: 2844,
    removed: 365,
    files: 41,
    onOpenDiff: noop,
  },
};

/** A bot's slim column: its coding agents and tasks, its context and its outputs. */
export const BOT_COLUMN: SessionViewProps = {
  kind: "bot",
  agents: [
    { id: "agent-export", title: "Fix the CSV export's dates", backend: "Codex", status: "running" },
    { id: "task-digest", title: "Weekly notes digest", backend: "Task", status: "completed" },
  ],
  onOpenAgent: noop,
  context: { used: 0.31, detail: "62,000 of 200,000 tokens. Older turns are summarized near the limit." },
  outputs: {
    items: [
      { id: "b1", name: "This week in the clover repo", kind: "page" },
      { id: "b2", name: "garden-beds.csv", kind: "file" },
    ],
    onOpen: noop,
  },
};
