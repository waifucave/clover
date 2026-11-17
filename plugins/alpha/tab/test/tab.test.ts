// Alpha's tab look, as data: a theme on top of MOSS's base theme (spec §5.5), its CSS, its layout, and the
// files they name. Alpha's own manifest is lane D's; the spec's example (§5.9) names `tab/theme.json`,
// `tab/layout.json` and `assets/alpha.vrm`, and this checks those are here and sound.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { BASE_THEME, TOKENS, checkTheme, contrast, readTheme, resolveTokens, tokensFor } from "../../../moss/plugins/base-theme/src/index";
import { checkThemeCss } from "../../../../packages/plugin-sdk/src/ui/theme-lint/css";
import { resolveShell, SHELL_GROUPS, SHELL_SHAPE_NAMES } from "../../../../packages/plugin-sdk/src/formats/shell";
import { SHELL_GROUPS as LINT_GROUPS } from "../../../moss/plugins/base-theme/src/theme";
import theme from "../theme.json" with { type: "json" };

const TAB = join(import.meta.dir, "..");
const ALPHA = join(TAB, "..");
// A format file's paths are relative to the plugin's folder (lane B, §5.9's `Path`): Alpha's, above `tab/`.
const alpha = readTheme(theme, { strict: true, plugin: "alpha" });
const light = resolveTokens("light", [tokensFor(BASE_THEME, "light"), tokensFor(alpha, "light")]);
const dark = resolveTokens("dark", [tokensFor(BASE_THEME, "dark"), tokensFor(alpha, "dark")]);
const hex = (tokens: Readonly<Record<string, string | number>>, name: string) => String(tokens[name]);

describe("Alpha's theme", () => {
  test("is theme format 1, in both appearances, naming only catalog tokens", () => {
    expect(checkTheme(theme, { strict: true, plugin: "alpha" })).toEqual([]);
    const names = new Set(TOKENS.map((t) => t.name));
    for (const name of [...Object.keys(theme.tokens), ...Object.keys(theme.dark.tokens)]) expect(names.has(name) || name.startsWith("plugin.alpha."), name).toBe(true);
    expect(theme.appearance).toBe("both");
  });

  test("names its CSS by its path inside Alpha's folder, the way every format file names a file", () => {
    expect(theme.css).toBe("tab/theme.css");
    expect(existsSync(join(ALPHA, theme.css))).toBe(true);
  });

  test("styles her own tab's approval cards through the card tokens alone, and leaves the island and the pill to the app", () => {
    // Card styling is a theme's `card.*` tokens and nothing else reaches inside a card (spec §5.5); a change to them waits for
    // its own OK. She sets the card's face, words, rim, buttons and type (`cards.test.ts` holds them legible) and no more.
    const allowed = new Set(["background", "text", "muted", "rim", "radius", "approve.background", "approve.text", "deny.background", "deny.text", "button.radius", "font.family", "font.size"].map((n) => `card.${n}`));
    for (const name of [...Object.keys(theme.tokens), ...Object.keys(theme.dark.tokens)]) {
      if (name.startsWith("card.")) expect(allowed.has(name), name).toBe(true);
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
    // Alpha keeps its own filled controls: the accent itself, a dark label on the light lilac in dark.
    ["color.accent.contrast", "color.accent.fill", 4.5],
    ["color.success", "color.surface", 4.5],
    ["bubble.user.text", "bubble.user.background", 7],
    ["composer.text", "composer.background", 7],
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

describe("Alpha's theme CSS", () => {
  const themeCss = readFileSync(join(ALPHA, "tab/theme.css"), "utf8");
  test("keeps to the theme CSS rules, dresses only the parts' (cl-) classes, and every file it names is in Alpha's folder", () => {
    expect(checkThemeCss(themeCss, { path: "tab/theme.css" })).toEqual([]);
    const selectorsOf = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/url\([^)]*\)/g, "").replace(/\{[^}]*\}/g, "{}");
    for (const [, name] of selectorsOf(themeCss).matchAll(/\.([a-z][a-z0-9_-]*)/g)) expect(name!.startsWith("cl-") || name!.startsWith("clvl-"), `.${name} is not a part's class`).toBe(true);
    for (const [, url] of themeCss.matchAll(/url\("([^"]+)"\)/g)) {
      const file = normalize(join(ALPHA, "tab", url!));
      expect(file.startsWith(ALPHA), url).toBe(true);
      expect(existsSync(file), url).toBe(true);
    }
  });
});

describe("what Alpha's manifest names (spec §5.9's example)", () => {
  test("the theme is where it says, and no tab layout (bots have no tab in MOSS Code's window); her figure is her avatar pack's (moss/alpha-figure)", () => {
    expect(existsSync(join(ALPHA, "tab/layout.json"))).toBe(false);
    for (const path of ["tab/theme.json"]) expect(existsSync(join(ALPHA, path)), path).toBe(true);
    for (const path of ["vrm/alpha.vrm", "live2d/alpha.model3.json", "live2d/alpha.moc3", "live2d/alpha.png"]) expect(existsSync(join(ALPHA, "..", "moss", "plugins", "alpha-figure", path)), path).toBe(true);
    // The portrait is an SVG until a real one exists; the spec's example says portrait.webp.
    expect(existsSync(join(ALPHA, "assets/portrait.svg"))).toBe(true);
    expect(dirname(join(ALPHA, "tab", "theme.json"))).toBe(TAB);
  });

  test("the placeholder portrait says it is one", () => {
    expect(readFileSync(join(ALPHA, "assets/portrait.svg"), "utf8")).toContain("<title>Alpha (placeholder portrait)</title>");
  });
});

describe("Alpha's shell skin: the window wears the meadow while her tab shows", () => {

  test("the lint and the SDK agree on the groups", () => {
    expect(LINT_GROUPS).toEqual(SHELL_GROUPS);
  });

  test("every group survives the checks in both appearances (nothing is dropped, so the whole chrome joins)", () => {
    for (const appearance of ["light", "dark"] as const) {
      const ground = hex(appearance === "light" ? light : dark, "color.surface");
      const r = resolveShell(theme.shell, appearance, ground, "both");
      expect(r.dropped, appearance).toEqual([]);
      expect(Object.keys(r.values).sort(), appearance).toEqual([...Object.values(SHELL_GROUPS).flat(), ...Object.keys(theme.shell.tokens).filter((n) => SHELL_SHAPE_NAMES.includes(n))].sort());
    }
  });
});

describe("her pane: the conversation's and the composer's own style entries", () => {
  const paneCss = readFileSync(join(ALPHA, "tab/pane.css"), "utf8");
  const paneTheme = JSON.parse(readFileSync(join(TAB, "pane.json"), "utf8")) as { css: string; tokens: Record<string, string>; dark: { tokens: Record<string, string> } };
  const manifest = JSON.parse(readFileSync(join(ALPHA, "moss.json"), "utf8")) as { contributes: { ui: { spot: string; style?: string }[] } };

  test("the manifest dresses nothing with pane.json any more: her tab left MOSS Code's window (lane MC)", () => {
    expect(manifest.contributes.ui).toBeUndefined();
  });

  test("pane.json is a theme of catalog tokens only, in both appearances, no card's, and names pane.css", () => {
    expect(checkTheme(paneTheme, { strict: true, plugin: "alpha" })).toEqual([]);
    expect(paneTheme.css).toBe("tab/pane.css");
    for (const name of [...Object.keys(paneTheme.tokens), ...Object.keys(paneTheme.dark.tokens)]) {
      for (const group of ["card.", "island.", "pill."]) expect(name.startsWith(group), name).toBe(false);
    }
    expect(Object.keys(paneTheme.dark.tokens).sort()).toEqual(Object.keys(paneTheme.tokens).sort());
  });

  test("pane.css keeps to the theme CSS rules and dresses only the parts' (cl-) classes, never an approval card", () => {
    expect(checkThemeCss(paneCss, { path: "tab/pane.css" })).toEqual([]);
    const selectors = paneCss.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{[^{}]*\}/g, "{}");
    for (const [, name] of selectors.matchAll(/\.([a-z][a-z0-9_-]*)/g)) expect(name!.startsWith("cl-"), `.${name}`).toBe(true);
    expect(selectors.includes("approval")).toBe(false);
  });
});


