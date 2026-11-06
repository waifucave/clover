import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BASE_THEME, TOKENS, contrast, cssProperty, resolveTokens, tokensFor } from "../../base-theme/src/index";
import { CHILD_PALETTES } from "../src/model/plume";
import { CHILD_PLUME_OPACITY } from "../src/ui/Children";
import { checkThemeCss } from "../../base-theme/src/css-check";
import { checkManifest } from "../../base-theme/src/manifest-check";
import { PILL_CSS } from "../src/ui/styles";

const byProperty = new Map(TOKENS.map((spec) => [cssProperty(spec.name), spec.name]));
/** The base theme as the core resolves it with no OS reading: an accent that follows the OS is the catalog's, an ink
 *  on it worked out against it (the CSS fallbacks are those values). */
const light = resolveTokens("light", [tokensFor(BASE_THEME, "light")]);
/** Custom properties the pill's own CSS sets for itself, not tokens. */
const LOCAL = new Set(["--glyph-cut"]);

const normalise = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

describe("the pill's stylesheet", () => {
  test("reads only catalog tokens, each with the base theme's value as its fallback", () => {
    const uses = [...PILL_CSS.matchAll(/var\((--[a-z0-9-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*?))?\)/g)];
    expect(uses.length).toBeGreaterThan(20);
    for (const [, property, fallback] of uses) {
      if (LOCAL.has(property!)) continue;
      const token = byProperty.get(property!);
      expect(token, `${property} is not a catalog token`).toBeDefined();
      expect(fallback, `${property} has no fallback`).toBeDefined();
      expect(normalise(fallback!), property).toBe(normalise(String(light[token!])));
    }
  });

  test("a working child's title reads at 4.5:1 or more over its plume's hottest colour, every palette", () => {
    const scrim = /\.clp-child\[data-status="working"\] \.clp-child-title \{[^}]*color-mix\(in srgb, var\(--clover-pill-surface, #000000\) (\d+)%, transparent\)/.exec(PILL_CSS);
    expect(scrim).not.toBeNull();
    const cover = Number(scrim![1]) / 100;
    const hex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
    for (const palette of CHILD_PALETTES) {
      // The hottest stop, at the plume's opacity over the chip's black, then under the scrim's black.
      const under = palette.hot.map((c) => c * CHILD_PLUME_OPACITY * (1 - cover));
      expect(contrast(String(light["pill.text"]), `#${under.map(hex).join("")}`)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("the box a sealed card sits in is a real box, so its height can be measured", () => {
    expect(PILL_CSS).toMatch(/\.clp-card-frame \{\s*display: block;/);
    expect(PILL_CSS).not.toMatch(/\.clp-card-frame \{[^}]*display: contents/);
  });

  test("puts nothing on an element that could hide a sealed frame", () => {
    expect(checkThemeCss(PILL_CSS, { component: true })).toEqual([]);
  });
});

describe("the manifest", () => {
  test("is a child plugin with one app surface, the DispatchPill component, as code", () => {
    const check = checkManifest(join(import.meta.dir, ".."), { child: true });
    expect(check.problems).toEqual([]);
    expect(check.kind).toBe("code");
  });
});
