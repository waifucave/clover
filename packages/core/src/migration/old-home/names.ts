// THE ONE TABLE of what the old install's home calls things that the renamed code calls something else (stage 2 of
// the rename, spec §12 "Existing Clover homes", item 125). The copy (`copy.ts`) maps a stored id, a tool name, a file
// name or a plugin's source text through these rows and nothing else, and `old-home-names.test.ts` holds every row.
// Every old spelling the copy needs is here, so the residue test permits them in this file alone (`scripts/rename/
// moss.ts`, entry `old-home-map`). The old home's own location is `other-installs.ts`'s, never spelled here.
//
// What is NOT here, on purpose: bot ids, conversations, memory and routines are copied as they are (no row maps
// them); the wire and on-disk tags the rename kept (`moss-residue.test.ts`) need no row, since the renamed code still
// reads them under their old spelling.
import { NEW_PLUGIN_SDK, OLD_INSTRUCTIONS_FILE, OLD_PLUGIN_MANIFEST, OLD_PLUGIN_SDK } from "../../old-names";

/** The old root plugin's id, and the new one's. A child is `<root>/<name>` (spec §5.1). */
export const OLD_ROOT_PLUGIN = "clover";
export const NEW_ROOT_PLUGIN = "moss";

/** The old daemon's standing MCP server prefix (`mcp__clover__<tool>`, capability tools `mcp__clover__<key>__<tool>`). */
export const OLD_MCP_PREFIX = "mcp__clover__";
export const NEW_MCP_PREFIX = "mcp__moss__";

/** MOSS's own turn ledger, by its path under the home. */
export const OLD_USAGE_LEDGER = "usage/clover.db";
export const NEW_USAGE_LEDGER = "usage/moss.db";

/** The old engine's named pipe stem on Windows (`\\.\pipe\clover-core-<id>`), for the "is it running" dial. */
export const OLD_PIPE_STEM = "clover-core-";

/** The old engine's own environment variable for its home, and its systemd user unit (Linux): what its login item
 *  names, read to find whether that item serves the copied home, and set when its own `autostart disable` runs. */
export const OLD_ENGINE_HOME_ENV = "CLOVER_HOME";
export const OLD_SYSTEMD_UNIT = "clover-core.service";

/** The runtime home's config file (claude's `.claude.json`, under the brand's name) in `sdk/`. */
export const OLD_SDK_CONFIG = ".clover.json";
export const NEW_SDK_CONFIG = ".moss.json";

/** The home's (and the runtime home's) own instructions file (the old name is `old-names.ts`'s). */
export const OLD_HOME_INSTRUCTIONS = OLD_INSTRUCTIONS_FILE;
export const NEW_HOME_INSTRUCTIONS = "MOSS.md";

/** The runtime home's plugin-manifest folder name (`brand.pluginManifestDir`). */
export const OLD_PLUGIN_MANIFEST_DIR = ".clover-plugin";
export const NEW_PLUGIN_MANIFEST_DIR = ".moss-plugin";

/** A folder plugin's manifest file (the old name is `old-names.ts`'s). */
export const OLD_MANIFEST_FILE = OLD_PLUGIN_MANIFEST;
export const NEW_MANIFEST_FILE = "moss.json";

/** The plugin SDK's import specifier before the rename (`old-names.ts`'s: a folder plugin outside the home that still
 *  imports it builds, the build resolving it to the new package). */
export { NEW_PLUGIN_SDK, OLD_PLUGIN_SDK };
export const OLD_PROTOCOL_PACKAGE = "@waifucave/clover-protocol";
export const NEW_PROTOCOL_PACKAGE = "@waifucave/moss-protocol";

/** A plugin id with the old root mapped to the new (`clover` → `moss`, `clover/voice` → `moss/voice`); any other id as
 *  it is (a third-party plugin keeps its id). */
export function mapPluginId(id: string): string {
  if (id === OLD_ROOT_PLUGIN) return NEW_ROOT_PLUGIN;
  if (id.startsWith(`${OLD_ROOT_PLUGIN}/`)) return `${NEW_ROOT_PLUGIN}/${id.slice(OLD_ROOT_PLUGIN.length + 1)}`;
  return id;
}

/** Whether `s` is a plugin id under the old root (exactly, never a longer name that starts with it). */
export function isOldRootId(s: string): boolean {
  return s === OLD_ROOT_PLUGIN || (s.startsWith(`${OLD_ROOT_PLUGIN}/`) && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s.slice(OLD_ROOT_PLUGIN.length + 1)));
}

/** An extension point's name: one an old-root plugin declared starts with its id (`clover/voice.provider`,
 *  `clover:x`), and takes the new root; any other as it is. */
export function mapPointName(point: string): string {
  return /^clover(?=[/:.]|$)/.test(point) ? `${NEW_ROOT_PLUGIN}${point.slice(OLD_ROOT_PLUGIN.length)}` : point;
}

/** A tool name (or a saved rule's key) with the old standing server's prefix mapped, wherever it starts the name or
 *  follows a rule kind's `tool:` (`tool:mcp__clover__x`). Anything else as it is. */
export function mapToolName(name: string): string {
  return name.replace(/(^|:)mcp__clover__/g, `$1${NEW_MCP_PREFIX}`);
}

/** A stored string value: an old-root plugin id mapped (`mapPluginId`), else a tool name or rule key mapped
 *  (`mapToolName`). Free text never matches either (an id is the whole string; a tool name starts it). */
export function mapStoredString(s: string): string {
  if (isOldRootId(s)) return mapPluginId(s);
  return mapToolName(s);
}

/** The folders of the home whose entries are named by a plugin id's top part, then (for a child) its own name:
 *  `plugin-data/<top>/`, `settings/plugins/<top>.json` or `<top>/<child>.json`, `settings/plugin-stores/` likewise.
 *  `plugins-state/` is not copied (`copy.ts`): its records are carried and signed again instead. */
export const ID_NAMED_FOLDERS: readonly string[] = ["plugin-data", "settings/plugins", "settings/plugin-stores"];

/** A path under the home (with `/`), mapped: the folders above named by an old-root id, the ledger, the runtime home's
 *  config file, plugin-manifest folders and instructions file. Anything else as it is. */
export function mapHomePath(rel: string): string {
  if (rel === OLD_USAGE_LEDGER) return NEW_USAGE_LEDGER;
  for (const suffix of ["-wal", "-shm"]) if (rel === `${OLD_USAGE_LEDGER}${suffix}`) return `${NEW_USAGE_LEDGER}${suffix}`;
  const parts = rel.split("/");
  for (const folder of ID_NAMED_FOLDERS) {
    const f = folder.split("/");
    if (parts.length <= f.length || f.some((p, i) => parts[i] !== p)) continue;
    const at = f.length;
    const name = parts[at]!;
    if (name === OLD_ROOT_PLUGIN) parts[at] = NEW_ROOT_PLUGIN;
    else if (name === `${OLD_ROOT_PLUGIN}.json`) parts[at] = `${NEW_ROOT_PLUGIN}.json`;
  }
  return parts
    .map((p, i) => {
      if (p === OLD_HOME_INSTRUCTIONS && (i === 0 || parts[0] === "sdk")) return NEW_HOME_INSTRUCTIONS;
      if (p === OLD_SDK_CONFIG && parts[0] === "sdk") return NEW_SDK_CONFIG;
      if (p === OLD_PLUGIN_MANIFEST_DIR && parts[0] === "sdk") return NEW_PLUGIN_MANIFEST_DIR;
      return p;
    })
    .join("/");
}

/** One rewrite of a plugin's source text: the rename's own content map, narrowed to what a plugin's tree holds. */
export interface ContentRow {
  id: string;
  regex: RegExp;
  to: string;
}

/** The rename's content map for a plugin's tree (`scripts/rename/moss.ts` made these same changes to the repo's own
 *  plugins): SDK and protocol import specifiers, the plugin API's environment variables, the CSS tokens, the URL
 *  schemes and plugin ids under the old root in string literals. The manifest file's own name is `pluginPathMap`. */
export const PLUGIN_CONTENT_MAP: readonly ContentRow[] = [
  { id: "sdk-import", regex: /@waifucave\/clover-plugin-sdk(?![A-Za-z0-9_-])/g, to: NEW_PLUGIN_SDK },
  { id: "protocol-import", regex: /@waifucave\/clover-protocol(?![A-Za-z0-9_-])/g, to: NEW_PROTOCOL_PACKAGE },
  { id: "plugin-env", regex: /\bCLOVER_PLUGIN_([A-Z_]+)\b/g, to: "MOSS_PLUGIN_$1" },
  { id: "css-tokens", regex: /--clover-(?=[a-z])/g, to: "--moss-" },
  { id: "url-schemes", regex: /\bclover(-(?:asset|core|plugin|sealed|ui|web))?:\/\//g, to: "moss$1://" },
  { id: "root-plugin-ids", regex: /(["'`])clover(\/[a-z0-9][a-z0-9-]{0,63})?\1/g, to: "$1moss$2$1" },
  { id: "standing-server-tools", regex: /\bmcp__clover__/g, to: NEW_MCP_PREFIX },
];

/** A plugin source file's text with every `PLUGIN_CONTENT_MAP` row applied, in order. */
export function mapPluginText(text: string): string {
  let out = text;
  for (const row of PLUGIN_CONTENT_MAP) out = out.replace(row.regex, row.to);
  return out;
}

/** A path inside a plugin's folder, mapped: its manifest (and each child's) takes the new file name. */
export function pluginPathMap(rel: string): string {
  const parts = rel.split("/");
  const last = parts.length - 1;
  if (parts[last] === OLD_MANIFEST_FILE) parts[last] = NEW_MANIFEST_FILE;
  return parts.join("/");
}

/** The table as rows, for the report and the test: where a record keys on an old name, and what the copy does. */
export interface MapRow {
  store: string;
  key: string;
  old: string;
  new: string;
  signed: "no" | "MAC (registry key)" | "hash (kept tag)" | "device key";
  done: string;
}

export const MAP_ROWS: readonly MapRow[] = [
  { store: "plugins-state/installed.json", key: "order, plugins.<id>, active.<point>.pluginId", old: "clover, clover/<child>", new: "moss, moss/<child>", signed: "MAC (registry key)", done: "carried, signed again: switches (enabled), order, appParts and one-at-a-time picks are written through the registry's own store with this engine's key; OK hashes, refusals and dev folders are dropped (a third-party plugin asks for its OK again, bundled ones approve themselves)" },
  { store: "plugins-state/oks/*.json, adult.json, indexes.json, grants.json", key: "the OK snapshots, the adult confirmation, added indexes, picked-file grants", old: "(any)", new: "(none)", signed: "MAC (registry key)", done: "dropped: the old key is in the old Keychain, so none can be verified; each is asked again where it matters" },
  { store: "rules/saved-rules.json", key: "keyHash of tool:mcp__clover__<tool>", old: "mcp__clover__", new: "mcp__moss__", signed: "hash (kept tag)", done: "re-hashed when the display string is the exact key (its hash proves it); every other rule is copied as it is (its tag was kept)" },
  { store: "settings.json", key: "mcp.toolPermissions.<server>.<tool>, mcp.toolsOwner.<server>, mcp.toolsSeen", old: "clover/<child>, mcp__clover__", new: "moss/<child>, mcp__moss__", signed: "no", done: "mapped" },
  { store: "settings/**.json, levels/**.json, trust/**.json, connectors/**.json, user-layers/**.json", key: "any key or string value that is an old-root plugin id or an mcp__clover__ tool name", old: "clover, clover/<child>, mcp__clover__", new: "moss, moss/<child>, mcp__moss__", signed: "no", done: "mapped" },
  { store: "settings/plugins/, settings/plugin-stores/", key: "the file per plugin (per-plugin settings and storage)", old: "clover.json, clover/<child>.json", new: "moss.json, moss/<child>.json", signed: "no", done: "renamed" },
  { store: "plugin-data/", key: "the folder per top plugin", old: "plugin-data/clover", new: "plugin-data/moss", signed: "no", done: "renamed" },
  { store: "usage/", key: "MOSS's own turn ledger", old: "usage/clover.db", new: "usage/moss.db", signed: "no", done: "copied with VACUUM INTO under the new name" },
  { store: "sdk/", key: "the runtime home's config file, plugin manifest folders, instructions file", old: ".clover.json, .clover-plugin, CLOVER.md", new: ".moss.json, .moss-plugin, MOSS.md", signed: "no", done: "renamed" },
  { store: "the home's instructions file", key: "<home>/CLOVER.md", old: "CLOVER.md", new: "MOSS.md", signed: "no", done: "renamed" },
  { store: "plugins/<third-party>/", key: "its manifest file, imports, env names, CSS tokens, URL schemes, old-root ids", old: "clover.json, @waifucave/clover-*, CLOVER_PLUGIN_*, --clover-*, clover*://, \"clover/…\"", new: "moss.json, @waifucave/moss-*, MOSS_PLUGIN_*, --moss-*, moss*://, \"moss/…\"", signed: "no", done: "rewritten; its tree changed, so it asks for its OK again on the normal card" },
  { store: "devices/registry.json", key: "this device and its pairings", old: "(the old device key)", new: "(none)", signed: "device key", done: "not copied: the device key is in the old Keychain; read only to name the paired devices to set up again" },
  { store: "credentials/index.json", key: "the secret store's index", old: "(the old secret store)", new: "(none)", signed: "no", done: "not copied: the secrets are in the old Keychain; read only to name the sign-ins to set up again" },
];
