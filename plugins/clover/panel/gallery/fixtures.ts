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
    folders: [
      { name: "clover · ~/projects", path: "home/Studio/projects/clover" },
      { name: "keycaps", path: "home/Studio/projects/keycaps" },
    ],
    branch: "lane/f-m1",
    remote: { on: true, onToggle: noop },
    onSave: noop,
  },
  context: { used: 0.14, detail: "28,000 of 200,000 tokens. Older turns are summarized near the limit." },
  connectors: { total: 7, needSignIn: 2, onOpen: noop },
  outputs: {
    items: [
      { id: "o1", name: "Panel layout review", kind: "artifact" },
      { id: "o2", name: "Gallery screens, light and dark", kind: "artifact" },
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
    onCreatePr: noop,
    prs: [
      { id: "pr155", title: "F-M1: the conversation parts", repo: "clover", number: 155, state: "open" },
      { id: "pr152", title: "C0: rename to Clover", repo: "clover", number: 152, state: "merged" },
    ],
    onOpenPr: noop,
  },
};
