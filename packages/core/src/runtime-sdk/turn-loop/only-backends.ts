// A plugin's `onlyBackends` (spec §5.1: "A plugin may also limit itself to certain agent backends, for example only
// Claude Code"): an agent session on a backend the list leaves out gets none of the plugin's MCP servers, skills, agent
// definitions or hooks. Bots aren't agent backends: the list never narrows what a bot gets (its `scope` does). A
// session Clover's own runtime drives (a bot's delegation on Clover's agent, or the user's coding session) is on the
// in-process backend, `clover`; an ACP agent's is its backend's id (`claude-code`, `codex`, …).
import { topPluginIdOf } from "@waifucave/clover-protocol";
import type { PluginRegistry } from "../../contracts/plugin-registry";

/** Clover's own in-process backend (`IN_PROCESS_BACKEND_ID`, subagent-backend.ts, and the agent manager's
 *  `HOOKED_IN_RUNTIME_BACKEND`). */
export const CLOVER_BACKEND = "clover";

/** Clover's own coding agent (`clover-code`, the user's coding session): its runtime is Clover's, so its sessions are
 *  on the backend `clover` as far as a plugin's list goes (spec §5.1). */
const CLOVER_RUNTIME_BACKENDS: ReadonlySet<string> = new Set([CLOVER_BACKEND, "clover-code"]);

/** The backend id a plugin's `onlyBackends` names for a session on `backend`: `clover` for Clover's own runtime. */
export function listedBackendOf(backend: string): string {
  return CLOVER_RUNTIME_BACKENDS.has(backend) ? CLOVER_BACKEND : backend;
}

/** Whether `pluginId`'s entries reach a session of `kind` on `backend` by its `onlyBackends` (its own list, else its top
 *  plugin's). Every session but an agent's or a coding one is reached; so is every backend when there is no list. */
export function servesBackend(registry: Pick<PluginRegistry, "get">, pluginId: string, kind: string, backend: string = CLOVER_BACKEND): boolean {
  if (kind !== "agent" && kind !== "coding") return true;
  const own = (registry.get(pluginId)?.manifest as { onlyBackends?: unknown } | undefined)?.onlyBackends;
  const list = own ?? (registry.get(topPluginIdOf(pluginId))?.manifest as { onlyBackends?: unknown } | undefined)?.onlyBackends;
  return !Array.isArray(list) || list.length === 0 || list.includes(listedBackendOf(backend));
}

/** Whether `pluginId`'s skills and agent definitions reach a session of `kind` by its manifest's `scope` (its own, else
 *  its top plugin's; `both` by default), read as its MCP servers' is: `bots` reaches bots' conversations and side
 *  threads, `agents` the agents' and the user's coding sessions. */
export function scopeServes(registry: Pick<PluginRegistry, "get">, pluginId: string, kind: string): boolean {
  const scopeOf = (id: string) => (registry.get(id)?.manifest as { scope?: unknown } | undefined)?.scope;
  const scope = scopeOf(pluginId) ?? scopeOf(topPluginIdOf(pluginId)) ?? "both";
  if (scope === "both") return true;
  if (scope === "bots") return kind === "bot" || kind === "side-thread";
  if (scope === "agents") return kind === "agent" || kind === "coding";
  return false;
}
