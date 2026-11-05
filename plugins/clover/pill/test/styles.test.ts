import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BASE_THEME, TOKENS, cssProperty, tokensFor } from "../../base-theme/src/index";
import { checkThemeCss } from "../../base-theme/src/css-check";
import { checkManifest } from "../../base-theme/src/manifest-check";
import { PILL_CSS } from "../src/ui/styles";

const byProperty = new Map(TOKENS.map((spec) => [cssProperty(spec.name), spec.name]));
const light = tokensFor(BASE_THEME, "light");
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
