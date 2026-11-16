import { describe, expect, test } from "bun:test";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import { validateManifest } from "@waifucave/moss-plugin-sdk";
import { checkThemeCss, tokenFallbackProblems, tokenUses, catalogValues } from "@waifucave/moss-plugin-sdk/ui/testing";
import { LIVE2D_CSS } from "../src/ui/styles";

/** The findings the SDK's validator reports for this part's manifest, as a child of the bundled `moss` plugin. */
function manifestFindings(root: string): string[] {
  const report = validateManifest(readFileSync(join(root, "moss.json"), "utf8"), { folderName: basename(root), parent: { id: "moss", namespace: "moss" }, bundled: true, file: "moss.json" });
  return report.issues.map((i) => `${i.severity} ${i.code} ${i.path}: ${i.message}`);
}


const light = catalogValues("light");

describe("the Live2D renderer's stylesheet", () => {
  test("reads only catalog tokens, each with the catalog's value as its fallback", () => {
    expect(tokenUses(LIVE2D_CSS).length).toBeGreaterThan(5);
    expect(tokenFallbackProblems(LIVE2D_CSS)).toEqual([]);
  });

  test("draws inside its own box: nothing of the avatar can lie over a sealed frame", () => {
    expect(LIVE2D_CSS).toMatch(/\.clvl-avatar \{[^}]*position: relative;[^}]*overflow: hidden;/);
    expect(checkThemeCss(LIVE2D_CSS, { component: true })).toEqual([]);
  });

  test("the manifest passes the plugin checks: a child of moss, UI code", () => {
    const root = join(import.meta.dir, "..");
    expect(manifestFindings(root)).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(root, "moss.json"), "utf8"));
    expect(manifest.client?.entry).toBeDefined();
  });
});

describe("the format's name stays out of the UI (owner's decision: the UI says \"2D model\")", () => {
  test("the strings, the manifest's name and description, and the gallery's titles never say Live2D or Cubism", async () => {
    const { readFileSync } = await import("node:fs");
    const { LIVE2D_STORIES } = await import("../src/gallery");
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "moss.json"), "utf8")) as { name: string; description: string };
    const { EN } = await import("../src/strings");
    const strings = Object.values(EN).flatMap((v) => (typeof v === "string" ? [v] : Object.values(v)));
    const shown = [manifest.name, manifest.description, ...strings, ...LIVE2D_STORIES.map((s) => s.title)];
    expect(strings.length).toBeGreaterThan(5);
    expect(shown.filter((text) => /live\s*2d|cubism/i.test(text))).toEqual([]);
  });
});
