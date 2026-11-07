// What Clover's plugins give an agent beyond the bridge (spec §9.3 "How plugins reach an ACP agent"): skills, agent
// definitions and hooks, for the plugins scoped to `agents` or `both` (§5.1). Every agent reaches skills through the
// bridge's `Glossary`; a backend that reads its own folders also gets them placed there (Claude Code: skills, agent
// definitions, and command hooks through Clover's shim). Lane B's registry (B-M2) fills `PluginPartsSource`; until then
// there are none.

/** The `hooks` point's events (the plugin SDK's `HOOK_EVENT_NAMES`, which the core doesn't depend on). */
export type HookEvent = "tool.before" | "tool.after" | "message.in" | "message.out" | "turn.start" | "turn.end" | "compact.before" | "compact.after";

export interface PluginParts {
  /** Skill folders, each holding a `SKILL.md`. */
  skills: { name: string; pluginId: string; dir: string }[];
  /** Claude-style agent files (`agents/*.md`, front matter and instructions). */
  agents: { name: string; pluginId: string; markdown: string }[];
  /** Hooks with a `command`, which speaks Claude Code's hook protocol (§5.3). */
  hooks: { id: string; pluginId: string; on: readonly HookEvent[]; tools?: readonly string[]; command: string; args?: readonly string[]; timeoutMs?: number }[];
}

export const NO_PARTS: PluginParts = { skills: [], agents: [], hooks: [] };

export interface PluginPartsSource {
  /** The parts in one agent session's scope. */
  parts(sessionId: string): Promise<PluginParts>;
}
