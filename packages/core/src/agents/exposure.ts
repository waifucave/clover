// How an agent is given a plugin tool the user set "on demand" (the tool setting, spec §6.7; contracts/tool-settings.ts):
// one answer per agent, from what its quirks say it can do, never from its name.
//
// * `agent-search`: the agent has a tool search of its own (`mcp.toolSearch: "own"`, Claude Code's). The bridge lists the
//   tool as it lists any other and flags only what is always on (`anthropic/alwaysLoad`); the agent's own search finds
//   and loads the rest. MOSS holds nothing back for it.
// * `host-search`: MOSS's own agent (`mcp.toolSearch: "host"`). Its runtime defers every tool the bridge does not flag, so an
//   on-demand tool is not in the model's tools until the bridge's `Glossary` loads it (the runtime's load key in its result), in that turn.
// * `list`: an agent with no search of its own that takes a changed list in a running session (`live`, or `next-turn` where
//   it can be opened again). The bridge's list leaves the tool out until the session loads it through `Glossary`; a load
//   changes the list, which the agent takes live or at its next turn.
// * `up-front`: an agent with neither. Nothing can hold a tool back, so on demand is offered from the start, as always on is.
import type { AgentQuirks } from "../contracts/agent-backend";

export type AgentExposure = "agent-search" | "host-search" | "list" | "up-front";

/** How a running session takes a changed tool list: what its backend declares (`mcp.toolListChanges`), and `next-turn`
 *  only where the agent can be opened again with its history (an honest `resume`, or a `load`). Nothing declared: `next-session`. */
export function listChangeModeOf(q: Pick<AgentQuirks, "mcp" | "sessions">): "live" | "next-turn" | "next-session" {
  const declared = q.mcp.toolListChanges ?? "next-session";
  if (declared !== "next-turn") return declared;
  return q.sessions.load.supported || (q.sessions.resume.supported && !q.sessions.resume.replays) ? "next-turn" : "next-session";
}

export function exposureOf(q: Pick<AgentQuirks, "mcp" | "sessions">): AgentExposure {
  if (q.mcp.toolSearch === "own") return "agent-search";
  if (q.mcp.toolSearch === "host") return "host-search";
  return listChangeModeOf(q) === "next-session" ? "up-front" : "list";
}
