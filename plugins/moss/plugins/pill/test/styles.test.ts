import { describe, expect, test } from "bun:test";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import { contrastRatio, flattenColor, validateManifest } from "@waifucave/moss-plugin-sdk";
import { checkThemeCss, tokenFallbackProblems, tokenUses, catalogValues } from "@waifucave/moss-plugin-sdk/ui/testing";
import { CHILD_PALETTES } from "../src/model/plume";
import { CHILD_PLUME_OPACITY } from "../src/ui/Children";
import { PILL_CSS } from "../src/ui/styles";

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
/** Custom properties the pill's own CSS sets for itself, not tokens. */
const LOCAL = new Set(["--glyph-cut"]);


describe("the pill's stylesheet", () => {
  test("reads only catalog tokens, each with the catalog's value as its fallback", () => {
    expect(tokenUses(PILL_CSS).length).toBeGreaterThan(20);
    expect(tokenFallbackProblems(PILL_CSS, { local: LOCAL })).toEqual([]);
  });

  test("a working child's title reads at 4.5:1 or more over its plume's hottest colour, every palette", () => {
    const scrim = /\.clp-child\[data-status="working"\] \.clp-child-title \{[^}]*color-mix\(in srgb, var\(--moss-pill-surface, #000000\) (\d+)%, transparent\)/.exec(PILL_CSS);
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
    const root = join(import.meta.dir, "..");
    expect(manifestFindings(root)).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(root, "moss.json"), "utf8"));
    expect(manifest.client?.entry).toBeDefined();
  });
});
