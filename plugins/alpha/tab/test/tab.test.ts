// Alpha's tab look, as data: a theme on top of Clover's base theme (spec §5.5), its CSS, its layout, and the
// files they name. Alpha's own manifest is lane D's; the spec's example (§5.9) names `tab/theme.json`,
// `tab/layout.json` and `assets/alpha.vrm`, and this checks those are here and sound.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { BASE_THEME, TOKENS, checkTheme, checkThemeCss, contrast, readTheme, resolveTokens, tokensFor } from "../../../clover/plugins/base-theme/src/index";
import { BOT_TAB_SPOTS, checkLayout } from "../../../clover/plugins/base-theme/src/layout-check";
import theme from "../theme.json" with { type: "json" };
import layout from "../layout.json" with { type: "json" };

const TAB = join(import.meta.dir, "..");
const ALPHA = join(TAB, "..");
// A format file's paths are relative to the plugin's folder (lane B, §5.9's `Path`): Alpha's, above `tab/`.
const css = readFileSync(join(ALPHA, theme.css), "utf8");
const alpha = readTheme(theme, { strict: true });
const light = resolveTokens("light", [tokensFor(BASE_THEME, "light"), tokensFor(alpha, "light")]);
const dark = resolveTokens("dark", [tokensFor(BASE_THEME, "dark"), tokensFor(alpha, "dark")]);
const hex = (tokens: Readonly<Record<string, string | number>>, name: string) => String(tokens[name]);

describe("Alpha's theme", () => {
  test("is theme format 1, in both appearances, naming only catalog tokens", () => {
    expect(checkTheme(theme, { strict: true })).toEqual([]);
    const names = new Set(TOKENS.map((t) => t.name));
    for (const name of [...Object.keys(theme.tokens), ...Object.keys(theme.dark.tokens)]) expect(names.has(name), name).toBe(true);
    expect(theme.appearance).toBe("both");
  });

  test("names its CSS by its path inside Alpha's folder, the way every format file names a file", () => {
    expect(theme.css).toBe("tab/theme.css");
    expect(existsSync(join(ALPHA, theme.css))).toBe(true);
  });

  test("leaves approval cards, the island and the pill to the app's own styling", () => {
    // Card styling waits for its own OK (spec §5.5); a bot's tab theme has no reason to ask for one.
    for (const name of [...Object.keys(theme.tokens), ...Object.keys(theme.dark.tokens)]) {
      expect(name.startsWith("card."), name).toBe(false);
      expect(name.startsWith("island."), name).toBe(false);
      expect(name.startsWith("pill."), name).toBe(false);
    }
  });

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
    ["color.accent.contrast", "color.accent", 4.5],
    ["color.success", "color.surface", 4.5],
    ["bubble.user.text", "bubble.user.background", 7],
    ["composer.text", "composer.background", 7],
    // The avatar's credit line sits on a plate of the surface colour, below the avatar.
    ["stage.text", "color.surface", 4.5],
    ["color.text.placeholder", "color.surface", 4.5],
    ["composer.placeholder", "composer.background", 4.5],
  ];
  for (const [appearance, tokens] of [["light", light], ["dark", dark]] as const) {
    for (const [fg, bg, floor] of floors) {
      test(`${appearance}: ${fg} on ${bg} reaches ${floor}:1 over the base theme`, () => {
        expect(contrast(hex(tokens, fg), hex(tokens, bg))).toBeGreaterThanOrEqual(floor);
      });
    }
  }
});

test("a selected row stands apart from a hovered one, and both from the canvas", () => {
  for (const tokens of [light, dark]) {
    expect(contrast(hex(tokens, "color.selected"), hex(tokens, "color.hover"))).toBeGreaterThanOrEqual(1.15);
    expect(contrast(hex(tokens, "color.selected"), hex(tokens, "color.canvas"))).toBeGreaterThanOrEqual(1.2);
    expect(contrast(hex(tokens, "color.hover"), hex(tokens, "color.canvas"))).toBeGreaterThanOrEqual(1.05);
  }
});

describe("Alpha's CSS", () => {
  test("keeps to the theme CSS rules", () => {
    expect(checkThemeCss(css, { path: theme.css })).toEqual([]);
  });

  test("dresses only its own layout's classes, and every file it names is in Alpha's folder", () => {
    const classes = new Set<string>();
    const walk = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      const n = node as Record<string, unknown>;
      if (typeof n.class === "string") for (const c of n.class.split(" ")) classes.add(c);
      for (const value of Object.values(n)) {
        if (Array.isArray(value)) value.forEach(walk);
        else if (typeof value === "object") walk(value);
      }
    };
    walk(layout.root);
    // Class selectors only: comments, url() and numbers aside.
    const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/url\([^)]*\)/g, "").replace(/\{[^}]*\}/g, "{}");
    for (const [, name] of selectors.matchAll(/\.([a-z][a-z0-9-]*)/g)) expect(classes.has(name!), `.${name} is not one of the layout's classes`).toBe(true);
    for (const [, url] of css.matchAll(/url\("([^"]+)"\)/g)) {
      const file = normalize(join(TAB, url!));
      expect(file.startsWith(ALPHA), url).toBe(true);
      expect(existsSync(file), url).toBe(true);
    }
  });
});

describe("Alpha's layout", () => {
  test("is layout format 1 and places the tab's spots once each, the stage beside the talk", () => {
    const check = checkLayout(layout, { spots: BOT_TAB_SPOTS });
    expect(check.problems).toEqual([]);
    expect(check.spots).toEqual(["bot.header", "conversation", "composer", "bot.stage"]);
    for (const path of check.paths) expect(existsSync(join(ALPHA, path)), path).toBe(true);
  });

  test("the stage gives way on a narrow window, and the talk never gets narrower than a phone", () => {
    const row = layout.root.column[1]!.row!;
    const stage = row.find((n) => "spot" in n && n.spot === "bot.stage") as { hideBelow: number; size: number; min: number };
    const talk = row.find((n) => "column" in n) as { min: number };
    expect(stage.hideBelow).toBeGreaterThanOrEqual(talk.min + stage.min);
    expect(talk.min).toBeGreaterThanOrEqual(320);
  });
});

describe("what Alpha's manifest names (spec §5.9's example)", () => {
  test("the theme, the layout and the avatar are where it says", () => {
    for (const path of ["tab/theme.json", "tab/layout.json", "assets/alpha.vrm"]) expect(existsSync(join(ALPHA, path)), path).toBe(true);
    // The portrait is an SVG until a real one exists; the spec's example says portrait.webp.
    expect(existsSync(join(ALPHA, "assets/portrait.svg"))).toBe(true);
    expect(dirname(join(ALPHA, "tab", "theme.json"))).toBe(TAB);
  });

  test("the placeholder portrait says it is one", () => {
    expect(readFileSync(join(ALPHA, "assets/portrait.svg"), "utf8")).toContain("<title>Alpha (placeholder portrait)</title>");
  });
});
