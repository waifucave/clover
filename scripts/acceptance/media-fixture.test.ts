// The media fixture's clauses (rows 1.9, 2.30): its manifest asks for `client.isolated` and holds `files`, and its page
// carries the folder button and the drop listener the row reads.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateManifest } from "../../packages/plugin-sdk/src/manifest/validate";

const dir = join(import.meta.dir, "fixtures", "acceptance-media");

test("acceptance-media is valid, isolated and holds files", () => {
  const manifest = JSON.parse(readFileSync(join(dir, "clover.json"), "utf8")) as { id: string; capabilities: string[]; client: { isolated?: boolean } };
  expect(validateManifest(manifest).ok).toBe(true);
  expect(manifest.client.isolated).toBe(true);
  expect(manifest.capabilities).toContain("files");
});

test("its page reads crossOriginIsolated, picks a folder and listens for a drop", () => {
  const page = readFileSync(join(dir, "client", "index.tsx"), "utf8");
  expect(page).toContain("self.crossOriginIsolated");
  expect(page).toContain('data-acceptance-media-step="folder"');
  expect(page).toContain("pickFolder");
  expect(page).toContain("onDrop");
});
