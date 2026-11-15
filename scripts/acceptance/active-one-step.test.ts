import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePluginFolder } from "../../packages/core/src/registry/validate";
import { ACTIVE_IDS, ACTIVE_NAMES, activeWrong, refText, writeActiveOne, type ActiveSeen } from "./active-one-step";

const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-b-active-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("the declarer and its fillers validate, and the verdict names each miss", async () => {
  const f = writeActiveOne(root);
  for (const dir of [f.deck, f.one, f.two, f.three]) {
    const v = await validatePluginFolder(dir, { os: "macos" });
    expect([dir, v.issues.filter((i) => i.severity === "error")]).toEqual([dir, []]);
  }
  const one = refText(ACTIVE_IDS.one, "one");
  const two = refText(ACTIVE_IDS.two, "two");
  const good: ActiveSeen = {
    before: one,
    picker: { title: "Acceptance deck mode", options: [[ACTIVE_NAMES.one, true], [ACTIVE_NAMES.two, false], [ACTIVE_NAMES.three, false]] },
    picked: { active: two, heard: [two] },
    fillerSees: two,
    off: { active: one, note: `The one you picked isn't running, so ${ACTIVE_NAMES.one} is used for now.`, notice: true },
    back: two,
  };
  expect(activeWrong(good)).toEqual([]);
  expect(activeWrong({ ...good, picker: undefined })).toHaveLength(1);
  expect(activeWrong({ ...good, picked: { active: one, heard: [] }, off: { ...good.off, notice: false } })).toHaveLength(3);
});
