// Validating a whole plugin folder (spec §5.1 child plugins, §5.5 a bot's tab, §5.6 `clover plugin validate`),
// through an in-memory reader.
import { describe, expect, test } from "bun:test";
import { detectBareItem, validateTree, type PluginFolderReader } from "../src/index";

function folder(files: Record<string, string | object>, opts: { outside?: string[] } = {}): PluginFolderReader {
  const text = new Map(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  const dirs = new Set<string>();
  for (const k of text.keys()) {
    const parts = k.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return {
    readText: (p) => text.get(p),
    exists: (p) => text.has(p) || dirs.has(p),
    listDirs: (p) => [...dirs].filter((d) => d.startsWith(`${p}/`) && !d.slice(p.length + 1).includes("/")).map((d) => d.slice(p.length + 1)),
    insideFolder: (p) => !(opts.outside ?? []).includes(p),
  };
}

const THEME = { theme: 1, name: "Luna", tokens: { "color.accent": "#7a5cff", "card.approve.background": "#7a5cff", "font.weight.bold": 700, "plugin.luna.glow": "#ffffff" } };
const LAYOUT = { layout: 1, root: { column: [{ spot: "bot.stage", grow: 1 }, { spot: "conversation", grow: 2 }, { spot: "composer" }] } };

const LUNA = {
  "clover.json": {
    manifest: 1, id: "luna", name: "Luna", version: "1.0.0",
    contributes: {
      bot: { name: "Luna", instructions: "bot/instructions.md", theme: "luna", layout: "tab/layout.json" },
      themes: [{ id: "luna", file: "tab/theme.json" }],
      locales: [{ lang: "fr", file: "locales/fr.json" }],
    },
  },
  "bot/instructions.md": "You are Luna.",
  "tab/theme.json": THEME,
  "tab/layout.json": LAYOUT,
  "locales/fr.json": { locale: 1, lang: "fr", strings: { "luna.greeting": "Bonjour", "luna.cards": { one: "{n} carte", other: "{n} cartes" } } },
  "plugins/tarot-panel/clover.json": {
    manifest: 1, name: "Tarot panel", engines: { clover: "^1.0.0" }, client: { entry: "client/index.tsx" },
    contributes: { ui: [{ spot: "panel", key: "tarot", component: "TarotPanel" }] },
  },
  "plugins/tarot-panel/client/index.tsx": "export function TarotPanel() { return null; }",
};

describe("a bot plugin with a child", () => {
  test("validates: the bot's tab look as data, the panel in a child of its own", async () => {
    const r = await validateTree(folder(LUNA), { folderName: "luna" });
    expect(r.issues).toEqual([]);
    expect(r.top.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.top.class).toBe("data");
    expect(r.children.map((c) => [c.folder, c.ok, c.report.id, c.report.class])).toEqual([["tarot-panel", true, "luna/tarot-panel", "code"]]);
  });

  test("a theme that sets card.* tokens, or a plugin with approvals, restyles approval cards (review S7)", async () => {
    const r = await validateTree(folder(LUNA), { folderName: "luna" });
    expect(r.restylesCards).toBe(true);
    expect(r.top.restylesCards).toBe(false);
    const plain = { ...LUNA, "tab/theme.json": { ...THEME, tokens: { "color.accent": "#7a5cff" } } };
    expect((await validateTree(folder(plain), { folderName: "luna" })).restylesCards).toBe(false);
    const placer = {
      ...plain,
      "plugins/tarot-panel/clover.json": {
        manifest: 1, name: "Tarot panel", engines: { clover: "^1.0.0" }, client: { entry: "client/index.tsx" }, capabilities: ["approvals"],
        contributes: { ui: [{ spot: "panel", key: "tarot", component: "TarotPanel" }] },
      },
    };
    const p = await validateTree(folder(placer), { folderName: "luna" });
    expect([p.restylesCards, p.children[0]!.report.restylesCards]).toEqual([true, true]);
  });

  test("a missing referenced file refuses what names it", async () => {
    const files = { ...LUNA } as Record<string, unknown>;
    delete files["bot/instructions.md"];
    const r = await validateTree(folder(files as Record<string, string>), { folderName: "luna" });
    expect(r.issues.map((i) => `${i.refuses}:${i.code}:${i.path}`)).toEqual(["contribution:file_missing:/contributes/bot/instructions"]);
  });

  test("a symlink out of the folder is refused where the reader says so", async () => {
    const r = await validateTree(folder(LUNA, { outside: ["tab/layout.json"] }), { folderName: "luna" });
    expect(r.issues.map((i) => i.code)).toEqual(["path_escape"]);
  });

  test("a bot's plugin translates only its own keys (§5.5)", async () => {
    const files = { ...LUNA, "locales/fr.json": { locale: 1, lang: "fr", strings: { "luna.greeting": "Bonjour", "clover.send": "Envoyer" } } };
    const r = await validateTree(folder(files), { folderName: "luna" });
    expect(r.issues.map((i) => `${i.code}:${i.path}`)).toEqual(["locale_foreign_key:/strings/clover.send"]);
  });

  test("a bot's layout places only spots of its tab", async () => {
    const files = { ...LUNA, "tab/layout.json": { layout: 1, root: { row: [{ spot: "conversation" }, { spot: "sidebar" }] } } };
    const r = await validateTree(folder(files), { folderName: "luna" });
    expect(r.issues.map((i) => i.code)).toEqual(["layout_foreign_spot"]);
  });

  test("theme tokens are the catalog's or the plugin's own, with safe values", async () => {
    const tokens = {
      "color.accent": "red; } body { display: none", "colour.bg": "#fff", "radius.medium": "url(x)", "font.size.body": 14,
      "plugin.luna.glow-x": "#fff", "plugin.luna.glow.soft": "#ffffff80", "luna.glow": "#fff", "plugin.luna.halo": "red; x",
    };
    const bad = { ...LUNA, "tab/theme.json": { theme: 1, name: "Luna", tokens } };
    const r = await validateTree(folder(bad), { folderName: "luna" });
    expect(r.issues.map((i) => `${i.code}:${i.path}`).sort()).toEqual([
      "token_unknown:/tokens/colour.bg", "token_unknown:/tokens/luna.glow", "token_unknown:/tokens/plugin.luna.glow-x",
      "token_value:/tokens/color.accent",
      "token_value:/tokens/font.size.body", "token_value:/tokens/plugin.luna.halo", "token_value:/tokens/radius.medium",
    ]);
  });

  test("a child that fails is invalid alone, and the rest of its tree loads", async () => {
    const files = { ...LUNA, "plugins/tarot-panel/clover.json": { manifest: 1, id: "tarot-panel", name: "T" } };
    const r = await validateTree(folder(files), { folderName: "luna" });
    expect(r.ok).toBe(true);
    expect(r.children[0]!.ok).toBe(false);
    expect(r.children[0]!.report.issues.map((i) => i.code)).toEqual(["child_id"]);
  });

  test("tool names are unique across the whole tree, which shares one namespace", async () => {
    const tools = (cmd: string) => ({ manifest: 1, name: cmd, engines: { clover: "^1.0.0" }, contributes: { mcpServers: { s: { type: "stdio", command: cmd, tools: { Draw: "preload" } } } } });
    const files = { ...LUNA, "plugins/deck-a/clover.json": tools("a"), "plugins/deck-b/clover.json": tools("b") };
    const r = await validateTree(folder(files), { folderName: "luna" });
    expect(r.issues.map((i) => `${i.file}:${i.code}`)).toEqual(["plugins/deck-b/clover.json:tool_duplicate"]);
    expect(r.children.find((c) => c.folder === "deck-b")!.ok).toBe(false);
    expect(r.children.find((c) => c.folder === "deck-a")!.ok).toBe(true);
  });

  test("children are one level deep", async () => {
    const files = { ...LUNA, "plugins/tarot-panel/plugins/deeper/clover.json": { manifest: 1, name: "Deeper" } };
    const r = await validateTree(folder(files), { folderName: "luna" });
    expect(r.issues.map((i) => i.code)).toEqual(["nested_children"]);
  });
});

describe("a folder with no clover.json", () => {
  test("is a bare item the core wraps: a Claude Code plugin, a skill folder or an MCP config (§5.1)", async () => {
    expect(await detectBareItem(folder({ ".claude-plugin/plugin.json": {} }))).toBe("claude-plugin");
    expect(await detectBareItem(folder({ "commands/review.md": "x" }))).toBe("claude-plugin");
    expect(await detectBareItem(folder({ "hooks/hooks.json": {} }))).toBe("claude-plugin");
    expect(await detectBareItem(folder({ "SKILL.md": "x" }))).toBe("skill-folder");
    expect(await detectBareItem(folder({ ".mcp.json": {} }))).toBe("mcp-config");
    expect(await detectBareItem(folder({ "clover.json": {}, "SKILL.md": "x" }))).toBeUndefined();
    const r = await validateTree(folder({ "SKILL.md": "x" }), { folderName: "pdf" });
    expect(r.ok).toBe(false);
    expect(r.bareItem).toBe("skill-folder");
    expect(r.top.issues.map((i) => i.code)).toEqual(["manifest_missing"]);
  });
});
