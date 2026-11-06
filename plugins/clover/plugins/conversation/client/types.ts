// The conversation view's props contract: everything it draws arrives as plain data (structured-clone
// shapes, spec §5.4's limits), plus callbacks the host routes back. Nothing here is read from the
// daemon directly; in M2 the shell maps the core's conversation stream onto these shapes.
//
// One item per thing that happened, in the order the computer running the bot placed it (spec §8.5).
// `kind` mirrors the `conversation.message` spot's keys (spec §5.5) — user, bot, tool, approval,
// question, routine-result, task-notification, agent-report, note — plus `thinking`, which the view
// draws itself (its titles moved to the conversation view, spec §12) and which is not a spot key.

/** Epoch milliseconds on the shared clock (spec §6.4): every device sees the same time. */
export type SharedTime = number;

interface ItemBase {
  /** Stable for the item's life: React keys and expansion state hang off it. */
  id: string;
  /** When it happened. For a user message, its send time, even when it was placed later (`late`). */
  at: SharedTime;
}

/** A file the user attached: an image (part of the transcript, spec §8.5) or a folder-tree path. */
export interface Attachment {
  /** The `[Image #n]` / `[File #n]` number in the message text. */
  n: number;
  kind: "image" | "file";
  name: string;
  /** Folder-tree path (`home/Studio/…`, spec §9.1). */
  path: string;
  /** An asset URL the host already resolved for an image's thumbnail. */
  previewUrl?: string;
}

export interface UserItem extends ItemBase {
  kind: "user";
  text: string;
  attachments?: Attachment[];
  /** The device it was sent from (spec §9.1: each user message says so). */
  device?: DeviceRef;
  /** Its stamp fell before output the model had already produced, so it was placed after that
   *  output; `at` still shows the real send time (spec §6.4). */
  late?: boolean;
}

export interface BotItem extends ItemBase {
  kind: "bot";
  /** Markdown. Raw HTML never renders, and links go to `onOpenLink`. */
  text: string;
  /** The answer is still arriving. */
  streaming?: boolean;
  /** The user's message cut this answer off (spec §6.4). */
  interrupted?: boolean;
}

/** `summary | update | exposed | hidden`: what kind of reasoning the block carried. */
export type ReasoningKind = "summary" | "update" | "exposed" | "hidden";

export interface ThinkingItem extends ItemBase {
  kind: "thinking";
  /** Title derived by the core (a provider's heading, an update's sentence); the view never parses
   *  reasoning text. */
  title?: string;
  /** Readable reasoning for the expanded row, from the closed block; empty while live and for a
   *  hidden block. */
  text?: string;
  /** Only live progress has arrived; the closed block has not. */
  live: boolean;
  reasoning: ReasoningKind;
  durationMs?: number;
  truncated?: boolean;
}

/** `waiting`: held for the user's OK on an approval card. `interrupted`: cancelled by the user's
 *  message or a restart, and recorded so (spec §6.4, §3.1). */
export type ToolStatus = "running" | "waiting" | "succeeded" | "failed" | "interrupted";

export interface ToolDiff {
  path: string;
  added: number;
  removed: number;
  diffId: string;
}

export interface ToolCall {
  callId: string;
  /** The tool's name as the model sees it: `Bash`, `Read`, `mcp__clover__WebSearch`… */
  name: string;
  /** A one-line hint: a command's first line, a path, a URL, a query. */
  detail?: string;
  /** The computer it ran on, given when the user has more than one (spec §9.1). */
  computer?: string;
  status: ToolStatus;
  /** The result text, already capped by the core. */
  output?: string;
  diff?: ToolDiff;
  /** Sites a web tool's result named, with the icon the tool reported. */
  /** The sites a web tool named. `icon` is an asset the host resolved (never a web URL): see `links.ts`. */
  sites?: { url: string; icon?: string }[];
  /** The safety reviewer is judging this call right now. */
  reviewing?: boolean;
  /** MCP Apps: the tool named a `ui://` page, which shows where the result shows (spec §5.5). */
  app?: { resourceUri: string };
}

export interface ToolItem extends ItemBase {
  kind: "tool";
  call: ToolCall;
}

/** An approval card. Its text is sealed: the view knows only its id, computer and state, and places
 *  the core's sealed frames (spec §5.5). */
/** Lane B's `CardOutcome`, plus pending: `cancelled` is a card whose session stopped. */
export type ApprovalState = "pending" | "approved" | "denied" | "expired" | "withdrawn" | "cancelled";

/** A device by its id (what comparisons use) and its name (what shows). */
export interface DeviceRef {
  id: string;
  name: string;
}

/** What a card is about (lane B's `CARD_KINDS`). */
export type ApprovalCardKind = "tool" | "agent-permission" | "plugin-ok" | "change" | "confirm" | "elicitation";

/** An option as a plugin hears it (lane B's `CardMeta.options`): never its label. */
export interface ApprovalOption {
  id: string;
  kind: "approve" | "deny";
  remember?: "always";
}

export interface ApprovalItem extends ItemBase {
  kind: "approval";
  cardId: string;
  /** What the card asks about. Absent: a tool call. */
  cardKind?: ApprovalCardKind;
  /** The card's options, in the core's order: one sealed button each. Absent: one Deny, one Approve. */
  options?: ApprovalOption[];
  /** A plugin's card (`confirm`, `plugin-ok`): whose. The sealed `source` field names it too. */
  pluginId?: string;
  computer?: string;
  /** The tool call it holds, when it holds one. */
  callId?: string;
  state: ApprovalState;
  /** Set when the turn was not started by the user's own message: unanswered, the card is denied at
   *  this time (spec §5.5, §9.1). Absent: it waits. */
  expiresAt?: SharedTime;
  /** The device whose answer won (every device shows the card; the first answer wins). */
  answeredOn?: string;
  /** Why it was withdrawn, when it was: the user's interrupt, or the turn ending another way. */
  withdrawnBy?: "interrupt" | "turn-end";
}

export interface QuestionOption {
  label: string;
  description?: string;
  /** A preview shown beside the options (a snippet, a scheme). Plain text. */
  preview?: string;
}

export interface Question {
  question: string;
  /** A short chip (≤ 12 characters) above the question in a card of several. */
  header?: string;
  /** None: answered by typing. Two to four: a menu, always with a free-text box under it. */
  options: QuestionOption[];
  multiSelect: boolean;
  placeholder?: string;
}

/** `AskUserQuestion`: readable, unlike approvals (spec §5.5). */
export interface QuestionItem extends ItemBase {
  kind: "question";
  callId: string;
  questions: Question[];
  state: "pending" | "answered" | "expired" | "withdrawn";
  /** Keyed by question text: the chosen labels (joined with ", " for several), or the typed text. */
  answers?: Record<string, string>;
  notes?: Record<string, string>;
  answeredOn?: string;
  expiresAt?: SharedTime;
  /** Why it was withdrawn, when it was: the user's interrupt, or the turn ending another way. */
  withdrawnBy?: "interrupt" | "turn-end";
}

/** A routine's run happened in a side thread and posted this short result (spec §7). */
export interface RoutineResultItem extends ItemBase {
  kind: "routine-result";
  routine: { id: string; name: string; computer: string };
  /** What fired it, as the routine engine describes it: "Every weekday at 9:00". */
  trigger?: string;
  status: "succeeded" | "failed";
  /** Markdown. */
  summary: string;
  /** The side thread, for "Open run". */
  threadId: string;
  durationMs?: number;
}

/** A background agent or a background command finished (spec §9.3). */
export interface TaskNotificationItem extends ItemBase {
  kind: "task-notification";
  task:
    | { kind: "agent"; agentId: string; name: string; backend?: string; computer?: string }
    | { kind: "command"; taskId: string; command: string; computer?: string; exitCode?: number | null };
  status: "completed" | "failed" | "stopped" | "stalled";
  /** Markdown: the agent's final report. */
  report?: string;
  /** Folder-tree path to the full transcript (`bots/<bot>/agents/…`). */
  transcriptPath?: string;
  durationMs?: number;
}

/** A message another session sent this bot with `SendMessage`: a background agent reporting while it
 *  works, or another bot. It folded into the running turn after a tool call (spec §6.4). */
export interface AgentReportItem extends ItemBase {
  kind: "agent-report";
  /** Who sent it: a background agent, another bot, another session, or a plugin. A plugin's message is
   *  lane B's `plugin_message` session event (`{ from: { kind: "plugin", pluginId }, text, app? }`): `id` is
   *  its `pluginId`, `name` the plugin's name as the host resolves it. It is never drawn as the user's. */
  from: { kind: "agent" | "bot" | "session" | "plugin"; id: string; name: string; backend?: string; computer?: string };
  /** A plugin's message that came from its MCP Apps page (`ui/message`): the tool call that drew the page. */
  app?: { callId: string };
  /** Markdown. */
  text: string;
  /** It joined a turn already running rather than starting one. */
  folded?: boolean;
}

/** Where a note came from. A plugin's note says which plugin (spec §5.4, `conversation.post`). */
export type NoteSource =
  | { kind: "core" }
  | { kind: "plugin"; id: string; name: string }
  | { kind: "hook"; plugin: string };

/** A quiet line: an error, a model switch, a compaction, a hook's notice, a plugin's note. */
export interface NoteItem extends ItemBase {
  kind: "note";
  /** Plain text: a note is never Markdown, since plugins and hooks write it. */
  text: string;
  tone?: "info" | "warning" | "error";
  from?: NoteSource;
  /** `divider` draws it across the conversation, as for a compaction. */
  variant?: "line" | "divider";
}

/** A run of consecutive tool calls, as the `tool` key of `conversation.message` gets it. */
export interface ToolRunItem {
  id: string;
  kind: "tool";
  at: SharedTime;
  calls: ToolCall[];
}

export type ConversationItem =
  | UserItem
  | BotItem
  | ThinkingItem
  | ToolItem
  | ApprovalItem
  | QuestionItem
  | RoutineResultItem
  | TaskNotificationItem
  | AgentReportItem
  | NoteItem;

export type ConversationItemKind = ConversationItem["kind"];

/** The `conversation.message` spot's keys (spec §5.5): every kind but `thinking`. */
export type MessageKind = Exclude<ConversationItemKind, "thinking">;

export const MESSAGE_KINDS: readonly MessageKind[] = [
  "user", "bot", "tool", "approval", "question", "routine-result", "task-notification", "agent-report", "note",
];

/** What the bot's main conversation is doing now. Side threads and background agents never show
 *  here (spec §6.4). */
export interface TurnState {
  running: boolean;
  /** `waiting`: held on an approval or a question. */
  phase?: "thinking" | "working" | "waiting" | "compacting" | "retrying";
  /** A provider retry: "busy, retrying 3 of 10". */
  retry?: { attempt: number; maxRetries: number; status?: number | null };
}

export interface QuestionAnswer {
  answers: Record<string, string>;
  notes?: Record<string, string>;
}

/** Callbacks the host routes back. Every one is optional: a view without one draws that control as
 *  plain text. */
export interface ConversationActions {
  /** May return a promise: if it rejects, the card takes answers again. */
  onAnswerQuestion?: (callId: string, answer: QuestionAnswer) => void | Promise<unknown>;
  /** Open a link in the user's browser; the view never navigates itself. */
  onOpenLink?: (url: string) => void;
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (diffId: string) => void;
  /** Open a routine run's side thread. */
  onOpenThread?: (threadId: string) => void;
  /** Open a background agent's live tab (spec §9.3). */
  onOpenAgent?: (agentId: string) => void;
  onCopy?: (text: string) => void;
}

/** Formatting the host pins (tests and the gallery pin both, so output is stable). */
export interface ConversationFormat {
  locale?: string;
  timeZone?: string;
}
