// `Glossary` (spec §6.8 [D]): the one tool for finding and loading anything a bot might want, replacing `Skill` and
// `ToolSearch`. Owner: lane A.
//
// * **`Glossary(query?, load?)`,** each one value or many, several searches and loads in one call.
// * **`query`** searches the index and answers each match's name, what it is and a short description: tools (the
//   on-demand ones as well as the rest), skills, agent definitions, plugins (with the add-ons a plugin takes) and
//   extension points (their shape, who fills them, and whether filling one replaces shipped UI).
// * **`load`:** a tool becomes callable (the runtime loads it through its own `select:` path, `hostToolSearch` in the
//   agent SDK: the same pool and refusals as `ToolSearch`), a skill's instructions are returned, an agent definition is
//   described for `Agent`, a point is described. A plugin is the way into what it offers a bot (the coordinator's ruling
//   of try 14e): its state, its MCP servers' instructions, an index of its tools (each with its one line), skills,
//   agent definitions and points, its children by their own ids; and its own tools become callable in the same call,
//   up to `PLUGIN_LOAD_MAX_TOOLS` (each call still judged as that tool), past which it says to load the ones needed. Its
//   search line says what loading it gives. A plugin a bot built that is stopped or waits for the user's OK is listed to
//   that bot alone, with its state and where its log is. Loading changes nothing about a plugin: it starts, installs
//   and grants nothing.
// * **The index** holds names, descriptions, tool schemas and every `SKILL.md`'s full text, rebuilt from the plugin
//   registry at each call (it is small, and a plugin installed, changed or removed shows at once).
// * **Search** is keyword search over names, descriptions and the skills' text. The spec's semantic half (a small
//   local embedding model) is not here yet; keyword search is its stated fallback.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { skillItem } from "@waifucave/clover-plugin-sdk";
import type { PluginRegistry } from "../../contracts/plugin-registry";
import type { BotMcpServer, CoreToolDef } from "./servers";

export const GLOSSARY_TOOL_NAME = "Glossary";

/** One thing the index knows. */
export interface GlossaryItem {
  kind: "tool" | "skill" | "agent" | "plugin" | "point";
  name: string;
  description: string;
  /** What `load` answers for a skill (its instructions), an agent definition, a plugin or a point. */
  body?: string;
  /** The tools loading it makes callable (a plugin's own, at most `PLUGIN_LOAD_MAX_TOOLS`). */
  loads?: readonly string[];
  /** Extra text the search reads but never shows (a tool's schema). */
  searchText?: string;
}

export interface GlossaryDeps {
  /** The session's tools, loaded or on-demand: `name`, its description and schema. */
  tools(): readonly { name: string; description?: string; inputSchema?: unknown }[];
  /** The plugin registry, for skills, agent definitions, plugins and points; the session's own scope applies. */
  registry?: Pick<PluginRegistry, "entries" | "get" | "list" | "points">;
  /** Whether a plugin's entries reach this session (its `scope`, or the entry's own `entryScope`, and `onlyBackends`);
   *  every one by default. */
  serves?(pluginId: string, entryScope?: unknown): boolean;
  /** The plugins' MCP servers this session has (each with its plugin, its instructions and its tools), for what a
   *  plugin offers. */
  servers?(): readonly Pick<BotMcpServer, "server" | "plugin" | "instructions" | "tools">[];
  /** The session's bot: a plugin it built that is stopped or waits for the OK is listed to it. */
  bot?: string;
}

/** The most tools loading a plugin makes callable at once; past it, the bot loads the ones it needs by name. */
export const PLUGIN_LOAD_MAX_TOOLS = 50;
/** The registry states a bot's own plugin is listed in, to it alone, while it doesn't run. */
const BUILDER_STATES: ReadonlySet<string> = new Set(["stopped", "found", "off"]);

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

/** A plugin's agent definition, as the Agent tool takes it (`agent: "<plugin>:<id>"`): its words only. It names a
 *  backend, a model and an effort the bot could pass itself; its folder, computer and plugin lists are never taken. */
export interface AgentDefinition {
  pluginId: string;
  id: string;
  name: string;
  /** The definition's instructions, which go before the bot's own brief. */
  prompt: string;
  backend?: string;
  model?: string;
  effort?: string;
}

/** A definition's display name: plain text on one line, no control or direction marks, at most 80 characters. */
export function plainName(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80).trim();
}
/** A backend's or a model's id as a definition may name one; anything else is left for the bot to give. */
const ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]{0,127}$/;
/** An agent definition's own scope (`own-bot`: inside its plugin's bot), where it has one. */
const entryScopeOf = (v: unknown): unknown => (typeof v === "object" && v !== null ? (v as { scope?: unknown }).scope : undefined);

/** An effort level: a word, as the backends name theirs (low, medium, high, xhigh, max). */
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;

/** The agent definition `name` names (`<plugin>:<id>`, as Glossary lists it), from a plugin whose entries reach this
 *  session; undefined for any other name. */
export function agentDefinitionOf(reg: Pick<PluginRegistry, "entries" | "get">, name: string, serves: (pluginId: string, entryScope?: unknown) => boolean = () => true): AgentDefinition | undefined {
  for (const c of reg.entries("agents")) {
    if (c.state !== "active" || !serves(c.pluginId, entryScopeOf(c.value))) continue;
    const record = reg.get(c.pluginId);
    if (record === undefined) continue;
    if (typeof c.value === "string") {
      const raw = readInside(record.folder, c.value);
      if (raw === undefined) continue;
      const fm = parseFrontmatter(raw);
      const id = fm.name ?? c.value.split("/").pop()!.replace(/\.md$/i, "");
      if (`${c.pluginId}:${id}` === name) return { pluginId: c.pluginId, id, name: plainName(id) || id, prompt: fm.body.trim().slice(0, 20_000) };
    } else if (c.value !== null && typeof c.value === "object") {
      const v = c.value as { id?: string; name?: unknown; backend?: unknown; model?: unknown; effort?: unknown; instructions?: string };
      const id = v.id ?? "agent";
      if (`${c.pluginId}:${id}` !== name) continue;
      const text = v.instructions === undefined ? undefined : readInside(record.folder, v.instructions);
      const body = text === undefined ? "" : parseFrontmatter(text).body.trim();
      return {
        pluginId: c.pluginId, id, name: plainName(textOf(v.name)) || id, prompt: body.slice(0, 20_000),
        ...(typeof v.backend === "string" && ID_TOKEN.test(v.backend) ? { backend: v.backend } : {}),
        ...(typeof v.model === "string" && ID_TOKEN.test(v.model) ? { model: v.model } : {}),
        ...(typeof v.effort === "string" && EFFORT.test(v.effort) ? { effort: v.effort } : {}),
      };
    }
  }
  return undefined;
}

/** The skill files a `skills` entry names: Markdown files (a glob of SKILL.md files, the usual entry), or the skill
 *  folders that hold them (`skills/pdf-tools`, as a wrapped skill folder's generated manifest names its one skill; a
 *  glob of folders), each folder's `SKILL.md`. A folder entry used to match no file at all, so a wrapped skill never reached the index (the acceptance's
 *  arrivals row, 2026-11-13). */
function skillFiles(folder: string, pattern: string): string[] {
  const p = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  try {
    const glob = new Bun.Glob(/\.md$/i.test(p) ? p : `${p}/SKILL.md`);
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
    const item = skillItem(c.value);
    if (c.state !== "active" || item === undefined || !serves(c.pluginId, item.scope)) continue;
    const record = reg.get(c.pluginId);
    if (record === undefined) continue;
    for (const rel of skillFiles(record.folder, item.path)) {
      const raw = readInside(record.folder, rel);
      if (raw === undefined) continue;
      const fm = parseFrontmatter(raw);
      const dirName = rel.split("/").slice(-2, -1)[0] ?? rel;
      const name = `${c.pluginId}:${fm.name ?? dirName}`;
      items.push({ kind: "skill", name, description: (fm.description ?? fm.body.trim().split("\n")[0] ?? "").slice(0, 300), body: fm.body, searchText: fm.body });
    }
  }
  for (const c of reg.entries("agents")) {
    if (c.state !== "active" || !serves(c.pluginId, entryScopeOf(c.value))) continue;
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
  const servers = deps.servers?.() ?? [];
  const points = reg.points();
  const records = reg.list();
  const sentence = (t: string) => (t === "" || /[.!?:]$/.test(t) ? t : `${t}.`);
  for (const p of records) {
    // Listed where any part of it reaches the session: its scope, or one of its servers' own (a bot plugin whose
    // persona is its own bot's can still serve every bot a tool). Its builder's stopped plugin is listed below anyway.
    const running = p.state === "running" || p.state === "waiting";
    if (running && !serves(p.id) && !servers.some((sv) => sv.plugin === p.id)) continue;
    const name = textOf(p.name) || p.id;
    const manifest = p.manifest as { description?: unknown; addons?: { description?: unknown } } | undefined;
    const addons = textOf(manifest?.addons?.description);
    const description = textOf((p as { description?: unknown }).description ?? manifest?.description);
    if (!running) {
      // A bot's own plugin that doesn't run (stopped by the crash rules or the user, or waiting for the user's OK):
      // listed to its builder alone, so it finds it exactly when it has to fix it. Nothing of it is loaded.
      const top = p.parent ?? (p.id.includes("/") ? p.id.slice(0, p.id.indexOf("/")) : undefined);
      const prov = (p as { provenance?: { by?: string; bot?: string } }).provenance ?? (top !== undefined ? (reg.get(top) as { provenance?: { by?: string; bot?: string } } | undefined)?.provenance : undefined);
      if (deps.bot === undefined || !BUILDER_STATES.has(p.state) || prov?.by !== "bot" || prov.bot !== deps.bot) continue;
      const state = p.state === "found" ? "waiting for the user's OK" : p.state === "off" ? "switched off" : "stopped";
      const reason = textOf((p as { reason?: unknown }).reason);
      const why = `${state}${reason ? ` (${reason.replace(/[.\s]+$/, "")})` : ""}`;
      items.push({
        kind: "plugin", name: p.id, description: `${name}, which you built: ${why}. PluginStatus ${p.id} has the log.`.slice(0, 300),
        body: [`Plugin ${p.id} (${name}), which you built: ${why}.`, description, `PluginStatus ${p.id} has the log. Nothing of it can be loaded until it runs.`].filter(Boolean).join("\n"),
      });
      continue;
    }
    // What it offers a bot: its own MCP servers' instructions and tools, skills, agent definitions and points (its
    // children's are theirs, under their own ids).
    const own = servers.filter((sv) => sv.plugin === p.id);
    const instructions = own.filter((sv) => sv.instructions !== undefined && sv.instructions.trim() !== "").map((sv) => `${own.length > 1 ? `[${sv.server}]\n` : ""}${sv.instructions!.trim()}`);
    const tools = own.flatMap((sv) => sv.tools.map((t) => ({ name: `mcp__${sv.server}__${t.name}`, line: (t.description ?? "").split("\n")[0]!.trim().slice(0, 200) })));
    const skills = items.filter((i) => i.kind === "skill" && i.name.startsWith(`${p.id}:`));
    const agents = items.filter((i) => i.kind === "agent" && i.name.startsWith(`${p.id}:`));
    const declared = points.filter((pt) => pt.declaredBy !== "core" && pt.declaredBy.pluginId === p.id);
    const children = records.filter((c) => c.parent === p.id || (c.parent === undefined && c.id.startsWith(`${p.id}/`))).filter((c) => (c.state === "running" || c.state === "waiting") && serves(c.id));
    const gives = [
      tools.length > 0 ? `${tools.length} tool${tools.length === 1 ? "" : "s"}` : undefined,
      instructions.length > 0 ? "instructions" : undefined,
      skills.length > 0 ? `${skills.length} skill${skills.length === 1 ? "" : "s"}` : undefined,
      agents.length > 0 ? `${agents.length} agent definition${agents.length === 1 ? "" : "s"}` : undefined,
      declared.length > 0 ? `${declared.length} point${declared.length === 1 ? "" : "s"}` : undefined,
      children.length > 0 ? `${children.length} child plugin${children.length === 1 ? "" : "s"}` : undefined,
    ].filter((x): x is string => x !== undefined);
    const headline = `${name}${description ? `: ${description}` : ""}`;
    if (gives.length === 0) {
      // Nothing for bots (a theme, a layout): what it is, as before.
      items.push({
        kind: "plugin", name: p.id, description: headline.slice(0, 300),
        body: [`Plugin ${p.id} (${name}), ${p.state}.`, description, addons ? `It takes add-ons: ${addons}` : undefined].filter(Boolean).join("\n"),
        ...(addons ? { searchText: addons } : {}),
      });
      continue;
    }
    const loads = tools.length <= PLUGIN_LOAD_MAX_TOOLS ? tools.map((t) => t.name) : [];
    const body = [
      `Plugin ${p.id} (${name}), ${p.state}.${description ? ` ${sentence(description)}` : ""}`,
      ...(instructions.length > 0 ? [`Its instructions:\n${instructions.join("\n\n")}`] : []),
      ...(tools.length > 0 ? [[
        tools.length <= PLUGIN_LOAD_MAX_TOOLS
          ? `Its tools, loaded now (call them by name):`
          : `Its tools (${tools.length}, more than ${PLUGIN_LOAD_MAX_TOOLS} at once: load the ones you need by name with Glossary):`,
        ...tools.map((t) => `- ${t.name}${t.line ? `: ${t.line}` : ""}`),
      ].join("\n")] : []),
      ...(skills.length > 0 ? [["Its skills (load one by name for its instructions):", ...skills.map((i) => `- ${i.name}${i.description ? `: ${i.description}` : ""}`)].join("\n")] : []),
      ...(agents.length > 0 ? [["Its agent definitions (for Agent):", ...agents.map((i) => `- ${i.name}${i.description ? `: ${i.description}` : ""}`)].join("\n")] : []),
      ...(declared.length > 0 ? [["The points it declares:", ...declared.map((pt) => `- ${pt.name} (${pt.spot ? "UI spot" : "extension point"}, shape ${String(pt.shape)})`)].join("\n")] : []),
      ...(children.length > 0 ? [["Its child plugins (load each by its id for what it offers):", ...children.map((c) => `- ${c.id} (${textOf(c.name) || c.id})`)].join("\n")] : []),
      ...(addons ? [`It takes add-ons: ${addons}`] : []),
    ].join("\n\n");
    items.push({
      kind: "plugin", name: p.id,
      description: `${headline.slice(0, 220)} (load it for ${gives.join(", ")})`.slice(0, 300),
      body,
      ...(loads.length > 0 ? { loads } : {}),
      searchText: [addons, ...tools.map((t) => `${t.name} ${t.line}`), ...instructions].filter(Boolean).join(" ").slice(0, 20_000),
    });
  }
  for (const pt of points) {
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
      "load: names to load, one or several: a tool becomes callable, a skill's instructions are returned (follow them), an agent definition becomes available to Agent, a plugin answers its instructions and what it offers and makes its tools callable, a point is described.",
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
        // A plugin's own tools become callable with it (each call still judged as that tool).
        if (item.loads !== undefined) toolNames.push(...item.loads);
        const body = item.body ?? item.description;
        const capped = body.length > SKILL_BODY_MAX_CHARS ? `${body.slice(0, SKILL_BODY_MAX_CHARS)}\n[cut at ${SKILL_BODY_MAX_CHARS} characters]` : body;
        out.push(item.kind === "skill" ? `<skill name="${item.name}">\n${capped.trim()}\n</skill>` : `${item.name} (${item.kind}):\n${capped.trim()}`);
      }
      const load = [...new Set(toolNames)];
      return { text: out.join("\n\n"), isError: false, ...(load.length > 0 ? { meta: { "clover/load": load } } : {}) };
    },
  };
}

