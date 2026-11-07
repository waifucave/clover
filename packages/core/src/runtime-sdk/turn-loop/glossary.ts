// `Glossary` (spec §6.8 [D]): the one tool for finding and loading anything a bot might want, replacing `Skill` and
// `ToolSearch`. Owner: lane A.
//
// * **`Glossary(query?, load?)`,** each one value or many, several searches and loads in one call.
// * **`query`** searches the index and answers each match's name, what it is and a short description: tools (the
//   on-demand ones as well as the rest), skills, agent definitions, plugins (with the add-ons a plugin takes) and
//   extension points (their shape, who fills them, and whether filling one replaces shipped UI).
// * **`load`:** a tool becomes callable (the runtime loads it through its own `select:` path, `hostToolSearch` in the
//   agent SDK: the same pool and refusals as `ToolSearch`), a skill's instructions are returned, an agent definition is
//   described for `Agent`, a plugin or a point is described.
// * **The index** holds names, descriptions, tool schemas and every `SKILL.md`'s full text, rebuilt from the plugin
//   registry at each call (it is small, and a plugin installed, changed or removed shows at once).
// * **Search** is keyword search over names, descriptions and the skills' text. The spec's semantic half (a small
//   local embedding model) is not here yet; keyword search is its stated fallback.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { PluginRegistry } from "../../contracts/plugin-registry";
import type { CoreToolDef } from "./servers";

export const GLOSSARY_TOOL_NAME = "Glossary";

/** One thing the index knows. */
export interface GlossaryItem {
  kind: "tool" | "skill" | "agent" | "plugin" | "point";
  name: string;
  description: string;
  /** What `load` answers for a skill (its instructions), an agent definition, a plugin or a point. */
  body?: string;
  /** Extra text the search reads but never shows (a tool's schema). */
  searchText?: string;
}

export interface GlossaryDeps {
  /** The session's tools, loaded or on-demand: `name`, its description and schema. */
  tools(): readonly { name: string; description?: string; inputSchema?: unknown }[];
  /** The plugin registry, for skills, agent definitions, plugins and points; the session's own scope applies. */
  registry?: Pick<PluginRegistry, "entries" | "get" | "list" | "points">;
  /** Whether a plugin's entries reach this session (its `scope`, `onlyBackends`); every one by default. */
  serves?(pluginId: string): boolean;
}

/** How many matches one query answers. */
const MAX_MATCHES = 12;
/** How much of one skill's instructions `load` returns. */
export const SKILL_BODY_MAX_CHARS = 60_000;
const SKILL_FILE_MAX_BYTES = 256 * 1024;

function asList(v: unknown): string[] {
  if (typeof v === "string") return v.trim() === "" ? [] : [v.trim()];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  return [];
}

function textOf(t: unknown): string {
  if (typeof t === "string") return t;
  if (t !== null && typeof t === "object" && typeof (t as { en?: unknown }).en === "string") return (t as { en: string }).en;
  return "";
}

/** `---` frontmatter's `name` and `description`, and the text after it. */
export function parseFrontmatter(text: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (m === null) return { body: text };
  const out: { name?: string; description?: string; body: string } = { body: text.slice(m[0].length) };
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (kv === null) continue;
    const value = kv[2]!.trim().replace(/^["']|["']$/g, "");
    if (kv[1] === "name") out.name = value;
    else out.description = value;
  }
  return out;
}

/** A file inside a plugin's folder, read only as a regular file of its own there (never through a link). */
function readInside(folder: string, rel: string): string | undefined {
  try {
    const root = realpathSync(folder);
    const path = resolve(root, rel);
    const r = relative(root, path);
    if (r.startsWith("..") || isAbsolute(r)) return undefined;
    const real = realpathSync(path);
    const rr = relative(root, real);
    if (rr.startsWith("..") || isAbsolute(rr)) return undefined;
    const st = lstatSync(real);
    if (!st.isFile() || st.size > SKILL_FILE_MAX_BYTES) return undefined;
    return readFileSync(real, "utf8");
  } catch {
    return undefined;
  }
}

function skillFiles(folder: string, pattern: string): string[] {
  try {
    const glob = new Bun.Glob(pattern);
    return [...glob.scanSync({ cwd: folder, onlyFiles: true, followSymlinks: false })].filter((p) => /(^|\/)SKILL\.md$/i.test(p) || p.toLowerCase().endsWith(".md")).slice(0, 1000);
  } catch {
    return [];
  }
}

/** Everything the index knows now. */
export function glossaryIndex(deps: GlossaryDeps): GlossaryItem[] {
  const items: GlossaryItem[] = [];
  const serves = deps.serves ?? (() => true);
  for (const t of deps.tools()) {
    let schema = "";
    try { schema = JSON.stringify(t.inputSchema ?? {}); } catch { schema = ""; }
    items.push({ kind: "tool", name: t.name, description: (t.description ?? "").split("\n")[0]!.slice(0, 300), searchText: `${t.description ?? ""} ${schema}` });
  }
  const reg = deps.registry;
  if (reg === undefined) return items;
  for (const c of reg.entries("skills")) {
    if (c.state !== "active" || !serves(c.pluginId)) continue;
    const record = reg.get(c.pluginId);
    if (record === undefined || typeof c.value !== "string") continue;
    for (const rel of skillFiles(record.folder, c.value)) {
      const raw = readInside(record.folder, rel);
      if (raw === undefined) continue;
      const fm = parseFrontmatter(raw);
      const dirName = rel.split("/").slice(-2, -1)[0] ?? rel;
      const name = `${c.pluginId}:${fm.name ?? dirName}`;
      items.push({ kind: "skill", name, description: (fm.description ?? fm.body.trim().split("\n")[0] ?? "").slice(0, 300), body: fm.body, searchText: fm.body });
    }
  }
  for (const c of reg.entries("agents")) {
    if (c.state !== "active" || !serves(c.pluginId)) continue;
    const record = reg.get(c.pluginId);
    if (record === undefined) continue;
    if (typeof c.value === "string") {
      const raw = readInside(record.folder, c.value);
      if (raw === undefined) continue;
      const fm = parseFrontmatter(raw);
      const base = c.value.split("/").pop()!.replace(/\.md$/i, "");
      items.push({ kind: "agent", name: `${c.pluginId}:${fm.name ?? base}`, description: (fm.description ?? "").slice(0, 300), body: `An agent definition for Agent (pass it as the agent).\n\n${fm.body.trim()}`, searchText: fm.body });
    } else if (c.value !== null && typeof c.value === "object") {
      const v = c.value as { id?: string; name?: unknown; backend?: string; model?: string; effort?: string; instructions?: string };
      const instructions = v.instructions === undefined ? undefined : readInside(record.folder, v.instructions);
      const facts = [v.backend && `backend ${v.backend}`, v.model && `model ${v.model}`, v.effort && `effort ${v.effort}`].filter(Boolean).join(", ");
      items.push({
        kind: "agent", name: `${c.pluginId}:${v.id ?? "agent"}`, description: `${textOf(v.name)}${facts ? ` (${facts})` : ""}`.slice(0, 300),
        body: `An agent definition for Agent (pass it as the agent): ${textOf(v.name)}${facts ? `, ${facts}` : ""}.${instructions === undefined ? "" : `\n\n${instructions.trim()}`}`,
        ...(instructions === undefined ? {} : { searchText: instructions }),
      });
    }
  }
  for (const p of reg.list()) {
    if (p.state !== "running" && p.state !== "waiting") continue;
    if (!serves(p.id)) continue;
    const manifest = p.manifest as { description?: unknown; addons?: { description?: unknown } } | undefined;
    const addons = textOf(manifest?.addons?.description);
    const description = textOf((p as { description?: unknown }).description ?? manifest?.description);
    items.push({
      kind: "plugin", name: p.id, description: `${textOf(p.name) || p.id}${description ? `: ${description}` : ""}`.slice(0, 300),
      body: [`Plugin ${p.id} (${textOf(p.name) || p.id}), ${p.state}.`, description, addons ? `It takes add-ons: ${addons}` : undefined].filter(Boolean).join("\n"),
      ...(addons ? { searchText: addons } : {}),
    });
  }
  for (const pt of reg.points()) {
    if (!pt.active) continue;
    const occupants = reg.entries(pt.name).filter((e) => e.state === "active").map((e) => e.pluginId);
    const decl = pt.decl as { replaces?: unknown; description?: unknown; props?: unknown; fields?: unknown } | undefined;
    const by = pt.declaredBy === "core" ? "the core" : pt.declaredBy.pluginId;
    const replaces = decl?.replaces === true;
    items.push({
      kind: "point", name: pt.name, description: `${pt.spot ? "UI spot" : "extension point"} (${String(pt.shape)}), declared by ${by}`.slice(0, 300),
      body: [
        `${pt.spot ? "UI spot" : "Extension point"} ${pt.name}, shape ${String(pt.shape)}, declared by ${by}.`,
        textOf(decl?.description),
        decl?.props !== undefined || decl?.fields !== undefined ? `Fields: ${JSON.stringify(decl?.props ?? decl?.fields).slice(0, 2000)}` : undefined,
        `Filled now by: ${occupants.length > 0 ? [...new Set(occupants)].join(", ") : "nothing"}.`,
        replaces ? "Filling it replaces shipped UI." : undefined,
      ].filter(Boolean).join("\n"),
    });
  }
  return items;
}

const TOKEN = /[\p{L}\p{N}]+/gu;
function tokens(s: string): string[] {
  return (s.toLowerCase().match(TOKEN) ?? []).filter((t) => t.length > 1 || /\d/.test(t));
}

/** Keyword search: every query word must appear somewhere; a word in the name counts most. */
export function searchGlossary(items: readonly GlossaryItem[], query: string, max = MAX_MATCHES): GlossaryItem[] {
  const words = tokens(query);
  if (words.length === 0) return [];
  const scored: { item: GlossaryItem; score: number }[] = [];
  for (const item of items) {
    const name = item.name.toLowerCase();
    const desc = item.description.toLowerCase();
    const rest = (item.searchText ?? "").toLowerCase();
    let score = 0;
    let all = true;
    for (const w of words) {
      const s = (name.includes(w) ? 6 : 0) + (desc.includes(w) ? 3 : 0) + (rest.includes(w) ? 1 : 0);
      if (s === 0) all = false;
      score += s;
    }
    if (name === query.trim().toLowerCase()) score += 20;
    if (score > 0) scored.push({ item, score: all ? score * 2 : score });
  }
  scored.sort((a, b) => b.score - a.score || (a.item.name < b.item.name ? -1 : 1));
  return scored.slice(0, max).map((s) => s.item);
}

function line(item: GlossaryItem): string {
  return `- ${item.name} (${item.kind}): ${item.description || "no description"}`;
}

/** The `Glossary` core tool. Its result asks the runtime to load the tools it names (`_meta["clover/load"]`). */
export function glossaryTool(deps: GlossaryDeps): CoreToolDef {
  return {
    name: GLOSSARY_TOOL_NAME,
    description: [
      "Find and load anything you might want: tools (some aren't loaded until you load them), skills, agent definitions, plugins and extension points.",
      "query: free text, one or several (\"deploy to hetzner\", \"pdf\"); answers the matching items with their name, what they are and a short description.",
      "load: names to load, one or several: a tool becomes callable, a skill's instructions are returned (follow them), an agent definition becomes available to Agent, a plugin or point is described.",
      "Several searches and loads can go in one call. Load a tool before you call it.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        query: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 20 }], description: "What to search for." },
        load: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 50 }], description: "Exact names to load, from a search or that you know." },
      },
    },
    async run(input) {
      const rec = (input ?? {}) as { query?: unknown; load?: unknown };
      const queries = asList(rec.query).slice(0, 20);
      const loads = [...new Set(asList(rec.load))].slice(0, 50);
      if (queries.length === 0 && loads.length === 0) return { text: "Give a query to search, or names to load.", isError: true };
      const items = glossaryIndex(deps);
      const out: string[] = [];
      for (const q of queries) {
        const found = searchGlossary(items, q);
        out.push(found.length === 0 ? `No matches for ${JSON.stringify(q)}.` : [`Matches for ${JSON.stringify(q)}:`, ...found.map(line)].join("\n"));
      }
      const toolNames: string[] = [];
      for (const name of loads) {
        const item = items.find((i) => i.name === name) ?? items.find((i) => i.name.toLowerCase() === name.toLowerCase());
        if (item === undefined) {
          out.push(`${name}: nothing by that name. Search for it first.`);
          continue;
        }
        if (item.kind === "tool") {
          toolNames.push(item.name);
          continue;
        }
        const body = item.body ?? item.description;
        const capped = body.length > SKILL_BODY_MAX_CHARS ? `${body.slice(0, SKILL_BODY_MAX_CHARS)}\n[cut at ${SKILL_BODY_MAX_CHARS} characters]` : body;
        out.push(item.kind === "skill" ? `<skill name="${item.name}">\n${capped.trim()}\n</skill>` : `${item.name} (${item.kind}):\n${capped.trim()}`);
      }
      return { text: out.join("\n\n"), isError: false, ...(toolNames.length > 0 ? { meta: { "clover/load": toolNames } } : {}) };
    },
  };
}

