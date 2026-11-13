// Settings' Tools tab: what the user says about each tool a plugin gives bots, always allow, ask or always block, for every
// bot on this computer. It is one store with the connector permissions (`agent/mcp/connector-permissions.ts`): a plugin's
// server is keyed in a tool's name exactly as a connector is (`mcp__<server>__<tool>`), so `settings.mcp.toolPermissions` is
// read live by the same floor (the PreToolUse hook and the approval bridge), with no restart, and `ask` here is the
// ABSENCE of a stored value, what happens without one (the approval level decides; a read-only tool may run with no card).
// The card's own "Always allow" (one bot, on the computers it was given on) stays in the broker's saved rules and is
// shown on the tool's row, where the user takes it back; nothing else is invented.
//
//   * Only the user sets or takes back a value (`userOnly`; the app's own Settings part, through a gesture). A plugin's
//     layer, its host half, a bot or an agent is refused (`requireUser`).
//   * A row's "all tools" writes each tool the plugin lists NOW (never `"*"`), and remembers that list in
//     `settings.mcp.toolsSeen`: a tool that appears later starts at Ask and is marked new, never inheriting the row's value.
//   * A stored value for a tool the plugin no longer lists is dropped when the user next sets one for that plugin, and
//     is never shown.
import { PLUGINS_METHODS } from "@waifucave/clover-protocol";
import { handler, requireUser, type MethodHandler } from "../rpc/handler";
import { connectorPermissionTable, type Settings } from "../settings";
import { setConnectorToolPermission } from "../settings";
import type { ConnectorPermission } from "../agent/mcp/connector-permissions";
import { OTHER_TOOL_KEY } from "./bot-check";
import { ruleKeyHash } from "./strings";

export interface ToolPermissionDeps {
  /** Every server listed here with its tools (`PluginMcp.toolListing`). */
  listing(): { server: string; plugin: string; name: string; tools: { name: string; title?: string }[] }[];
  /** A plugin's own name, for its heading. */
  pluginName(pluginId: string): string | undefined;
  loadSettings(): Settings;
  /** Saves the settings and tells the live table (the connector source's `noteWritten`). */
  saveSettings(next: Settings): void;
  savedFor(keyHash: string): { bot?: string; computers: string[] }[];
  forgetSaved(keyHash: string, bot: string): number;
}

/** The name a bot calls a plugin's tool by. */
export const pluginToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`;

const seenOf = (settings: Settings, server: string): readonly string[] | undefined => {
  const seen = (settings.mcp as { toolsSeen?: Record<string, unknown> } | undefined)?.toolsSeen?.[server];
  return Array.isArray(seen) && seen.every((n) => typeof n === "string") ? seen as string[] : undefined;
};

export function toolPermissionMethods(deps: ToolPermissionDeps): Record<string, MethodHandler> {
  const M = PLUGINS_METHODS;
  return {
    [M.toolPermissions.name]: handler(M.toolPermissions, async (_p, ctx) => {
      requireUser(ctx, "read the tool permissions");
      const settings = deps.loadSettings();
      const table = connectorPermissionTable(settings);
      const plugins = deps.listing()
        .filter((l) => l.tools.length > 0)
        .map((l) => {
          const row = table[l.server] ?? {};
          const seen = seenOf(settings, l.server);
          return {
            pluginId: l.plugin,
            name: deps.pluginName(l.plugin) ?? l.plugin,
            server: l.server,
            tools: l.tools.map((t) => {
              const stored: ConnectorPermission | undefined = row[t.name];
              return {
                name: t.name,
                ...(t.title === undefined ? {} : { title: t.title }),
                permission: stored ?? "ask",
                ...(seen !== undefined && !seen.includes(t.name) ? { isNew: true as const } : {}),
                cardRules: deps.savedFor(ruleKeyHash(`${OTHER_TOOL_KEY}${pluginToolName(l.server, t.name)}`)).flatMap((r) => (r.bot === undefined ? [] : [{ bot: r.bot, computers: r.computers }])),
              };
            }),
          };
        });
      return { plugins };
    }),

    [M.toolSetPermission.name]: handler(M.toolSetPermission, async (p, ctx) => {
      requireUser(ctx, "set a tool's permission");
      const listed = deps.listing().find((l) => l.server === p.server);
      if (listed === undefined) throw new Error("that plugin gives no tools here");
      const names = listed.tools.map((t) => t.name);
      if (p.tool !== undefined && !names.includes(p.tool)) throw new Error("the plugin doesn't give that tool");
      let next = deps.loadSettings();
      // Values for tools the plugin no longer lists go.
      const row = connectorPermissionTable(next)[p.server] ?? {};
      for (const stale of Object.keys(row)) if (!names.includes(stale)) next = setConnectorToolPermission(next, p.server, stale, undefined);
      for (const name of p.tool === undefined ? names : [p.tool]) next = setConnectorToolPermission(next, p.server, name, p.permission === "ask" ? undefined : p.permission);
      // What the plugin lists now: a tool it adds later is new, and keeps Ask.
      const seen = { ...((next.mcp as { toolsSeen?: Record<string, string[]> } | undefined)?.toolsSeen ?? {}), [p.server]: names };
      next = { ...next, mcp: { ...(next.mcp ?? {}), toolsSeen: seen } } as Settings;
      deps.saveSettings(next);
      return { ok: true as const };
    }),

    [M.toolTakeBackRule.name]: handler(M.toolTakeBackRule, async (p, ctx) => {
      requireUser(ctx, "take back a saved Always allow");
      return { removed: deps.forgetSaved(ruleKeyHash(`${OTHER_TOOL_KEY}${pluginToolName(p.server, p.tool)}`), p.bot) };
    }),
  };
}
