import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateManifest } from "@waifucave/moss-plugin-sdk";
import { readFileSync as readManifestFile } from "node:fs";
import { basename, join as joinPath } from "node:path";

/** The findings the core's validator reports for this bundled part's manifest (a child of the bundled `moss` plugin). */
function manifestFindings(root: string): string[] {
  const report = validateManifest(readManifestFile(joinPath(root, "moss.json"), "utf8"), { folderName: basename(root), parent: { id: "moss", namespace: "moss" }, bundled: true, file: "moss.json" });
  return report.issues.map((i) => `${i.severity} ${i.code} ${i.path}: ${i.message}`);
}


const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "moss.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const stage = manifest.contributes.ui[0];

describe("moss.json (spec §5.9, format 1)", () => {
  test("a child of `moss`: no id of its own, a name, format 1; the package is named for it", () => {
    expect(manifest.manifest).toBe(1);
    expect(manifest.id).toBeUndefined();
    expect(manifest.name).toBe("Character");
    expect(pkg.name).toBe("@waifucave/moss-plugin-character");
  });

  test("its client entry and stylesheet exist; the entry imports no CSS; each entry names a component it exports", async () => {
    expect(existsSync(join(root, manifest.client.entry))).toBe(true);
    for (const css of manifest.client.css) expect(existsSync(join(root, css))).toBe(true);
    expect(readFileSync(join(root, manifest.client.entry), "utf8")).not.toMatch(/import\s+["'][^"']+\.css["']/);
    const entry = await import(join(root, manifest.client.entry));
    for (const ui of manifest.contributes.ui) expect(typeof entry[ui.component]).toBe("function");
  });

  test("it fills `bot.stage` and declares the `avatar` spot (keyed); `avatar.formats` and `avatar.packs` are the platform's, which it declares nothing for", () => {
    expect(stage.spot).toBe("bot.stage");
    expect(stage.declares.avatar.shape).toBe("keyed");
    expect(Object.keys(stage.declares).sort()).toEqual(["avatar", "bot.stage.action"]);
  });

  test("it fills the bot editor's `bot.editor.section` with the Avatar section", () => {
    expect(manifest.contributes.ui.find((e: { spot: string }) => e.spot === "bot.editor.section")).toMatchObject({ id: "avatar", component: "AvatarSection", title: "Avatar" });
  });

  test("lane B's validator finds nothing it would report, loaded as a bundled part of moss", () => {
    expect(manifestFindings(root)).toEqual([]);
  });
});

describe("the bundled renderers declare their formats", () => {
  for (const [dir, format] of [["vrm", "vrm"], ["live2d", "live2d"]] as const) {
    test(`${dir} declares \`${format}\` in avatar.formats, and the validator finds nothing`, () => {
      const m = JSON.parse(readFileSync(join(root, "..", dir, "moss.json"), "utf8"));
      expect(m.contributes["avatar.formats"].map((f: { format: string }) => f.format)).toEqual([format]);
      expect(manifestFindings(join(root, "..", dir))).toEqual([]);
    });
  }
});
