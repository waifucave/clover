// The read-only and display-only tools a plugin's MCP server declares (`McpServerSchema.readOnly`, lane C's ask, and
// `McpServerSchema.contained`, the owner's ask for a plugin's own stage). The read-only ones (`readOnly`): the approval policy
// may let a call to one run without a card at the default level, but only as the OK card the user approved showed
// them. So it holds only for a running top-level plugin whose tree now is the one OK'd (`okHash` equal to `treeHash`),
// never a development folder (its claim was never on a card), and never a server that can reach the network
// (`readOnlyReachesNetwork`: an http server, a `network:` grant anywhere in the tree, a wrapper's network grant, or no
// plugin fence on this computer). A change to the list asks for the OK again (`changes.ts`), and a tool a server merely
// calls read-only at run time never is. The display-only ones (`contained`) hold to every one of those conditions, and
// besides, the tree holds no capability beyond reading Clover's own state (`CONTAINED_TOOL_CAPABILITIES`); a hit is a
// contained call (effect `other`), never a read. One tool is on one list at most.
import { containedToolsHold, readOnlyReachesNetwork } from "@waifucave/clover-plugin-sdk";
import { topPluginIdOf } from "@waifucave/clover-protocol";
import type { PluginRegistry } from "../contracts/plugin-registry";
import { pluginFenceAvailable } from "./plugin-fence";

type DeclaredList = "readOnly" | "contained";

/** The conditions both lists share (one place to get them wrong): a running top-level plugin (a child's list isn't on
 *  its tree's card), not a dev folder, its tree now the one OK'd, and `tool` on that server's `list` there. The server
 *  and the tree's capabilities, for the list's own network and capability rule, or undefined. */
function declaredTool(registry: Pick<PluginRegistry, "get" | "list">, pluginId: string, server: string, tool: string, list: DeclaredList):
  { server: { type?: unknown; url?: unknown }; capabilities: string[]; wrappedNetwork: boolean } | undefined {
  if (topPluginIdOf(pluginId) !== pluginId) return undefined;
  const r = registry.get(pluginId);
  if (r === undefined || r.dev || r.state !== "running" || r.okHash === undefined || r.okHash !== r.treeHash) return undefined;
  const s = (r.manifest?.contributes as { mcpServers?: Record<string, { type?: unknown; url?: unknown; readOnly?: readonly string[]; contained?: readonly string[] }> } | undefined)?.mcpServers?.[server];
  const names = s?.[list];
  if (s === undefined || !Array.isArray(names) || !names.includes(tool)) return undefined;
  // One tool, one class (the validator refuses a tool on both lists): a tool both name is neither.
  const other = s[list === "readOnly" ? "contained" : "readOnly"];
  if (Array.isArray(other) && other.includes(tool)) return undefined;
  const tree = registry.list().filter((x) => topPluginIdOf(x.id) === pluginId);
  const capabilities = tree.flatMap((x) => [...x.capabilities, ...(Array.isArray(x.manifest?.capabilities) ? (x.manifest.capabilities as string[]) : [])]);
  return { server: s, capabilities, wrappedNetwork: r.provenance.wrapped?.network !== undefined };
}

/**
 * Whether a call to `tool` on `server` of `pluginId` may run without an approval card at the default level.
 *
 * What the caller must hold to:
 * - Pass the plugin, server and tool the call was actually routed to (the router's binding), never names parsed back
 *   out of a tool's `mcp__<server>__<tool>` string: a crafted name must not borrow another server's list.
 * - Call it at decision time, for each call; never cache the answer (an OK, a tree change, a revocation or a dev folder
 *   standing over the plugin changes it at any moment).
 * - A hit is effect `read` under the computer's approval level, nothing more: a level that asks for reads still asks.
 */
export function pluginToolReadOnly(registry: Pick<PluginRegistry, "get" | "list">, pluginId: string, server: string, tool: string, o: { fenced?: boolean } = {}): boolean {
  const d = declaredTool(registry, pluginId, server, tool, "readOnly");
  return d !== undefined && !readOnlyReachesNetwork(d.server, { capabilities: d.capabilities, wrappedNetwork: d.wrappedNetwork, fenced: o.fenced ?? pluginFenceAvailable() });
}

/**
 * Whether a call to `tool` on `server` of `pluginId` is a contained call: a display-only tool (`McpServerSchema.contained`)
 * on the tree the user OK'd, where its tree can't reach the network and holds no capability beyond reading Clover's
 * state (`containedToolsHold`). The call's arguments are data the bot hands the plugin, which may keep them in its own
 * data: that is why no network anywhere in the tree is a hard condition, and why the capabilities are bounded.
 *
 * The caller holds to what `pluginToolReadOnly` asks (the routed plugin, server and tool, never parsed names; decided
 * at each call, never cached). A hit is effect `other` with `contained`, under the computer's level and after the
 * broker's earlier rules (the fence, a card every time, an unresolved path): it runs without a card at the default
 * level and above, asks at "ask" and is refused at read-only.
 */
export function pluginToolContained(registry: Pick<PluginRegistry, "get" | "list">, pluginId: string, server: string, tool: string, o: { fenced?: boolean } = {}): boolean {
  const d = declaredTool(registry, pluginId, server, tool, "contained");
  return d !== undefined && containedToolsHold(d.server, { capabilities: d.capabilities, wrappedNetwork: d.wrappedNetwork, fenced: o.fenced ?? pluginFenceAvailable() });
}
