// Validating a whole plugin folder through a reader (spec §5.1, §5.6 `clover plugin validate`): the top-level manifest,
// its child plugins one level deep, the files the manifests name, and the theme, layout and locale files they point
// to. Nothing runs. The reader is how the folder is reached: the real file system for the CLI and the registry, or an
// in-memory folder in tests.
import { MAX_CHILD_PLUGINS, type ValidationIssue } from "@waifucave/clover-protocol";
import { avatarFileProblem, BUNDLED_AVATAR_FORMATS, extensionOf, live2dReferences, type AvatarFormatDecl } from "../catalogs/avatars";
import { AvatarFormatEntry } from "../catalogs/points";
import { spotInfo } from "../catalogs/spots";
import { TOKENS, TOKEN_TYPES, type TokenValue, isTokenValue, isPluginTokenName, isValueForToken } from "../catalogs/tokens";
import { DEFAULT_TAB_LAYOUT, LayoutContributionSchema, LayoutFileSchema, contributionProblems, isLayoutPatch, layoutPaths, layoutSpots, resolveLayoutFile } from "../formats/layout";
import { LocaleSchema, localeKeyOwner } from "../formats/locale";
import { resolveShell } from "../formats/shell";
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
  /** A theme or `style` file carries a `shell` block: the plugin dresses the window (title bar, sidebar, accent) while
   *  its bot is open. The OK says so (`describeOk`); a change to the file is a plugin change like any other. */
  restylesWindow: boolean;
  /** The `shell` blocks of the tree's theme files, canonical and ordered: the OK keeps them, and a change to one asks
   *  the user again (`classifyChange`). Empty when no theme has a `shell` block. */
  windowSkin: string;
  issues: ValidationIssue[];
}

interface Cards {
  styled: boolean; window: boolean; skins: string[];
  /** Each bot's avatar, checked once every format the tree declares is known (after its children are read). */
  avatars: { base: string; file: string; avatar: { file: string; format: string } }[];
  /** The `avatar.formats` entries the tree's own plugins declare. */
  formats: AvatarFormatDecl[];
}

/** JSON with every object's keys in order, so two spellings of one block compare equal. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}`;
  return JSON.stringify(v);
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
export async function validateTree(reader: PluginFolderReader, opts: {
  folderName: string; bundled?: boolean; apiVersion?: string;
  /** The installed renderers' `avatar.formats` declarations, which a bot's avatar is checked by (its file, how its
   *  model's files are found); the ones Clover ships when left out. The tree's own declarations count too. */
  avatarFormats?: readonly AvatarFormatDecl[];
}): Promise<TreeReport> {
  const findings = new TreeFindings();
  const text = await reader.readText(MANIFEST_FILE);
  if (text === undefined) {
    const bare = await detectBareItem(reader);
    const top = refusedReport([{
      severity: "error", refuses: "plugin", code: "manifest_missing", file: MANIFEST_FILE, path: "",
      message: bare ? `no ${MANIFEST_FILE}; this is a ${bare.replace("-", " ")}, which Clover wraps into a plugin` : `no ${MANIFEST_FILE}`,
    }]);
    return { ok: false, top, children: [], ...(bare ? { bareItem: bare } : {}), restylesCards: false, restylesWindow: false, windowSkin: "", issues: findings.list };
  }

  const top = validateManifest(text, { folderName: opts.folderName, bundled: opts.bundled, apiVersion: opts.apiVersion });
  const topId = top.id ?? opts.folderName;
  const namespace = top.namespace ?? topId;
  const cards: Cards = { styled: top.restylesCards, window: false, skins: [], avatars: [], formats: [] };
  if (top.manifest) await checkFiles(reader, "", top.manifest, topId, top.bot, findings, cards);

  const children: { folder: string; ok: boolean; report: ManifestReport }[] = [];
  const childFolders = (await reader.listDirs("plugins")).sort();
  // A bound every list of a plugin's children is held to (the protocol's): past it the tree is refused, and only the
  // first that many are read.
  if (childFolders.length > MAX_CHILD_PLUGINS) {
    findings.error(MANIFEST_FILE, "plugin", "too_many_children", [], `a plugin has at most ${MAX_CHILD_PLUGINS} child plugins; this one has ${childFolders.length}`);
  }
  for (const folder of childFolders.slice(0, MAX_CHILD_PLUGINS)) {
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

  // Each bot's avatar, by its format's declaration: the installed ones (or Clover's own) and the tree's.
  const formats = [...cards.formats, ...(opts.avatarFormats ?? BUNDLED_AVATAR_FORMATS)];
  for (const a of cards.avatars) await checkAvatar(reader, a.base, a.file, a.avatar, formats, findings);

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
  return { ok: !topRefused, top, children, restylesCards: cards.styled, restylesWindow: cards.window, windowSkin: cards.skins.sort().join("\n"), issues: findings.list };
}

/** The files a manifest names exist, stay inside the folder, and are well formed when they are themes, layouts or
 *  string tables. */
async function checkFiles(reader: PluginFolderReader, base: string, m: Manifest, topId: string, isBot: boolean, f: TreeFindings, cards: Cards): Promise<void> {
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
    if (c.bot.avatar && (await must(c.bot.avatar.file, ["contributes", "bot", "avatar", "file"], "contribution"))) {
      cards.avatars.push({ base, file, avatar: c.bot.avatar });
    }
    if (c.bot.layout && (await must(c.bot.layout, ["contributes", "bot", "layout"], "contribution"))) {
      await checkLayout(reader, base, c.bot.layout, file, isBot, f);
    }
  }
  for (const raw of ((c as Record<string, unknown>)["avatar.formats"] as unknown[] | undefined) ?? []) {
    const parsed = AvatarFormatEntry.safeParse(raw);
    if (parsed.success) cards.formats.push(parsed.data);
  }
  for (const [i, theme] of (c.themes ?? []).entries()) {
    if (await must(theme.file, ["contributes", "themes", i, "file"], "entry") && (await checkTheme(reader, base, theme.file, topId, f, cards))) cards.styled = true;
  }
  for (const [i, ui] of (c.ui ?? []).entries()) {
    if (ui.style && (await must(ui.style, ["contributes", "ui", i, "style"], "entry")) && (await checkTheme(reader, base, ui.style, topId, f, cards))) cards.styled = true;
    if (ui.web?.entry) await must(ui.web.entry, ["contributes", "ui", i, "web", "entry"], "entry");
    if (ui.layout && (await must(ui.layout, ["contributes", "ui", i, "layout"], "entry"))) {
      const own = new Set((c.ui ?? []).flatMap((u) => Object.keys((u as { declares?: Record<string, unknown> }).declares ?? {})));
      const css = await checkContribution(reader, base, ui.layout, own, f);
      if (css !== undefined) await must(css, ["contributes", "ui", i, "layout"], "entry");
    }
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
async function checkTheme(reader: PluginFolderReader, base: string, path: string, topId: string, f: TreeFindings, cards: Cards): Promise<boolean> {
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
  if (t.shell !== undefined) {
    cards.window = true;
    cards.skins.push(`${full}=${stable(t.shell)}`);
    // The app's own check (apps/desktop's `shellSkin`): each group kept only whole and legible over the theme's own
    // surface, Clover's marks included. A group it would drop is said here, before the user sees a window half skinned.
    for (const appearance of ["light", "dark"] as const) {
      const tokens = appearance === "dark" && (t.appearance ?? "both") === "both" ? { ...t.tokens, ...(t.dark?.tokens ?? {}) } : t.tokens;
      const surface = (tokens as Record<string, unknown>)["color.surface"];
      const ground = typeof surface === "string" && /^#[0-9a-f]{6}$/i.test(surface) ? surface : appearance === "dark" ? "#1E1E1E" : "#FFFFFF";
      for (const d of resolveShell(t.shell, appearance, ground, t.appearance ?? "both").dropped) {
        f.warn(full, "shell_dropped", ["shell"], `in ${appearance} appearance the window doesn't use its ${d.group} group: ${d.why}`);
      }
    }
  }
  return setsCardTokens(t);
}

/** A bot's avatar by its format's declaration: its file (the bot schema already holds Clover's own formats to theirs),
 *  and, for a format whose files are found by a check the core implements (`files.find`), that check. A format no
 *  declaration names isn't checked: its renderer, once installed, knows its files. */
async function checkAvatar(reader: PluginFolderReader, base: string, file: string, avatar: { file: string; format: string }, formats: readonly AvatarFormatDecl[], f: TreeFindings): Promise<void> {
  const decl = formats.find((d) => d.format === avatar.format);
  if (decl === undefined) return;
  if (!BUNDLED_AVATAR_FORMATS.some((b) => b.format === avatar.format)) {
    const problem = avatarFileProblem(avatar.format, avatar.file, [decl]);
    if (problem) {
      f.error(file, "contribution", "file_format", ["contributes", "bot", "avatar", "file"], problem);
      return;
    }
  }
  // An archive is checked when the core unpacks it.
  if (extensionOf(avatar.file, decl.entry.extensions) === ".zip") return;
  if (decl.files.find === "cubism-model3") await checkCubismModel3(reader, base, avatar.file, f);
}

/** `cubism-model3`: a Cubism `model3.json` names files beside it (`live2dReferences`); each must exist and stay inside
 *  the folder. */
async function checkCubismModel3(reader: PluginFolderReader, base: string, path: string, f: TreeFindings): Promise<void> {
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
  const parsed = LayoutFileSchema.safeParse(value);
  if (!parsed.success) {
    for (const i of flattenZodIssues(parsed.error)) f.error(full, "contribution", "file_format", i.path, i.message);
    return;
  }
  // A patch is checked as what it makes: the stock tab with its changes. A change whose node isn't there is skipped
  // where the tab is drawn (the stock tab changes over time), never an error here.
  if (isLayoutPatch(parsed.data) && parsed.data.extends !== "default") {
    f.error(full, "contribution", "file_format", ["extends"], `a plugin's layout extends "default" (the stock tab); "${parsed.data.extends}" is the user's own layout's base`);
    return;
  }
  const layout = resolveLayoutFile(parsed.data, { default: DEFAULT_TAB_LAYOUT }).layout;
  if (layout === null) return;
  for (const p of layoutPaths(layout)) {
    const problem = manifestPathProblem(p);
    if (problem) f.error(full, "contribution", "path_escape", [], `"${p}" has ${problem}`);
  }
  if (isBot) {
    for (const spot of layoutSpots(layout.root)) {
      const info = spotInfo(spot);
      if (info && !info.inBotTab) f.error(full, "contribution", "layout_foreign_spot", [], `a bot's layout places spots of its tab, and "${spot}" is outside it`);
    }
  }
  void file;
}

/** A layout patch for bots' tabs (a `ui` entry's `layout`): its own format, none of what only a bot's own layout says
 *  (`contributionProblems`), and the spots its added nodes place are the tab's own or ones the plugin's entries
 *  declare. Its CSS file, for the caller to find. */
async function checkContribution(reader: PluginFolderReader, base: string, path: string, own: ReadonlySet<string>, f: TreeFindings): Promise<string | undefined> {
  const full = `${base}${path.startsWith("./") ? path.slice(2) : path}`;
  const value = await readFormat(reader, base, path, full, f);
  if (value === undefined) return undefined;
  const parsed = LayoutContributionSchema.safeParse(value);
  if (!parsed.success) {
    for (const i of flattenZodIssues(parsed.error)) f.error(full, "entry", "file_format", i.path, i.message);
    return undefined;
  }
  for (const why of contributionProblems(parsed.data)) f.error(full, "entry", "layout_patch_reach", [], why);
  for (const c of parsed.data.changes) {
    if (!("add" in c)) continue;
    for (const spot of layoutSpots(c.add)) {
      if (spotInfo(spot)?.declaredBy === "bot-tab" || own.has(spot)) continue;
      f.error(full, "entry", "layout_foreign_spot", [], `a patch to a bot's tab places the tab's own spots or ones its plugin declares, and "${spot}" is neither`);
    }
  }
  if (parsed.data.css !== undefined) {
    const problem = manifestPathProblem(parsed.data.css);
    if (problem) {
      f.error(full, "entry", "path_escape", ["css"], `"${parsed.data.css}" has ${problem}`);
      return undefined;
    }
  }
  return parsed.data.css;
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
