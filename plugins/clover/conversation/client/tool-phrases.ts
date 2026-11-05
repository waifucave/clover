// What a run of tool calls says in one line: "Ran 3 commands, read 2 files". Pure, so the sentence a
// run reads as is tested apart from any view.
import type { ToolCall, ToolStatus } from "./types";

type Phrase = (count: number) => string;

const times = (n: number) => (n === 1 ? "" : ` ${n} times`);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("#", String(n)));

/** The core tools (spec §6.7) and the tools we ship under `mcp__clover__` (spec §5.3). */
const PHRASES: Record<string, Phrase> = {
  Bash: (n) => plural(n, "ran a command", "ran # commands"),
  PowerShell: (n) => plural(n, "ran a PowerShell command", "ran # PowerShell commands"),
  Read: (n) => plural(n, "read a file", "read # files"),
  Write: (n) => plural(n, "wrote a file", "wrote # files"),
  Edit: (n) => plural(n, "made an edit", "made # edits"),
  Glob: (n) => `looked for files${times(n)}`,
  Grep: (n) => `searched files${times(n)}`,
  SendMessage: (n) => plural(n, "sent a message", "sent # messages"),
  Agent: (n) => plural(n, "started an agent", "started # agents"),
  TaskStop: (n) => plural(n, "stopped an agent", "stopped # agents"),
  ListAgents: (n) => `checked running sessions${times(n)}`,
  Routine: (n) => plural(n, "wrote a routine", "wrote # routines"),
  Glossary: (n) => `searched the glossary${times(n)}`,
  AskUserQuestion: (n) => plural(n, "asked a question", "asked # questions"),
  TaskCreate: (n) => plural(n, "added a task", "added # tasks"),
  TaskUpdate: (n) => plural(n, "updated a task", "updated # tasks"),
  TaskList: (n) => `checked the task list${times(n)}`,
  TaskGet: (n) => `checked a task${times(n)}`,
  TaskOutput: (n) => `checked a command's output${times(n)}`,
  Monitor: (n) => plural(n, "watched a command", "watched # commands"),
  ListMcpResources: (n) => `listed resources${times(n)}`,
  ReadMcpResource: (n) => plural(n, "read a resource", "read # resources"),
  mcp__clover__WebSearch: (n) => `searched the web${times(n)}`,
  mcp__clover__WebFetch: (n) => plural(n, "fetched a page", "fetched # pages"),
  mcp__clover__Browser: (n) => `used the browser${times(n)}`,
};

/** `mcp__<namespace>__<Tool>` split, or null for any other name. */
export function splitPluginTool(name: string): { namespace: string; tool: string } | null {
  const m = /^mcp__([a-z0-9-]+)__(.+)$/.exec(name);
  return m ? { namespace: m[1] ?? "", tool: m[2] ?? "" } : null;
}

/** One stretch of same-named calls as a lowercase fragment. */
export function toolFragment(name: string, count: number): string {
  const phrase = PHRASES[name];
  if (phrase) return phrase(count);
  const plugin = splitPluginTool(name);
  if (plugin) return `used ${plugin.tool} (${plugin.namespace})${times(count)}`;
  return `used ${name}${times(count)}`;
}

/** Consecutive calls of the same tool, in order. */
export function stretches(calls: readonly ToolCall[]): { name: string; calls: ToolCall[] }[] {
  const out: { name: string; calls: ToolCall[] }[] = [];
  for (const call of calls) {
    const last = out[out.length - 1];
    if (last && last.name === call.name) last.calls.push(call);
    else out.push({ name: call.name, calls: [call] });
  }
  return out;
}

/** The whole run as one sentence, first letter capitalized. */
export function toolSentence(calls: readonly ToolCall[]): string {
  const sentence = stretches(calls)
    .map((s) => toolFragment(s.name, s.calls.length))
    .join(", ");
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
