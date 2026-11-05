// Names derived from a plugin (spec §5.1 "wrapped automatically", §6.7 "Where the names come from"): tool names as the
// model sees them, and the ids and namespaces of the plugins the core generates around bare items.
import { BUNDLED_ROOT_PLUGIN, PLUGIN_ID_MAX } from "@waifucave/clover-protocol";

/** Model APIs allow only letters, digits, `_` and `-` in tool names, and at most 64 characters (§6.7). */
export const TOOL_WIRE_NAME_MAX = 64;

/** FNV-1a, 32 bits, over UTF-8, as 8 hex digits: the short digest of a long tool name. Not a security digest; it only
 *  has to be the same on every computer. */
export function shortDigest(text: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** A tool name with each character model APIs refuse turned into `-` (MCP allows `.`, §6.7). */
export function sanitizeToolName(tool: string): string {
  return tool.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** `mcp__<namespace>__<Tool>` (§6.7). A name over 64 characters gets a short digest form: the tool part cut, then `-`
 *  and 8 hex digits of `<namespace>\0<tool>`. The tool part never holds `__`, so a name always splits cleanly. */
export function toolWireName(namespace: string, tool: string): string {
  const clean = sanitizeToolName(tool);
  const prefix = `mcp__${namespace}__`;
  const full = `${prefix}${clean}`;
  if (full.length <= TOOL_WIRE_NAME_MAX) return full;
  const room = TOOL_WIRE_NAME_MAX - prefix.length - 1 - 8;
  const cut = clean.slice(0, Math.max(room, 1)).replace(/[-_]+$/, "") || "t";
  return `${prefix}${cut}-${shortDigest(`${namespace}\u0000${tool}`)}`;
}

/** Splits a tool's wire name into namespace and tool part; null when it isn't a plugin tool. */
export function splitToolWireName(name: string): { namespace: string; tool: string } | null {
  const m = /^mcp__([a-z0-9]+(?:-[a-z0-9]+)*)__(.+)$/.exec(name);
  if (!m || m[2]!.includes("__")) return null;
  return { namespace: m[1]!, tool: m[2]! };
}

export type WrapperKind = "mcp" | "skill" | "agent" | "claude";

const WRAPPER_PREFIX: Record<WrapperKind, string> = { mcp: "mcp-", skill: "skill-", agent: "agent-", claude: "claude-" };
const WRAPPER_FALLBACK: Record<WrapperKind, string> = { mcp: "server", skill: "skill", agent: "agent", claude: "plugin" };

/** A name's clean-up (§5.1): lowercased, each run of characters other than `a-z` and `0-9` turned into one `-`, cut to
 *  `max`, hyphens at either end dropped. */
export function cleanName(name: string, max: number): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, max).replace(/^-+|-+$/g, "");
}

/** The id and namespace of a plugin the core generates around a bare item (§5.1): `mcp-<server>`, `skill-<name>`,
 *  `agent-<name>`, `claude-<name>`, with a number added on a clash or for `clover`. A wrapped server's tools use the
 *  server's name (`mcp-blender` gives `mcp__blender__Render`); a Claude Code plugin's name is also its namespace. */
export function wrapperId(kind: WrapperKind, name: string, taken: ReadonlySet<string>): { id: string; namespace: string } {
  const prefix = WRAPPER_PREFIX[kind];
  const room = PLUGIN_ID_MAX - prefix.length;
  const base = cleanName(name, room) || WRAPPER_FALLBACK[kind];
  const free = (id: string, ns: string) => !taken.has(id) && ns !== BUNDLED_ROOT_PLUGIN;
  if (free(`${prefix}${base}`, base)) return { id: `${prefix}${base}`, namespace: base };
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const b = base.slice(0, room - suffix.length).replace(/-+$/, "");
    const ns = `${b}${suffix}`;
    if (free(`${prefix}${ns}`, ns)) return { id: `${prefix}${ns}`, namespace: ns };
  }
}

/** Commands that fetch code when they run (§5.6: the OK flags them). */
export function fetchesCodeAtRunTime(command: string, args: readonly string[] = []): boolean {
  const exe = (command.split(/[\\/]/).pop() ?? command).replace(/\.(cmd|exe)$/i, "").toLowerCase();
  if (["npx", "uvx", "bunx", "pnpx"].includes(exe)) return true;
  const first = args[0]?.toLowerCase();
  const second = args[1]?.toLowerCase();
  if ((exe === "pnpm" || exe === "yarn") && first === "dlx") return true;
  if (exe === "npm" && (first === "exec" || first === "x")) return true;
  if (exe === "pipx" && first === "run") return true;
  if (exe === "uv" && first === "tool" && second === "run") return true;
  if (exe === "bun" && first === "x") return true;
  return false;
}
