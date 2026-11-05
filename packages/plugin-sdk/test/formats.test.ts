// The file formats (spec §5.1, §5.5, §5.9): theme, layout, locale, index, revocations, the tree hash and semver.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  IndexSchema, LayoutSchema, LocaleSchema, RevocationsSchema, ThemeSchema, compareVersions, isRevoked, isTreeHashExcluded,
  layoutPaths, layoutSpots, localeFallbacks, parseRange, parseSignatureFile, parseVersion, placeholdersOf, satisfies,
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
    expect(FRAME_VARIABLES.map((v) => cssProperty(v.name))).toEqual(["--clover-frame-inset-top", "--clover-frame-window-controls"]);
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

describe("index and revocations, format 1", () => {
  test("an index lists ids and versions, each with its tree hash and download URL", () => {
    const index = { index: 1, name: "Official", plugins: [{ id: "luna", versions: [{ version: "1.0.0", hash: `sha256:${H("a")}`, url: "https://plugins.waifucave.com/luna-1.0.0.tar.gz" }] }] };
    expect(IndexSchema.safeParse(index).success).toBe(true);
    expect(IndexSchema.safeParse({ ...index, plugins: [{ id: "luna", versions: [{ version: "1.0", hash: "x", url: "u" }] }] }).success).toBe(false);
  });

  test("a revocation names an id, with all its versions or listed hashes, and a reason", () => {
    const list = RevocationsSchema.parse({ revocations: 1, entries: [{ id: "evil", reason: "malware" }, { id: "luna", versions: ["1.0.1"], reason: "leaks tokens" }, { id: "nova", hashes: [`sha256:${H("b")}`], reason: "bad build" }] });
    expect(isRevoked(list, "evil", "9.9.9", `sha256:${H("c")}`)).toEqual({ revoked: true, reason: "malware" });
    expect(isRevoked(list, "luna", "1.0.1", `sha256:${H("c")}`)).toEqual({ revoked: true, reason: "leaks tokens" });
    expect(isRevoked(list, "luna", "1.0.2", `sha256:${H("c")}`)).toEqual({ revoked: false });
    expect(isRevoked(list, "nova", "2.0.0", `sha256:${H("b")}`).revoked).toBe(true);
  });

  test("a .sig file is one line of base64: a 64-byte Ed25519 signature", () => {
    const sig = btoa(String.fromCharCode(...new Uint8Array(64).fill(7)));
    expect(parseSignatureFile(`${sig}\n`)?.length).toBe(64);
    expect(parseSignatureFile("not base64")).toBeNull();
    expect(parseSignatureFile(btoa("short"))).toBeNull();
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
