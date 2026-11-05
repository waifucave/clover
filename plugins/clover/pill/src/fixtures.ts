// Mocked data for the pill's tests and gallery: who it messages, what it asks, the agents working for it and
// recent turns. The sealed fixtures stand for words only the core would draw.

import type { ChildItem } from "./model/children";
import type { ApprovalCard, LinkCard, QuestionCard } from "./model/cards";
import type { Exchange } from "./model/preview";
import type { PlumeThrow, ToolGlyph } from "./model/plume";
import type { ScheduledThrow } from "./ui/Plume";
import type { PillTarget } from "./ui/Bar";
import type { SealedFixtures } from "./mock-kit";

/** Alpha's portrait lives in Alpha's plugin; the gallery serves it at this path. */
export const ALPHA: PillTarget = { id: "alpha", name: "Alpha", portrait: "plugins/alpha/assets/portrait.svg", color: "#B9A6FF" };
export const LUNA: PillTarget = { id: "luna", name: "Luna", color: "#7FD6C2" };
export const MORI: PillTarget = { id: "mori", name: "Mori", color: "#FFC56B" };
export const TARGETS: readonly PillTarget[] = [ALPHA, LUNA, MORI];

export const APPROVAL: ApprovalCard = { id: "ask-1", kind: "approval", source: { id: "alpha", name: "Alpha" }, computer: "Studio" };
export const APPROVAL_CHILD: ApprovalCard = { id: "ask-2", kind: "approval", source: { id: "agent-2", name: "Screenshot pass" }, computer: "Studio" };
export const LINK: LinkCard = { id: "ask-3", kind: "link", source: { id: "alpha", name: "Alpha" } };
/** An approval whose answers include "always allow": three sealed buttons, each its option. */
export const APPROVAL_ALWAYS: ApprovalCard = {
  id: "ask-6",
  kind: "approval",
  source: { id: "luna", name: "Luna" },
  computer: "Studio",
  options: [
    { id: "once", kind: "approve" },
    { id: "always", kind: "approve", remember: "always" },
    { id: "deny", kind: "deny" },
  ],
};

export const SEALED: SealedFixtures = {
  "ask-1": {
    source: "Alpha · Bash",
    what: "Run a command that deletes the build folder and rebuilds the site",
    command: "rm -rf dist && bun run build",
    risk: "Deletes files, inside the project only",
  },
  "ask-2": {
    source: "Screenshot pass · Computer use",
    what: "Take control of Safari to capture the settings page",
    command: "computer: open Safari, click Settings",
  },
  "ask-3": {
    source: "Alpha · GitHub",
    what: "GitHub asks you to sign in to finish connecting",
    host: "github.com",
  },
  "ask-6": {
    source: "Luna · WebFetch",
    what: "Read pages on wikipedia.org",
    options: { once: "Allow once", always: "Always allow", deny: "Deny" },
  },
};

export const QUESTION: QuestionCard = {
  id: "ask-4",
  kind: "question",
  source: { id: "alpha", name: "Alpha" },
  questions: [
    {
      question: "Which branch should I open the pull request against?",
      options: [{ label: "main" }, { label: "release/1.111", description: "Ships with the next patch" }, { label: "Leave it as a draft" }],
      multiSelect: false,
    },
  ],
};

export const QUESTIONS: QuestionCard = {
  id: "ask-5",
  kind: "question",
  source: { id: "alpha", name: "Alpha" },
  questions: [
    { question: "Which platforms should the release notes cover?", header: "Platforms", options: [{ label: "macOS" }, { label: "Windows" }, { label: "Linux" }], multiSelect: true },
    { question: "Should I post them when they're ready?", options: [{ label: "Post them" }, { label: "Wait for me" }], multiSelect: false },
  ],
};

export const EXCHANGES: readonly Exchange[] = [
  { prompt: "What's left before the release?", reply: "Two things: the Windows tray fix and the notes." },
  {
    prompt: "Can you tidy the release notes before I post them?",
    reply:
      "Done. I merged the two **bug-fix** sections and moved the Windows note to the top.\n\n## What changed\n- The tray icon shows on Windows again\n- Startup is faster on older Macs\n\nThe draft is in `notes/1.111.md`.",
  },
  { prompt: "", reply: "The nightly build finished. Everything passed." },
];

export const AGENTS: readonly ChildItem[] = [
  { id: "agent-1", title: "Release notes", status: "working" },
  { id: "agent-2", title: "Screenshot pass", status: "needsYou" },
  { id: "agent-3", title: "Changelog check", status: "done" },
];

export const MANY_AGENTS: readonly ChildItem[] = [
  { id: "agent-1", title: "Release notes", status: "working" },
  { id: "agent-4", title: "Translate the notes", status: "working" },
  { id: "agent-5", title: "Tray fix", status: "failed" },
  { id: "agent-2", title: "Screenshot pass", status: "needsYou" },
  { id: "agent-6", title: "Docs links", status: "working" },
  { id: "agent-3", title: "Changelog check", status: "done" },
  { id: "agent-7", title: "Size budget", status: "working" },
];

const tool = (id: string, glyph: ToolGlyph): PlumeThrow => ({ id, kind: { tool: glyph } });

/** A turn's tools, as the plume throws them: thrown at these moments into a still. */
export const THROWS: readonly ScheduledThrow[] = [
  { at: 0.15, item: tool("t1", "doc") },
  { at: 0.5, item: tool("t2", "search") },
  { at: 0.85, item: tool("t3", "terminal") },
  { at: 1.2, item: { id: "t4", kind: { site: "github.com" } } },
  { at: 1.45, item: tool("t5", "pencil") },
];
