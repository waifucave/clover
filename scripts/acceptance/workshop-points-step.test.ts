// The points row's own parts, held without a run: the plugin Alpha builds first is the builder's `point` template under
// its own id (it declares the point the second one fills), the second one is a manifest that adds one entry to it, and
// every call the row has the scripted fake make is short enough for the fake to read whole.
import { expect, test } from "bun:test";
import { FULL_STEPS } from "./steps";
import { callText } from "./workshop-step";
import { BOARD_ID, BOARD_POINT, ITEM_ID, ITEM_TITLE, WORKSHOP_POINTS_STEP, boardFiles, itemFiles } from "./workshop-points-step";

test("the row is in the table; the first plugin declares the point, the second fills it with one entry", () => {
  expect(FULL_STEPS).toContain(WORKSHOP_POINTS_STEP);
  const board = JSON.parse(boardFiles()["clover.json"]!) as { id: string; contributes: { ui: { declares: Record<string, unknown> }[] } };
  expect(board.id).toBe(BOARD_ID);
  expect(Object.keys(board.contributes.ui[0]!.declares)).toEqual([BOARD_POINT]);
  const item = JSON.parse(itemFiles()["clover.json"]!) as { id: string; contributes: Record<string, { id: string; title: string }[]> };
  expect(item.id).toBe(ITEM_ID);
  expect(item.contributes[BOARD_POINT]).toEqual([{ id: "hello", title: ITEM_TITLE }]);
});

test("each Write the row has Alpha make fits the 4,000 characters the scripted fake reads", () => {
  for (const [id, files] of [[BOARD_ID, boardFiles()], [ITEM_ID, itemFiles()]] as const) {
    for (const [path, content] of Object.entries(files)) expect(callText("Write", { file_path: `/h/scratch/alpha/${id}/${path}`, content }).length).toBeLessThan(4000);
  }
});
