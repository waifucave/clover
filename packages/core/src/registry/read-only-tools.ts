// The read-only tools a plugin's MCP server declares (lane C's ask; `McpServerSchema.readOnly`): the approval policy
// may let a call to one run without a card at the default level, but only as the OK card the user approved showed
// them. So it holds only for a running plugin whose tree now is the one OK'd (`okHash` equal to `treeHash`); a change
// to the list asks for the OK again (`changes.ts`), and a tool a server merely calls read-only at run time never is.
import type { PluginRegistry } from "../contracts/plugin-registry";

export function pluginToolReadOnly(registry: Pick<PluginRegistry, "get">, pluginId: string, server: string, tool: string): boolean {
  const r = registry.get(pluginId);
  if (r === undefined || r.state !== "running" || r.okHash === undefined || r.okHash !== r.treeHash) return false;
  const s = (r.manifest?.contributes as { mcpServers?: Record<string, { readOnly?: readonly string[] }> } | undefined)?.mcpServers?.[server];
  return Array.isArray(s?.readOnly) && s.readOnly.includes(tool);
}
