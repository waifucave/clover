// The file formats (spec §5.1, §5.5, §5.9): theme, layout, locale, index, revocations, the tree hash and semver.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  IndexSchema, LayoutContributionSchema, LayoutSchema, LayoutFileSchema, LocaleSchema, contributionProblems, DEFAULT_TAB_LAYOUT, applyLayoutPatch, resolveLayoutFile, ThemeSchema, compareVersions, isTreeHashExcluded,
  layoutPaths, layoutSpots, localeFallbacks, parseRange, parseVersion, placeholdersOf, satisfies,
  AUTO_INK, AUTO_INKS, FRAME_VARIABLES, LABEL_INK, SYSTEM_ACCENT, SYSTEM_ACCENT_TOKENS, TOKENS, contrastRatio, cssProperty, fillForWhiteLabel, flattenColor,
  isValueForToken, systemAccentFromOs, validateTree,
  cardTokensChanged, cssFunctionName, cssUnescape, cssUrlArgumentsAreDynamic, isCssUrlFunction, isDroppedCssFunction, resolveCssUrl, resolveTokens, setsCardTokens, sha256Hex,
  themeTokensFor, treeHash, treeHashInput, treePathProblem,
} from "../src/index";

const H = (c: string) => c.repeat(64);

describe("theme format 1", () => {
  test("tokens, a dark set, cleaned CSS, fonts and icons", () => {
    const t = { theme: 1, name: "Luna", appearance: "both", tokens: { "color.accent": "#7a5cff" }, dark: { tokens: { "color.accent": "#9c85ff" } }, css: "tab/theme.css", fonts: [{ family: "Luna Sans", src: "fonts/luna.woff2" }], icons: { send: "icons/send.svg" } };
    expect(ThemeSchema.safeParse(t).success).toBe(true);
    expect(ThemeSchema.safeParse({ ...t, theme: 2 }).success).toBe(false);
    expect(ThemeSchema.safeParse({ ...t, script: "x.js" }).success).toBe(false);
  });
});

describe("appearance and the fallback order", () => {
  test("a light-only theme does nothing in dark; a `both` theme's dark.tokens replace some of its tokens", () => {
    const light = { appearance: "light" as const, tokens: { "color.accent": "#111111" } };
    expect(themeTokensFor(light, "light")).toEqual({ "color.accent": "#111111" });
    expect(themeTokensFor(light, "dark")).toBeUndefined();
    const both = { tokens: { "color.accent": "#111111", "color.text": "#222222" }, dark: { tokens: { "color.accent": "#eeeeee" } } };
    expect(themeTokensFor(both, "dark")).toEqual({ "color.accent": "#eeeeee", "color.text": "#222222" });
    expect(themeTokensFor({ appearance: "dark" as const, tokens: { "color.text": "#fafafa" } }, "light")).toBeUndefined();
  });

  test("the catalog's default for the appearance, then each layer, lowest first; unsafe values never apply", () => {
    const base = { tokens: { "color.accent": "#C2387A" }, dark: { tokens: { "color.accent": "#FF7AB6" } } };
    const bot = { appearance: "light" as const, tokens: { "color.accent": "#7A5CFF", "plugin.luna.glow": "red; x" } };
    const user = { tokens: { "color.text": "#000000" } };
    const light = resolveTokens("light", [base, bot, user]);
    expect(light["color.accent"]).toBe("#7A5CFF");
    expect(light["color.text"]).toBe("#000000");
    expect(light["color.canvas"]).toBe("#F5F5F5");
    expect(light["plugin.luna.glow"]).toBeUndefined();
    const dark = resolveTokens("dark", [base, bot, user]);
    expect(dark["color.accent"]).toBe("#FF7AB6");
    expect(dark["color.canvas"]).toBe("#202020");
  });

  test("an accent may follow the OS; a labelled fill darkens until white reads; glyphs are white at 3:1, labels at 4.5:1, else black", async () => {
    const theme = {
      tokens: { "color.accent": SYSTEM_ACCENT, "color.accent.glyph": AUTO_INK, "color.accent.contrast": AUTO_INK, "card.approve.background": SYSTEM_ACCENT, "card.approve.text": AUTO_INK },
    };
    const ink = (v: Record<string, unknown>) => [v["color.accent"], v["color.accent.glyph"], v["color.accent.contrast"], v["card.approve.background"], v["card.approve.text"]];
    const INK = "#111111";
    // The OSes' default blues get white glyphs on the raw accent; every filled control (the accent fill, the approve
    // button) is the accent darkened in its own hue until its white label reads at 4.5:1 (review A1).
    const blue = resolveTokens("light", [theme], { systemAccent: systemAccentFromOs("007affff") });
    expect(ink(blue)).toEqual(["#007AFF", "#FFFFFF", "#FFFFFF", fillForWhiteLabel("#007AFF", "#FFFFFF"), "#FFFFFF"]);
    expect(blue["color.accent.fill"]).toBe(fillForWhiteLabel("#007AFF", "#FFFFFF"));
    expect(contrastRatio("#FFFFFF", String(blue["card.approve.background"]))).toBeGreaterThanOrEqual(4.5);
    expect(ink(resolveTokens("light", [theme], { systemAccent: "#0078D4" }))).toEqual(["#0078D4", "#FFFFFF", "#FFFFFF", "#0078D4", "#FFFFFF"]);
    // A yellow accent never gets white glyphs on it; its fills still darken until white reads.
    const yellow = resolveTokens("light", [theme], { systemAccent: "#FFC600" });
    expect(ink(yellow).slice(0, 3)).toEqual(["#FFC600", INK, "#FFFFFF"]);
    expect([yellow["card.approve.text"], contrastRatio("#FFFFFF", String(yellow["card.approve.background"]))! >= 4.5]).toEqual(["#FFFFFF", true]);
    expect(contrastRatio("#FFFFFF", String(yellow["color.accent.fill"]))).toBeGreaterThanOrEqual(4.5);
    expect(ink(resolveTokens("light", [theme], { systemAccent: "#8C8C8C" })).slice(0, 3)).toEqual(["#8C8C8C", "#FFFFFF", "#FFFFFF"]);
    // The fill follows the accent as resolved, a theme's own included; a fill a theme sets itself is its own.
    expect(resolveTokens("light", [{ tokens: { "color.accent": "#5E2CA5" } }])["color.accent.fill"]).toBe("#5E2CA5");
    expect(resolveTokens("light", [{ tokens: { "color.accent": "#FFC600" } }])["color.accent.fill"]).toBe(fillForWhiteLabel("#FFC600", "#FFFFFF"));
    const ownFill = resolveTokens("light", [{ tokens: { "color.accent.fill": "#FFC600" } }], { systemAccent: "#007AFF" });
    expect([ownFill["color.accent.fill"], ownFill["color.accent.contrast"]]).toEqual(["#FFC600", LABEL_INK]);
    // A glyph's dark ink that misses 3:1 too gives way to black (review A2).
    expect(resolveTokens("light", [{ tokens: { "color.accent.ink": "#999999" } }], { systemAccent: "#FFC600" })["color.accent.glyph"]).toBe("#000000");
    // Darkened in its own hue: hue and saturation kept, lighter ones left alone.
    expect(fillForWhiteLabel("#2F6FDF", "#FFFFFF")).toBe("#2F6FDF");
    expect(fillForWhiteLabel("#0A84FF", "#191919")).toMatch(/^#[0-9A-F]{6}$/);
    expect(contrastRatio("#FFFFFF", fillForWhiteLabel("#4180E3", "#202020")!)).toBeGreaterThanOrEqual(4.5);
    // An accent with alpha is judged as painted on the control's background.
    expect(flattenColor("#007AFF80", "#FFFFFF")).toBe("#7FBCFF");
    expect(resolveTokens("light", [{ tokens: { "color.accent": "#007AFF80", "color.accent.glyph": AUTO_INK } }])["color.accent.glyph"]).toBe(INK);
    // Whatever the OS says, white is drawn only where it reaches the floor, and a labelled fill always carries white.
    for (let i = 0; i < 4096; i += 7) {
      const accent = `#${(i * 4099 % 0x1000000).toString(16).padStart(6, "0").toUpperCase()}`;
      const v = resolveTokens("light", [theme], { systemAccent: accent });
      if (v["color.accent.glyph"] === "#FFFFFF") expect([accent, contrastRatio("#FFFFFF", accent)! >= 3]).toEqual([accent, true]);
      expect([accent, v["color.accent.contrast"], contrastRatio("#FFFFFF", String(v["color.accent.fill"]))! >= 4.5]).toEqual([accent, "#FFFFFF", true]);
      if (v["color.accent.glyph"] !== "#FFFFFF") expect([accent, contrastRatio(String(v["color.accent.glyph"]), accent)! >= 3]).toEqual([accent, true]);
      expect([accent, v["card.approve.text"], contrastRatio("#FFFFFF", String(v["card.approve.background"]))! >= 4.5]).toEqual([accent, "#FFFFFF", true]);
    }
    // With no theme at all, the catalog itself follows the OS and resolves its inks.
    const bare = resolveTokens("dark", [], { systemAccent: "#0A84FF" });
    expect([bare["color.accent"], bare["color.focus"], bare["island.accept"], bare["pill.accept"], bare["island.accept.text"], bare["pill.accept.text"]])
      .toEqual(["#0A84FF", "#0A84FF", "#0A84FF", "#0A84FF", "#FFFFFF", "#FFFFFF"]);
    expect(SYSTEM_ACCENT_TOKENS.every((n) => TOKENS.find((t) => t.name === n)?.follows === SYSTEM_ACCENT)).toBe(true);
    expect(Object.keys(AUTO_INKS).every((n) => TOKENS.find((t) => t.name === n)?.follows === AUTO_INK)).toBe(true);
    // No reading (Linux): the theme's accent, the value beneath "system", which G's floors cover.
    const lunaAccent = { tokens: { "color.accent": "#5E2CA5" } };
    expect(resolveTokens("light", [lunaAccent, theme])["color.accent"]).toBe("#5E2CA5");
    expect(resolveTokens("light", [theme])["color.accent"]).toBe(TOKENS.find((t) => t.name === "color.accent")!.default);
    expect(resolveTokens("light", [theme], { systemAccent: "not a colour" })["color.accent"]).toBe(TOKENS.find((t) => t.name === "color.accent")!.default);
    expect(resolveTokens("light", [lunaAccent, theme])["color.accent.glyph"]).toBe("#FFFFFF");
    expect(resolveTokens("light", [{ tokens: { "card.approve.background": "#FFC600" } }])["card.approve.text"]).toBe(LABEL_INK);
    // A layer above that sets the accent wins over "system"; the OS is read only for "system".
    expect(resolveTokens("light", [theme, { tokens: { "color.accent": "#123456" } }], { systemAccent: "#FFC600" })["color.accent"]).toBe("#123456");
    // Only accent tokens take "system", only inks on them take "auto".
    expect(isValueForToken("color.accent", SYSTEM_ACCENT)).toBe(true);
    expect(isValueForToken("color.text", SYSTEM_ACCENT)).toBe(false);
    expect(isValueForToken("color.accent.glyph", AUTO_INK)).toBe(true);
    expect(isValueForToken("color.text", AUTO_INK)).toBe(false);
    expect(isValueForToken("plugin.luna.glow", SYSTEM_ACCENT)).toBe(false);
    expect(Object.values(AUTO_INKS).map((i) => i.floor)).toEqual([4.5, 3, 4.5, 3, 3]);
    expect(isValueForToken("color.accent.fill", SYSTEM_ACCENT)).toBe(true);
    expect(isValueForToken("color.focus", SYSTEM_ACCENT) && isValueForToken("island.accept", SYSTEM_ACCENT) && isValueForToken("pill.accept", SYSTEM_ACCENT)).toBe(true);
    expect(isValueForToken("pill.accept.text", AUTO_INK)).toBe(true);
    // The frame's variables are the shell's: no theme sets them.
    expect(FRAME_VARIABLES.map((v) => cssProperty(v.name))).toEqual(["--clover-frame-inset-top", "--clover-frame-window-controls", "--clover-frame-window-controls-end"]);
    expect(isValueForToken("frame.inset.top", "45px")).toBe(false);
    expect(systemAccentFromOs("blue")).toBeUndefined();
    // A theme file may say so.
    const files = new Map([
      ["clover.json", JSON.stringify({ manifest: 1, id: "luna", name: "Luna", contributes: { themes: [{ id: "luna", file: "t.json" }] } })],
      ["t.json", JSON.stringify({ theme: 1, name: "Luna", tokens: { "color.accent": "system", "color.accent.glyph": "auto", "color.text": "system" } })],
    ]);
    const r = await validateTree({ readText: (p) => files.get(p), exists: (p) => files.has(p), listDirs: () => [] }, { folderName: "luna" });
    expect(r.issues.map((i) => `${i.code}:${i.path}`)).toEqual(["token_value:/tokens/color.text"]);
  });

  test("a window skin the app would drop a group of is a warning at validation, by appearance, with the app's reason", async () => {
    const files = (barPaint: string) => new Map([
      ["clover.json", JSON.stringify({ manifest: 1, id: "luna", name: "Luna", contributes: { themes: [{ id: "luna", file: "t.json" }] } })],
      ["t.json", JSON.stringify({ theme: 1, name: "Luna", appearance: "light", tokens: { "color.surface": "#FFFDF6" }, shell: { tokens: { bar: barPaint, "bar.text": "#221A33", "bar.rule": "#C9BDEB" } } })],
    ]);
    const check = async (barPaint: string) => {
      const f = files(barPaint);
      return (await validateTree({ readText: (p) => f.get(p), exists: (p) => f.has(p), listDirs: () => [] }, { folderName: "luna" })).issues;
    };
    // Clover's attention mark on a bar this tinted is under 3:1 (a light-only theme: the dark appearance isn't checked, as
    // the app doesn't skin it).
    const weak = await check("#E4D2F7");
    expect(weak.map((i) => [i.severity, i.code, i.file, i.path])).toEqual([["warning", "shell_dropped", "t.json", "/shell"]]);
    expect(weak[0]!.message).toMatch(/^in light appearance the window doesn't use its bar group: Clover's attention mark on the bar is \d\.\d\d:1; it needs 3:1$/);
    expect(await check("#F6F2FF")).toEqual([]);
  });

  test("the sidebar's old shell names still load, are ignored, and each is a warning: Bots doesn't offer the sidebar", async () => {
    const files = new Map([
      ["clover.json", JSON.stringify({ manifest: 1, id: "luna", name: "Luna", contributes: { themes: [{ id: "luna", file: "t.json" }] } })],
      ["t.json", JSON.stringify({ theme: 1, name: "Luna", tokens: { "color.surface": "#FFFDF6" }, shell: { tokens: { bar: "#F6F2FF", "bar.text": "#221A33", "bar.rule": "#C9BDEB", "sidebar.mode": "none" }, dark: { tokens: { "sidebar.mode": "none", sidebar: "#16132B" } } } })],
    ]);
    const issues = (await validateTree({ readText: (p) => files.get(p), exists: (p) => files.has(p), listDirs: () => [] }, { folderName: "luna" })).issues;
    const told = issues.filter((i) => i.code === "shell_not_offered");
    expect(told.map((i) => [i.severity, i.file, i.path])).toEqual([["warning", "t.json", "/shell/sidebar"], ["warning", "t.json", "/shell/sidebar.mode"]]);
    expect(told[1]!.message).toBe('Bots doesn\'t offer the sidebar: "sidebar.mode" is ignored, and the sidebar stays as it is on every tab.');
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  test("a change to card styling waits for its OK: cards keep the values last OK'd, the rest applies (review S7)", () => {
    const okd = { tokens: { "color.accent": "#111111", "card.approve.background": "#00AA00" } };
    const now = { tokens: { "color.accent": "#222222", "card.approve.background": "#AA0000", "card.deny.background": "#00AA00" } };
    expect(setsCardTokens(okd)).toBe(true);
    expect(setsCardTokens({ tokens: { "color.accent": "#111111" } })).toBe(false);
    expect(setsCardTokens({ tokens: {}, dark: { tokens: { "card.background": "#000000" } } })).toBe(true);
    expect(cardTokensChanged(okd, now)).toBe(true);
    expect(cardTokensChanged(okd, { tokens: { ...okd.tokens, "color.accent": "#333333" } })).toBe(false);
    const held = resolveTokens("light", [{ ...now, heldCard: okd }]);
    expect(held["color.accent"]).toBe("#222222");
    expect(held["card.approve.background"]).toBe("#00AA00");
    const fresh = resolveTokens("light", []);
    expect(held["card.deny.background"]).toBe(fresh["card.deny.background"]);
    expect(resolveTokens("light", [now])["card.approve.background"]).toBe("#AA0000");
  });
});

describe("what a plugin's CSS may load", () => {
  test("a URL function whose arguments the page computes is dropped: var(), env(), attr(), however spelled (review S6)", () => {
    expect(cssUrlArgumentsAreDynamic("var(--u)")).toBe(true);
    expect(cssUrlArgumentsAreDynamic('"a.png" 1x, var(--u) 2x')).toBe(true);
    expect(cssUrlArgumentsAreDynamic("VAR(--u)")).toBe(true);
    expect(cssUrlArgumentsAreDynamic("\\76 ar(--u)")).toBe(true);
    expect(cssUrlArgumentsAreDynamic("env(safe-area-inset-top)")).toBe(true);
    expect(cssUrlArgumentsAreDynamic("attr(data-src url)")).toBe(true);
    expect(cssUrlArgumentsAreDynamic('"img/a.png" 1x, "img/b.png" 2x')).toBe(false);
    expect(cssUrlArgumentsAreDynamic("img/avatar.png")).toBe(false);
    expect(cssUrlArgumentsAreDynamic("img/xvar(1).png")).toBe(false);
  });

  test("escapes decode before any comparison, as CSS Syntax 3 says", () => {
    expect(cssUnescape("u\\72 l")).toBe("url");
    expect(cssUnescape("\\2e\\2e/x")).toBe("../x");
    expect(cssUnescape("\\55\r\nrl")).toBe("Url");
    expect(cssUnescape("\\0 a")).toBe("\uFFFDa");
    expect(cssUnescape("\\D800")).toBe("\uFFFD");
    expect(cssUnescape("\\110000")).toBe("\uFFFD");
    expect(cssUnescape("a\\")).toBe("a\uFFFD");
    expect(cssUnescape("a\\\nb")).toBe("ab");
    expect(cssFunctionName("U\\52 L")).toBe("url");
    expect(isCssUrlFunction("u\\72 l")).toBe(true);
    expect(isCssUrlFunction("-WEBKIT-Image-Set")).toBe(true);
    expect(isCssUrlFunction("rgb")).toBe(false);
    expect(isDroppedCssFunction("\\69mage")).toBe(true);
    expect(isDroppedCssFunction("cross-fade")).toBe(true);
  });

  test("a URL is resolved against its CSS file's folder, and kept only inside the plugin's folder", () => {
    expect(resolveCssUrl("img/a.png", "tab/theme.css")).toEqual({ ok: true, path: "tab/img/a.png", suffix: "" });
    expect(resolveCssUrl("../assets/a.png", "tab/theme.css")).toEqual({ ok: true, path: "assets/a.png", suffix: "" });
    expect(resolveCssUrl("%2e%2e/meadow.svg", "tab/theme.css")).toEqual({ ok: true, path: "meadow.svg", suffix: "" });
    expect(resolveCssUrl(" fonts/a.woff2?#iefix ", "tab/theme.css")).toEqual({ ok: true, path: "tab/fonts/a.woff2", suffix: "#iefix" });
    expect(resolveCssUrl("sprite.svg#send", "theme.css")).toEqual({ ok: true, path: "sprite.svg", suffix: "#send" });
    expect(resolveCssUrl("my%20font.woff2", "my dir/x.css")).toEqual({ ok: true, path: "my dir/my font.woff2", suffix: "" });
    const refused = [
      "%2e%2e/%2e%2e/secret", "../../secret", "..\\..\\secret", ".%2E/.%2e/secret", "/tab/a.png", "//evil.example/a.png",
      "https://evil.example/a.png", "HTTPS://evil.example/a.png", "ht\ttps://evil.example/a.png", "data:image/png;base64,AAAA",
      "file:///etc/passwd", "javascript:alert(1)", "a%2fb.png", "a%5cb.png", "%zz.png", "", "  ",
      "https://plugin.clover.invalid/__plugin__/x.png",
    ];
    for (const raw of refused) expect([raw, resolveCssUrl(raw, "tab/theme.css").ok]).toEqual([raw, false]);
    // A string in image-set() is a URL like any other.
    expect(resolveCssUrl("https://cdn.example/x.png", "theme.css").ok).toBe(false);
    expect(resolveCssUrl("x.png", "../theme.css").ok).toBe(false);
  });
});

describe("layout format 1", () => {
  const layout = {
    layout: 1,
    root: { row: [
      { column: [{ spot: "bot.stage", grow: 1 }, { image: "assets/frame.png", size: "40px" }], size: 320, hideBelow: 720 },
      { tabs: [{ title: "Chat", node: { spot: "conversation", prefer: ["vn-view", "luna#bubble"] } }, { title: { en: "Notes", fr: "Notes" }, node: { markdown: "notes.md" } }] },
      { spacer: true },
    ] },
    background: "assets/bg.webp",
  };

  test("rows, columns, stacks, tabs, spots, images, text and spacers, with sizes and narrow-window rules", () => {
    expect(LayoutSchema.safeParse(layout).success).toBe(true);
    expect(layoutSpots(layout.root as never).sort()).toEqual(["bot.stage", "conversation"]);
    expect(layoutPaths(layout as never).sort()).toEqual(["assets/bg.webp", "assets/frame.png", "notes.md"]);
  });

  test("no events, scripts or outside URLs: unknown keys are refused", () => {
    expect(LayoutSchema.safeParse({ layout: 1, root: { spot: "conversation", onClick: "x()" } }).success).toBe(false);
    expect(LayoutSchema.safeParse({ layout: 1, root: { row: [], column: [] } }).success).toBe(false);
  });
});

describe("layout patches: start from a layout, state only the changes", () => {
  const patch = (changes: unknown[], extra: Record<string, unknown> = {}) => {
    const parsed = LayoutFileSchema.safeParse({ layout: 1, extends: "default", changes, ...extra });
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message);
    return parsed.data as never;
  };
  const shape = (n: unknown): unknown => {
    const o = n as Record<string, unknown>;
    for (const k of ["row", "column", "stack"]) if (Array.isArray(o[k])) return { [k]: (o[k] as unknown[]).map(shape) };
    return o.spot !== undefined ? o.spot : o.class !== undefined ? `.${String(o.class)}` : Object.keys(o)[0];
  };

  test("the stock tab is named data: the stage, then the conversation over the composer, in three named boxes", () => {
    expect(LayoutSchema.safeParse(DEFAULT_TAB_LAYOUT).success).toBe(true);
    expect(layoutSpots(DEFAULT_TAB_LAYOUT.root)).toEqual(["bot.stage", "conversation", "composer"]);
    expect(DEFAULT_TAB_LAYOUT).toEqual({ layout: 1, root: { column: [{ spot: "bot.stage", class: "stage" }, { column: [{ spot: "conversation", grow: 1 }, { spot: "composer" }], grow: 1, class: "talk" }], grow: 1, class: "tab" } });
  });

  test("the owner's example: the tab turned into a row, so the stage stands to the left of the transcript, wider", () => {
    const { layout, skipped } = applyLayoutPatch(DEFAULT_TAB_LAYOUT, patch([{ set: ".tab", as: "row" }, { set: "bot.stage", size: "42%", min: 280 }]));
    expect(skipped).toEqual([]);
    expect(shape(layout.root)).toEqual({ row: ["bot.stage", { column: ["conversation", "composer"] }] });
    expect(layout.root).toMatchObject({ class: "tab", grow: 1 });
    expect((layout.root as { row: unknown[] }).row[0]).toEqual({ spot: "bot.stage", class: "stage", size: "42%", min: 280 });
    expect(LayoutSchema.safeParse(layout).success).toBe(true);
    // The base is untouched.
    expect(shape(DEFAULT_TAB_LAYOUT.root)).toEqual({ column: ["bot.stage", { column: ["conversation", "composer"] }] });
  });

  test("move before, after and into (at start, end or an index); remove; add; wrap", () => {
    const r = applyLayoutPatch(DEFAULT_TAB_LAYOUT, patch([
      { move: "composer", before: "conversation" },
      { add: { spacer: true, class: "gap" }, into: ".talk", at: 1 },
      { move: "bot.stage", into: ".talk", at: "end" },
      { wrap: "conversation", in: "row", class: "wide", gap: 8 },
      { add: { spot: "bot.side", size: 240 }, after: "conversation" },
      { remove: ".gap" },
    ]));
    expect(r.skipped).toEqual([]);
    expect(shape(r.layout.root)).toEqual({ column: [{ column: ["composer", { row: ["conversation", "bot.side"] }, "bot.stage"] }] });
    expect((r.layout.root as { column: { column: { gap?: number; class?: string }[] }[] }).column[0]!.column[1]).toMatchObject({ class: "wide", gap: 8 });
    // A spot with a key is named with it; `{ spot }` without a key names only the keyless one.
    const keyed = applyLayoutPatch({ layout: 1, root: { row: [{ spot: "panel.view", key: "files" }, { spot: "panel.view" }] } }, patch([{ remove: { spot: "panel.view", key: "files" } }]));
    expect(keyed.layout.root).toEqual({ row: [{ spot: "panel.view" }] });
  });

  test("a change whose node isn't there, or that can't be made where it points, is skipped and said, never an error", () => {
    const r = applyLayoutPatch(DEFAULT_TAB_LAYOUT, patch([
      { set: "bot.header", size: 10 },
      { remove: ".tab" },
      { move: ".talk", into: "conversation" },
      { move: ".tab", before: "composer" },
      { add: { spacer: true }, after: "no.such" },
      { set: "conversation", as: "row" },
      { set: "composer", grow: 2 },
    ]));
    expect(r.skipped).toEqual([
      "change 1 (set bot.header): no such node; skipped",
      "change 2 (remove .tab): the root or a tab's own node stays; skipped",
      "change 3 (move .talk): conversation is inside it; skipped",
      "change 4 (move .tab): the root or a tab's own node stays where it is; skipped",
      "change 5 (add): no no.such here; skipped",
      "change 6 (set conversation): only a row, column or stack can become a row; skipped",
    ]);
    // What could be made was: the composer grows.
    expect(layoutSpots(r.layout.root)).toEqual(["bot.stage", "conversation", "composer"]);
    expect(JSON.stringify(r.layout.root)).toContain('{"spot":"composer","grow":2}');
  });

  test("the file: a whole layout or a patch; changes are data only; one place per move or add; background and css replace the base's", () => {
    expect(LayoutFileSchema.safeParse(DEFAULT_TAB_LAYOUT).success).toBe(true);
    expect(LayoutFileSchema.safeParse({ layout: 1, extends: "default", changes: [{ move: "composer", before: "conversation", after: "bot.stage" }] }).success).toBe(false);
    expect(LayoutFileSchema.safeParse({ layout: 1, extends: "default", changes: [{ move: "composer", after: "bot.stage", at: 1 }] }).success).toBe(false);
    expect(LayoutFileSchema.safeParse({ layout: 1, extends: "default", changes: [{ set: "composer", onClick: "x()" }] }).success).toBe(false);
    expect(LayoutFileSchema.safeParse({ layout: 1, extends: "elsewhere", changes: [] }).success).toBe(false);
    expect(LayoutFileSchema.safeParse({ layout: 1, extends: "default", root: { spot: "conversation" }, changes: [] }).success).toBe(false);
    const withCss = resolveLayoutFile(patch([], { css: "tab/layout.css", background: "assets/bg.webp" }), { default: DEFAULT_TAB_LAYOUT });
    expect(withCss.layout).toMatchObject({ css: "tab/layout.css", background: "assets/bg.webp" });
    expect(layoutPaths(withCss.layout!).sort()).toEqual(["assets/bg.webp", "tab/layout.css"]);
  });

  test("resolving: a whole layout as it is; a patch on its base; the user's patch on the bot's own; a result that isn't a layout gives the base", () => {
    expect(resolveLayoutFile(DEFAULT_TAB_LAYOUT, { default: DEFAULT_TAB_LAYOUT }).layout).toBe(DEFAULT_TAB_LAYOUT);
    const own = { layout: 1 as const, root: { row: [{ spot: "conversation" }, { spot: "bot.stage", class: "figure" }] }, css: "tab/own.css" };
    const user = LayoutFileSchema.parse({ layout: 1, extends: "bot", changes: [{ move: ".figure", before: "conversation" }] });
    const r = resolveLayoutFile(user, { default: DEFAULT_TAB_LAYOUT, bot: own });
    expect(shape(r.layout!.root)).toEqual({ row: ["bot.stage", "conversation"] });
    expect(r.layout!.css).toBe("tab/own.css");
    expect(resolveLayoutFile(user, { default: DEFAULT_TAB_LAYOUT })).toEqual({ layout: null, notes: ['it extends "bot", and there is no such layout here'] });
    // Sixty-five boxes in one row: no valid layout, so the stock tab stays.
    const many = patch(Array.from({ length: 64 }, () => ({ add: { spacer: true }, into: ".talk" })));
    const big = resolveLayoutFile(many, { default: DEFAULT_TAB_LAYOUT });
    expect(big.layout).toBe(DEFAULT_TAB_LAYOUT);
    expect(big.notes.at(-1)).toContain("the patched layout isn't valid");
  });
});

describe("a patch from another plugin to a bot's tab", () => {
  test("changes and its own CSS only: no extends, no background; never a class on a node it didn't add, nor a prefer, an image or a markdown node", () => {
    const move = { layout: 1, changes: [{ move: "bot.header", before: "composer" }, { wrap: "bot.header", in: "row", class: "nudge" }], css: "tab/move.css" };
    const ok = LayoutContributionSchema.parse(move);
    expect(contributionProblems(ok)).toEqual([]);
    expect(LayoutContributionSchema.safeParse({ ...move, extends: "bot" }).success).toBe(false);
    expect(LayoutContributionSchema.safeParse({ ...move, background: "bg.webp" }).success).toBe(false);
    const far = LayoutContributionSchema.parse({
      layout: 1,
      changes: [
        { set: ".talk", class: "mine", grow: 2 },
        { add: { column: [{ spot: "bot.side", prefer: ["acme"] }, { image: "a.png" }] }, into: ".talk" },
        { add: { markdown: "notes.md" }, after: "composer" },
      ],
    });
    expect(contributionProblems(far)).toEqual([
      "change 1: `set` gives a class to a node it didn't add; wrap the node in a box with its own class instead",
      "change 2: a node it adds has `prefer`, which only the bot's own layout says",
      "change 2: a node it adds is an image; a tab's files are its bot's",
      "change 3: a node it adds is a markdown file; a tab's files are its bot's",
    ]);
  });
});

describe("locale format 1", () => {
  test("keys start with a plugin id and a dot; plural forms need `other`", () => {
    expect(LocaleSchema.safeParse({ locale: 1, lang: "pt-BR", strings: { "luna.hi": "Oi {name}", "clover.items": { one: "{n} item", other: "{n} itens" } } }).success).toBe(true);
    expect(LocaleSchema.safeParse({ locale: 1, lang: "pt-BR", strings: { hello: "Oi" } }).success).toBe(false);
    expect(LocaleSchema.safeParse({ locale: 1, lang: "pt-BR", strings: { "luna.items": { one: "1" } } }).success).toBe(false);
    expect(placeholdersOf("Hi {name}, {count} new")).toEqual(["name", "count"]);
  });

  test("a missing string falls back from a regional language to its base, then to English (§5.5)", () => {
    expect(localeFallbacks("pt-BR")).toEqual(["pt-BR", "pt", "en"]);
    expect(localeFallbacks("en-GB")).toEqual(["en-GB", "en"]);
    expect(localeFallbacks("zh-Hant-TW")).toEqual(["zh-Hant-TW", "zh-Hant", "zh", "en"]);
  });
});

describe("index format 1", () => {
  test("an index lists ids and versions, each with its tree hash and download URL; it carries no signing fields", () => {
    const index = { index: 1, name: "Somebody's plugins", plugins: [{ id: "luna", versions: [{ version: "1.0.0", hash: `sha256:${H("a")}`, url: "https://plugins.example.com/luna-1.0.0.tar.gz" }] }] };
    expect(IndexSchema.safeParse(index).success).toBe(true);
    expect(IndexSchema.safeParse({ ...index, plugins: [{ id: "luna", versions: [{ version: "1.0", hash: "x", url: "u" }] }] }).success).toBe(false);
    expect(IndexSchema.safeParse({ ...index, seq: 1 }).success).toBe(false);
  });
});

describe("the tree hash", () => {
  const entries = [
    { path: "host/index.ts", executable: false, sha256: H("1") },
    { path: "bin/run", executable: true, sha256: H("2") },
    { path: "clover.json", executable: false, sha256: H("3") },
    { path: "assets/.DS_Store", executable: false, sha256: H("4") },
    { path: ".git/HEAD", executable: false, sha256: H("5") },
    { path: "plugins/tarot/Thumbs.db", executable: false, sha256: H("6") },
  ];

  test("is SHA-256 over sorted lines of path, executable bit and the file's SHA-256 (§5.1)", async () => {
    const input = treeHashInput(entries);
    expect(input).toBe(`bin/run\tx\t${H("2")}\nclover.json\t-\t${H("3")}\nhost/index.ts\t-\t${H("1")}\n`);
    const want = createHash("sha256").update(input).digest("hex");
    expect(await treeHash(entries)).toBe(`sha256:${want}`);
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("leaves out only .DS_Store, Thumbs.db and .git/, at any depth", () => {
    expect(isTreeHashExcluded(".git/config")).toBe(true);
    expect(isTreeHashExcluded("plugins/x/.git/HEAD")).toBe(true);
    expect(isTreeHashExcluded("a/.DS_Store")).toBe(true);
    expect(isTreeHashExcluded(".gitignore")).toBe(false);
    expect(isTreeHashExcluded("git/x")).toBe(false);
  });

  test("sorts by UTF-8 bytes, and refuses paths that could differ between computers", () => {
    const sorted = treeHashInput([{ path: "z", executable: false, sha256: H("a") }, { path: "é", executable: false, sha256: H("b") }, { path: "a", executable: false, sha256: H("c") }]);
    expect(sorted.split("\n").slice(0, 3).map((l) => l.split("\t")[0])).toEqual(["a", "z", "é"]);
    expect(treePathProblem("é")).toBe("not in Unicode NFC");
    expect(treePathProblem("a\tb")).toBe("a control character");
    expect(treePathProblem("../x")).not.toBeNull();
    expect(treePathProblem("a\\b")).not.toBeNull();
    expect(() => treeHashInput([{ path: "a", executable: false, sha256: H("a") }, { path: "a", executable: true, sha256: H("b") }])).toThrow();
  });
});

describe("semver", () => {
  test("versions and precedence", () => {
    expect(parseVersion("1.111.1")).toEqual({ major: 1, minor: 111, patch: 1, prerelease: [] });
    expect(parseVersion("1.0")).toBeNull();
    const cmp = (a: string, b: string) => compareVersions(parseVersion(a)!, parseVersion(b)!);
    expect(cmp("1.0.0-alpha", "1.0.0")).toBe(-1);
    expect(cmp("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
    expect(cmp("1.0.0-rc.1", "1.0.0-beta.11")).toBe(1);
    expect(cmp("2.0.0", "10.0.0")).toBe(-1);
  });

  test("ranges, npm's grammar", () => {
    const cases: [string, string, boolean][] = [
      ["1.2.3", "^1.0.0", true], ["2.0.0", "^1.0.0", false], ["0.2.5", "^0.2.3", true], ["0.3.0", "^0.2.3", false],
      ["0.0.3", "^0.0.3", true], ["0.0.4", "^0.0.3", false], ["1.2.9", "~1.2.3", true], ["1.3.0", "~1.2.3", false],
      ["1.4.0", ">=1.0.0 <2.0.0", true], ["2.0.0", ">=1.0.0 <2.0.0", false], ["1.5.0", "1.x", true], ["2.0.0", "1.x", false],
      ["3.0.0", "*", true], ["1.2.3", "1.2.3", true], ["1.2.4", "1.2.3", false], ["1.5.0", "1.2.3 - 1.6", true],
      ["1.7.0", "1.2.3 - 1.6", false], ["3.1.0", "^1.0.0 || ^3.0.0", true], ["1.0.0", ">1", false], ["2.0.0", ">1", true],
      ["1.0.0-beta", "^1.0.0", false], ["1.0.0-beta.2", ">=1.0.0-beta.1 <1.0.0", true], ["1.0.0", "<=1.0", true], ["1.1.0", "<=1.0", false],
    ];
    for (const [v, r, want] of cases) expect([v, r, satisfies(v, r)]).toEqual([v, r, want]);
    expect(parseRange("not a range")).toBeNull();
    expect(parseRange("^1.0.0 ||")).not.toBeNull();
  });
});
