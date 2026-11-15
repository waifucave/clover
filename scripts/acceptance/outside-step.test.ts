import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePluginFolder } from "../../packages/core/src/registry/validate";
import { OUTSIDE_FOLDER, OUTSIDE_NOTE, OUTSIDE_PRIVATE, outsideWrong, writeOutside } from "./outside-step";

const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-b-outside-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("the two plugins validate, the named one's OK card names its program and folder, and the verdict names each miss", async () => {
  const o = writeOutside(join(root, "src"), join(root, "bin"), join(root, "user"));
  const named = await validatePluginFolder(o.named, { os: "macos" });
  const plain = await validatePluginFolder(o.plain, { os: "macos" });
  expect(named.issues.filter((i) => i.severity === "error")).toEqual([]);
  expect(plain.issues.filter((i) => i.severity === "error")).toEqual([]);
  const card = JSON.stringify(named.okText);
  const plainCard = JSON.stringify(plain.okText);
  const good = { named: { ran: `ran:0:${OUTSIDE_PRIVATE}`, folder: `read:${OUTSIDE_NOTE}`, direct: "refused:EPERM" }, plain: { ran: "refused: /x/acc-outside-cat isn't a program acc-inside names outside its sandbox (host.outside.programs), so it doesn't run there", folder: "refused:EPERM", direct: "refused:EPERM" } };
  expect(outsideWrong({ card, plainCard, program: o.program, ...good })).toEqual([]);
  // Its read-only tool: a tool card at the default level, then its answer; no card, or no answer, is a miss.
  expect(outsideWrong({ card, plainCard, program: o.program, ...good, tool: { cards: ["a tool card, approved"], answered: true } })).toEqual([]);
  expect(outsideWrong({ card, plainCard, program: o.program, ...good, tool: { cards: [], answered: true } })).toHaveLength(1);
  expect(outsideWrong({ card, plainCard, program: o.program, ...good, tool: { cards: ["a tool card, approved"], answered: false } })).toHaveLength(1);
  expect(card).toContain(OUTSIDE_FOLDER);
  // Inside the sandbox the program's read would have been refused; and a plain plugin that reads the folder is a miss.
  expect(outsideWrong({ card, plainCard, program: o.program, named: { ...good.named, ran: "ran:1:" }, plain: { ...good.plain, folder: `read:${OUTSIDE_NOTE}` } })).toHaveLength(2);
});
