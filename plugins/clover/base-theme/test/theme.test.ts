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
    ["stage.text", "color.surface", 4.5],
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
    expect(cssProperty("color.text.muted")).toBe("--color-text-muted");
    expect(cssVariables({ "color.text": "#000000", "font.weight.bold": 700 })).toEqual({
      "--color-text": "#000000",
      "--font-weight-bold": "700",
    });
    expect(cssRule(".x", { "space.s": "8px" })).toBe(".x {\n  --space-s: 8px;\n}\n");
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
    expect(checkTheme({ theme: 1, name: "x", tokens: { "luna.sparkle": "#FFFFFF" } })).toEqual([]);
    expect(checkTheme({ theme: 1, name: "x", tokens: { "luna.sparkle": "#FFFFFF" } }, { strict: true })).toHaveLength(1);
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
