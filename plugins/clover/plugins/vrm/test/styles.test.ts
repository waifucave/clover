import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BASE_THEME, TOKENS, cssProperty, resolveTokens, tokensFor } from "../../base-theme/src/index";
import { checkThemeCss } from "../../base-theme/src/css-check";
import { checkManifest } from "../../base-theme/src/manifest-check";
import { AVATAR_CSS } from "../src/ui/styles";

const byProperty = new Map(TOKENS.map((spec) => [cssProperty(spec.name), spec.name]));
/** The base theme as the core resolves it with no OS reading: an accent that follows the OS is the catalog's, an ink
 *  on it worked out against it (the CSS fallbacks are those values). */
const light = resolveTokens("light", [tokensFor(BASE_THEME, "light")]);
const normalise = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

describe("the avatar's stylesheet", () => {
  test("reads only catalog tokens, each with the base theme's value as its fallback", () => {
    const uses = [...AVATAR_CSS.matchAll(/var\((--[a-z0-9-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*?))?\)/g)];
    expect(uses.length).toBeGreaterThan(5);
    for (const [, property, fallback] of uses) {
      const token = byProperty.get(property!);
      expect(token, `${property} is not a catalog token`).toBeDefined();
      expect(normalise(fallback!), property).toBe(normalise(String(light[token!])));
    }
  });

  test("keeps to the theme CSS rules", () => {
    expect(checkThemeCss(AVATAR_CSS, { component: true })).toEqual([]);
  });

  test("the component reads the stage's light tokens", () => {
    for (const name of ["avatar.light.key", "avatar.light.fill", "avatar.light.rim", "avatar.exposure"]) expect(byProperty.get(cssProperty(name))).toBe(name);
  });
});

describe("the manifest", () => {
  test("fills the stage's avatar spot for the vrm format, as code", () => {
    const check = checkManifest(join(import.meta.dir, ".."), { child: true });
    expect(check.problems).toEqual([]);
    expect(check.kind).toBe("code");
  });

  test("asks for no capability: the avatar hears nothing, it is told what plays", async () => {
    const manifest = (await import("../clover.json", { with: { type: "json" } })).default as { capabilities?: string[] };
    expect(manifest.capabilities ?? []).toEqual([]);
  });
});
