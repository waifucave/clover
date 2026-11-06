import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BASE_THEME, TOKENS, contrast, cssProperty, tokensFor } from "../../base-theme/src/index";
import { checkThemeCss } from "../../base-theme/src/css-check";
import { checkManifest } from "../../base-theme/src/manifest-check";
import { ISLAND_CSS } from "../src/ui/styles";

const byProperty = new Map(TOKENS.map((spec) => [cssProperty(spec.name), spec.name]));
const light = tokensFor(BASE_THEME, "light");
/** Custom properties the island's own CSS sets for itself, not tokens. */
const LOCAL = new Set(["--glyph-cut"]);

const normalise = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

describe("the island's stylesheet", () => {
  test("reads only catalog tokens, each with the base theme's value as its fallback", () => {
    const uses = [...ISLAND_CSS.matchAll(/var\((--[a-z0-9-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*?))?\)/g)];
    expect(uses.length).toBeGreaterThan(20);
    for (const [, property, fallback] of uses) {
      if (LOCAL.has(property!)) continue;
      const token = byProperty.get(property!);
      expect(token, `${property} is not a catalog token`).toBeDefined();
      expect(fallback, `${property} has no fallback`).toBeDefined();
      expect(normalise(fallback!), property).toBe(normalise(String(light[token!])));
    }
  });

  test("the answer field's placeholder reads at 4.5:1 or more, on the island's black and on an inner card", () => {
    const share = /\.clv-other::placeholder \{\s*color: color-mix\(in srgb, var\(--clover-island-text, #FFFFFF\) (\d+)%, transparent\)/.exec(ISLAND_CSS);
    expect(share).not.toBeNull();
    const alpha = Math.round((Number(share![1]) / 100) * 255).toString(16).padStart(2, "0").toUpperCase();
    const placeholder = `${String(light["island.text"])}${alpha}`;
    for (const ground of [String(light["island.surface"]), String(light["island.card"])]) {
      // The field's own fill over the ground, then the placeholder over both.
      const fill = String(light["island.option"]);
      expect(contrast(placeholder, fill, ground)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("the box a sealed card sits in is a real box, so its height can be measured", () => {
    expect(ISLAND_CSS).toMatch(/\.clv-card-frame \{\s*display: block;/);
    expect(ISLAND_CSS).not.toMatch(/\.clv-card-frame \{[^}]*display: contents/);
  });

  test("puts nothing on an element that could hide a sealed frame", () => {
    // The component CSS is held to the theme rules too: anything that hides would hide a card part. What it
    // positions is checked on the rendered surfaces instead (`sealed.test.tsx`).
    expect(checkThemeCss(ISLAND_CSS, { component: true })).toEqual([]);
  });
});

describe("the manifest", () => {
  test("is a child plugin with one app surface, the Island component, as code", () => {
    const check = checkManifest(join(import.meta.dir, ".."), { child: true });
    expect(check.problems).toEqual([]);
    expect(check.kind).toBe("code");
  });
});
