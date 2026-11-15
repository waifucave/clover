// The browser row's third-party island tab: a valid manifest under its own id whose only entry fills the island's slot,
// with a TSX client and no react shipped.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateManifest } from "../../packages/plugin-sdk/src/manifest/validate";

const dir = join(import.meta.dir, "fixtures", "acceptance-tab");

test("acceptance-tab is a valid manifest whose one entry is an island.tab, with a TSX client and no react", () => {
  const manifest = JSON.parse(readFileSync(join(dir, "clover.json"), "utf8")) as { id: string; contributes: { ui: { spot: string }[] } };
  expect(manifest.contributes.ui.map((e) => e.spot)).toEqual(["island.tab"]);
  expect(existsSync(join(dir, "client", "index.tsx"))).toBe(true);
  expect(existsSync(join(dir, "node_modules"))).toBe(false);
  const report = validateManifest(manifest);
  expect([report.ok, report.id]).toEqual([true, "acceptance-tab"]);
});
