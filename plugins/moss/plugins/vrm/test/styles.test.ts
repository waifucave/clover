import { describe, expect, test } from "bun:test";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import { validateManifest } from "@waifucave/moss-plugin-sdk";
import { checkThemeCss, tokenFallbackProblems, tokenUses, catalogValues } from "@waifucave/moss-plugin-sdk/ui/testing";
import { AVATAR_CSS } from "../src/ui/styles";

/** The findings the SDK's validator reports for this part's manifest, as a child of the bundled `moss` plugin. */
function manifestFindings(root: string): string[] {
  const report = validateManifest(readFileSync(join(root, "moss.json"), "utf8"), { folderName: basename(root), parent: { id: "moss", namespace: "moss" }, bundled: true, file: "moss.json" });
  return report.issues.map((i) => `${i.severity} ${i.code} ${i.path}: ${i.message}`);
}


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

});

describe("the manifest", () => {
  test("fills the avatar plugin's renderer spot for the vrm format, as code", () => {
    const root = join(import.meta.dir, "..");
    expect(manifestFindings(root)).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(root, "moss.json"), "utf8"));
    expect(manifest.client?.entry).toBeDefined();
  });

  test("asks for no capability: the avatar hears nothing, it is told what plays", async () => {
    const manifest = (await import("../moss.json", { with: { type: "json" } })).default as { capabilities?: string[] };
    expect(manifest.capabilities ?? []).toEqual([]);
  });
});
