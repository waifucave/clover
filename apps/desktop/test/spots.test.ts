// The spot resolver (spec §5.5 "UI spots" and "Which entry shows"): keyed defaults, the six rules, the smaller part,
// style and hide entries, `needs` and `keep`, list spots and safe mode.
import { describe, expect, test } from "bun:test";
import { readUiEntry, type UiPlugin } from "../src/main/ui/model";
import { NO_CHOICES, SpotTree, entryRef, partOf, resolveCell, type CellContext, type UiChoices } from "../src/main/ui/spots";

let enabled = 0;
function plugin(id: string, ui: Record<string, unknown>[], opts: Partial<Pick<UiPlugin, "source" | "isBot" | "bots" | "enabledAt">> & { caps?: string[] } = {}): UiPlugin {
  const top = id.split("/")[0]!;
  return {
    id,
    topId: top,
    layer: top === "clover" ? "clover" : id.replace(/\//g, "--"),
    treeHash: "0".repeat(64),
    assetBase: `/plugins/${id}`,
    css: [],
    source: opts.source ?? (top === "clover" || top === "alpha" ? "bundled" : "installed"),
    enabledAt: opts.enabledAt ?? ++enabled,
    capabilities: new Set(opts.caps ?? []),
    bots: opts.bots ?? "all",
    isBot: opts.isBot ?? false,
    themes: [],
    locales: [],
    entries: ui.map((u) => readUiEntry(id, u)!),
  };
}

const ctx: CellContext = { os: "macos" };
const inTab = (bot: string, extra: Partial<CellContext> = {}): CellContext => ({ os: "macos", bot, ...extra });
const shownRefs = (r: { shown: { entry: { pluginId: string; id: string } }[] }) => r.shown.map((c) => entryRef(c.entry));

// The default shell, as F's manifests have it, plus what the default bot tab would add.
const shell = plugin("clover/shell", [{ spot: "app.root", component: "Window", declares: { sidebar: { shape: "single", props: {} }, main: { shape: "keyed", props: {} }, panel: { shape: "keyed", props: {} } } }]);
const sidebar = plugin("clover/sidebar", [{ spot: "sidebar", component: "Sidebar" }]);
const composer = plugin("clover/composer", [{ spot: "composer", component: "Composer", declares: { "composer.action": { shape: "keyed", props: {} } } }]);
const conversation = plugin("clover/conversation", [{ spot: "conversation", component: "ConversationView" }, { spot: "conversation.message", component: "Message" }], { caps: ["conversation.read", "approvals"] });
const panelDiff = plugin("clover/panel-diff", [{ spot: "panel", key: "diff", component: "DiffPanel", when: { session: "coding" } }]);
const panelSession = plugin("clover/panel", [{ spot: "panel", key: "session", component: "SessionView" }]);
const DEFAULT = [shell, sidebar, composer, conversation, panelDiff, panelSession];

describe("single spots and keyed defaults", () => {
  test("the shell fills app.root", () => {
    expect(shownRefs(resolveCell({ plugins: DEFAULT, ctx }, "app.root"))).toEqual(["clover/shell#app.root"]);
  });

  test("an exact key fills its cell; a key nothing fills shows nothing", () => {
    expect(shownRefs(resolveCell({ plugins: DEFAULT, ctx }, "panel", "session"))).toEqual(["clover/panel#panel"]);
    expect(resolveCell({ plugins: DEFAULT, ctx }, "panel", "browser").shown).toEqual([]);
  });

  test("an entry with no key fills every key without its own, after `*` patterns, after exact keys", () => {
    const any = plugin("x-files", [{ spot: "file.preview", component: "Any" }]);
    const images = plugin("x-images", [{ spot: "file.preview", key: "image/*", component: "Images" }]);
    const png = plugin("x-png", [{ spot: "file.preview", key: "image/png", component: "Png" }]);
    const all = [any, images, png];
    expect(shownRefs(resolveCell({ plugins: all, ctx }, "file.preview", "image/png"))).toEqual(["x-png#file.preview"]);
    expect(shownRefs(resolveCell({ plugins: all, ctx }, "file.preview", "image/jpeg"))).toEqual(["x-images#file.preview"]);
    expect(shownRefs(resolveCell({ plugins: all, ctx }, "file.preview", "text/plain"))).toEqual(["x-files#file.preview"]);
  });

  test("a bot's own keyless bot.tab entry fills only that bot's tab", () => {
    const luna = plugin("luna", [{ spot: "bot.tab", component: "LunaTab" }], { isBot: true });
    const tabs = plugin("x-tabs", [{ spot: "bot.tab", component: "AnyTab" }]);
    expect(shownRefs(resolveCell({ plugins: [luna, tabs], ctx }, "bot.tab", "luna"))).toEqual(["luna#bot.tab"]);
    expect(shownRefs(resolveCell({ plugins: [luna, tabs], ctx }, "bot.tab", "alpha"))).toEqual(["x-tabs#bot.tab"]);
  });

  test("`when.session`: a code-only panel shows only in a code session", () => {
    expect(shownRefs(resolveCell({ plugins: DEFAULT, ctx: { os: "macos", session: "coding" } }, "panel", "diff"))).toEqual(["clover/panel-diff#panel"]);
    const bot = resolveCell({ plugins: DEFAULT, ctx: inTab("alpha", { session: "bot" }) }, "panel", "diff");
    expect(bot.shown).toEqual([]);
    expect(bot.skipped).toEqual([{ ref: "clover/panel-diff#panel", reason: "when" }]);
  });

  test("`when.os` and `when.surface`", () => {
    const winOnly = plugin("x-win", [{ spot: "status", component: "S", when: { os: ["windows"] } }]);
    const island = plugin("x-island", [{ spot: "island.tab", component: "T", title: "T", when: { surface: "island" } }]);
    expect(resolveCell({ plugins: [winOnly], ctx }, "status").shown).toEqual([]);
    expect(resolveCell({ plugins: [winOnly], ctx: { os: "windows" } }, "status").shown).toHaveLength(1);
    expect(resolveCell({ plugins: [island], ctx: { os: "macos", surface: "island" } }, "island.tab").shown).toHaveLength(1);
    expect(resolveCell({ plugins: [island], ctx: { os: "macos", surface: "pill" } }, "island.tab").shown).toHaveLength(0);
  });
});

describe("which entry shows: the six rules", () => {
  const vn = plugin("vn-composer", [{ spot: "composer", component: "VnComposer" }]);

  test("5: a plugin the user installed beats a bundled one dressing the same part", () => {
    const r = resolveCell({ plugins: [...DEFAULT, vn], ctx: inTab("alpha") }, "composer");
    expect(shownRefs(r)).toEqual(["vn-composer#composer"]);
    expect(r.decidedBy).toBe(5);
    expect(r.conflict).toBe(false);
  });

  test("1: the user's pick, for this bot first, then globally", () => {
    const choices: UiChoices = { picks: [{ spot: "composer", entry: "clover/composer" }, { spot: "composer", bot: "luna", entry: "vn-composer#composer" }], lists: [] };
    expect(shownRefs(resolveCell({ plugins: [...DEFAULT, vn], choices, ctx: inTab("alpha") }, "composer"))).toEqual(["clover/composer#composer"]);
    const luna = resolveCell({ plugins: [...DEFAULT, vn], choices, ctx: inTab("luna") }, "composer");
    expect(shownRefs(luna)).toEqual(["vn-composer#composer"]);
    expect(luna.decidedBy).toBe(1);
  });

  test("1: a pick of nothing hides the part; a pick of an entry that can't show there is ignored", () => {
    const hide: UiChoices = { picks: [{ spot: "composer", entry: null }], lists: [] };
    const r = resolveCell({ plugins: DEFAULT, choices: hide, ctx: inTab("alpha") }, "composer");
    expect(r.hidden).toBe(true);
    expect(r.shown).toEqual([]);
    const stale: UiChoices = { picks: [{ spot: "composer", entry: "gone-plugin" }], lists: [] };
    expect(shownRefs(resolveCell({ plugins: DEFAULT, choices: stale, ctx: inTab("alpha") }, "composer"))).toEqual(["clover/composer#composer"]);
  });

  test("2: the smaller part — a composer plugin turned on for a bot takes the composer from the bot's tab look", () => {
    // The bot's plugin fills its tab and its own composer: it dresses the whole tab. The composer plugin dresses only
    // the composer, so it wins there even though the bot's own entries count as limited to that bot (rule 4).
    const luna = plugin("luna", [{ spot: "bot.tab", component: "LunaTab" }, { spot: "composer", component: "LunaComposer" }], { isBot: true });
    const quiet = plugin("quiet-composer", [{ spot: "composer", component: "Quiet" }], { bots: ["luna"] });
    const r = resolveCell({ plugins: [shell, luna, quiet], ctx: inTab("luna") }, "composer");
    expect(shownRefs(r)).toEqual(["quiet-composer#composer"]);
    expect(r.decidedBy).toBe(2);
    // With the bundled composer in the running too, the composer plugin still wins (it is limited to the bot).
    expect(shownRefs(resolveCell({ plugins: [...DEFAULT, luna, quiet], ctx: inTab("luna") }, "composer"))).toEqual(["quiet-composer#composer"]);
    // In another bot's tab, neither the bot's composer nor the ticked plugin applies.
    expect(shownRefs(resolveCell({ plugins: [...DEFAULT, luna, quiet], ctx: inTab("alpha") }, "composer"))).toEqual(["clover/composer#composer"]);
  });

  test("2: a send-button plugin takes that button from a plugin that dresses every button", () => {
    const buttons = plugin("all-buttons", [{ spot: "composer.action", component: "B" }]);
    const send = plugin("send-button", [{ spot: "composer.action", key: "send", component: "Send" }]);
    const plugins = [...DEFAULT, buttons, send];
    expect(shownRefs(resolveCell({ plugins, ctx: inTab("alpha") }, "composer.action", "send"))).toEqual(["send-button#composer.action"]);
    expect(shownRefs(resolveCell({ plugins, ctx: inTab("alpha") }, "composer.action", "attach"))).toEqual(["all-buttons#composer.action"]);
  });

  test("2: the part is measured per plugin, a child counting as its own plugin", () => {
    const tree = new SpotTree(DEFAULT);
    expect(partOf(shell, "app.root", { ctx }, tree)).toBe("app.root");
    expect(partOf(composer, "composer", { ctx: inTab("alpha") }, tree)).toBe("composer");
    // A plugin whose entries sit in the composer and the conversation dresses the tab around both.
    const both = plugin("both", [{ spot: "composer", component: "C" }, { spot: "conversation", component: "V" }]);
    expect(partOf(both, "composer", { ctx: inTab("alpha") }, new SpotTree([...DEFAULT, both]))).toBe("bot.tab");
    // Inside a tab, entries outside it (a sidebar row) don't widen the part.
    const rowAndComposer = plugin("row-and-composer", [{ spot: "sidebar.bot", component: "Row" }, { spot: "composer", component: "C" }]);
    expect(partOf(rowAndComposer, "composer", { ctx: inTab("alpha") }, new SpotTree([...DEFAULT, rowAndComposer]))).toBe("composer");
  });

  test("2: a plugin's own spots sit under the entry that declares them", () => {
    const deck = plugin("deck", [{ spot: "bot.side", component: "Deck", declares: { "deck.card": { shape: "keyed", props: {} } } }, { spot: "deck.card", key: "tarot", component: "Tarot" }]);
    const tarot = plugin("tarot", [{ spot: "deck.card", key: "tarot", component: "Better" }]);
    const plugins = [...DEFAULT, deck, tarot];
    const tree = new SpotTree(plugins);
    expect(tree.chain("deck.card[tarot]")).toEqual(["deck.card[tarot]", "deck.card", "bot.side", "bot.tab", "main[bot]", "main", "app.root"]);
    const r = resolveCell({ plugins, ctx: inTab("alpha") }, "deck.card", "tarot");
    expect(shownRefs(r)).toEqual(["tarot#deck.card"]);
    expect(r.decidedBy).toBe(2);
  });

  test("3: the bot layout's `prefer`", () => {
    const a = plugin("a-composer", [{ spot: "composer", component: "A" }], { enabledAt: 1e9 });
    const b = plugin("b-composer", [{ spot: "composer", component: "B" }], { enabledAt: 1 });
    const r = resolveCell({ plugins: [a, b], ctx: inTab("alpha", { prefer: { composer: ["b-composer"] } }) }, "composer");
    expect(shownRefs(r)).toEqual(["b-composer#composer"]);
    expect(r.decidedBy).toBe(3);
  });

  test("4: the most specific `when.bot`: one bot, then some bots, then all", () => {
    const all = plugin("c-all", [{ spot: "composer", component: "A" }], { enabledAt: 3e9 });
    const some = plugin("c-some", [{ spot: "composer", component: "S", when: { bot: ["alpha", "luna"] } }], { enabledAt: 2e9 });
    const one = plugin("c-one", [{ spot: "composer", component: "O", when: { bot: "alpha" } }], { enabledAt: 1 });
    const r = resolveCell({ plugins: [all, some, one], ctx: inTab("alpha") }, "composer");
    expect(shownRefs(r)).toEqual(["c-one#composer"]);
    expect(r.decidedBy).toBe(4);
    expect(shownRefs(resolveCell({ plugins: [all, some, one], ctx: inTab("luna") }, "composer"))).toEqual(["c-some#composer"]);
    // The user's ticks replace `when.bot`.
    const ticked = plugin("c-ticked", [{ spot: "composer", component: "T", when: { bot: "alpha" } }], { bots: ["luna"] });
    expect(shownRefs(resolveCell({ plugins: [ticked], ctx: inTab("alpha") }, "composer"))).toEqual([]);
    expect(shownRefs(resolveCell({ plugins: [ticked], ctx: inTab("luna") }, "composer"))).toEqual(["c-ticked#composer"]);
  });

  test("6: the most recently enabled decides last, with a conflict badge", () => {
    const older = plugin("c-older", [{ spot: "composer", component: "O" }], { enabledAt: 100 });
    const newer = plugin("c-newer", [{ spot: "composer", component: "N" }], { enabledAt: 200 });
    const r = resolveCell({ plugins: [older, newer], ctx: inTab("alpha") }, "composer");
    expect(shownRefs(r)).toEqual(["c-newer#composer"]);
    expect(r.decidedBy).toBe(6);
    expect(r.conflict).toBe(true);
  });
});

describe("entries: style and hide, `needs` and `keep`", () => {
  test("a winning hide entry shows nothing; Settings can bring the part back with a pick", () => {
    const noStatus = plugin("no-status", [{ spot: "composer", hide: true }]);
    const r = resolveCell({ plugins: [...DEFAULT, noStatus], ctx: inTab("alpha") }, "composer");
    expect(r.hidden).toBe(true);
    expect(r.shown).toEqual([]);
    const back: UiChoices = { picks: [{ spot: "composer", entry: "clover/composer" }], lists: [] };
    expect(shownRefs(resolveCell({ plugins: [...DEFAULT, noStatus], choices: back, ctx: inTab("alpha") }, "composer"))).toEqual(["clover/composer#composer"]);
  });

  test("a kept key can't be hidden, by an entry or by a pick", () => {
    const hideCards = plugin("hide-cards", [{ spot: "conversation.message", key: "approval", hide: true }], { caps: ["conversation.read"] });
    const r = resolveCell({ plugins: [...DEFAULT, hideCards], ctx: inTab("alpha") }, "conversation.message", "approval");
    expect(r.hidden).toBe(false);
    expect(shownRefs(r)).toEqual(["clover/conversation#conversation.message"]);
    const pickNothing: UiChoices = { picks: [{ spot: "conversation.message", key: "approval", entry: null }], lists: [] };
    expect(resolveCell({ plugins: DEFAULT, choices: pickNothing, ctx: inTab("alpha") }, "conversation.message", "approval").hidden).toBe(false);
    // Another key of the same spot can be hidden.
    const hideNotes = plugin("hide-notes", [{ spot: "conversation.message", key: "note", hide: true }], { caps: ["conversation.read"] });
    expect(resolveCell({ plugins: [...DEFAULT, hideNotes], ctx: inTab("alpha") }, "conversation.message", "note").hidden).toBe(true);
  });

  test("style-only entries don't compete, and apply in reverse rank so the would-be winner applies last", () => {
    const bundledStyle = plugin("clover/look", [{ spot: "composer", style: "a.json" }]);
    const userStyle = plugin("rounder", [{ spot: "composer", style: "b.json" }]);
    const lunaStyle = plugin("luna-look", [{ spot: "composer", style: "c.json", when: { bot: "luna" } }]);
    const r = resolveCell({ plugins: [...DEFAULT, bundledStyle, userStyle, lunaStyle], ctx: inTab("luna") }, "composer");
    expect(shownRefs(r)).toEqual(["clover/composer#composer"]);
    expect(r.styles.map((c) => c.plugin.id)).toEqual(["clover/look", "rounder", "luna-look"]);
    expect(resolveCell({ plugins: [...DEFAULT, bundledStyle, userStyle, lunaStyle], ctx: inTab("alpha") }, "composer").styles.map((c) => c.plugin.id)).toEqual(["clover/look", "rounder"]);
  });

  test("`needs`: an entry whose plugin lacks a capability the spot's props carry data for isn't mounted", () => {
    const blind = plugin("blind-bubbles", [{ spot: "conversation.message", key: "bot", component: "Bubble" }]);
    const r = resolveCell({ plugins: [...DEFAULT, blind], ctx: inTab("alpha") }, "conversation.message", "bot");
    expect(shownRefs(r)).toEqual(["clover/conversation#conversation.message"]);
    expect(r.skipped).toEqual([{ ref: "blind-bubbles#conversation.message", reason: "needs", detail: "conversation.read" }]);
  });

  test("a plugin's own spot uses its own declaration's `needs` and `keep`", () => {
    const host = plugin("deck", [{ spot: "bot.side", component: "Deck", declares: { "deck.card": { shape: "keyed", props: {}, needs: ["bots.read"], keep: ["rules"] } } }]);
    const card = plugin("cards", [{ spot: "deck.card", key: "rules", hide: true }, { spot: "deck.card", key: "rules", component: "R" }], { caps: [] });
    const r = resolveCell({ plugins: [host, card], ctx: inTab("alpha") }, "deck.card", "rules");
    expect(r.hidden).toBe(false);
    expect(r.skipped.map((s) => s.reason)).toEqual(["needs", "needs"]);
  });
});

describe("list spots", () => {
  const a = plugin("s-a", [{ spot: "status", component: "A", order: 10 }]);
  const b = plugin("s-b", [{ spot: "status", component: "B" }]);
  const c = plugin("s-c", [{ spot: "status", component: "C" }]);

  test("every entry shows, by `order` (default 500), then plugin id", () => {
    expect(resolveCell({ plugins: [c, b, a], ctx }, "status").shown.map((x) => x.plugin.id)).toEqual(["s-a", "s-b", "s-c"]);
  });

  test("the user's order and hidden entries, for this bot first", () => {
    const choices: UiChoices = { picks: [], lists: [{ spot: "status", order: ["s-c", "s-b"], hidden: ["s-a"] }] };
    const r = resolveCell({ plugins: [a, b, c], choices, ctx }, "status");
    expect(r.shown.map((x) => x.plugin.id)).toEqual(["s-c", "s-b"]);
    expect(r.hiddenByUser.map((x) => x.plugin.id)).toEqual(["s-a"]);
  });
});

describe("safe mode", () => {
  test("only the app's own plugins run", () => {
    const vn = plugin("vn-composer", [{ spot: "composer", component: "VnComposer" }]);
    const alphaTab = plugin("alpha", [{ spot: "bot.tab", component: "AlphaTab" }], { isBot: true });
    const r = resolveCell({ plugins: [...DEFAULT, vn, alphaTab], ctx: inTab("alpha", { safeMode: true }) }, "composer");
    expect(shownRefs(r)).toEqual(["clover/composer#composer"]);
    expect(r.skipped).toEqual([{ ref: "vn-composer#composer", reason: "safe-mode" }]);
    expect(shownRefs(resolveCell({ plugins: [...DEFAULT, alphaTab], ctx: { os: "macos", safeMode: true } }, "bot.tab", "alpha"))).toEqual(["alpha#bot.tab"]);
  });

  test("with nothing to show, the cell is empty, never an error", () => {
    expect(resolveCell({ plugins: [], choices: NO_CHOICES, ctx }, "app.root")).toMatchObject({ shown: [], hidden: false, conflict: false, decidedBy: 0 });
  });
});

describe("private spots", () => {
  test("a private spot is open only to the declaring plugin's own tree (§5.4)", () => {
    const host = plugin("vn", [{ spot: "conversation", component: "Novel", declares: { "vn.line": { shape: "single", props: {}, private: true } } }]);
    const own = plugin("vn/lines", [{ spot: "vn.line", component: "Line" }], { enabledAt: 1 });
    const other = plugin("intruder", [{ spot: "vn.line", component: "Fake" }], { enabledAt: 999 });
    const r = resolveCell({ plugins: [host, own, other], ctx }, "vn.line");
    expect(shownRefs(r)).toEqual(["vn/lines#vn.line"]);
    expect(r.skipped).toContainEqual({ ref: "intruder#vn.line", reason: "private" });
    // The same spot, not private: the most recently enabled wins.
    const open = plugin("vn", [{ spot: "conversation", component: "Novel", declares: { "vn.line": { shape: "single", props: {} } } }]);
    expect(shownRefs(resolveCell({ plugins: [open, own, other], ctx }, "vn.line"))).toEqual(["intruder#vn.line"]);
  });
});
