// The builder-examples row's own parts, held without a run: the row lists exactly the examples the builder's skill holds,
// a declarer before the plugins that fill its point, and an example's files are written as a plugin folder (its nested
// child plugin included).
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readExamples } from "../../plugins/clover/plugins/plugin-builder/test/examples";
import { FULL_STEPS } from "./steps";
import { BUILDER_EXAMPLES_STEP, INSTALL_ORDER, writeExample } from "./builder-examples-step";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

test("the row is in the table and installs every example of the builder's skill, a declarer before its fillers", () => {
  expect(FULL_STEPS).toContain(BUILDER_EXAMPLES_STEP);
  expect([...INSTALL_ORDER].sort()).toEqual(readExamples().map((e) => e.folder).sort());
  const at = (id: string) => INSTALL_ORDER.indexOf(id as (typeof INSTALL_ORDER)[number]);
  expect(at("ex-board")).toBeLessThan(at("ex-board-widget"));
  expect(at("ex-fit")).toBeLessThan(at("ex-fit-tile"));
});

test("an example's files are written as a plugin folder, ex-buddy's child plugin in its own folder under it", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lane-d-examples-")));
  temps.push(dir);
  for (const ex of readExamples()) {
    const folder = writeExample(dir, ex);
    for (const [path, body] of Object.entries(ex.files)) expect(readFileSync(join(folder, path), "utf8")).toBe(body);
    expect((JSON.parse(readFileSync(join(folder, "clover.json"), "utf8")) as { id: string }).id).toBe(ex.folder);
  }
  expect(existsSync(join(dir, "ex-buddy", "plugins", "settings", "clover.json"))).toBe(true);
});
