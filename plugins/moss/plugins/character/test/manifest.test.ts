import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { validateManifest } from "@waifucave/moss-plugin-sdk";

/** The findings the core's validator reports for this bundled part's manifest (a child of the bundled `moss` plugin). */
function manifestFindings(root: string): string[] {
  const report = validateManifest(readFileSync(join(root, "moss.json"), "utf8"), { folderName: basename(root), parent: { id: "moss", namespace: "moss" }, bundled: true, file: "moss.json" });
  return report.issues.map((i) => `${i.severity} ${i.code} ${i.path}: ${i.message}`);
}

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "moss.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const ui = manifest.contributes.ui as { spot: string; id: string; component: string; declares?: Record<string, { props?: unknown; fills?: { ok: string }; files?: unknown }> }[];

describe("moss.json (spec §5.9, format 1)", () => {
  test("a child of `moss`: no id of its own, a name, format 1; the package is named for it", () => {
    expect(manifest.manifest).toBe(1);
    expect(manifest.id).toBeUndefined();
    expect(manifest.name).toBe("Avatar");
    expect(pkg.name).toBe("@waifucave/moss-plugin-character");
  });

  test("its client entry and stylesheet exist; the entry imports no CSS; each entry names a component it exports", async () => {
    expect(existsSync(join(root, manifest.client.entry))).toBe(true);
    for (const css of manifest.client.css) expect(existsSync(join(root, css))).toBe(true);
    expect(readFileSync(join(root, manifest.client.entry), "utf8")).not.toMatch(/import\s+["'][^"']+\.css["']/);
    const entry = await import(join(root, manifest.client.entry));
    for (const e of ui) expect(typeof entry[e.component]).toBe("function");
  });

  test("it shows in a panel of its own and on the screen, each declaring its own renderer spot (keyed), and in Settings, which declares its own points", () => {
    expect(ui.map((e) => [e.spot, e.id])).toEqual([["panel", "figure"], ["app.surface", "on-screen"], ["settings.section", "settings"]]);
    for (const place of ui.slice(0, 2)) expect(Object.keys(place.declares ?? {})).toEqual(["moss.character.renderer"]);
    expect(JSON.stringify(ui[0]!.declares)).toBe(JSON.stringify(ui[1]!.declares));
    expect(Object.keys(ui[2]!.declares ?? {}).sort()).toEqual(["moss.character.figure", "moss.character.formats", "moss.character.packs"]);
    // What plugs in is named on its card, in this plugin's words: a renderer, a pack, a controller.
    expect(ui[0]!.declares!["moss.character.renderer"]!.fills?.ok).toMatch(/model files/);
    expect(ui[2]!.declares!["moss.character.packs"]!.fills?.ok).toMatch(/picker/);
    expect(ui[2]!.declares!["moss.character.figure"]!.fills?.ok).toMatch(/moves the figure/);
    // A pack's model files come along with its entry, by the declared kinds.
    expect(ui[2]!.declares!["moss.character.packs"]!.files).toMatchObject({ file: { kinds: expect.any(Array) } });
  });

  test("it holds no retired capability; it reads the activity feed of sessions and of bots, floats over the screen (`overlay`), and reads the files the person picks for their own models (`files`)", () => {
    expect([...manifest.capabilities].sort()).toEqual(["activity.read.bots", "activity.read.sessions", "files", "overlay"]);
    expect(manifest.settings.onScreen).toMatchObject({ type: "boolean", default: false, scope: "device" });
  });

  test("lane B's validator finds nothing it would report, loaded as a bundled part of moss", () => {
    expect(manifestFindings(root)).toEqual([]);
  });
});

describe("the bundled renderers plug into the avatar plugin's points, and MOSS Voice's speech", () => {
  for (const [dir, format] of [["vrm", "vrm"], ["live2d", "live2d"]] as const) {
    test(`${dir} fills moss.character.renderer keyed \`${format}\`, declares it in moss.character.formats, hears moss.voice.speech, and the validator finds nothing`, () => {
      const m = JSON.parse(readFileSync(join(root, "..", dir, "moss.json"), "utf8"));
      expect(m.contributes.ui).toEqual([expect.objectContaining({ spot: "moss.character.renderer", key: format })]);
      expect(m.contributes["moss.character.formats"].map((f: { format: string }) => f.format)).toEqual([format]);
      expect(m.contributes["moss.voice.speech"]).toEqual([{ id: "mouth" }]);
      expect(m.contributes["avatar.formats"]).toBeUndefined();
      expect(manifestFindings(join(root, "..", dir))).toEqual([]);
    });
  }
});
