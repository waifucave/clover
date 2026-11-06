import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASE_THEME,
  TOKENS,
  checkTheme,
  checkThemeCss,
  contrast,
  cssProperty,
  cssRule,
  cssVariables,
  isTokenName,
  pluginTokenName,
  readTheme,
  resolveTokens,
  stack,
  tokensFor,
  AUTO_INKS,
  SYSTEM_ACCENT_TOKENS,
  hexToHsl,
  labelFill,
  resolveAutoInk,
} from "../src/index";
import { checkManifest } from "../src/manifest-check";

const root = join(import.meta.dir, "..");
// As the core resolves them with no OS accent to read (Linux): "system" keeps the theme's accent, "auto" inks resolve.
const light = resolveTokens("light", [tokensFor(BASE_THEME, "light")]);
const dark = resolveTokens("dark", [tokensFor(BASE_THEME, "dark")]);
const hex = (tokens: Readonly<Record<string, string | number>>, name: string) => String(tokens[name]);

describe("the base theme file", () => {
  test("is theme format 1 and holds only catalog tokens, each of its type", () => {
    const json = JSON.parse(readFileSync(join(root, "theme.json"), "utf8"));
    expect(checkTheme(json, { strict: true, plugin: "clover" })).toEqual([]);
  });

  test("gives every catalog token a value in both appearances", () => {
    for (const { name } of TOKENS) {
      expect(light[name], `${name} (light)`).toBeDefined();
      expect(dark[name], `${name} (dark)`).toBeDefined();
    }
  });

  test("keeps the island and the pill dark in both appearances", () => {
    // They float over any desktop as black liquid (docs/claude/island.md): a light appearance never
    // turns them white.
    for (const name of Object.keys(BASE_THEME.dark?.tokens ?? {})) {
      expect(name.startsWith("island.") || name.startsWith("pill."), name).toBe(false);
    }
    expect(light["island.surface"]).toBe("#000000");
    expect(light["pill.surface"]).toBe("#000000");
  });

  test("gives approval cards self-contained values", () => {
    // Card styling is the token values handed to sealed frames (spec §5.5): a card value that pointed
    // at another token would change whenever a theme restyled that token, without its own OK.
    for (const tokens of [light, dark]) {
      for (const [name, value] of Object.entries(tokens)) {
        if (!name.startsWith("card.")) continue;
        expect(String(value)).not.toMatch(/var\(|\{/);
      }
    }
  });
});

describe("contrast", () => {
  const floors: [string, string, number][] = [
    ["color.text", "color.surface", 7],
    ["color.text", "color.canvas", 7],
    ["color.text", "color.raised", 7],
    ["color.text.secondary", "color.canvas", 4.5],
    ["color.text.muted", "color.surface", 4.5],
    ["color.text.muted", "color.canvas", 4.5],
    ["color.text.muted", "color.raised", 4.5],
    ["color.accent.text", "color.surface", 4.5],
    ["color.accent", "color.surface", 3],
    ["color.accent", "color.canvas", 3],
    // A label reads on the filled control, the accent darkened for it (lane B's `color.accent.fill`).
    ["color.accent.contrast", "color.accent.fill", 4.5],
    ["color.accent.glyph", "color.accent", 3],
    ["color.attention.text", "color.surface", 4.5],
    ["color.danger", "color.surface", 4.5],
    ["color.success", "color.surface", 4.5],
    ["bubble.user.text", "bubble.user.background", 7],
    ["composer.text", "composer.background", 7],
    ["card.text", "card.background", 7],
    ["card.muted", "card.background", 4.5],
    ["card.approve.text", "card.approve.background", 4.5],
    ["card.deny.text", "card.deny.background", 4.5],
    // The avatar's credit line sits on a plate of the surface colour, below the avatar (avatar.css).
    ["stage.text", "color.surface", 4.5],
    // Placeholders are words, and the compact pill's is its only label.
    ["color.text.placeholder", "color.surface", 4.5],
    // An input's placeholder sits on the control fill (lane F flagged it at 4.16:1).
    ["color.text.placeholder", "color.control", 4.5],
    ["composer.placeholder", "composer.background", 4.5],
    ["pill.placeholder", "pill.surface", 4.5],
    ["pill.placeholder.typing", "pill.surface", 4.5],
    ["island.text", "island.surface", 7],
    ["island.muted", "island.surface", 4.5],
    ["island.attention", "island.surface", 4.5],
    ["island.accept.text", "island.accept", 3],
    ["pill.muted", "pill.surface", 4.5],
  ];
  for (const [appearance, tokens] of [["light", light], ["dark", dark]] as const) {
    for (const [fg, bg, floor] of floors) {
      test(`${appearance}: ${fg} on ${bg} reaches ${floor}:1`, () => {
        expect(contrast(hex(tokens, fg), hex(tokens, bg))).toBeGreaterThanOrEqual(floor);
      });
    }
  }

  test("a selected row stands apart from a hovered one, and both from the canvas", () => {
    for (const tokens of [light, dark]) {
      expect(contrast(hex(tokens, "color.selected"), hex(tokens, "color.hover"))).toBeGreaterThanOrEqual(1.15);
      expect(contrast(hex(tokens, "color.selected"), hex(tokens, "color.canvas"))).toBeGreaterThanOrEqual(1.2);
      expect(contrast(hex(tokens, "color.hover"), hex(tokens, "color.canvas"))).toBeGreaterThanOrEqual(1.05);
    }
  });

  test("the content plane stands apart from the canvas in both appearances", () => {
    // brand.md §2: the difference IS the separation, the hairline is secondary.
    for (const tokens of [light, dark]) {
      expect(hex(tokens, "color.surface")).not.toBe(hex(tokens, "color.canvas"));
      expect(contrast(hex(tokens, "color.surface"), hex(tokens, "color.canvas"))).toBeGreaterThan(1.03);
    }
  });

  test("the raised hairline separates on its own plane", () => {
    for (const tokens of [light, dark]) {
      expect(contrast(hex(tokens, "color.hairline.raised"), hex(tokens, "color.raised"))).toBeGreaterThan(1.25);
    }
  });
});

describe("token names", () => {
  test("follow the grammar and map to distinct custom properties", () => {
    const properties = new Set<string>();
    for (const { name } of TOKENS) {
      expect(isTokenName(name), name).toBe(true);
      properties.add(cssProperty(name));
    }
    expect(properties.size).toBe(TOKENS.length);
  });

  test("refuse what could collide or escape", () => {
    for (const bad of ["Color.text", "color..text", "color.text-muted", "color.1", ".color", "color.", "color text"]) {
      expect(isTokenName(bad), bad).toBe(false);
    }
  });

  test("become custom properties and a rule", () => {
    expect(cssProperty("color.text.muted")).toBe("--clover-color-text-muted");
    expect(cssVariables({ "color.text": "#000000", "font.weight.bold": 700 })).toEqual({
      "--clover-color-text": "#000000",
      "--clover-font-weight-bold": "700",
    });
    expect(cssRule(".x", { "space.s": "8px" })).toBe(".x {\n  --clover-space-s: 8px;\n}\n");
  });
});

describe("the stack", () => {
  test("lets a later layer win, token by token", () => {
    const merged = stack(light, { "color.accent": "#7651DD" }, { "space.s": "10px" });
    expect(merged["color.accent"]).toBe("#7651DD");
    expect(merged["space.s"]).toBe("10px");
    expect(merged["color.text"]).toBe(light["color.text"]);
  });

  test("resolves dark from tokens plus dark.tokens", () => {
    expect(dark["color.surface"]).toBe("#191919");
    expect(dark["radius.small"]).toBe(light["radius.small"]);
  });
});

describe("checkTheme", () => {
  test("names every problem at once", () => {
    const problems = checkTheme(
      {
        theme: 2,
        name: "",
        extra: true,
        tokens: { "color.text": "red", "space.s": 8, "Bad.name": "#000", "font.weight.bold": "700", "stage.background": "url(x.png)" },
        css: "../outside.css",
      },
      { strict: true },
    );
    expect(problems).toContain(`unknown key "extra"`);
    expect(problems).toContain(`"theme" must be 1 (this app reads format 1)`);
    expect(problems).toContain(`"name" must be a string or { en, … }`);
    expect(problems.some((p) => p.includes("color.text"))).toBe(true);
    expect(problems.some((p) => p.includes("space.s"))).toBe(true);
    expect(problems.some((p) => p.includes("Bad.name"))).toBe(true);
    expect(problems.some((p) => p.includes("font.weight.bold"))).toBe(true);
    expect(problems.some((p) => p.includes("stage.background"))).toBe(true);
    expect(problems).toContain(`"css" must be a path inside the plugin`);
  });

  test("lets a lenient reader pass tokens it does not know", () => {
    expect(checkTheme({ theme: 1, name: "x", tokens: { "plugin.luna.sparkle": "#FFFFFF" } })).toEqual([]);
    expect(checkTheme({ theme: 1, name: "x", tokens: { "plugin.luna.sparkle": "#FFFFFF" } }, { strict: true })).toHaveLength(1);
  });

  test("holds every value to what a custom property may hold, a token it does not know included", () => {
    const injection = "red; } body { background: url(https://evil.test/x.png) } x {";
    expect(checkTheme({ theme: 1, name: "x", tokens: { "plugin.luna.sparkle": injection } })).toHaveLength(1);
    expect(checkTheme({ theme: 1, name: "x", tokens: { "color.unlisted": injection } })).toHaveLength(1);
    for (const value of ["image-set('https://evil.test/x.png' 1x)", "src('x')", "cross-fade(red, blue)", "a\\62 c", "x /* y */", "<b>", "@x", "red !important", "a\nb", '"open', "x".repeat(301)]) {
      expect(checkTheme({ theme: 1, name: "x", tokens: { "plugin.luna.sparkle": value } }), value).toHaveLength(1);
    }
    expect(checkTheme({ theme: 1, name: "x", tokens: { "plugin.luna.face": '"Iowan Old Style", serif' } })).toEqual([]);
    expect(() => cssRule(".x", { "plugin.luna.sparkle": injection })).toThrow();
    expect(() => cssVariables({ "color.text": "red;}" })).toThrow();
  });

  test("takes a plugin's own tokens by lane B's names: plugin.<its top-level id>, hyphens and all", () => {
    expect(checkTheme({ theme: 1, name: "x", tokens: { "plugin.mcp-blender.glow.soft": "#FFFFFF" } })).toEqual([]);
    expect(checkTheme({ theme: 1, name: "x", tokens: { "plugin.mcp-blender.glow": "#FFFFFF" } }, { strict: true, plugin: "mcp-blender" })).toEqual([]);
    expect(checkTheme({ theme: 1, name: "x", tokens: { "plugin.luna.glow": "#FFFFFF" } }, { strict: true, plugin: "mcp-blender" })).toHaveLength(1);
    // The group is reserved: no other name may sit under it, and no plugin id can name a catalog token.
    expect(checkTheme({ theme: 1, name: "x", tokens: { "plugin.glow": "#FFFFFF" } })).toHaveLength(1);
    expect(checkTheme({ theme: 1, name: "x", tokens: { "mcp-blender.glow": "#FFFFFF", "plugin.-bad.glow": "#FFFFFF" } })).toHaveLength(2);
    expect(cssProperty("plugin.mcp-blender.glow")).toBe("--clover-plugin-mcp_blender-glow");
    expect(pluginTokenName("luna", "glow.soft")).toBe("plugin.luna.glow.soft");
    // Every catalog property differs from every plugin property.
    const properties = new Set(TOKENS.map((spec) => cssProperty(spec.name)));
    for (const id of ["color", "card", "island", "mcp-blender"]) expect(properties.has(cssProperty(`plugin.${id}.text`))).toBe(false);
  });

  test("a theme applies only in the appearances it names", () => {
    const lightOnly = readTheme({ theme: 1, name: "Day", appearance: "light", tokens: { "color.accent": "#7651DD" } });
    expect(tokensFor(lightOnly, "light")["color.accent"]).toBe("#7651DD");
    expect(tokensFor(lightOnly, "dark")).toEqual({});
    const darkOnly = readTheme({ theme: 1, name: "Night", appearance: "dark", tokens: { "color.accent": "#B9A8FF" } });
    expect(tokensFor(darkOnly, "light")).toEqual({});
    expect(tokensFor(darkOnly, "dark")["color.accent"]).toBe("#B9A8FF");
  });
});

describe("the base theme's CSS", () => {
  test("keeps the cleaner's rules and never hides a sealed frame", () => {
    expect(checkThemeCss(readFileSync(join(root, "theme.css"), "utf8"))).toEqual([]);
  });
});

describe("the manifest", () => {
  test("is a child plugin contributing the theme, as data", () => {
    const check = checkManifest(root, { child: true });
    expect(check.problems).toEqual([]);
    expect(check.kind).toBe("data");
  });
});

describe("layout format 1", () => {
  test("a sound layout passes and lists its spots and files", async () => {
    const { checkLayout, BOT_TAB_SPOTS } = await import("../src/layout-check");
    const check = checkLayout(
      { layout: 1, root: { column: [{ spot: "bot.header" }, { row: [{ spot: "conversation", grow: 1 }, { image: "art/a.png", size: 40 }], gap: 8 }, { tabs: [{ title: "Notes", node: { markdown: "notes.md" } }] }, { spacer: true }] }, background: "bg.svg" },
      { spots: BOT_TAB_SPOTS },
    );
    expect(check.problems).toEqual([]);
    expect(check.spots).toEqual(["bot.header", "conversation"]);
    expect(check.paths).toEqual(["bg.svg", "art/a.png", "notes.md"]);
  });

  test("what it refuses", async () => {
    const { checkLayout, BOT_TAB_SPOTS } = await import("../src/layout-check");
    const problems = (json: unknown) => checkLayout(json, { spots: BOT_TAB_SPOTS }).problems;
    expect(problems({ layout: 2, root: { spacer: true } })).toContain("`layout` must be 1.");
    expect(problems({ layout: 1 })).toContain("A layout needs a `root`.");
    expect(problems({ layout: 1, root: { row: [], column: [] } })[0]).toMatch(/exactly one of/);
    expect(problems({ layout: 1, root: { spot: "island" } })[0]).toMatch(/not a spot here/);
    expect(problems({ layout: 1, root: { row: [{ spot: "composer" }, { spot: "composer" }] } })[0]).toMatch(/placed twice/);
    expect(problems({ layout: 1, root: { image: "../outside.png" } })[0]).toMatch(/inside the plugin/);
    expect(problems({ layout: 1, root: { image: "https://x.test/a.png" } })[0]).toMatch(/inside the plugin/);
    expect(problems({ layout: 1, root: { spot: "composer", min: 400, max: 200 } })[0]).toMatch(/`min` is more than `max`/);
    expect(problems({ layout: 1, root: { spot: "composer", grow: -1 } })[0]).toMatch(/from 0 to 1000/);
    expect(problems({ layout: 1, root: { spot: "composer", size: "12 parsecs" } })[0]).toMatch(/CSS length/);
    expect(problems({ layout: 1, root: { spot: "composer", hideBelow: 1.5 } })[0]).toMatch(/whole number/);
    expect(problems({ layout: 1, root: { spot: "composer", class: "two classes" } })[0]).toMatch(/one class name/);
    expect(problems({ layout: 1, root: { spot: "composer", onClick: "x" } })[0]).toMatch(/unknown key/);
    expect(problems({ layout: 1, root: { text: { fr: "Bonjour" } } })[0]).toMatch(/words/);
    expect(problems({ layout: 1, root: { spot: "avatar", key: "" } })[0]).toMatch(/`key` is a name/);
    expect(problems({ layout: 1, root: { spot: "sidebar" } })[0]).toMatch(/not a spot here/);
  });

  test("follows lane B's schema: every bot-tab spot of B's catalog, avatar included, a spot's key, words by language, CSS lengths", async () => {
    const { checkLayout, BOT_TAB_SPOTS, SPOTS } = await import("../src/layout-check");
    expect(BOT_TAB_SPOTS).toContain("avatar");
    expect(BOT_TAB_SPOTS).toEqual(SPOTS.filter((s) => s.inBotTab).map((s) => s.name));
    for (const outside of ["sidebar", "island.tab", "pill.target", "app.surface"]) expect(BOT_TAB_SPOTS).not.toContain(outside);
    const check = checkLayout(
      {
        $schema: "https://waifucave.com/schemas/layout-1.json",
        layout: 1,
        root: {
          row: [
            { column: [{ text: { en: "Hello", fr: "Bonjour" } }, { spot: "conversation", grow: 1 }], size: "60%" },
            { spot: "avatar", key: "vrm", min: "12rem", class: "Alpha_stage" },
            { tabs: [{ title: { en: "Notes" }, node: { markdown: "notes.md" } }] },
          ],
          gap: "1rem",
        },
      },
      { spots: BOT_TAB_SPOTS },
    );
    expect(check.problems).toEqual([]);
    expect(check.spots).toEqual(["conversation", "avatar#vrm"]);
  });
});

describe("the OS accent colour (lane B's rule)", () => {
  // macOS's accents in light and dark, Windows' default and its dark-mode shade, and the theme's own (Linux).
  const ACCENTS = [
    "#007AFF", "#A550A7", "#F74F9E", "#FF5257", "#F7821B", "#FFC600", "#62BA46", "#8C8C8C",
    "#0A84FF", "#BF5AF2", "#FF375F", "#FF453A", "#FF9F0A", "#FFD60A", "#30D158", "#98989D",
    "#0078D4", "#4CC2FF", "#2F6FDF", "#4180E3", "#3570D8",
  ];

  test("the base theme's controls follow it: every accent token is \"system\", every ink on one \"auto\" (decision 82: no fixed blue)", () => {
    for (const name of SYSTEM_ACCENT_TOKENS) expect(BASE_THEME.tokens[name], name).toBe("system");
    expect(SYSTEM_ACCENT_TOKENS).toEqual(["color.accent", "color.accent.fill", "color.focus", "card.approve.background", "island.accept", "pill.accept"]);
    for (const ink of Object.keys(AUTO_INKS)) expect(BASE_THEME.tokens[ink], ink).toBe("auto");
    // Nothing in dark undoes it.
    for (const name of [...SYSTEM_ACCENT_TOKENS, ...Object.keys(AUTO_INKS)]) expect(BASE_THEME.dark?.tokens[name], name).toBeUndefined();
  });

  test("with no reading the theme's accent stands; with one, the OS accent", () => {
    expect(light["color.accent"]).toBe("#2F6FDF");
    expect(dark["color.accent"]).toBe("#4180E3");
    expect(dark["card.approve.background"]).toBe("#3570D8");
    const blue = resolveTokens("light", [tokensFor(BASE_THEME, "light")], { systemAccent: "#007AFF" });
    expect(blue["color.accent"]).toBe("#007AFF");
    // The approve button and every filled control carry a text label: the OS accent, darkened in its own hue until
    // white reaches 4.5:1. The fill follows the accent as resolved.
    expect(blue["card.approve.background"]).toBe(labelFill("#007AFF"));
    expect(blue["color.accent.fill"]).toBe(labelFill("#007AFF"));
    expect(blue["color.accent.contrast"]).toBe("#FFFFFF");
    expect(blue["island.accept"]).toBe("#007AFF");
    expect(blue["color.focus"]).toBe("#007AFF");
    expect(blue["card.approve.background"]).not.toBe("#007AFF");
    expect(blue["card.approve.text"]).toBe("#FFFFFF");
    // A theme above that sets its own accent keeps it (Alpha's tab keeps its look); one that says "system" again
    // falls back to the value beneath it.
    const own = resolveTokens("light", [tokensFor(BASE_THEME, "light"), { "color.accent": "#7651DD" }], { systemAccent: "#007AFF" });
    expect(own["color.accent"]).toBe("#7651DD");
    // …and its filled controls are that accent, darkened for their white labels.
    expect(own["color.accent.fill"]).toBe(labelFill("#7651DD"));
    expect(resolveTokens("light", [tokensFor(BASE_THEME, "light"), { "color.accent": "#7651DD" }, { "color.accent": "system" }])["color.accent"]).toBe("#7651DD");
  });

  test("a glyph-only control gets white when white reaches 3:1 on the accent, otherwise the theme's dark ink", () => {
    for (const appearance of ["light", "dark"] as const) {
      for (const accent of ACCENTS) {
        const tokens = resolveTokens(appearance, [tokensFor(BASE_THEME, appearance)], { systemAccent: accent });
        for (const [glyphToken, on] of [["color.accent.glyph", "color.accent"], ["island.accept.text", "island.accept"], ["pill.accept.text", "pill.accept"]] as const) {
          const glyph = hex(tokens, glyphToken);
          expect(glyph, `${appearance} ${accent} ${glyphToken}`).toBe(contrast("#FFFFFF", accent) >= 3 ? "#FFFFFF" : hex(tokens, "color.accent.ink"));
          expect(contrast(glyph, hex(tokens, on)), `${appearance} ${accent} ${glyphToken}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  test("a theme's dark ink that misses 3:1 too gives way to black (lane B's rule)", () => {
    // A mid grey ink on a mid-grey accent: white misses 3:1, the grey does too, black reaches it.
    expect(resolveAutoInk("#A0A0A0", { background: "#FFFFFF", darkInk: "#555555", floor: 3 })).toBe("#000000");
    expect(resolveAutoInk("#FFC600", { background: "#FFFFFF", darkInk: "#111111", floor: 3 })).toBe("#111111");
    expect(resolveAutoInk("#0A3D91", { background: "#FFFFFF", darkInk: "#111111", floor: 3 })).toBe("#FFFFFF");
    // Through the stack: a theme whose dark ink is too light for a yellow OS accent.
    const tokens = resolveTokens("light", [tokensFor(BASE_THEME, "light"), { "color.accent.ink": "#777777" }], { systemAccent: "#FFC600" });
    expect(tokens["color.accent.glyph"]).toBe("#000000");
  });

  test("a control with a text label reaches 4.5:1 on every one of these accents, the approve button's included", () => {
    for (const appearance of ["light", "dark"] as const) {
      for (const accent of ACCENTS) {
        const tokens = resolveTokens(appearance, [tokensFor(BASE_THEME, appearance)], { systemAccent: accent });
        // A label sits on the fill, the accent darkened for it: always white, at 4.5:1 or more.
        expect(hex(tokens, "color.accent.contrast"), `${appearance} ${accent} label`).toBe("#FFFFFF");
        expect(contrast("#FFFFFF", hex(tokens, "color.accent.fill")), `${appearance} ${accent} label`).toBeGreaterThanOrEqual(4.5);
        // The approve button's fill is the accent darkened for its label, which is always white.
        expect(hex(tokens, "card.approve.text"), `${appearance} ${accent} approve`).toBe("#FFFFFF");
        expect(contrast("#FFFFFF", hex(tokens, "card.approve.background")), `${appearance} ${accent} approve`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("only the accent tokens may be \"system\", and only the inks on them \"auto\"", () => {
    expect(checkTheme({ theme: 1, name: "x", tokens: { "island.accept": "system" } })).toEqual([]);
    expect(checkTheme({ theme: 1, name: "x", tokens: { "island.surface": "system" } })).toHaveLength(1);
    expect(checkTheme({ theme: 1, name: "x", tokens: { "color.text": "auto" } })).toHaveLength(1);
    expect(checkTheme({ theme: 1, name: "x", tokens: { "plugin.luna.glow": "system" } })).toHaveLength(1);
    expect(checkTheme({ theme: 1, name: "x", tokens: { "color.accent": "system", "color.accent.glyph": "auto" } }, { strict: true })).toEqual([]);
    // An unresolved word never reaches CSS.
    expect(() => cssVariables({ "color.accent": "system" })).toThrow();
  });
});

describe("every possible OS accent (the review's sweep: 52 steps a channel, 140,608 colours)", () => {
  const grid: string[] = [];
  for (let r = 0; r < 256; r += 5) for (let g = 0; g < 256; g += 5) for (let b = 0; b < 256; b += 5) grid.push(`#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase()}`);

  test("the text-label ink reaches 4.5:1 and the glyph ink 3:1 on every one, in both appearances", () => {
    for (const tokens of [light, dark]) {
      const darkInk = hex(tokens, "color.accent.ink");
      expect(darkInk).toBe("#000000");
      let text = 0;
      let glyph = 0;
      for (const accent of grid) {
        if (contrast(resolveAutoInk(accent, { background: "#FFFFFF", darkInk, floor: 4.5 }), accent) < 4.5) text++;
        if (contrast(resolveAutoInk(accent, { background: "#FFFFFF", darkInk, floor: 3 }), accent) < 3) glyph++;
      }
      expect(text).toBe(0);
      expect(glyph).toBe(0);
    }
  });

  test("the approve button: the accent darkened in its own hue until its always-white label reaches 4.5:1", () => {
    let darkened = 0;
    for (const accent of grid.filter((_, i) => i % 7 === 0)) {
      const fill = labelFill(accent);
      expect(contrast("#FFFFFF", fill), accent).toBeGreaterThanOrEqual(4.5);
      if (contrast("#FFFFFF", accent) >= 4.5) {
        expect(fill, accent).toBe(accent);
        continue;
      }
      darkened++;
      const [h0, s0, l0] = hexToHsl(accent);
      const [h1, , l1] = hexToHsl(fill);
      expect(l1, accent).toBeLessThan(l0);
      // The same hue, within what whole channels can hold (a near-grey has little hue to keep).
      if (s0 > 0.2 && l1 > 0.08) expect(Math.min(Math.abs(h1 - h0), 360 - Math.abs(h1 - h0)), accent).toBeLessThan(4);
      // The lightest shade that holds: one step lighter would not.
      expect(contrast("#FFFFFF", labelFill(fill, 4.4)), accent).toBeGreaterThanOrEqual(4.4);
    }
    expect(darkened).toBeGreaterThan(1000);
    // Through the stack: macOS's default blue gets a white "Allow once", in both appearances.
    for (const appearance of ["light", "dark"] as const) {
      const tokens = resolveTokens(appearance, [tokensFor(BASE_THEME, appearance)], { systemAccent: "#007AFF" });
      expect(hex(tokens, "card.approve.text")).toBe("#FFFFFF");
      expect(contrast("#FFFFFF", hex(tokens, "card.approve.background"))).toBeGreaterThanOrEqual(4.5);
      // Glyph-only controls keep the plain accent and the 3:1 white-bias rule.
      expect(hex(tokens, "color.accent")).toBe("#007AFF");
      expect(hex(tokens, "color.accent.glyph")).toBe("#FFFFFF");
    }
  });
});
