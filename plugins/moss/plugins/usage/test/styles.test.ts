import { describe, expect, test } from "bun:test";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import { validateManifest } from "@waifucave/moss-plugin-sdk";
import { checkThemeCss, tokenFallbackProblems, tokenUses, catalogValues } from "@waifucave/moss-plugin-sdk/ui/testing";
import { USAGE_CSS } from "../src/ui/styles";

/** The findings the SDK's validator reports for this part's manifest, as a child of the bundled `moss` plugin. */
function manifestFindings(root: string): string[] {
  const report = validateManifest(readFileSync(join(root, "moss.json"), "utf8"), { folderName: basename(root), parent: { id: "moss", namespace: "moss" }, bundled: true, file: "moss.json" });
  return report.issues.map((i) => `${i.severity} ${i.code} ${i.path}: ${i.message}`);
}


const light = catalogValues("light");

describe("the usage plugin's stylesheet", () => {
  test("reads only catalog tokens, each with the catalog's value as its fallback", () => {
    expect(tokenUses(USAGE_CSS).length).toBeGreaterThan(20);
    expect(tokenFallbackProblems(USAGE_CSS)).toEqual([]);
  });

  test("puts nothing on an element that could hide a sealed frame", () => {
    expect(checkThemeCss(USAGE_CSS, { component: true })).toEqual([]);
  });

  test("the manifest passes the plugin checks: a child of moss, UI code", () => {
    const root = join(import.meta.dir, "..");
    expect(manifestFindings(root)).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(root, "moss.json"), "utf8"));
    expect(manifest.client?.entry).toBeDefined();
  });
});
