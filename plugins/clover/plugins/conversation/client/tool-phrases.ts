// What a run of tool calls says in one line: "Ran 3 commands, read 2 files", "Running a command",
// "Waiting to run a command". Pure, so the sentence a run reads as is tested apart from any view.
import type { ToolCall, ToolStatus } from "./types";

/** A tool's phrase: its verb in three forms and its object, one or many (`#` is the count). */
interface Phrase {
  past: string;
  doing: string;
  base: string;
  one: string;
  many: string;
}

const p = (past: string, doing: string, base: string, one: string, many: string): Phrase => ({ past, doing, base, one, many });

/** The core tools (spec §6.7) and the tools we ship under `mcp__clover__` (spec §5.3). */
const PHRASES: Record<string, Phrase> = {
  Bash: p("ran", "running", "run", "a command", "# commands"),
  PowerShell: p("ran", "running", "run", "a PowerShell command", "# PowerShell commands"),
  Read: p("read", "reading", "read", "a file", "# files"),
  Write: p("wrote", "writing", "write", "a file", "# files"),
  Edit: p("made", "making", "make", "an edit", "# edits"),
  Glob: p("looked for", "looking for", "look for", "files", "files # times"),
  Grep: p("searched", "searching", "search", "files", "files # times"),
  SendMessage: p("sent", "sending", "send", "a message", "# messages"),
  Agent: p("started", "starting", "start", "an agent", "# agents"),
  TaskStop: p("stopped", "stopping", "stop", "an agent", "# agents"),
  ListAgents: p("checked", "checking", "check", "running sessions", "running sessions # times"),
  Routine: p("wrote", "writing", "write", "a routine", "# routines"),
  Glossary: p("searched", "searching", "search", "the glossary", "the glossary # times"),
  AskUserQuestion: p("asked", "asking", "ask", "a question", "# questions"),
  TaskCreate: p("added", "adding", "add", "a task", "# tasks"),
  TaskUpdate: p("updated", "updating", "update", "a task", "# tasks"),
  TaskList: p("checked", "checking", "check", "the task list", "the task list # times"),
  TaskGet: p("checked", "checking", "check", "a task", "# tasks"),
  TaskOutput: p("checked", "checking", "check", "a command's output", "command output # times"),
  Monitor: p("watched", "watching", "watch", "a command", "# commands"),
  ListMcpResources: p("listed", "listing", "list", "resources", "resources # times"),
  ReadMcpResource: p("read", "reading", "read", "a resource", "# resources"),
  mcp__clover__WebSearch: p("searched", "searching", "search", "the web", "the web # times"),
  mcp__clover__WebFetch: p("fetched", "fetching", "fetch", "a page", "# pages"),
  mcp__clover__Browser: p("used", "using", "use", "the browser", "the browser # times"),
};

/** `mcp__<namespace>__<Tool>` split, or null for any other name. */
export function splitPluginTool(name: string): { namespace: string; tool: string } | null {
  const m = /^mcp__([a-z0-9-]+)__(.+)$/.exec(name);
  return m ? { namespace: m[1] ?? "", tool: m[2] ?? "" } : null;
}

function phraseFor(name: string): Phrase {
  const known = PHRASES[name];
  if (known) return known;
  const plugin = splitPluginTool(name);
  const thing = plugin ? `${plugin.tool} (${plugin.namespace})` : name;
  return p("used", "using", "use", thing, `${thing} # times`);
}

/** Done, still going, held for the user's OK, or cut off by an interrupt (it may have run in part). */
export type PhraseForm = "done" | "doing" | "waiting" | "stopped";

export function formOf(status: ToolStatus): PhraseForm {
  if (status === "waiting") return "waiting";
  if (status === "running") return "doing";
  if (status === "interrupted") return "stopped";
  return "done";
}

/** One stretch of same-named calls in one form, as a lowercase fragment. */
export function toolFragment(name: string, count: number, form: PhraseForm = "done"): string {
  const phrase = phraseFor(name);
  const object = count === 1 ? phrase.one : phrase.many.replace("#", String(count));
  if (form === "doing") return `${phrase.doing} ${object}`;
  if (form === "waiting") return `waiting to ${phrase.base} ${object}`;
  if (form === "stopped") return `stopped ${phrase.doing} ${object}`;
  return `${phrase.past} ${object}`;
}

/** Consecutive calls of the same tool in the same form, in order. */
export function stretches(calls: readonly ToolCall[]): { name: string; form: PhraseForm; calls: ToolCall[] }[] {
  const out: { name: string; form: PhraseForm; calls: ToolCall[] }[] = [];
  for (const call of calls) {
    const form = formOf(call.status);
    const last = out[out.length - 1];
    if (last && last.name === call.name && last.form === form) last.calls.push(call);
    else out.push({ name: call.name, form, calls: [call] });
  }
  return out;
}

/** How many fragments a summary line names before it says "and N more". */
export const SUMMARY_FRAGMENTS = 3;

/** The whole run as one summary line, first letter capitalized: "Ran a command, edited 2 files, and
 *  read a file"; past three stretches, the rest count as calls ("…, and 3 more"). */
export function toolSentence(calls: readonly ToolCall[]): string {
  const all = stretches(calls);
  const named = all.length > SUMMARY_FRAGMENTS ? all.slice(0, SUMMARY_FRAGMENTS - 1) : all;
  const parts = named.map((s) => toolFragment(s.name, s.calls.length, s.form));
  const rest = all.slice(named.length).reduce((n, s) => n + s.calls.length, 0);
  if (rest > 0) parts.push(rest === 1 ? "1 more" : `${rest} more`);
  const sentence =
    parts.length <= 1
      ? (parts[0] ?? "")
      : parts.length === 2
        ? `${parts[0]} and ${parts[1]}`
        : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** The one status a collapsed run shows: anything still going outranks a failure, which outranks an
 *  interruption. */
export function runStatus(calls: readonly ToolCall[]): ToolStatus {
  const has = (s: ToolStatus) => calls.some((c) => c.status === s);
  if (has("waiting")) return "waiting";
  if (has("running")) return "running";
  if (has("failed")) return "failed";
  if (has("interrupted")) return "interrupted";
  return "succeeded";
}

/** The computer every call ran on, when they share one. */
export function sharedComputer(calls: readonly ToolCall[]): string | undefined {
  const first = calls[0]?.computer;
  return first !== undefined && calls.every((c) => c.computer === first) ? first : undefined;
}
