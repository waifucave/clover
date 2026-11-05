// The hook catalog (spec §5.3 "Hook order", "What each event may return", "Handlers"; §9.3 for Claude Code). The turn
// loop calls `hooks` entries before and after a tool call, on messages in and out, at a turn's start and end, and
// around compaction. A hook can block or adjust inputs and results, under time limits, but cannot replace the runtime
// or skip approvals [D].
import type { Caller } from "@waifucave/clover-protocol";

export const HOOK_EVENTS = [
  "tool.before", "tool.after", "message.in", "message.out", "turn.start", "turn.end", "compact.before", "compact.after",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** What a hook may return on each event (§5.3). `tool.before` may deny, ask or replace the input, never allow; the
 *  reviewer, the fences and the approval check then judge the input as the hooks left it, and nothing changes an input
 *  after it is approved. */
export const HOOK_RETURNS: Readonly<Record<HookEvent, readonly ("deny" | "ask" | "input" | "result" | "text" | "note")[]>> = {
  "tool.before": ["deny", "ask", "input"],
  "tool.after": ["result"],
  "message.in": ["text"],
  "message.out": ["text"],
  "turn.start": ["note"],
  "turn.end": [],
  "compact.before": [],
  "compact.after": [],
};

/** Events whose hooks take a `tools` filter: exact names, or patterns with `*`. */
export const TOOL_HOOK_EVENTS: readonly HookEvent[] = ["tool.before", "tool.after"];

/** A hook that throws or runs past its `timeoutMs` is skipped, and Settings shows it. */
export const HOOK_DEFAULT_TIMEOUT_MS = 10_000;
export const HOOK_MAX_TIMEOUT_MS = 600_000;
/** A wrapped Claude Code hook keeps its own timeout, 600 seconds when unset (§5.1). */
export const CLAUDE_HOOK_DEFAULT_TIMEOUT_MS = 600_000;

/** Claude Code's hook events where one exists. A hook's `command` speaks Claude Code's hook protocol (JSON on stdin and
 *  stdout, exit code 2 to deny) under these names, and the core ignores an `allow`. */
export const CLAUDE_HOOK_EVENTS: Readonly<Record<string, HookEvent>> = {
  PreToolUse: "tool.before",
  PostToolUse: "tool.after",
  UserPromptSubmit: "message.in",
  Stop: "turn.end",
  PreCompact: "compact.before",
  PostCompact: "compact.after",
};
export function claudeEventNameOf(event: HookEvent): string | undefined {
  return Object.entries(CLAUDE_HOOK_EVENTS).find(([, e]) => e === event)?.[0];
}

/** What a hook handler gets (§5.3 "Handlers"). */
export interface HookInput {
  event: HookEvent;
  /** The session the turn belongs to, and who started it. */
  session: { id: string; kind: "bot" | "side-thread" | "agent" | "coding"; caller: Caller };
  bot?: string;
  /** The computer running the session. */
  computer: string;
  tool?: { name: string; callId: string };
  input?: unknown;
  result?: unknown;
  text?: string;
}

/** What a hook handler returns, by event. Anything its event doesn't allow is ignored (§5.3). */
export type HookOutput =
  | { event: "tool.before"; deny?: { reason: string }; ask?: { reason: string }; input?: unknown }
  | { event: "tool.after"; result?: unknown }
  | { event: "message.in"; text?: string }
  | { event: "message.out"; text?: string }
  | { event: "turn.start"; note?: { label: string; text: string } }
  | { event: "turn.end" | "compact.before" | "compact.after" };

/** Hooks on one event run one after another, in the order of their plugins' ids, each seeing the last one's output. */
export function hookOrder<T extends { pluginId: string }>(hooks: readonly T[]): T[] {
  return [...hooks].sort((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0));
}

/** Whether a hook's `tools` filter matches a tool name: exact names, or patterns where `*` matches any run. */
export function hookMatchesTool(filter: readonly string[] | undefined, tool: string): boolean {
  if (filter === undefined) return true;
  return filter.some((pattern) => {
    if (!pattern.includes("*")) return pattern === tool;
    const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return re.test(tool);
  });
}
