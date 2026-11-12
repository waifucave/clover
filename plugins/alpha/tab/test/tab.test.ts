// Alpha's tab look, as data: a theme on top of Clover's base theme (spec §5.5), its CSS, its layout, and the
// files they name. Alpha's own manifest is lane D's; the spec's example (§5.9) names `tab/theme.json`,
// `tab/layout.json` and `assets/alpha.vrm`, and this checks those are here and sound.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { BASE_THEME, TOKENS, checkTheme, checkThemeCss, contrast, readTheme, resolveTokens, tokensFor } from "../../../clover/plugins/base-theme/src/index";
import { resolveShell, SHELL_GROUPS, SHELL_SHAPE_NAMES } from "../../../../packages/plugin-sdk/src/formats/shell";
import { SHELL_GROUPS as LINT_GROUPS } from "../../../clover/plugins/base-theme/src/theme";
import { BOT_TAB_SPOTS, checkLayout } from "../../../clover/plugins/base-theme/src/layout-check";
import theme from "../theme.json" with { type: "json" };
import layout from "../layout.json" with { type: "json" };

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

const VARIANTS = [
  { name: "meadow", layoutFile: "layout.json", layoutJson: layout, layoutCss: "tab/layout.css", themeCss: "tab/theme.css" },
] as const;

describe("Alpha's CSS, in both directions", () => {
  for (const v of VARIANTS) {
    const layoutCss = readFileSync(join(ALPHA, v.layoutCss), "utf8");
    const themeCss = readFileSync(join(ALPHA, v.themeCss), "utf8");
    test(`${v.name}: both sheets keep to the theme CSS rules`, () => {
      expect(checkThemeCss(layoutCss, { path: v.layoutCss })).toEqual([]);
      expect(checkThemeCss(themeCss, { path: v.themeCss })).toEqual([]);
    });

    test(`${v.name}: the layout's sheet dresses only the layout's own classes, the theme's sheet only the parts' (cl-) classes, and every file named is in Alpha's folder`, () => {
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
      walk(v.layoutJson.root);
      const selectorsOf = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/url\([^)]*\)/g, "").replace(/\{[^}]*\}/g, "{}");
      for (const [, name] of selectorsOf(layoutCss).matchAll(/\.([a-z][a-z0-9-]*)/g)) expect(classes.has(name!), `.${name} is not one of the layout's classes`).toBe(true);
      for (const [, name] of selectorsOf(themeCss).matchAll(/\.([a-z][a-z0-9_-]*)/g)) expect(name!.startsWith("cl-") || name!.startsWith("clvl-"), `.${name} is not a part's class`).toBe(true);
      for (const [css, base] of [[layoutCss, v.layoutCss], [themeCss, v.themeCss]] as const) {
        for (const [, url] of css.matchAll(/url\("([^"]+)"\)/g)) {
          const file = normalize(join(ALPHA, dirname(base), url!));
          expect(file.startsWith(ALPHA), url).toBe(true);
          expect(existsSync(file), url).toBe(true);
        }
      }
    });
  }
});

describe("Alpha's layouts", () => {
  for (const v of VARIANTS) {
    test(`${v.name}: layout format 1, the tab's spots once each, its CSS named`, () => {
      const check = checkLayout(v.layoutJson, { spots: BOT_TAB_SPOTS });
      expect(check.problems).toEqual([]);
      expect([...check.spots].sort()).toEqual(["bot.controls", "bot.header", "bot.side", "bot.stage", "chrome.panels", "composer", "conversation"].sort());
      expect(v.layoutJson.css).toBe(v.layoutCss);
      for (const path of check.paths) expect(existsSync(join(ALPHA, path)), path).toBe(true);
    });

    test(`${v.name}: the pane never gets narrower than a phone, and the stage and the pane's gap are one width`, () => {
      const find = (n: any, cls: string): any => {
        if (n.class === cls) return n;
        for (const key of ["row", "column", "stack"]) for (const c of n[key] ?? []) { const f = find(c, cls); if (f) return f; }
        return undefined;
      };
      const pane = find(v.layoutJson.root, "alpha-pane");
      const gap = find(v.layoutJson.root, "alpha-stage-gap");
      expect(pane.min).toBeGreaterThanOrEqual(320);
      for (const k of ["size", "min", "max"]) expect(gap[k], k).toBe(pane[k]);
    });
  }
});

describe("what Alpha's manifest names (spec §5.9's example)", () => {
  test("the theme, the layout and the avatar are where it says", () => {
    for (const path of ["tab/theme.json", "tab/layout.json", "assets/alpha.vrm", "assets/live2d/alpha.model3.json", "assets/live2d/alpha.moc3", "assets/live2d/alpha.png"]) expect(existsSync(join(ALPHA, path)), path).toBe(true);
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
  const manifest = JSON.parse(readFileSync(join(ALPHA, "clover.json"), "utf8")) as { contributes: { ui: { spot: string; style?: string }[] } };

  test("the manifest dresses the conversation and the composer with pane.json, and nothing else with it", () => {
    const styled = manifest.contributes.ui.filter((e) => e.style !== undefined).map((e) => [e.spot, e.style]);
    expect(styled).toEqual([["conversation", "tab/pane.json"], ["composer", "tab/pane.json"]]);
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

describe("her pane's sealed approval cards: no other layer lies over them", () => {
  // A stack draws each layer as a full-window box, and a press on a sealed button counts only while no box is drawn over it
  // (pointer-events: none doesn't take a box out of that check). So the order is set by painting alone, never by `:has()`
  // (which would have to see into the parts, past the sheet's scope) and never by a z-index that lifts (the theme CSS rules):
  // the layers' full-window boxes stay in flow, the pane's row is positioned and so paints in front of all of them, and only
  // the boxes positioned after it, the top band's own 64 px strip and the panels' card (no height while no panel is open),
  // paint in front of it.
  test("the pane's row paints in front of every layer's box; only the top strip and an open panel paint in front of it", () => {
    const layers = (layout.root as { stack: { class?: string; row?: { class?: string }[]; column?: unknown[] }[] }).stack;
    const paneAt = layers.findIndex((l) => JSON.stringify(l).includes('"alpha-pane"'));
    expect(paneAt).toBeGreaterThan(-1);
    expect(layers[paneAt]!.class).toBe("alpha-panerow");
    const after = layers.slice(paneAt + 1).map((l) => l.class);
    expect(after).toEqual(["alpha-top", "alpha-panels"]);
    const css = readFileSync(join(ALPHA, "tab/layout.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toContain(":has(> ");
    expect(css).toMatch(/\.alpha-scene \{[^}]*isolation: isolate;/);
    expect(css).not.toContain("z-index");
    expect(css).toContain(".alpha-scene > div { pointer-events: none; min-height: 0; }");
    expect(css).not.toMatch(/\.alpha-scene > div[^{]*\{[^}]*position:/);
    expect(css).toContain(".alpha-panerow { position: relative; }");
    expect(css).toContain(".alpha-topline { position: relative; }");
    expect(css).toContain(".alpha-panels { position: relative; }");
    // Nothing else in her scene is positioned, so nothing else paints in front of the pane's row.
    const positioned = [...css.matchAll(/([^{}]+)\{[^}]*position:\s*(relative|absolute|fixed|sticky)/g)].map((m) => m[1]!.trim());
    expect(positioned.sort()).toEqual([".alpha-panels", ".alpha-panerow", ".alpha-scene", ".alpha-topline"]);
    // The top strip is its 64 px and no more; the pane's transcript starts below it at every width (76 px, 56 px plus the
    // 14 px lace, 240 px).
    expect(css).toMatch(/\.alpha-topline \{[^}]*height: 64px;/);
    expect(css).toMatch(/\.alpha-pane \{ padding: 76px /);
    // The pane's row takes a pointer only on its sheet: its empty padding never blocks the band or her room.
    expect(css).toContain(".alpha-sheet, .alpha-room, .alpha-topline, .alpha-figure { pointer-events: auto; }");
    expect(css).not.toMatch(/\.alpha-pane[ ,][^{]*\{[^}]*pointer-events: auto/);
  });
});
