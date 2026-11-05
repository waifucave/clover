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
  stack,
  tokensFor,
} from "../src/index";
import { checkManifest } from "../src/manifest-check";

const root = join(import.meta.dir, "..");
const light = tokensFor(BASE_THEME, "light");
const dark = tokensFor(BASE_THEME, "dark");
const hex = (tokens: Readonly<Record<string, string | number>>, name: string) => String(tokens[name]);

describe("the base theme file", () => {
  test("is theme format 1 and holds only catalog tokens, each of its type", () => {
    const json = JSON.parse(readFileSync(join(root, "theme.json"), "utf8"));
    expect(checkTheme(json, { strict: true })).toEqual([]);
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
    ["color.accent.contrast", "color.accent", 4.5],
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
    expect(dark["color.surface"]).toBe("#18181C");
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
