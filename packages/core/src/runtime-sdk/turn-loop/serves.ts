// Which plugins' entries reach a session (spec §5.1 scope, §9.3): the plugin's `scope` (`bots`, `agents`, `both`) for
// its skills, agent definitions and plugin listing, as it already was for its hooks and servers, and `onlyBackends`, which
// narrows the agents (the ACP backends, §9.3) a plugin reaches; the bots' own sessions are not backends and stay as the
// scope says. An agent session whose backend isn't known gets nothing from a plugin that names backends.
import type { PluginRegistry } from "../../contracts/plugin-registry";
import { servesSession, type HookSession } from "./hooks";

export type SessionLike = Pick<HookSession, "kind" | "bot">;

/** Whether a plugin that names `onlyBackends` reaches a session of `kind` running on `backend`. */
export function backendAllows(onlyBackends: readonly string[] | undefined, kind: SessionLike["kind"], backend?: string): boolean {
  if (onlyBackends === undefined || onlyBackends.length === 0) return true;
  if (kind !== "agent" && kind !== "coding") return true;
  return backend !== undefined && onlyBackends.includes(backend);
}

/** Whether the plugin whose manifest this is reaches `session` (on `backend`, for an agent). */
export function servesPlugin(manifest: { scope?: "bots" | "agents" | "both"; onlyBackends?: readonly string[] } | undefined, session: SessionLike, backend?: string): boolean {
  return servesSession(manifest?.scope ?? "both", session) && backendAllows(manifest?.onlyBackends, session.kind, backend);
}

/** `GlossaryDeps.serves` for one session: each plugin's own manifest decides. A plugin the registry doesn't hold is served (the
 *  entries that name it are the registry's to list). */
export function glossaryServes(registry: Pick<PluginRegistry, "get">, session: SessionLike, backend?: string): (pluginId: string) => boolean {
  return (pluginId) => servesPlugin(registry.get(pluginId)?.manifest as Parameters<typeof servesPlugin>[0], session, backend);
}
