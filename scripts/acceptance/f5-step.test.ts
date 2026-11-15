import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePluginFolder } from "../../packages/core/src/registry/validate";
import { f5Wrong, writeF5, type F5Seen } from "./f5-step";

const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-b-f5-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("the three folder plugins validate, Surf's card names it as a Browser tool, and the verdict names each miss", async () => {
  const f = writeF5(root);
  const cards: string[] = [];
  for (const dir of [f.surf, f.view, f.term]) {
    const v = await validatePluginFolder(dir, { os: "macos" });
    expect([dir, v.issues.filter((i) => i.severity === "error")]).toEqual([dir, []]);
    cards.push(JSON.stringify(v.okText ?? []));
  }
  const good: F5Seen = {
    surfCard: cards[0]!,
    open: { text: "surf opened tab_1 for alpha", cards: [] },
    read: { text: "surf read: Browser fixture home | Browser fixture home", cards: [] },
    click: { text: "surf clicked: hello was clicked", cards: ["a tool card, approved"] },
    view: { listed: 1, shown: "shown", heard: true, hidden: "headless" },
    term: { output: true, inputRefused: "a terminal takes only the user's own key presses and pastes, which the app hands over itself" },
  };
  expect(f5Wrong(good)).toEqual([]);
  expect(f5Wrong({ ...good, click: { text: "surf clicked: ", cards: [] }, term: { output: true, inputRefused: "written" } })).toHaveLength(3);
});
