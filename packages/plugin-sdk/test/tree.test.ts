// Validating a whole plugin folder (spec §5.1 child plugins, §5.5 a bot's tab, §5.6 `moss plugin validate`),
// through an in-memory reader.
import { describe, expect, test } from "bun:test";
import { MAX_CHILD_PLUGINS } from "@waifucave/moss-protocol";
import { describeOk, detectBareItem, validateTree, type PluginFolderReader } from "../src/index";

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

const LUNA = {
  "moss.json": {
    manifest: 1, id: "luna", name: "Luna", version: "1.0.0",
    contributes: {
      bot: { name: "Luna", instructions: "bot/instructions.md", theme: "luna" },
      themes: [{ id: "luna", file: "tab/theme.json" }],
      locales: [{ lang: "fr", file: "locales/fr.json" }],
    },
  },
  "bot/instructions.md": "You are Luna.",
  "tab/theme.json": THEME,
  "locales/fr.json": { locale: 1, lang: "fr", strings: { "luna.greeting": "Bonjour", "luna.cards": { one: "{n} carte", other: "{n} cartes" } } },
  "plugins/tarot-panel/moss.json": {
    manifest: 1, name: "Tarot panel", engines: { moss: "^1.0.0" }, client: { entry: "client/index.tsx" },
    contributes: { ui: [{ spot: "panel", key: "tarot", title: "Tarot", component: "TarotPanel" }] },
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
      "plugins/tarot-panel/moss.json": {
        manifest: 1, name: "Tarot panel", engines: { moss: "^1.0.0" }, client: { entry: "client/index.tsx" }, capabilities: ["approvals"],
        contributes: { ui: [{ spot: "panel", key: "tarot", title: "Tarot", component: "TarotPanel" }] },
      },
    };
    const p = await validateTree(folder(placer), { folderName: "luna" });
    expect([p.restylesCards, p.children[0]!.report.restylesCards]).toEqual([true, true]);
  });

  test("a theme with a shell block styles the window: the OK says so; one without does not", async () => {
    const plain = await validateTree(folder(LUNA), { folderName: "luna" });
    expect(plain.restylesWindow).toBe(false);
    expect(describeOk(plain.top, { restylesWindow: plain.restylesWindow }).join(" ")).not.toContain("styles the window");
    const skinned = { ...LUNA, "tab/theme.json": { ...THEME, shell: { tokens: { bar: "#1b1530", "bar.text": "#f4eefc", "bar.rule": "#3a2f5e" } } } };
    const r = await validateTree(folder(skinned), { folderName: "luna" });
    // Whether its colours read is formats.test's (`shell_dropped`, a warning): here, only that it validates and restyles.
    expect(r.issues.filter((i) => i.code !== "shell_dropped")).toEqual([]);
    expect(r.restylesWindow).toBe(true);
    expect(r.windowSkin).toContain("tab/theme.json=");
    expect(plain.windowSkin).toBe("");
    expect(describeOk(r.top, { restylesWindow: r.restylesWindow })).toContain("It styles the window while its tab shows.");
  });


  test("a client stylesheet must exist (review minor)", async () => {
    const files = {
      ...LUNA,
      "plugins/tarot-panel/moss.json": {
        manifest: 1, name: "Tarot panel", engines: { moss: "^1.0.0" }, client: { entry: "client/index.tsx", css: ["client/panel.css"] },
        contributes: { ui: [{ spot: "panel", key: "tarot", title: "Tarot", component: "TarotPanel" }] },
      },
    };
    const r = await validateTree(folder(files), { folderName: "luna" });
    expect(r.issues.map((i) => `${i.file}:${i.refuses}:${i.code}:${i.path}`)).toEqual(["plugins/tarot-panel/moss.json:plugin:file_missing:/client/css/0"]);
    expect(r.children[0]!.ok).toBe(false);
  });

  test("a missing referenced file refuses what names it", async () => {
    const files = { ...LUNA } as Record<string, unknown>;
    delete files["bot/instructions.md"];
    const r = await validateTree(folder(files as Record<string, string>), { folderName: "luna" });
    expect(r.issues.map((i) => `${i.refuses}:${i.code}:${i.path}`)).toEqual(["contribution:file_missing:/contributes/bot/instructions"]);
  });

  test("a symlink out of the folder is refused where the reader says so", async () => {
    const r = await validateTree(folder(LUNA, { outside: ["tab/theme.json"] }), { folderName: "luna" });
    expect(r.issues.map((i) => i.code)).toEqual(["path_escape"]);
  });

  test("a bot's plugin translates only its own keys (§5.5)", async () => {
    const files = { ...LUNA, "locales/fr.json": { locale: 1, lang: "fr", strings: { "luna.greeting": "Bonjour", "moss.send": "Envoyer" } } };
    const r = await validateTree(folder(files), { folderName: "luna" });
    expect(r.issues.map((i) => `${i.code}:${i.path}`)).toEqual(["locale_foreign_key:/strings/moss.send"]);
  });

  test("a bot's tab layout is retired (G8): a bot's own is ignored with a warning and never read, another plugin's patch is refused", async () => {
    const own = { ...LUNA, "moss.json": { ...LUNA["moss.json"], contributes: { ...LUNA["moss.json"].contributes, bot: { ...LUNA["moss.json"].contributes.bot, layout: "tab/layout.json" } } }, "tab/layout.json": { layout: 1, root: { row: [{ spot: "sidebar" }, { image: "../x.png" }] } } };
    const r = await validateTree(folder(own), { folderName: "luna" });
    // The layout file is never read (its foreign spot and its path out of the folder are no findings); the manifest says why.
    expect(r.issues).toEqual([]);
    expect(r.top.issues.map((i) => `${i.severity}:${i.code}:${i.path}`)).toEqual(["warning:bot_layout_retired:/contributes/bot/layout"]);
    expect(r.ok).toBe(true);
    const mover = folder({
      "moss.json": { manifest: 1, id: "mover", name: "Mover", version: "1.0.0", engines: { moss: "^1.0.0" }, contributes: { ui: [{ spot: "bot.tab", id: "move", layout: "tab/move.json", when: { bot: "luna" } }] } },
      "tab/move.json": { layout: 1, changes: [{ move: "bot.header", before: "composer" }] },
    } as Record<string, string | object>);
    const moved = await validateTree(mover, { folderName: "mover" });
    expect([...moved.issues, ...moved.top.issues].map((i) => `${i.refuses}:${i.code}:${i.path}`)).toEqual(["entry:spot_retired:/contributes/ui/0/layout"]);
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
    const files = { ...LUNA, "plugins/tarot-panel/moss.json": { manifest: 1, id: "tarot-panel", name: "T" } };
    const r = await validateTree(folder(files), { folderName: "luna" });
    expect(r.ok).toBe(true);
    expect(r.children[0]!.ok).toBe(false);
    expect(r.children[0]!.report.issues.map((i) => i.code)).toEqual(["child_id"]);
  });

  test("tool names are unique across the whole tree, which shares one namespace", async () => {
    const tools = (cmd: string) => ({ manifest: 1, name: cmd, engines: { moss: "^1.0.0" }, contributes: { mcpServers: { s: { type: "stdio", command: cmd, tools: { Draw: "preload" } } } } });
    const files = { ...LUNA, "plugins/deck-a/moss.json": tools("a"), "plugins/deck-b/moss.json": tools("b") };
    const r = await validateTree(folder(files), { folderName: "luna" });
    expect(r.issues.map((i) => `${i.file}:${i.code}`)).toEqual(["plugins/deck-b/moss.json:tool_duplicate"]);
    expect(r.children.find((c) => c.folder === "deck-b")!.ok).toBe(false);
    expect(r.children.find((c) => c.folder === "deck-a")!.ok).toBe(true);
  });

  test("children are one level deep", async () => {
    const files = { ...LUNA, "plugins/tarot-panel/plugins/deeper/moss.json": { manifest: 1, name: "Deeper" } };
    const r = await validateTree(folder(files), { folderName: "luna" });
    expect(r.issues.map((i) => i.code)).toEqual(["nested_children"]);
  });
});

describe("a folder with no moss.json", () => {
  test("is a bare item the core wraps: a Claude Code plugin, a skill folder or an MCP config (§5.1)", async () => {
    expect(await detectBareItem(folder({ ".claude-plugin/plugin.json": {} }))).toBe("claude-plugin");
    expect(await detectBareItem(folder({ "commands/review.md": "x" }))).toBe("claude-plugin");
    expect(await detectBareItem(folder({ "hooks/hooks.json": {} }))).toBe("claude-plugin");
    expect(await detectBareItem(folder({ "SKILL.md": "x" }))).toBe("skill-folder");
    expect(await detectBareItem(folder({ ".mcp.json": {} }))).toBe("mcp-config");
    expect(await detectBareItem(folder({ "moss.json": {}, "SKILL.md": "x" }))).toBeUndefined();
    const r = await validateTree(folder({ "SKILL.md": "x" }), { folderName: "pdf" });
    expect(r.ok).toBe(false);
    expect(r.bareItem).toBe("skill-folder");
    expect(r.top.issues.map((i) => i.code)).toEqual(["manifest_missing"]);
  });
});

// The audit's plugin.list crash: MOSS's bundled tree has 259 children, past the old cap of 256.
describe("a tree's children are bounded", () => {
  const pack = (n: number) => {
    const files: Record<string, string | object> = { "moss.json": { manifest: 1, id: "pack", name: "Pack", version: "1.0.0" } };
    for (let i = 0; i < n; i++) files[`plugins/c${String(i).padStart(4, "0")}/moss.json`] = { manifest: 1, name: `C${i}` };
    return folder(files);
  };

  test("300 children validate, and every list of them fits the protocol's bound", async () => {
    const r = await validateTree(pack(300), { folderName: "pack" });
    expect(r.children.length).toBe(300);
    expect(r.issues.filter((i) => i.code === "too_many_children")).toEqual([]);
  });

  test(`a tree past ${MAX_CHILD_PLUGINS} children is refused, and only the first ${MAX_CHILD_PLUGINS} are read`, async () => {
    const r = await validateTree(pack(MAX_CHILD_PLUGINS + 1), { folderName: "pack" });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === "too_many_children" && i.refuses === "plugin")).toBe(true);
    expect(r.children.length).toBe(MAX_CHILD_PLUGINS);
  });

  // Whoever owns a plug sets the rules (§5.5, the owner's rule of November 14): Bots offers a bot its top bar, never the
  // sidebar. A child tied to the bot's tab may dress the bar as any app plugin may, and nothing tied to a bot's tab
  // dresses the sidebar; the bot's own plugin fills its bar directly.
  test("a bot's top bar is retired (G8), directly or through a child; a child's panel names its capabilities; the sidebar no part tied to its tab dresses", async () => {
    const chromeChild = (ui: Record<string, unknown>[]) => ({
      "plugins/chrome/moss.json": {
        manifest: 1, name: "Luna's chrome", engines: { moss: "^1.0.0" }, client: { entry: "client/index.tsx" },
        capabilities: ["bots.read", "shell.read", "shell.control"], contributes: { ui },
      },
      "plugins/chrome/client/index.tsx": "export const LunaBar = () => null; export const LunaSidebar = () => null;",
    });
    const barChild = await validateTree(folder({ ...LUNA, ...chromeChild([{ spot: "bar", id: "bar", component: "LunaBar", when: { bot: "luna" } }]) }), { folderName: "luna" });
    expect(barChild.children.find((c) => c.folder === "chrome")!.report.issues.map((i) => i.code)).toEqual(["spot_retired"]);
    const r = await validateTree(folder({ ...LUNA, ...chromeChild([{ spot: "panel", key: "lunabar", title: "Luna", id: "bar", component: "LunaBar", when: { bot: "luna" } }]) }), { folderName: "luna" });
    expect(r.issues).toEqual([]);
    const child = r.children.find((c) => c.folder === "chrome")!;
    expect([child.ok, child.report.id, child.report.class]).toEqual([true, "luna/chrome", "code"]);
    // The card names the two capabilities in words, so the user sees what the part may do before it installs.
    const card = describeOk(child.report, { treeCapabilities: r.top.capabilities.concat(child.report.capabilities) }).join(" ");
    expect(card).toContain("lets its own buttons move around MOSS's window");
    expect(card).toContain("sees which tab and panels are showing");
    const sidebar = await validateTree(folder({ ...LUNA, ...chromeChild([{ spot: "sidebar", id: "sidebar", component: "LunaSidebar", when: { bot: "luna" } }]) }), { folderName: "luna" });
    expect(sidebar.children.find((c) => c.folder === "chrome")!.report.issues.some((i) => i.code === "bot_tied_not_offered")).toBe(true);
    const withUi = (ui: Record<string, unknown>[]) => ({ ...LUNA, "moss.json": { ...(LUNA["moss.json"] as { contributes: object }), contributes: { ...(LUNA["moss.json"] as { contributes: object }).contributes, ui }, engines: { moss: "^1.0.0" }, client: { entry: "client/index.tsx" } }, "client/index.tsx": "export const X = () => null;" });
    const bar = await validateTree(folder(withUi([{ spot: "bar", component: "X" }])), { folderName: "luna" });
    expect([...bar.issues, ...bar.top.issues].map((i) => i.code)).toEqual(["spot_retired"]);
    const bad = await validateTree(folder(withUi([{ spot: "sidebar", component: "X" }])), { folderName: "luna" });
    expect([...bad.issues, ...bad.top.issues].some((i) => i.code === "bot_spot_not_offered")).toBe(true);
  });

  test("a bot's own locale table translates only its keys; one marked `app` may translate the rest", async () => {
    const withLocale = (app: boolean) => ({
      ...LUNA,
      "moss.json": { ...(LUNA["moss.json"] as { contributes: object }), contributes: { ...(LUNA["moss.json"] as { contributes: object }).contributes, locales: [{ lang: "fr", file: "fr.json", ...(app ? { app: true } : {}) }] } },
      "fr.json": { locale: 1, lang: "fr", strings: { "luna.hello": "Salut", "moss.send": "Envoyer" } },
    });
    const own = await validateTree(folder(withLocale(false)), { folderName: "luna" });
    expect([...own.issues, ...own.top.issues].some((i) => i.code === "locale_foreign_key")).toBe(true);
    const app = await validateTree(folder(withLocale(true)), { folderName: "luna" });
    expect([...app.issues, ...app.top.issues].some((i) => i.code === "locale_foreign_key")).toBe(false);
  });
});
