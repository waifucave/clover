// Which bundled tool a bot's call is, for the approvals (`botApprovalCheck`'s `bundledTool`): the Browser tool (F5 turns
// it into a capability; until then the core names its plugin). Only a server of the staged, digest-checked bundled copy
// counts: the plugin's record must say `bundled`, and its manifest in the staged copy must hash to the digest staging
// measured (`stagedManifest`). Any other plugin's tool of the same name is judged as a tool.
//
// The web plugin's search and fetch and the builder's read-only PluginNew are no longer named here (R1, the owner's
// "no door checks a plugin's id", 2026-11-15): they are their manifests' `webSearch`, `webFetch` and `readOnly`, which
// hold for the build's copy (`builtCopy`) as an OK's would (registry/read-only-tools.ts).
import { stagedManifest } from "../registry/bundled-stage";
import type { BuiltCopy } from "../registry/read-only-tools";
import { BROWSER_PLUGIN_ID, type BundledToolKind } from "./bot-check";

/** One server a session is offered (`PluginMcp.servers`): the name it sees, whose it is, and its tools. */
export interface OfferedServer { server: string; plugin: string; tools: readonly { name: string }[] }

export interface BundledToolLookup {
  servers: readonly OfferedServer[];
  /** The plugin registry's record of a plugin: where it was found, and its folder. */
  record(pluginId: string): { source: string; folder: string } | undefined;
  /** The staged bundled copy this daemon verified at boot; undefined when it has none. */
  staged: { dir: string; digests: ReadonlyMap<string, string> } | undefined;
}

/** Whether a plugin is of the build's copy: installed as bundled, its folder in the staged copy, its manifest the one
 *  staging measured. What its manifest declares then holds as an OK's would, with no card. */
export function builtCopy(o: Pick<BundledToolLookup, "record" | "staged">): BuiltCopy {
  return (pluginId) => {
    const rec = o.record(pluginId);
    if (rec === undefined || rec.source !== "bundled" || o.staged === undefined) return false;
    return stagedManifest({ folder: rec.folder, stagedDir: o.staged.dir, digests: o.staged.digests }) !== undefined;
  };
}

export function bundledToolKind(o: BundledToolLookup, tool: string): BundledToolKind | undefined {
  for (const s of o.servers) {
    if (s.plugin !== BROWSER_PLUGIN_ID) continue;
    const t = s.tools.find((x) => `mcp__${s.server}__${x.name}` === tool);
    if (t === undefined) continue;
    if (!builtCopy(o)(s.plugin)) return undefined;
    return t.name === "Browser" ? "browser" : undefined;
  }
  return undefined;
}
