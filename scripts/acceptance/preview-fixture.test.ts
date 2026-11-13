// Row 1.85 (ui `file.preview`): a plugin fills the keyed spot, and the shell's own resolver picks it for the media types it
// names and for no other, as the spot's catalog entry says (keyed by media type; `image/*`).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SPOTS } from "../../packages/plugin-sdk/src/catalogs/spots";
import { validateManifest } from "../../packages/plugin-sdk/src/manifest/validate";
import { resolveSpot, type UiEntry } from "../../plugins/clover/plugins/shell/runtime/resolve";

const dir = join(import.meta.dir, "fixtures", "acceptance-preview");
const manifest = JSON.parse(readFileSync(join(dir, "clover.json"), "utf8"));

test("the fixture is a valid manifest that fills file.preview for image/*", () => {
  const report = validateManifest(manifest);
  expect([report.ok, report.issues]).toEqual([true, []]);
  expect(report.manifest?.contributes?.ui).toEqual([{ spot: "file.preview", key: "image/*", component: "ImagePreview" }]);
  expect(SPOTS.find((s) => s.name === "file.preview")?.shape).toBe("keyed");
  expect(readFileSync(join(dir, "client", "index.tsx"), "utf8")).toContain("export function ImagePreview");
});

test("the resolver gives its entry to an image of any type, and nothing to a text file", () => {
  const entry: UiEntry = { pluginId: "acceptance-preview", id: "file.preview", spot: "file.preview", key: "image/*", component: "ImagePreview", source: "installed", enabledAt: 1 };
  const pick = (type: string) => resolveSpot("file.preview", { shape: "keyed" }, [entry], {}, type).entries.map((e) => e.component);
  expect(pick("image/png")).toEqual(["ImagePreview"]);
  expect(pick("image/svg+xml")).toEqual(["ImagePreview"]);
  expect(pick("text/plain")).toEqual([]);
});
