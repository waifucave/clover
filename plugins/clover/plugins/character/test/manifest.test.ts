import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { manifestFindings } from "../../shell/runtime/manifest-check";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "clover.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const stage = manifest.contributes.ui[0];

describe("clover.json (spec §5.9, format 1)", () => {
  test("a child of `clover`: no id of its own, a name, format 1; the package is named for it", () => {
    expect(manifest.manifest).toBe(1);
    expect(manifest.id).toBeUndefined();
    expect(manifest.name).toBe("Character");
    expect(pkg.name).toBe("@waifucave/clover-plugin-character");
  });

  test("its client entry and stylesheet exist; the entry imports no CSS; each entry names a component it exports", async () => {
    expect(existsSync(join(root, manifest.client.entry))).toBe(true);
    for (const css of manifest.client.css) expect(existsSync(join(root, css))).toBe(true);
    expect(readFileSync(join(root, manifest.client.entry), "utf8")).not.toMatch(/import\s+["'][^"']+\.css["']/);
    const entry = await import(join(root, manifest.client.entry));
    for (const ui of manifest.contributes.ui) expect(typeof entry[ui.component]).toBe("function");
  });

  test("it fills `bot.stage` and declares the `avatar` spot (keyed) and the data points `avatar.formats` and `avatar.packs` (lists)", () => {
    expect(stage.spot).toBe("bot.stage");
    expect(stage.declares.avatar.shape).toBe("keyed");
    for (const point of ["avatar.formats", "avatar.packs"]) {
      expect(stage.declares[point].shape).toBe("list");
      expect(stage.declares[point].props).toBeUndefined();
    }
    expect(Object.keys(stage.declares["avatar.packs"].fields.properties).sort()).toEqual(["file", "format", "id", "license", "name", "portrait"]);
    expect(stage.declares["avatar.packs"].fields.required).toEqual(["id", "file", "format"]);
  });

  test("lane B's validator finds nothing it would report, loaded as a bundled part of clover", () => {
    expect(manifestFindings(root)).toEqual([]);
  });
});

describe("the bundled renderers declare their formats", () => {
  for (const [dir, format] of [["vrm", "vrm"], ["live2d", "live2d"]] as const) {
    test(`${dir} declares \`${format}\` in avatar.formats, and the validator finds nothing`, () => {
      const m = JSON.parse(readFileSync(join(root, "..", dir, "clover.json"), "utf8"));
      expect(m.contributes["avatar.formats"].map((f: { format: string }) => f.format)).toEqual([format]);
      expect(manifestFindings(join(root, "..", dir))).toEqual([]);
    });
  }
});
