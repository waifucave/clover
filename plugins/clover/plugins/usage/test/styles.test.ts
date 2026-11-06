import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BASE_THEME, CATALOG_ACCENTS, SYSTEM_ACCENT, TOKENS, cssProperty, tokensFor } from "../../base-theme/src/index";
import { checkThemeCss } from "../../base-theme/src/css-check";
import { checkManifest } from "../../base-theme/src/manifest-check";
import { USAGE_CSS } from "../src/ui/styles";

const byProperty = new Map(TOKENS.map((spec) => [cssProperty(spec.name), spec.name]));
const light = tokensFor(BASE_THEME, "light");
const normalise = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

describe("the usage plugin's stylesheet", () => {
  test("reads only catalog tokens, each with the base theme's value as its fallback", () => {
    const uses = [...USAGE_CSS.matchAll(/var\((--[a-z0-9-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*?))?\)/g)];
    expect(uses.length).toBeGreaterThan(20);
    const wrong: string[] = [];
    for (const [, property, fallback] of uses) {
      const token = byProperty.get(property!);
      if (!token) wrong.push(`${property} is not a catalog token`);
      else if (fallback === undefined) wrong.push(`${property} has no fallback`);
      else {
        // The accent follows the OS (`system`); its fallback is the catalog's own accent.
        const want = light[token] === SYSTEM_ACCENT ? CATALOG_ACCENTS[token]!.light : String(light[token]);
        if (normalise(fallback) !== normalise(want)) wrong.push(`${property}: ${fallback}, the base theme's is ${want}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("puts nothing on an element that could hide a sealed frame", () => {
    expect(checkThemeCss(USAGE_CSS, { component: true })).toEqual([]);
  });

  test("the manifest passes the plugin checks: a child of clover, UI code", () => {
    const check = checkManifest(join(import.meta.dir, ".."), { child: true });
    expect(check.problems).toEqual([]);
    expect(check.kind).toBe("code");
  });
});
