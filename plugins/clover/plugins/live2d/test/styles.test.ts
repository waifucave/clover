import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BASE_THEME, CATALOG_ACCENTS, SYSTEM_ACCENT, TOKENS, cssProperty, tokensFor } from "../../base-theme/src/index";
import { checkThemeCss } from "../../base-theme/src/css-check";
import { checkManifest } from "../../base-theme/src/manifest-check";
import { LIVE2D_CSS } from "../src/ui/styles";

const byProperty = new Map(TOKENS.map((spec) => [cssProperty(spec.name), spec.name]));
const light = tokensFor(BASE_THEME, "light");
const normalise = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

describe("the Live2D renderer's stylesheet", () => {
  test("reads only catalog tokens, each with the base theme's value as its fallback", () => {
    const wrong: string[] = [];
    for (const [, property, fallback] of LIVE2D_CSS.matchAll(/var\((--[a-z0-9-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*?))?\)/g)) {
      const token = byProperty.get(property!);
      if (!token) wrong.push(`${property} is not a catalog token`);
      else if (fallback === undefined) wrong.push(`${property} has no fallback`);
      else {
        const want = light[token] === SYSTEM_ACCENT ? CATALOG_ACCENTS[token]!.light : String(light[token]);
        if (normalise(fallback) !== normalise(want)) wrong.push(`${property}: ${fallback}, the base theme's is ${want}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("draws inside its own box: nothing of the avatar can lie over a sealed frame", () => {
    expect(LIVE2D_CSS).toMatch(/\.clvl-avatar \{[^}]*position: relative;[^}]*overflow: hidden;/);
    expect(checkThemeCss(LIVE2D_CSS, { component: true })).toEqual([]);
  });

  test("the manifest passes the plugin checks: a child of clover, UI code", () => {
    const check = checkManifest(join(import.meta.dir, ".."), { child: true });
    expect(check.problems).toEqual([]);
    expect(check.kind).toBe("code");
  });
});

describe("the format's name stays out of the UI (owner's decision: the UI says \"2D model\")", () => {
  test("the strings, the manifest's name and description, and the gallery's titles never say Live2D or Cubism", async () => {
    const { readFileSync } = await import("node:fs");
    const { LIVE2D_STORIES } = await import("../src/gallery");
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "clover.json"), "utf8")) as { name: string; description: string };
    const { EN } = await import("../src/strings");
    const strings = Object.values(EN).flatMap((v) => (typeof v === "string" ? [v] : Object.values(v)));
    const shown = [manifest.name, manifest.description, ...strings, ...LIVE2D_STORIES.map((s) => s.title)];
    expect(strings.length).toBeGreaterThan(5);
    expect(shown.filter((text) => /live\s*2d|cubism/i.test(text))).toEqual([]);
  });
});
