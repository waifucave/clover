import type { AgentLive } from "./context";
import { clip, firstLine } from "./format";
import type { ConversationItem } from "./types";

/** What the sessions area says of one agent session. */
export interface AgentStatus {
  definition?: string;
  backend?: string;
  status: string;
}

/** The agents this conversation started: each one the sessions area names (`status`, keyed by session id), with the
 *  latest line it sent the bot and its backend. An agent that only appears in the messages is listed too. */
export function liveAgents(items: readonly ConversationItem[], status: Readonly<Record<string, AgentStatus>> | undefined): AgentLive[] {
  const lines = new Map<string, string>();
  const finished = new Map<string, { backend?: string; status: string }>();
  for (const it of items) {
    if (it.kind === "agent-report" && it.from.kind === "agent") {
      const line = firstLine(it.text);
      if (line) lines.set(it.from.id, clip(line, 140));
    } else if (it.kind === "task-notification" && it.task.kind === "agent") {
      finished.set(it.task.agentId, { ...(it.task.backend ? { backend: it.task.backend } : {}), status: it.status });
    }
  }
  const ids = new Set<string>([...Object.keys(status ?? {}), ...lines.keys(), ...finished.keys()]);
  return [...ids].map((id) => {
    const s = status?.[id];
    const f = finished.get(id);
    const definition = s?.definition ?? "";
    const backend = s?.backend ?? f?.backend;
    const line = lines.get(id);
    return {
      id,
      name: definition.includes(":") ? definition.slice(definition.indexOf(":") + 1) : definition || id,
      ...(backend ? { backend } : {}),
      status: f ? f.status : s?.status ?? "working",
      ...(line ? { line } : {}),
    };
  });
}
