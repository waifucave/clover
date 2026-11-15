// The build's own copy (`builtCopy`): a plugin of the staged, digest-checked bundled copy holds what its manifest declares
// as the user's OK would. No tool is named here by a plugin's id: the Browser tool is its manifest's `browserTools` (F5),
// the web plugin's search and fetch its `webSearch` and `webFetch`, the builder's PluginNew its `readOnly` (R1, the
// owner's "no door checks a plugin's id", 2026-11-15; registry/read-only-tools.ts).
import { stagedManifest } from "../registry/bundled-stage";
import type { BuiltCopy } from "../registry/read-only-tools";

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
