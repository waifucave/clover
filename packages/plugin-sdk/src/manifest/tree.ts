// Validating a whole plugin folder through a reader (spec §5.1, §5.6 `clover plugin validate`): the top-level manifest,
// its child plugins one level deep, the files the manifests name, and the theme, layout and locale files they point
// to. Nothing runs. The reader is how the folder is reached: the real file system for the CLI and the registry, or an
// in-memory folder in tests.
import type { ValidationIssue } from "@waifucave/clover-protocol";
import { live2dReferences } from "../catalogs/avatars";
import { spotInfo } from "../catalogs/spots";
import { TOKENS, TOKEN_TYPES, type TokenValue, isTokenValue, isPluginTokenName, isValueForToken } from "../catalogs/tokens";
import { LayoutSchema, layoutPaths, layoutSpots } from "../formats/layout";
import { LocaleSchema, localeKeyOwner } from "../formats/locale";
import { ThemeSchema, setsCardTokens } from "../formats/theme";
import { parseJsonc } from "../jsonc";
import { MANIFEST_FILE } from "../version";
import type { Manifest } from "./types";
import { flattenZodIssues, jsonPointer, manifestPathProblem, refusedReport, validateManifest, type ManifestReport } from "./validate";

export interface PluginFolderReader {
  /** A file's text, or undefined when it doesn't exist. Paths are relative to the plugin folder, with `/`. */
  readText(path: string): Promise<string | undefined> | string | undefined;
  /** Whether a file or folder exists. */
  exists(path: string): Promise<boolean> | boolean;
  /** The folders inside a folder (empty when it doesn't exist). */
  listDirs(path: string): Promise<string[]> | string[];
  /** Whether a path's real path stays inside the plugin folder (no symlink out, §5.1). Optional: without it only the
   *  lexical rules are checked. */
  insideFolder?(path: string): Promise<boolean> | boolean;
}

export interface TreeReport {
  /** The top-level plugin loads; a child that fails is invalid alone (§5.1). */
  ok: boolean;
  top: ManifestReport;
  /** Each child, and whether it loads once the tree-wide findings are counted. */
  children: { folder: string; ok: boolean; report: ManifestReport }[];
  /** What a bare folder holds when it has no `clover.json`, so the core wraps it (§5.1). */
  bareItem?: BareItemKind;
  /** Card styling (§5.5, review S7): a manifest in the tree has `approvals`, or a theme or `style` file sets `card.*`
   *  tokens. The OK says "restyles approval cards" (`describeOk`), and a later change to that styling waits for its own
   *  OK while the rest applies: the core keeps the card values last OK'd (`resolveTokens`' `heldCard`). */
  restylesCards: boolean;
  issues: ValidationIssue[];
}

export type BareItemKind = "claude-plugin" | "skill-folder" | "mcp-config";

/** What a folder with no `clover.json` is (§5.1): a Claude Code plugin if it has `.claude-plugin/plugin.json`, or
 *  `skills/`, `commands/`, `agents/` or `hooks/hooks.json` where Claude Code looks for them; a skill folder if it has
 *  a `SKILL.md`; an MCP config if it has only `.mcp.json`. */
export async function detectBareItem(reader: PluginFolderReader): Promise<BareItemKind | undefined> {
  if (await reader.exists(MANIFEST_FILE)) return undefined;
  if (await reader.exists(".claude-plugin/plugin.json")) return "claude-plugin";
  for (const p of ["skills", "commands", "agents", "hooks/hooks.json"]) if (await reader.exists(p)) return "claude-plugin";
  if (await reader.exists("SKILL.md")) return "skill-folder";
  if (await reader.exists(".mcp.json")) return "mcp-config";
  return undefined;
}

type Seg = string | number;

class TreeFindings {
  readonly list: ValidationIssue[] = [];
  error(file: string, refuses: "plugin" | "contribution" | "entry", code: string, path: readonly Seg[], message: string): void {
    this.list.push({ severity: "error", refuses, code, message, file, path: jsonPointer(path) });
  }
  warn(file: string, code: string, path: readonly Seg[], message: string): void {
    this.list.push({ severity: "warning", refuses: "none", code, message, file, path: jsonPointer(path) });
  }
}

/** Validates the plugin folder the reader shows. `folderName` is its name in the plugins directory. */
export async function validateTree(reader: PluginFolderReader, opts: { folderName: string; bundled?: boolean; apiVersion?: string }): Promise<TreeReport> {
  const findings = new TreeFindings();
  const text = await reader.readText(MANIFEST_FILE);
  if (text === undefined) {
    const bare = await detectBareItem(reader);
    const top = refusedReport([{
      severity: "error", refuses: "plugin", code: "manifest_missing", file: MANIFEST_FILE, path: "",
      message: bare ? `no ${MANIFEST_FILE}; this is a ${bare.replace("-", " ")}, which Clover wraps into a plugin` : `no ${MANIFEST_FILE}`,
    }]);
    return { ok: false, top, children: [], ...(bare ? { bareItem: bare } : {}), restylesCards: false, issues: findings.list };
  }

  const top = validateManifest(text, { folderName: opts.folderName, bundled: opts.bundled, apiVersion: opts.apiVersion });
  const topId = top.id ?? opts.folderName;
  const namespace = top.namespace ?? topId;
  const cards = { styled: top.restylesCards };
  if (top.manifest) await checkFiles(reader, "", top.manifest, topId, top.bot, findings, cards);

  const children: { folder: string; ok: boolean; report: ManifestReport }[] = [];
  for (const folder of (await reader.listDirs("plugins")).sort()) {
    const base = `plugins/${folder}`;
    const file = `${base}/${MANIFEST_FILE}`;
    const childText = await reader.readText(file);
    if (childText === undefined) {
      findings.error(file, "entry", "manifest_missing", [], `the child folder "${folder}" has no ${MANIFEST_FILE}, so it is not loaded`);
      continue;
    }
    const report = validateManifest(childText, {
      folderName: folder, parent: { id: topId, namespace }, bundled: opts.bundled, apiVersion: opts.apiVersion, file,
    });
    if (report.manifest) await checkFiles(reader, `${base}/`, report.manifest, topId, report.bot, findings, cards);
    if (report.restylesCards) cards.styled = true;
    if ((await reader.listDirs(`${base}/plugins`)).length > 0) {
      findings.warn(file, "nested_children", [], "child plugins are one level deep; the plugins inside this child are not loaded");
    }
    children.push({ folder, ok: report.ok, report });
  }

  // Across the tree: tool names are unique within a top-level plugin (§5.9), and command names within its namespace.
  const tools = new Map<string, string>();
  for (const [where, r] of [["", top] as const, ...children.map((c) => [`plugins/${c.folder}/`, c.report] as const)]) {
    for (const t of r.toolNames) {
      if (tools.has(t)) findings.error(`${where}${MANIFEST_FILE}`, "plugin", "tool_duplicate", [], `${t} is also a tool of ${tools.get(t) || "the top-level plugin"}`);
      else tools.set(t, where || "the top-level plugin");
    }
  }
  const commands = new Map<string, string>();
  for (const [where, r] of [["", top] as const, ...children.map((c) => [`plugins/${c.folder}/`, c.report] as const)]) {
    for (const cmd of r.manifest?.contributes?.commands ?? []) {
      if (commands.has(cmd.name)) findings.error(`${where}${MANIFEST_FILE}`, "entry", "command_duplicate", [], `${namespace}.${cmd.name} is also a command of ${commands.get(cmd.name)}`);
      else commands.set(cmd.name, where || "the top-level plugin");
    }
  }

  const refusesFile = (file: string) => findings.list.some((i) => i.severity === "error" && i.refuses === "plugin" && i.file === file);
  for (const child of children) if (refusesFile(`plugins/${child.folder}/${MANIFEST_FILE}`)) child.ok = false;
  const topRefused = !top.ok || findings.list.some((i) => i.severity === "error" && i.refuses === "plugin" && !i.file.startsWith("plugins/"));
  return { ok: !topRefused, top, children, restylesCards: cards.styled, issues: findings.list };
}

/** The files a manifest names exist, stay inside the folder, and are well formed when they are themes, layouts or
 *  string tables. */
async function checkFiles(reader: PluginFolderReader, base: string, m: Manifest, topId: string, isBot: boolean, f: TreeFindings, cards: { styled: boolean }): Promise<void> {
  const file = `${base}${MANIFEST_FILE}`;
  const at = (path: string) => `${base}${path.startsWith("./") ? path.slice(2) : path}`;
  const must = async (path: string | undefined, where: Seg[], refuses: "plugin" | "contribution" | "entry", glob = false): Promise<boolean> => {
    if (path === undefined || glob) return true;
    if (!(await reader.exists(at(path)))) {
      f.error(file, refuses, "file_missing", where, `"${path}" doesn't exist`);
      return false;
    }
    if (reader.insideFolder && !(await reader.insideFolder(at(path)))) {
      f.error(file, refuses, "path_escape", where, `"${path}" leads out of the plugin folder`);
      return false;
    }
    return true;
  };
  if (m.icon !== undefined && !(await reader.exists(at(m.icon)))) f.warn(file, "file_missing", ["icon"], `the icon "${m.icon}" doesn't exist`);
  await must(m.host?.entry, ["host", "entry"], "plugin");
  await must(m.client?.entry, ["client", "entry"], "plugin");
  for (const [i, css] of (m.client?.css ?? []).entries()) await must(css, ["client", "css", i], "plugin");
  for (const [p, bin] of Object.entries(m.helper?.bin ?? {})) await must(bin, ["helper", "bin", p], "plugin");
  const c = m.contributes ?? {};
  if (c.bot) {
    for (const k of ["instructions", "greeting", "memory"] as const) await must(c.bot[k], ["contributes", "bot", k], "contribution");
    if (c.bot.avatar && (await must(c.bot.avatar.file, ["contributes", "bot", "avatar", "file"], "contribution")) && c.bot.avatar.format === "live2d") {
      await checkLive2d(reader, base, c.bot.avatar.file, f);
    }
    if (c.bot.layout && (await must(c.bot.layout, ["contributes", "bot", "layout"], "contribution"))) {
      await checkLayout(reader, base, c.bot.layout, file, isBot, f);
    }
  }
  for (const [i, theme] of (c.themes ?? []).entries()) {
    if (await must(theme.file, ["contributes", "themes", i, "file"], "entry") && (await checkTheme(reader, base, theme.file, topId, f))) cards.styled = true;
  }
  for (const [i, ui] of (c.ui ?? []).entries()) {
    if (ui.style && (await must(ui.style, ["contributes", "ui", i, "style"], "entry")) && (await checkTheme(reader, base, ui.style, topId, f))) cards.styled = true;
    if (ui.web?.entry) await must(ui.web.entry, ["contributes", "ui", i, "web", "entry"], "entry");
  }
  for (const [i, loc] of (c.locales ?? []).entries()) {
    if (await must(loc.file, ["contributes", "locales", i, "file"], "entry")) await checkLocale(reader, base, loc.file, loc.lang, topId, isBot, f);
  }
  for (const [i, model] of (c.models ?? []).entries()) if (typeof model.catalog === "string") await must(model.catalog, ["contributes", "models", i, "catalog"], "entry");
  for (const [i, agent] of (c.agents ?? []).entries()) {
    if (typeof agent === "string") await must(agent, ["contributes", "agents", i], "entry");
    else await must(agent.instructions, ["contributes", "agents", i, "instructions"], "entry");
  }
  for (const [name, s] of Object.entries(c.mcpServers ?? {})) await must(s.instructions, ["contributes", "mcpServers", name, "instructions"], "entry");
}

async function readFormat(reader: PluginFolderReader, base: string, path: string, file: string, f: TreeFindings): Promise<unknown | undefined> {
  const full = `${base}${path.startsWith("./") ? path.slice(2) : path}`;
  const text = await reader.readText(full);
  if (text === undefined) return undefined;
  const parsed = parseJsonc(text);
  if (!parsed.ok) {
    f.error(full, "entry", "jsonc", [], `not JSON: ${parsed.error.message} (line ${parsed.error.line})`);
    return undefined;
  }
  return parsed.value;
}

const TOKEN_TYPE = new Map(TOKENS.map((t) => [t.name, t.type] as const));

/** Checks a theme or `style` file; true when it sets `card.*` tokens, which is card styling (§5.5). */
async function checkTheme(reader: PluginFolderReader, base: string, path: string, topId: string, f: TreeFindings): Promise<boolean> {
  const full = `${base}${path}`;
  const value = await readFormat(reader, base, path, full, f);
  if (value === undefined) return false;
  const parsed = ThemeSchema.safeParse(value);
  if (!parsed.success) {
    for (const i of flattenZodIssues(parsed.error)) f.error(full, "entry", "file_format", i.path, i.message);
    return false;
  }
  const t = parsed.data;
  const tokenSets: [Record<string, TokenValue>, Seg[]][] = [[t.tokens, ["tokens"]], ...(t.dark ? [[t.dark.tokens, ["dark", "tokens"]] as [Record<string, TokenValue>, Seg[]]] : [])];
  for (const [tokens, where] of tokenSets) {
    for (const [name, v] of Object.entries(tokens)) {
      const type = TOKEN_TYPE.get(name);
      if (type === undefined) {
        if (!isPluginTokenName(name, topId)) f.error(full, "entry", "token_unknown", [...where, name], `"${name}" is no token of the catalog, nor one of this plugin's (plugin.${topId}.…)`);
        else if (!TOKEN_TYPES.some((type) => isTokenValue(type, v))) f.error(full, "entry", "token_value", [...where, name], "this value isn't a safe token value");
      } else if (!isValueForToken(name, v)) {
        f.error(full, "entry", "token_value", [...where, name], `"${v}" is not a ${type}`);
      }
    }
  }
  for (const p of [t.css, ...(t.fonts ?? []).map((x) => x.src), ...Object.values(t.icons ?? {})]) {
    if (p === undefined) continue;
    const problem = manifestPathProblem(p);
    if (problem) f.error(full, "entry", "path_escape", [], `"${p}" has ${problem}`);
  }
  return setsCardTokens(t);
}

/** A Live2D avatar's `model3.json` names files beside it (`live2dReferences`); each must exist and stay inside the
 *  folder. A `.zip` is checked when the core unpacks it. */
async function checkLive2d(reader: PluginFolderReader, base: string, path: string, f: TreeFindings): Promise<void> {
  if (!path.toLowerCase().endsWith(".model3.json")) return;
  const full = `${base}${path.startsWith("./") ? path.slice(2) : path}`;
  const value = await readFormat(reader, base, path, full, f);
  if (value === undefined) return;
  const refs = live2dReferences(value);
  if (refs === null) {
    f.error(full, "contribution", "file_format", [], "not a Cubism model3.json: it needs FileReferences with a Moc and Textures");
    return;
  }
  const dir = full.includes("/") ? full.slice(0, full.lastIndexOf("/") + 1) : "";
  for (const ref of refs) {
    const problem = manifestPathProblem(`${dir.slice(base.length)}${ref}`);
    if (problem) f.error(full, "contribution", "path_escape", [], `"${ref}" has ${problem}`);
    else if (!(await reader.exists(`${dir}${ref}`))) f.error(full, "contribution", "file_missing", [], `"${ref}" doesn't exist`);
  }
}

async function checkLayout(reader: PluginFolderReader, base: string, path: string, file: string, isBot: boolean, f: TreeFindings): Promise<void> {
  const full = `${base}${path}`;
  const value = await readFormat(reader, base, path, full, f);
  if (value === undefined) return;
  const parsed = LayoutSchema.safeParse(value);
  if (!parsed.success) {
    for (const i of flattenZodIssues(parsed.error)) f.error(full, "contribution", "file_format", i.path, i.message);
    return;
  }
  for (const p of layoutPaths(parsed.data)) {
    const problem = manifestPathProblem(p);
    if (problem) f.error(full, "contribution", "path_escape", [], `"${p}" has ${problem}`);
  }
  if (isBot) {
    for (const spot of layoutSpots(parsed.data.root)) {
      const info = spotInfo(spot);
      if (info && !info.inBotTab) f.error(full, "contribution", "layout_foreign_spot", [], `a bot's layout places spots of its tab, and "${spot}" is outside it`);
    }
  }
  void file;
}

async function checkLocale(reader: PluginFolderReader, base: string, path: string, lang: string, topId: string, isBot: boolean, f: TreeFindings): Promise<void> {
  const full = `${base}${path}`;
  const value = await readFormat(reader, base, path, full, f);
  if (value === undefined) return;
  const parsed = LocaleSchema.safeParse(value);
  if (!parsed.success) {
    for (const i of flattenZodIssues(parsed.error)) f.error(full, "entry", "file_format", i.path, i.message);
    return;
  }
  if (parsed.data.lang !== lang) f.error(full, "entry", "locale_lang", ["lang"], `the file is "${parsed.data.lang}" but the manifest says "${lang}"`);
  if (isBot) {
    // A bot's plugin translates only its own keys (§5.5); a pack for the rest can be a child in its folder.
    for (const key of Object.keys(parsed.data.strings)) {
      if (localeKeyOwner(key) !== topId) f.error(full, "entry", "locale_foreign_key", ["strings", key], `a bot's plugin translates only its own keys (${topId}.…)`);
    }
  }
}
