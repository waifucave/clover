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

/** A plugin's scope (spec §5.1): `bots`, `agents`, `both` (the default), or `own-bot`: a bot plugin's own parts, for
 *  that bot alone (its hooks, skills, agent definitions and servers that say so, or its whole plugin's). */
export type PluginScope = "bots" | "agents" | "both" | "own-bot";

/** A session as the scope rule reads it: its kind, and its bot (a bot's own session's, or the bot whose delegation an
 *  `agent` session is). In Clover an `agent` session is always a bot's delegation (the agent manager's); a session the
 *  user started is `coding`. */
export interface ScopeSession {
  kind: string;
  bot?: string;
}

/** THE scope rule, one for every place a plugin's parts reach a session (hooks, the bots' Glossary, the MCP servers,
 *  an agent's bridge and placed parts):
 *  - `bots`: a bot's own sessions (its conversation, side threads) and the agents it delegates to (its work: §5.3, "a
 *    hook scoped to `bots` covers the agents a bot starts"; bots are equal, so every bot's);
 *  - `agents`: every agent session, a bot's delegation or the user's own coding session (§9.3 [D]);
 *  - `both`: every session;
 *  - `own-bot`: as `bots`, for the bot the plugin's tree is (a bot's id is its plugin's) and the agents it starts. */
export function servesScope(scope: PluginScope, s: ScopeSession, pluginId?: string): boolean {
  if (scope === "both") return true;
  if (scope === "own-bot") return pluginId !== undefined && s.bot !== undefined && topPluginIdOf(s.bot) === topPluginIdOf(pluginId) && servesScope("bots", s);
  if (scope === "bots") return s.kind === "bot" || s.kind === "side-thread" || (s.kind === "agent" && s.bot !== undefined);
  if (scope === "agents") return s.kind === "agent" || s.kind === "coding";
  return false;
}

const SCOPES: ReadonlySet<string> = new Set(["bots", "agents", "both", "own-bot"]);

/** A plugin part's scope: the entry's own (an MCP server's or hook's `scope`), else its plugin's manifest's, else its
 *  top plugin's (a child takes its tree's), else `both`. */
export function scopeOf(registry: Pick<PluginRegistry, "get">, pluginId: string, entryScope?: unknown): PluginScope {
  const valid = (v: unknown): PluginScope | undefined => (typeof v === "string" && SCOPES.has(v) ? (v as PluginScope) : undefined);
  const manifestScope = (id: string) => valid((registry.get(id)?.manifest as { scope?: unknown } | undefined)?.scope);
  return valid(entryScope) ?? manifestScope(pluginId) ?? manifestScope(topPluginIdOf(pluginId)) ?? "both";
}

/** Whether a plugin's skills, agent definitions and plugin listing reach a session: its scope (`scopeOf`) serves the
 *  session (`servesScope`) and its `onlyBackends` the session's backend (`servesBackend`). The bots' Glossary and an
 *  agent's bridge and placed parts both ask this. */
export function partsServe(registry: Pick<PluginRegistry, "get">, pluginId: string, s: ScopeSession & { backend?: string }): boolean {
  return servesScope(scopeOf(registry, pluginId), { kind: s.kind, ...(s.bot === undefined ? {} : { bot: s.bot }) }, pluginId)
    && servesBackend(registry, pluginId, s.kind, s.backend);
}
