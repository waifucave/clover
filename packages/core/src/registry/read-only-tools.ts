// The read-only and display-only tools a plugin's MCP server declares (`McpServerSchema.readOnly`, lane C's ask, and
// `McpServerSchema.contained`, the owner's ask for a plugin's own stage). The read-only ones (`readOnly`): the approval policy
// may let a call to one run without a card at the default level, but only as the OK card the user approved showed
// them. So it holds only for a running top-level plugin whose tree now is the one OK'd (`okHash` equal to `treeHash`),
// never a development folder (its claim was never on a card), and never a server that can reach the network
// (`readOnlyReachesNetwork`: an http server, a `network:` grant anywhere in the tree, a wrapper's network grant, or no
// plugin fence on this computer). A change to the list asks for the OK again (`changes.ts`), and a tool a server merely
// calls read-only at run time never is. The display-only ones (`contained`) hold to every one of those conditions, and
// besides, the tree holds no capability beyond reading MOSS's own state (`CONTAINED_TOOL_CAPABILITIES`); a hit is a
// contained call (effect `other`), never a read. One tool is on one list at most.
//
// The build's own copy (R1, the owner's "no door checks a plugin's id", 2026-11-15): a plugin of the staged,
// digest-checked bundled copy holds what its manifest declares as the user's OK would (`built`), with no card: the only
// thing "bundled" means. So the builder's `readOnly` PluginNew and the web plugin's `webSearch`/`webFetch` hold from their
// manifests, never from a plugin id the core names.
//
// The web tools (`webSearch`, `webFetch`): a call is judged as a web search or a page fetch, as MOSS's own web plugin's
// are. They hold for a top-level plugin on the tree the user OK'd (the card names them, with a warning), or for the
// build's copy; never a dev folder.
//
// None of the lists holds for a tree that names programs it runs outside its sandbox (`host.outside.programs`, P5),
// the build's copy's included (`treeRunsOutside`): every tool of it asks as any tool does.
import { containedToolsHold, readOnlyReachesNetwork } from "@waifucave/moss-plugin-sdk";
import { topPluginIdOf } from "@waifucave/moss-protocol";
import { grantsInForce, type PluginRegistry } from "../contracts/plugin-registry";
import { pluginFenceAvailable } from "./plugin-fence";

type DeclaredList = "readOnly" | "contained" | "webSearch" | "webFetch" | "browserTools";

/** Whether a plugin is of the build's staged, digest-checked copy (the daemon's `stagedManifest` check on the record's
 *  folder, its source `bundled`): its manifest's claims hold as an OK's would. Absent: none is. */
export type BuiltCopy = (pluginId: string) => boolean;

/** Whether `pluginId`'s tree names programs of the user's it runs outside its sandbox (`host.outside.programs`, P5):
 *  then none of its tools runs without a card, the build's copy's included. Its tools are its code, which can run those
 *  programs with what a bot hands them. By the manifests, never by an id. */
export function treeRunsOutside(registry: Pick<PluginRegistry, "get" | "list">, pluginId: string): boolean {
  const top = topPluginIdOf(pluginId);
  const names = (m: unknown) => {
    const p = (m as { host?: { outside?: { programs?: unknown } } } | undefined)?.host?.outside?.programs;
    return Array.isArray(p) && p.length > 0;
  };
  return names(registry.get(top)?.manifest) || registry.list().some((x) => topPluginIdOf(x.id) === top && names(x.manifest));
}

/** A tool of a plugin of the build's copy on `list` of its server (any plugin of the copy, a child too): the build
 *  granted it, with no card and no network condition, unless its tree runs programs outside its sandbox. */
function builtTool(registry: Pick<PluginRegistry, "get" | "list">, pluginId: string, server: string, tool: string, list: DeclaredList, built: BuiltCopy | undefined): boolean {
  if (built === undefined || !built(pluginId)) return false;
  if (treeRunsOutside(registry, pluginId)) return false;
  const r = registry.get(pluginId);
  if (r === undefined || r.dev || r.state !== "running") return false;
  const s = (r.manifest?.contributes as { mcpServers?: Record<string, Partial<Record<DeclaredList, readonly string[]>>> } | undefined)?.mcpServers?.[server];
  const names = s?.[list];
  if (!Array.isArray(names) || !names.includes(tool)) return false;
  // One tool, one class.
  return (["readOnly", "contained", "webSearch", "webFetch", "browserTools"] as const).filter((l) => l !== list && Array.isArray(s?.[l]) && s![l]!.includes(tool)).length === 0;
}

/** The conditions both lists share (one place to get them wrong): a running top-level plugin (a child's list isn't on
 *  its tree's card), not a dev folder, its tree now the one OK'd, and `tool` on that server's `list` there. The server
 *  and the tree's capabilities, for the list's own network and capability rule, or undefined. */
function declaredTool(registry: Pick<PluginRegistry, "get" | "list">, pluginId: string, server: string, tool: string, list: DeclaredList):
  { server: { type?: unknown; url?: unknown }; capabilities: string[]; wrappedNetwork: boolean } | undefined {
  if (topPluginIdOf(pluginId) !== pluginId) return undefined;
  // A tree that runs programs outside its sandbox has no tool that skips the card (P5): its card says they still ask.
  if (treeRunsOutside(registry, pluginId)) return undefined;
  const r = registry.get(pluginId);
  if (r === undefined || r.dev || r.state !== "running" || r.okHash === undefined || r.okHash !== r.treeHash) return undefined;
  const s = (r.manifest?.contributes as { mcpServers?: Record<string, { type?: unknown; url?: unknown } & Partial<Record<DeclaredList, readonly string[]>>> } | undefined)?.mcpServers?.[server];
  const names = s?.[list];
  if (s === undefined || !Array.isArray(names) || !names.includes(tool)) return undefined;
  // One tool, one class (the validator refuses a tool on two lists): a tool two name is none.
  if ((["readOnly", "contained", "webSearch", "webFetch", "browserTools"] as const).some((l) => l !== list && Array.isArray(s[l]) && s[l]!.includes(tool))) return undefined;
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
export function pluginToolReadOnly(registry: Pick<PluginRegistry, "get" | "list">, pluginId: string, server: string, tool: string, o: { fenced?: boolean; built?: BuiltCopy } = {}): boolean {
  if (builtTool(registry, pluginId, server, tool, "readOnly", o.built)) return true;
  const d = declaredTool(registry, pluginId, server, tool, "readOnly");
  return d !== undefined && !readOnlyReachesNetwork(d.server, { capabilities: d.capabilities, wrappedNetwork: d.wrappedNetwork, fenced: o.fenced ?? pluginFenceAvailable() });
}

/**
 * Whether a call to `tool` on `server` of `pluginId` is a contained call: a display-only tool (`McpServerSchema.contained`)
 * on the tree the user OK'd, where its tree can't reach the network and holds no capability beyond reading MOSS's
 * state (`containedToolsHold`). The call's arguments are data the bot hands the plugin, which may keep them in its own
 * data: that is why no network anywhere in the tree is a hard condition, and why the capabilities are bounded.
 *
 * The caller holds to what `pluginToolReadOnly` asks (the routed plugin, server and tool, never parsed names; decided
 * at each call, never cached). A hit is effect `other` with `contained`, under the computer's level and after the
 * broker's earlier rules (the fence, a card every time, an unresolved path): it runs without a card at the default
 * level and above, asks at "ask" and is refused at read-only.
 *
 * What it leaves open, as for `readOnly` (spec §9.1): the plugin's UI layer reaches no network but for WebRTC's
 * connectivity checks, not proven closed, so a hostile plugin with a UI layer could try to send what its tools were
 * handed; what they were handed may sit in its data and its synced store, which reaches the user's other computers
 * running the same tree; and a later version that gains the network could send it, an update whose OK card says so
 * (`gainsNetworkLines`).
 *
 * Its hooks are their own power, named on the OK card, and a contained tool adds nothing to it. A hook handler's
 * return can do this much, by event (`HOOK_RETURNS`), on any session its scope reaches, this tool's calls included:
 * `tool.before` may deny a call, send it to a card (`ask`) or replace its input, never allow it; `tool.after` may
 * replace a result; `message.in` and `message.out` may replace a message's text; `turn.start` may add a labelled
 * note; `turn.end`, `compact.before` and `compact.after` only observe. A `command` hook (Claude Code's protocol) has
 * the same reach, an `allow` ignored.
 */
export function pluginToolContained(registry: Pick<PluginRegistry, "get" | "list">, pluginId: string, server: string, tool: string, o: { fenced?: boolean } = {}): boolean {
  const d = declaredTool(registry, pluginId, server, tool, "contained");
  return d !== undefined && containedToolsHold(d.server, { capabilities: d.capabilities, wrappedNetwork: d.wrappedNetwork, fenced: o.fenced ?? pluginFenceAvailable() });
}

/**
 * How the approvals judge a call to `tool` on `server` of `pluginId` that its manifest declares a web tool: `web-search`
 * (`webSearch`: effect `search`) or `web-fetch` (`webFetch`: a page fetch of `input.url`, contained when the session
 * already saw the address and the turn's budget holds, its "Always allow" kept for the site). Undefined for any other.
 *
 * It holds for a running top-level plugin on the tree the user OK'd, whose card named the tool with its warning
 * (`webToolOkLines`), never a dev folder; or for a plugin of the build's copy (`built`). The caller holds to what
 * `pluginToolReadOnly` asks: the routed plugin, server and tool, decided at each call, never cached.
 */
export function pluginWebTool(registry: Pick<PluginRegistry, "get" | "list">, pluginId: string, server: string, tool: string, o: { built?: BuiltCopy } = {}): "web-search" | "web-fetch" | "browser" | undefined {
  for (const [list, kind] of [["webSearch", "web-search"], ["webFetch", "web-fetch"], ["browserTools", "browser"]] as const) {
    // A Browser tool (F5) only while its plugin holds `browser` now: the class is the browser's, so is the grant.
    if (list === "browserTools" && !grantsInForce(registry.get(pluginId)).includes("browser")) continue;
    if (builtTool(registry, pluginId, server, tool, list, o.built)) return kind;
    if (declaredTool(registry, pluginId, server, tool, list) !== undefined) return kind;
  }
  return undefined;
}
