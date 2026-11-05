// Mock conversations for the gallery and the tests. Plain data, as the shell will hand it over in M2.
// Times are pinned (UTC, en-US) so every render reads the same.
import type {
  AgentReportItem,
  ApprovalItem,
  BotItem,
  ConversationFormat,
  ConversationItem,
  NoteItem,
  QuestionItem,
  RoutineResultItem,
  TaskNotificationItem,
  ThinkingItem,
  ToolCall,
  ToolItem,
  UserItem,
} from "../client/types";
import type { SealedCardData } from "./mock-runtime";

export const FORMAT: ConversationFormat = { locale: "en-US", timeZone: "UTC" };
/** Thursday, November 5, 2026, 16:30 UTC. */
export const NOW = Date.UTC(2026, 10, 5, 16, 30);
export const BOT = { id: "alpha", name: "Alpha" };
export const DEVICE = { id: "dev_studio", name: "Studio" };
const IPHONE = { id: "dev_iphone", name: "iPhone" };
const LAPTOP = { id: "dev_laptop", name: "Laptop" };
const WEB = { id: "dev_web", name: "clover.waifucave.com" };

/** A time on a day relative to NOW's day (0 = today, -1 = yesterday). */
export const at = (dayOffset: number, h: number, m: number) => Date.UTC(2026, 10, 5 + dayOffset, h, m);

let seq = 0;
const id = (prefix: string) => `${prefix}-${++seq}`;

export const user = (time: number, text: string, extra: Partial<UserItem> = {}): UserItem => ({
  kind: "user", id: id("u"), at: time, text, device: DEVICE, ...extra,
});
export const bot = (time: number, text: string, extra: Partial<BotItem> = {}): BotItem => ({
  kind: "bot", id: id("b"), at: time, text, ...extra,
});
export const thinking = (time: number, extra: Partial<ThinkingItem> = {}): ThinkingItem => ({
  kind: "thinking", id: id("t"), at: time, live: false, reasoning: "summary", ...extra,
});
export const tool = (time: number, call: Partial<ToolCall> & Pick<ToolCall, "name">): ToolItem => {
  const itemId = id("c");
  return { kind: "tool", id: itemId, at: time, call: { callId: `call-${itemId}`, status: "succeeded", ...call } };
};
export const approval = (time: number, extra: Partial<ApprovalItem> = {}): ApprovalItem => ({
  kind: "approval", id: id("a"), at: time, cardId: id("card"), state: "pending", ...extra,
});
export const question = (time: number, extra: Partial<QuestionItem> & Pick<QuestionItem, "questions">): QuestionItem => ({
  kind: "question", id: id("q"), at: time, callId: id("call"), state: "pending", ...extra,
});
export const note = (time: number, text: string, extra: Partial<NoteItem> = {}): NoteItem => ({
  kind: "note", id: id("n"), at: time, text, ...extra,
});

// ---------------------------------------------------------------- plain exchanges

export const GREETING: ConversationItem[] = [
  bot(at(-2, 9, 0), "Hi, I'm **Alpha**. I live on your computers and remember what we talk about.\n\nTell me what you're working on, or ask me anything."),
];

export const BASIC: ConversationItem[] = [
  user(at(-1, 18, 5), "Can you summarize what changed in the clover repo this week?"),
  bot(
    at(-1, 18, 6),
    [
      "Here's the week in the `clover` repo:",
      "",
      "## Highlights",
      "",
      "1. **The rename landed.** Every package now lives under `@waifucave/*`.",
      "2. **Spikes started** for the transport, the browser and the layers.",
      "3. CI runs on all three OSes, with Windows still red on the bash fence.",
      "",
      "> The plugin section of the spec is frozen as of revision 16.",
      "",
      "| Area | PRs | Status |",
      "| --- | --- | --- |",
      "| Rename | 1 | In review |",
      "| Spikes | 6 | Open |",
      "",
      "To catch up locally:",
      "",
      "```sh",
      "git fetch origin --prune",
      "git log --oneline origin/main..origin/c0/rename",
      "```",
      "",
      "The full list is on [GitHub](https://github.com/waifucave/clover/pulls).",
    ].join("\n"),
  ),
  user(at(0, 9, 12), "Thanks! What's on my calendar today?", { device: IPHONE }),
  bot(at(0, 9, 12), "Three things today:\n\n- **10:30** design review with the island team\n- **13:00** lunch with Mira\n- **16:00** dentist, so I'll keep the afternoon quiet"),
];

// ---------------------------------------------------------------- streaming and thinking

export const STREAMING: ConversationItem[] = [
  user(at(0, 16, 20), "Why did last night's deploy fail?"),
  thinking(at(0, 16, 20), { title: "Reading the deploy logs", durationMs: 4200, text: "The deploy job ran at 02:10. I should read the job log first, then the migration output." }),
  tool(at(0, 16, 21), { name: "Bash", detail: "gh run view 4412 --log-failed", computer: "Studio", output: "migrate | error: column \"owner_id\" of relation \"bots\" already exists\nmigrate | exit status 1" }),
  tool(at(0, 16, 21), { name: "Read", detail: "home/Studio/projects/hub/migrations/0042_owner.sql", computer: "Studio", output: "ALTER TABLE bots ADD COLUMN owner_id uuid;" }),
  thinking(at(0, 16, 22), { title: "Comparing the migration with the schema", live: true, reasoning: "summary" }),
  bot(at(0, 16, 22), "The deploy failed in the **migration step**: `0042_owner.sql` adds `owner_id`, but the column already exists because the hotfix on Monday added it by hand.\n\nTwo ways out:\n\n1. Make the migration idempotent:\n\n```sql\nALTER TABLE bots ADD COLUMN IF NOT EXISTS", { streaming: true }),
];

export const THINKING: ConversationItem[] = [
  user(at(0, 15, 2), "Plan the move from the old sync to the new one."),
  thinking(at(0, 15, 2), {
    title: "Mapping what the old sync stores",
    durationMs: 12_400,
    text: "The old sync keeps a cursor per device and a pending queue. The new one keeps an append-only log with a lease epoch per event, so the cursor maps onto the last seen sequence number and the queue becomes unsent events.",
  }),
  thinking(at(0, 15, 3), { durationMs: 8_000, text: "Both stores can be read side by side, so the move can be gradual." }),
  thinking(at(0, 15, 3), { reasoning: "hidden", durationMs: 3_100 }),
  bot(at(0, 15, 4), "Here's a plan in three steps. First, read both stores side by side…"),
  user(at(0, 15, 10), "And the rollback?"),
  thinking(at(0, 15, 10), { title: "Weighing a rollback window", live: true }),
];

// ---------------------------------------------------------------- tools

const DEPLOY_LOG = Array.from({ length: 56 }, (_, i) => `[build] step ${i + 1}/56 ${i % 7 === 0 ? "compiling" : "ok"}`).join("\n");

const runA = tool(at(0, 14, 0), { name: "Bash", detail: "git status --short", computer: "Studio", output: " M plugins/clover/shell/clover.json\n?? plugins/clover/composer/" });
const runC = tool(at(0, 14, 3), {
  name: "mcp__clover__WebSearch",
  detail: "electron WebContentsView partition per session",
  output: "3 results",
  sites: [
    { url: "https://www.electronjs.org/docs/latest/api/web-contents-view" },
    { url: "https://github.com/electron/electron/issues/41300" },
    { url: "https://developer.chrome.com/docs/web-platform/site-isolation" },
  ],
});
const runD = tool(at(0, 14, 4), { name: "mcp__charts__Plot", detail: "build times by day", output: "Rendered a chart.", app: { resourceUri: "ui://charts/build-times" } });
const runE = tool(at(0, 14, 4), { name: "mcp__blender__Render", detail: "scene: island-preview", computer: "Laptop", output: "home/Laptop/renders/island-preview.png" });

export const TOOLS: ConversationItem[] = [
  user(at(0, 14, 0), "Clean up the plugin manifests and check the build."),
  runA,
  tool(at(0, 14, 0), { name: "Bash", detail: "bun test", computer: "Studio", output: "84 pass\n0 fail\nRan 84 tests across 9 files. [1.2s]" }),
  tool(at(0, 14, 0), { name: "Bash", detail: "bun run build", computer: "Studio", output: DEPLOY_LOG }),
  tool(at(0, 14, 1), { name: "Read", detail: "home/Studio/projects/clover/plugins/clover/shell/clover.json", computer: "Studio", output: "{\n  \"manifest\": 1,\n  \"name\": \"Shell\"\n}" }),
  tool(at(0, 14, 1), { name: "Read", detail: "home/Studio/projects/clover/docs/clover-spec.md", computer: "Studio", output: "# Clover — direction spec\n…" }),
  bot(at(0, 14, 1), "The manifests parse. I'll tidy the two that still list old fields."),
  tool(at(0, 14, 2), {
    name: "Edit",
    detail: "home/Studio/projects/clover/plugins/clover/shell/clover.json",
    computer: "Studio",
    output: "Edited 1 place.",
    diff: { path: "plugins/clover/shell/clover.json", added: 4, removed: 2, diffId: "d1" },
  }),
  tool(at(0, 14, 2), {
    name: "Write",
    detail: "home/Studio/projects/clover/plugins/clover/composer/clover.json",
    computer: "Studio",
    output: "Wrote 9 lines.",
    diff: { path: "plugins/clover/composer/clover.json", added: 9, removed: 0, diffId: "d2" },
  }),
  thinking(at(0, 14, 3), { title: "Checking how Electron isolates sessions", durationMs: 2_600 }),
  runC,
  tool(at(0, 14, 3), { name: "mcp__clover__WebFetch", detail: "https://www.electronjs.org/docs/latest/api/web-contents-view", output: "WebContentsView: a view that displays a WebContents…" }),
  bot(at(0, 14, 4), "Electron keeps one partition per session, so each bot's tabs stay apart. Here are this week's build times:"),
  runD,
  bot(at(0, 14, 4), "And the island preview, rendered on Laptop:"),
  runE,
  bot(at(0, 14, 5), "Checking the types."),
  tool(at(0, 14, 5), { name: "Bash", detail: "bun run typecheck", computer: "Studio", status: "failed", output: "client/Composer.tsx(41,7): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error." }),
  bot(at(0, 14, 6), "One type error left in the composer. Fixing it now."),
  tool(at(0, 14, 6), { name: "Edit", detail: "home/Studio/projects/clover/plugins/clover/composer/client/Composer.tsx", computer: "Studio", output: "Edited 1 place." }),
  tool(at(0, 14, 6), { name: "Bash", detail: "bun run dev", computer: "Studio", status: "interrupted" }),
  bot(at(0, 14, 7), "Reinstalling, since the lockfile moved."),
  tool(at(0, 14, 7), { name: "Bash", detail: "rm -rf node_modules && bun install", computer: "Studio", status: "running", reviewing: true }),
];

/** The runs to show open: the first, the web search and the plugin tool's. */
export const TOOLS_OPEN = [runA.id, runC.id, runE.id];

export const TOOL_APPS = { [runD.call.callId]: { resourceUri: "ui://charts/build-times" } };

/** The `tool.result` spot's example: a plugin draws Blender renders its own way. */
export const BLENDER_CALL_ID = runE.call.callId;

// ---------------------------------------------------------------- approvals

export const APPROVAL_PENDING_CARD = "card-push";

export const APPROVAL_PENDING: ConversationItem[] = [
  user(at(0, 16, 1), "Ship the branch to main."),
  tool(at(0, 16, 1), { name: "Bash", detail: "git log --oneline -3", computer: "Studio", output: "c2002b2 C0: the lockfiles name the renamed packages\n747580b CI runs on demand only\nd6b8c9a README says where Clover stands" }),
  bot(at(0, 16, 2), "Everything is committed. Pushing needs your OK, since it rewrites the remote branch."),
  tool(at(0, 16, 2), { name: "Bash", detail: "git push origin main --force-with-lease", computer: "Studio", status: "waiting" }),
  approval(at(0, 16, 2), {
    cardId: APPROVAL_PENDING_CARD,
    computer: "Studio",
    options: [
      { id: "allow_once", kind: "approve" },
      { id: "allow_always", kind: "approve", remember: "always" },
      { id: "deny", kind: "deny" },
    ],
  }),
];

export const CONFIRM_CARD = "card-confirm";
export const ELICITATION_CARD = "card-elicitation";

/** Lane B's other card kinds: a plugin's `confirm(text)`, and an MCP server's sign-in link. */
export const OTHER_CARDS: ConversationItem[] = [
  bot(at(0, 16, 5), "The Tarot panel wants to post today's spread to your journal. That's its own question, so it asks you:"),
  approval(at(0, 16, 5), {
    cardId: CONFIRM_CARD,
    cardKind: "confirm",
    pluginId: "tarot-panel",
    options: [{ id: "approve", kind: "approve" }, { id: "deny", kind: "deny" }],
  }),
  bot(at(0, 16, 6), "Linear needs you to sign in again before I can read the sprint board."),
  approval(at(0, 16, 6), {
    cardId: ELICITATION_CARD,
    cardKind: "elicitation",
    options: [{ id: "open_link", kind: "approve" }, { id: "decline", kind: "deny" }],
  }),
];

export const APPROVAL_STATES: ConversationItem[] = [
  approval(at(0, 9, 0), { cardId: "card-approved", state: "approved", answeredOn: "iPhone" }),
  approval(at(0, 9, 5), { cardId: "card-denied", state: "denied", answeredOn: "Studio" }),
  approval(at(0, 9, 10), { cardId: "card-expired", state: "expired" }),
  approval(at(0, 9, 15), { cardId: "card-withdrawn", state: "withdrawn", withdrawnBy: "turn-end" }),
  approval(at(0, 9, 17), { cardId: "card-cancelled", state: "cancelled" }),
  note(at(0, 16, 22), "The Nightly backup routine needs your OK:", { tone: "info" }),
  approval(at(0, 16, 22), { cardId: "card-routine", computer: "Studio", expiresAt: at(0, 16, 32) }),
];

export const SEALED_CARDS: Record<string, SealedCardData> = {
  [APPROVAL_PENDING_CARD]: {
    title: "Run a command on Studio",
    command: "git push origin main --force-with-lease",
    computer: "Studio",
    risk: "Rewrites a remote branch",
    reason: "The safety reviewer asks because a force push can drop other people's commits.",
    expires: "Waits for your answer",
  },
  "card-approved": { title: "Delete 14 files in home/Studio/Downloads" },
  "card-denied": { title: "Buy a domain: clover-bots.app ($12)" },
  "card-expired": { title: "Install a plugin: tarot-panel" },
  "card-withdrawn": { title: "Run a command on Laptop" },
  "card-migrate": { title: "Run a command on Studio" },
  "card-cancelled": { title: "Read the shared calendar" },
  [CONFIRM_CARD]: {
    title: "A plugin asks",
    source: "Tarot panel · tarot-panel · from the plugin index",
    what: "Post today's spread to your journal?",
    expires: "Waits for your answer",
  },
  [ELICITATION_CARD]: {
    title: "Sign in to Linear",
    source: "MCP server linear (Linear's own)",
    what: "Open this sign-in link in your browser?",
    host: "linear.app",
    command: "https://linear.app/oauth/authorize?client_id=clover&state=7f2c",
  },
  "card-routine": {
    title: "Run a command on Studio",
    command: "restic backup ~/Projects --exclude node_modules",
    computer: "Studio",
    risk: "Writes to the backup bucket",
    expires: "Denied at 4:32 PM unless you answer",
  },
};

// ---------------------------------------------------------------- questions

export const QUESTION_SINGLE: QuestionItem = question(at(0, 16, 10), {
  questions: [
    {
      question: "Which database should the hub use?",
      options: [
        { label: "Postgres", description: "What production already runs" },
        { label: "SQLite", description: "One file, no server; fine for one computer" },
        { label: "Keep both", description: "SQLite locally, Postgres on the cloud computer" },
      ],
      multiSelect: false,
    },
  ],
});

export const QUESTION_MULTI: QuestionItem = question(at(0, 16, 11), {
  questions: [
    {
      question: "Which computers should run the nightly backup?",
      header: "Computers",
      options: [
        { label: "Studio" },
        { label: "Laptop" },
        { label: "Cloud computer", description: "Always on; costs a little" },
      ],
      multiSelect: true,
    },
    {
      question: "When should it run?",
      header: "Time",
      options: [{ label: "2:00" }, { label: "4:00" }],
      multiSelect: false,
      placeholder: "Or type a time",
    },
  ],
});

export const QUESTION_FREE: QuestionItem = question(at(0, 16, 12), {
  questions: [{ question: "What should I call the new bot?", options: [], multiSelect: false, placeholder: "A name" }],
  expiresAt: at(0, 16, 38),
});

export const QUESTION_PREVIEW: QuestionItem = question(at(0, 16, 13), {
  questions: [
    {
      question: "Which layout for Luna's tab?",
      options: [
        { label: "Stage left", preview: "row\n├─ stage (avatar)   320px\n└─ column\n   ├─ conversation\n   └─ composer" },
        { label: "Stage on top", preview: "column\n├─ stage (avatar)   240px\n├─ conversation\n└─ composer" },
      ],
      multiSelect: false,
    },
  ],
});

export const QUESTION_ANSWERED: QuestionItem = question(at(0, 11, 0), {
  questions: [{ question: "Which database should the hub use?", options: [{ label: "Postgres" }, { label: "SQLite" }], multiSelect: false }],
  state: "answered",
  answers: { "Which database should the hub use?": "Postgres" },
  answeredOn: "iPhone",
});

export const QUESTION_EXPIRED: QuestionItem = question(at(0, 11, 30), {
  questions: [{ question: "Should the routine also email you the report?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false }],
  state: "expired",
});

// ---------------------------------------------------------------- events: routines, agents, other bots

const REPORT = [
  "Done. The island now draws at the notch on macOS and as a top strip elsewhere.",
  "",
  "**What changed**",
  "",
  "- `plugins/clover/island/client/Island.tsx`: the notch geometry comes from the app",
  "- `plugins/clover/island/client/strip.tsx`: a new top strip for Windows and Linux",
  "- 14 new tests, all passing on the three OSes",
  "",
  "**Left for you**",
  "",
  "- The Wayland fallback still opens a normal window; it needs a live check.",
  "- I didn't touch the Usage tab.",
  "",
  "Transcript and diffs are in the agent's folder.",
  "",
  "One more thing: the strip's height is a setting now, so a theme can move it.",
].join("\n");

export const EVENTS: ConversationItem[] = [
  {
    kind: "routine-result", id: "r-1", at: at(0, 9, 0),
    routine: { id: "morning-brief", name: "Morning brief", computer: "Studio" },
    trigger: "Every weekday at 9:00",
    status: "succeeded",
    summary: "3 meetings today, 12 new emails (2 need you), and the overnight build passed.",
    threadId: "side-1",
    durationMs: 48_000,
  } satisfies RoutineResultItem,
  {
    kind: "routine-result", id: "r-2", at: at(0, 9, 30),
    routine: { id: "inbox-triage", name: "Inbox triage", computer: "Cloud computer" },
    trigger: "Webhook from GitHub",
    status: "failed",
    summary: "The GitHub token expired, so I couldn't read the new issues.",
    threadId: "side-2",
  } satisfies RoutineResultItem,
  user(at(0, 10, 0), "Have OpenCode rebuild the island as a plugin on Studio."),
  bot(at(0, 10, 0), "Started an OpenCode agent on Studio for it. I'll tell you when it reports."),
  {
    kind: "agent-report", id: "ar-1", at: at(0, 10, 20),
    from: { kind: "agent", id: "agent-island", name: "OpenCode", backend: "OpenCode", computer: "Studio" },
    text: "Halfway there: the notch geometry works. Should the strip be 32 or 40 px tall on Windows?",
    folded: true,
  } satisfies AgentReportItem,
  {
    kind: "agent-report", id: "ar-2", at: at(0, 10, 25),
    from: { kind: "bot", id: "luna", name: "Luna" },
    text: "I drew the tarot for today's reading: **The Star**. Pass it on when you talk to them?",
  } satisfies AgentReportItem,
  {
    kind: "agent-report", id: "ar-3", at: at(0, 10, 30),
    from: { kind: "plugin", id: "tarot-panel", name: "Tarot panel" },
    app: { callId: "call-tarot" },
    text: "The user pinned The Star to today's page.",
  } satisfies AgentReportItem,
  {
    kind: "task-notification", id: "tn-1", at: at(0, 10, 44),
    task: { kind: "agent", agentId: "agent-island", name: "OpenCode", backend: "OpenCode · kimi-k3, high effort", computer: "Studio" },
    status: "completed",
    report: REPORT,
    transcriptPath: "bots/alpha/agents/agent-island.jsonl",
    durationMs: 44 * 60_000,
  } satisfies TaskNotificationItem,
  {
    kind: "task-notification", id: "tn-2", at: at(0, 11, 2),
    task: { kind: "agent", agentId: "agent-lint", name: "Codex", backend: "Codex", computer: "Laptop" },
    status: "stalled",
    report: "Made no progress for 10 minutes, so it was stopped. The last thing it ran was `bun test --watch`.",
    transcriptPath: "bots/alpha/agents/agent-lint.jsonl",
  } satisfies TaskNotificationItem,
  {
    kind: "task-notification", id: "tn-3", at: at(0, 11, 5),
    task: { kind: "command", taskId: "bg-1", command: "bun run build --watch", computer: "Studio", exitCode: 0 },
    status: "completed",
  } satisfies TaskNotificationItem,
  {
    kind: "task-notification", id: "tn-4", at: at(0, 11, 6),
    task: { kind: "command", taskId: "bg-2", command: "pg_dump hub > hub.sql", computer: "Cloud computer", exitCode: 1 },
    status: "failed",
  } satisfies TaskNotificationItem,
];

// ---------------------------------------------------------------- notes

export const NOTES: ConversationItem[] = [
  note(at(-1, 23, 50), "Alpha summarized the conversation up to here", { variant: "divider" }),
  user(at(0, 8, 0), "Morning! Switch to a faster model for today."),
  note(at(0, 8, 0), "Switched to Grok 5, low effort. The next turn uses it."),
  bot(at(0, 8, 0), "Done. I'll be quicker today."),
  note(at(0, 8, 2), "You're on Laptop. Alpha thinks on Studio.", { from: { kind: "core" } }),
  note(at(0, 8, 5), "2 new tools arrived: mcp__figma__Export and mcp__figma__Inspect."),
  note(at(0, 8, 6), "Drew The Star for today's reading.", { from: { kind: "plugin", id: "tarot-panel", name: "Tarot panel" } }),
  note(at(0, 8, 7), "Blocked a write to package-lock.json.", { tone: "warning", from: { kind: "hook", plugin: "lint-guard" } }),
  note(at(0, 8, 9), "The provider stopped answering (HTTP 529). Send another message to try again.", { tone: "error" }),
  // A plugin's divider that copies the core's compaction words: it still says who drew it.
  note(at(0, 8, 10), "Alpha summarized the conversation up to here", {
    variant: "divider",
    from: { kind: "plugin", id: "story-mode", name: "Story mode" },
  }),
];

// ---------------------------------------------------------------- interrupts, devices, status

export const INTERRUPT: ConversationItem[] = [
  user(at(0, 16, 0), "Deploy the hub to production."),
  tool(at(0, 16, 0), { name: "Bash", detail: "bun run build", computer: "Studio", output: "Built in 14.2s" }),
  bot(at(0, 16, 1), "Built. Now running the migrations against production, then I'll", { interrupted: true }),
  tool(at(0, 16, 1), { name: "Bash", detail: "bun run migrate --env production", computer: "Studio", status: "interrupted" }),
  approval(at(0, 16, 1), { cardId: "card-migrate", state: "withdrawn", withdrawnBy: "interrupt" }),
  user(at(0, 16, 2), "Stop, use the staging database first."),
  thinking(at(0, 16, 2), { title: "Switching to staging", live: true }),
];

export const DEVICES: ConversationItem[] = [
  user(at(0, 12, 0), "Remind me what the fix for the login loop was.", { device: IPHONE }),
  bot(at(0, 12, 0), "The refresh token was rotated twice when two devices refreshed together. Now only the refresher refreshes."),
  user(at(0, 12, 3), "And who's the refresher now?", { device: WEB }),
  bot(at(0, 12, 3), "Studio, your main computer."),
  user(at(0, 12, 2), "Also, check the lease logs", { device: LAPTOP, late: true }),
  bot(at(0, 12, 4), "The lease logs are clean: Studio renewed every 30 seconds all night."),
];

export const STATUS_RETRYING: ConversationItem[] = [
  user(at(0, 16, 25), "Draft the release notes."),
  tool(at(0, 16, 25), { name: "Bash", detail: "git log --oneline v1.110.0..HEAD", computer: "Studio", output: "214 commits" }),
];

export const ATTACHMENTS: ConversationItem[] = [
  user(at(0, 13, 0), "Which of these two mockups reads better? [Image #1] [Image #2] Notes are in [File #1].", {
    attachments: [
      { n: 1, kind: "image", name: "island-a.png", path: "home/Studio/Desktop/island-a.png", previewUrl: swatch("#8ccbf0", "#2b5d7d") },
      { n: 2, kind: "image", name: "island-b.png", path: "home/Studio/Desktop/island-b.png", previewUrl: swatch("#f3c4d8", "#7d2b55") },
      { n: 1, kind: "file", name: "notes.md", path: "home/Studio/Desktop/notes.md" },
    ],
  }),
  bot(at(0, 13, 1), "**B** reads better: the darker rim separates the island from the menu bar, and the badge stays legible."),
];

/** A long conversation, for the "Show earlier" and "Jump to latest" story. */
export function longConversation(count = 14): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (let i = 0; i < count; i++) {
    items.push(user(at(0, 8 + Math.floor(i / 2), (i * 7) % 60), `Question ${i + 1}: what about step ${i + 1}?`));
    items.push(bot(at(0, 8 + Math.floor(i / 2), (i * 7 + 1) % 60), `Step ${i + 1} is done. It took a moment because the build cache was cold, but everything passed.`));
  }
  return items;
}

/** A tiny two-tone image as a data URL, standing in for a photo. */
function swatch(a: string, b: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="180" height="120" fill="url(#g)"/><rect x="45" y="12" width="90" height="22" rx="11" fill="#111"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
