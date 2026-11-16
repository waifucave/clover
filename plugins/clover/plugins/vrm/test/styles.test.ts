import { describe, expect, test } from "bun:test";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import { TOKENS, cssProperty, validateManifest } from "@waifucave/clover-plugin-sdk";
import { checkThemeCss, tokenFallbackProblems, tokenUses, catalogValues } from "@waifucave/clover-plugin-sdk/ui/testing";
import { AVATAR_CSS } from "../src/ui/styles";

/** The findings the SDK's validator reports for this part's manifest, as a child of the bundled `clover` plugin. */
function manifestFindings(root: string): string[] {
  const report = validateManifest(readFileSync(join(root, "clover.json"), "utf8"), { folderName: basename(root), parent: { id: "clover", namespace: "clover" }, bundled: true, file: "clover.json" });
  return report.issues.map((i) => `${i.severity} ${i.code} ${i.path}: ${i.message}`);
}


const byProperty = new Map(TOKENS.map((spec) => [cssProperty(spec.name), spec.name]));
/** The base theme as the core resolves it with no OS reading: an accent that follows the OS is the catalog's, an ink
 *  on it worked out against it (the CSS fallbacks are those values). */
const light = catalogValues("light");

describe("the avatar's stylesheet", () => {
  test("reads only catalog tokens, each with the catalog's value as its fallback", () => {
    expect(tokenUses(AVATAR_CSS).length).toBeGreaterThan(5);
    expect(tokenFallbackProblems(AVATAR_CSS)).toEqual([]);
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
    const root = join(import.meta.dir, "..");
    expect(manifestFindings(root)).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(root, "clover.json"), "utf8"));
    expect(manifest.client?.entry).toBeDefined();
  });

  test("asks for no capability: the avatar hears nothing, it is told what plays", async () => {
    const manifest = (await import("../clover.json", { with: { type: "json" } })).default as { capabilities?: string[] };
    expect(manifest.capabilities ?? []).toEqual([]);
  });
});
