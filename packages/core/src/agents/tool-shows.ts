// What a code session's (or a bot's agent's) plugin tool calls show in the conversation beside their names, as a bot's
// turn shows them (runtime-sdk/tool-display.ts): the tool's declared title on its `tool_call`, and what its successful
// result showed on its `tool_result`. General: any plugin tool the bridge serves, on any ACP agent.
//
// The bridge's call and the agent's own record of it are two messages with no shared id (the bridge's call id is its
// own), so a result's display waits here under the bridge tool's name and input, and the agent's call takes it when it
// ends: by the tool its title names (`mcp__<bridge server>__<tool>`, or any title that holds the tool's bridge name)
// and, of two calls of one tool, the one with the same input first. Display only: nothing here decides anything.
import type { ToolDisplay } from "@waifucave/moss-protocol";
import type { AgentToolShows } from "./driver";

/** The most results kept waiting for their call's end (a call the agent never reported ending). */
export const AGENT_DISPLAYS_MAX = 64;

/** The bridge tool a call's title names: `mcp__moss_<16 hex>__<tool>` (MOSS's own agent and Claude Code), its first word. */
const BRIDGE_TITLE = /^mcp__moss_[0-9a-f]{16}__(\S+)/;

function inputKey(v: unknown): string {
  try {
    return JSON.stringify(v ?? {}) ?? "{}";
  } catch {
    return "";
  }
}

export class AgentToolDisplays implements AgentToolShows {
  /** The bridge tools' declared titles, by bridge name, as the session's last listing gave them. */
  #titles = new Map<string, string>();
  readonly #waiting: { tool: string; input: string; display: ToolDisplay }[] = [];

  /** The session's bridge listing now (its plugin tools' titles). */
  listed(tools: readonly { name: string; displayTitle?: string }[]): void {
    this.#titles = new Map(tools.flatMap((t) => (t.displayTitle === undefined ? [] : [[t.name, t.displayTitle] as const])));
  }

  /** A bridge call's successful result showed this. */
  put(tool: string, input: unknown, display: ToolDisplay): void {
    this.#waiting.push({ tool, input: inputKey(input), display });
    while (this.#waiting.length > AGENT_DISPLAYS_MAX) this.#waiting.shift();
  }

  #toolOf(callTitle: string, known: Iterable<string>): string | undefined {
    const m = BRIDGE_TITLE.exec(callTitle);
    if (m !== null) return m[1];
    // Another agent's title: the longest bridge name it holds.
    let best: string | undefined;
    for (const t of known) if (callTitle.includes(t) && (best === undefined || t.length > best.length)) best = t;
    return best;
  }

  title(callTitle: string): string | undefined {
    const tool = this.#toolOf(callTitle, this.#titles.keys());
    return tool === undefined ? undefined : this.#titles.get(tool);
  }

  take(callTitle: string, rawInput: unknown): ToolDisplay | undefined {
    const tool = this.#toolOf(callTitle, this.#waiting.map((w) => w.tool));
    if (tool === undefined) return undefined;
    const key = inputKey(rawInput);
    let at = this.#waiting.findIndex((w) => w.tool === tool && w.input === key);
    if (at < 0) at = this.#waiting.findIndex((w) => w.tool === tool);
    if (at < 0) return undefined;
    return this.#waiting.splice(at, 1)[0]!.display;
  }
}
