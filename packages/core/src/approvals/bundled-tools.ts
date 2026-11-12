// Which bundled tool a bot's call is, for the approvals (`botApprovalCheck`'s `bundledTool`): the web plugin's search
// and fetch, and the bundled tools that only read (`BUNDLED_READ_TOOLS`). Only a server of the staged, digest-checked
// bundled copy counts: the plugin's record must say `bundled`, and its manifest in the staged copy must hash to the
// digest staging measured (`stagedManifest`). Any other plugin's tool of the same name is judged as a tool.
import { stagedManifest } from "../registry/bundled-stage";
import { BUNDLED_READ_TOOLS, WEB_PLUGIN_ID, type BundledToolKind } from "./bot-check";

/** One server a session is offered (`PluginMcp.servers`): the name it sees, whose it is, and its tools. */
export interface OfferedServer { server: string; plugin: string; tools: readonly { name: string }[] }

export interface BundledToolLookup {
  servers: readonly OfferedServer[];
  /** The plugin registry's record of a plugin: where it was found, and its folder. */
  record(pluginId: string): { source: string; folder: string } | undefined;
  /** The staged bundled copy this daemon verified at boot; undefined when it has none. */
  staged: { dir: string; digests: ReadonlyMap<string, string> } | undefined;
}

export function bundledToolKind(o: BundledToolLookup, tool: string): BundledToolKind | undefined {
  for (const s of o.servers) {
    if (s.plugin !== WEB_PLUGIN_ID && BUNDLED_READ_TOOLS[s.plugin] === undefined) continue;
    const t = s.tools.find((x) => `mcp__${s.server}__${x.name}` === tool);
    if (t === undefined) continue;
    const rec = o.record(s.plugin);
    if (rec === undefined || rec.source !== "bundled" || o.staged === undefined) return undefined;
    if (stagedManifest({ folder: rec.folder, stagedDir: o.staged.dir, digests: o.staged.digests }) === undefined) return undefined;
    if (s.plugin !== WEB_PLUGIN_ID) return BUNDLED_READ_TOOLS[s.plugin]!.includes(t.name) ? "read" : undefined;
    return t.name === "WebSearch" ? "web-search" : t.name === "WebFetch" ? "web-fetch" : undefined;
  }
  return undefined;
}
