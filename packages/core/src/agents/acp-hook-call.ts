// How an external agent's permission request is shown to the plugins' `tool.before` hooks (the manager): under the
// tool name Clover's own sessions use, so a guard written for `Bash`, `Write` or `Edit` sees the same act from a coding
// agent, with ACP's own kind kept beside it as `acpKind`. A kind with no Clover tool keeps its own name.
//
// * `execute` → `Bash` (an argv `command`, as some agents send it, joined into one string beside the original).
// * `edit` → `Write` when the request carries a whole file's `content` and no `old_string`, else `Edit`.
// * `read` → `Read`; `fetch` → `WebFetch`; `search` → `WebSearch` with a `query`, `Glob` for a bare glob pattern,
//   else `Grep`.
// * An MCP tool keeps its `mcp__<server>__<tool>` name.

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The name and input a permission request meets the hooks with. */
export function acpHookCall(raw: { toolKind: string; rawInput?: unknown; mcp?: { server: string; tool: string } }): { name: string; input: Record<string, unknown> } {
  const given = isObject(raw.rawInput) ? raw.rawInput : raw.rawInput === undefined ? {} : { input: raw.rawInput };
  const input: Record<string, unknown> = { ...given, acpKind: raw.toolKind };
  if (raw.mcp !== undefined) return { name: `mcp__${raw.mcp.server}__${raw.mcp.tool}`, input };
  switch (raw.toolKind) {
    case "execute":
      if (Array.isArray(given.command)) input.command = given.command.map(String).join(" ");
      return { name: "Bash", input };
    case "edit":
      return { name: typeof given.content === "string" && given.old_string === undefined ? "Write" : "Edit", input };
    case "read":
      return { name: "Read", input };
    case "fetch":
      return { name: "WebFetch", input };
    case "search": {
      if (typeof given.query === "string") return { name: "WebSearch", input };
      const pattern = given.pattern;
      const grepOnly = ["output_mode", "glob", "type", "-i", "-n", "-A", "-B", "-C", "multiline"].some((k) => k in given);
      return { name: typeof pattern === "string" && /[*?{[]/.test(pattern) && !grepOnly ? "Glob" : "Grep", input };
    }
    default:
      return { name: raw.toolKind, input };
  }
}
