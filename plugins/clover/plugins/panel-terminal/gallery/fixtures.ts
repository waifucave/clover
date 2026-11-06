// A mocked PTY feed: a test run in the session's folder.
import type { TerminalChunk, TerminalTab } from "../client/types";

export const TABS: TerminalTab[] = [
  { id: "t1", title: "zsh" },
  { id: "t2", title: "bun dev", exited: { code: 0 } },
];

export const FEED: TerminalChunk[] = [
  { text: "~/projects/clover ", style: "prompt" },
  { text: "lane/f-m1 ", style: "dim" },
  { text: "$ bun test plugins/clover/panel\n" },
  { text: "bun test v1.3.14\n\n", style: "dim" },
  { text: "test/panel.test.tsx:\n" },
  { text: "✓", style: "success" },
  { text: " the toggles > each toggle says whether its view is open [3.1ms]\n" },
  { text: "✓", style: "success" },
  { text: " the host > holds two views one above the other [4.4ms]\n" },
  { text: "✗", style: "error" },
  { text: " the session column > a section folds [2.0ms]\n" },
  { text: "error: expect(received).toBeNull()\n", style: "error" },
  { text: "warning: ", style: "warning" },
  { text: "a test left a timer running\n\n" },
  { text: " 15 pass\n", style: "success" },
  { text: " 1 fail\n", style: "error" },
  { text: "~/projects/clover ", style: "prompt" },
  { text: "lane/f-m1 ", style: "dim" },
  { text: "$ " },
];
