import { describe, expect, test } from "bun:test";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import { contrastRatio, flattenColor, validateManifest } from "@waifucave/moss-plugin-sdk";
import { checkThemeCss, tokenFallbackProblems, tokenUses, catalogValues } from "@waifucave/moss-plugin-sdk/ui/testing";
import { ISLAND_CSS } from "../src/ui/styles";

/** The findings the SDK's validator reports for this part's manifest, as a child of the bundled `moss` plugin. */
function manifestFindings(root: string): string[] {
  const report = validateManifest(readFileSync(join(root, "moss.json"), "utf8"), { folderName: basename(root), parent: { id: "moss", namespace: "moss" }, bundled: true, file: "moss.json" });
  return report.issues.map((i) => `${i.severity} ${i.code} ${i.path}: ${i.message}`);
}

/** The contrast of `fg` on `bg` (hex), a translucent `bg` first laid on `under`: the SDK's catalog helpers. */
const contrast = (fg: string, bg: string, under = "#FFFFFF"): number => {
  const ground = flattenColor(bg, under)!;
  return contrastRatio(flattenColor(fg, ground)!, ground)!;
};


/** The base theme as the core resolves it with no OS reading: an accent that follows the OS is the catalog's, an ink
 *  on it worked out against it (the CSS fallbacks are those values). */
const light = catalogValues("light");
/** Custom properties the island's own CSS sets for itself, not tokens. */
const LOCAL = new Set(["--glyph-cut"]);


describe("the island's stylesheet", () => {
  test("reads only catalog tokens, each with the catalog's value as its fallback", () => {
    expect(tokenUses(ISLAND_CSS).length).toBeGreaterThan(20);
    expect(tokenFallbackProblems(ISLAND_CSS, { local: LOCAL })).toEqual([]);
  });

  test("the answer field's placeholder reads at 4.5:1 or more, on the island's black and on an inner card", () => {
    const share = /\.clv-other::placeholder \{\s*color: color-mix\(in srgb, var\(--moss-island-text, #FFFFFF\) (\d+)%, transparent\)/.exec(ISLAND_CSS);
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
    const root = join(import.meta.dir, "..");
    expect(manifestFindings(root)).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(root, "moss.json"), "utf8"));
    expect(manifest.client?.entry).toBeDefined();
  });
});
