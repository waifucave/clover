// The read-only tools a plugin's MCP server declares (lane C's ask; `McpServerSchema.readOnly`): the approval policy
// may let a call to one run without a card at the default level, but only as the OK card the user approved showed
// them. So it holds only for a running top-level plugin whose tree now is the one OK'd (`okHash` equal to `treeHash`),
// never a development folder (its claim was never on a card), and never a server that can reach the network
// (`readOnlyReachesNetwork`: an http server, a `network:` grant anywhere in the tree, a wrapper's network grant, or no
// plugin fence on this computer). A change to the list asks for the OK again (`changes.ts`), and a tool a server merely
// calls read-only at run time never is.
import { readOnlyReachesNetwork } from "@waifucave/clover-plugin-sdk";
import { topPluginIdOf } from "@waifucave/clover-protocol";
import type { PluginRegistry } from "../contracts/plugin-registry";
import { pluginFenceAvailable } from "./plugin-fence";

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
  // A child's list isn't named on its tree's OK card (the card shows the top plugin's servers).
  if (topPluginIdOf(pluginId) !== pluginId) return false;
  const r = registry.get(pluginId);
  if (r === undefined || r.dev || r.state !== "running" || r.okHash === undefined || r.okHash !== r.treeHash) return false;
  const s = (r.manifest?.contributes as { mcpServers?: Record<string, { type?: unknown; url?: unknown; readOnly?: readonly string[] }> } | undefined)?.mcpServers?.[server];
  if (!Array.isArray(s?.readOnly) || !s.readOnly.includes(tool)) return false;
  const tree = registry.list().filter((x) => topPluginIdOf(x.id) === pluginId);
  const capabilities = tree.flatMap((x) => [...x.capabilities, ...(Array.isArray(x.manifest?.capabilities) ? (x.manifest.capabilities as string[]) : [])]);
  return !readOnlyReachesNetwork(s, { capabilities, wrappedNetwork: r.provenance.wrapped?.network !== undefined, fenced: o.fenced ?? pluginFenceAvailable() });
}
