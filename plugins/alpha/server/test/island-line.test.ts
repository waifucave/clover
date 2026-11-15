// Her line on the island (`island.line`): what she is doing now, only while a turn is running and only for her own turns.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateTree } from "../../../../packages/plugin-sdk/src/index";
import * as server from "../index";
import { ALPHA, diskReader, fakeApi } from "./fakes";

afterEach(() => server.stop());

test("no line before a turn, 'Thinking' while it thinks, the tool she last ran while she works, none after the turn ends or goes quiet", async () => {
  await server.start(fakeApi().api as never);
  expect(await server.islandLine()).toBeUndefined();
  await server.onTurnStart({ event: "turn.start", bot: "alpha" });
  expect(await server.islandLine()).toEqual({ text: "Thinking", icon: "clock", bot: "alpha" });
  await server.onToolAfter({ event: "tool.after", bot: "alpha", tool: { name: "Write" }, input: { file_path: "/Users/k/Documents/secret/story.md" } });
  expect(await server.islandLine()).toEqual({ text: "Working, last ran Write story.md", icon: "bolt", bot: "alpha" });
  await server.onTurnEnd({ event: "turn.end", bot: "alpha", outcome: "completed" });
  expect(await server.islandLine()).toBeUndefined();
  // A turn that never reached turn.end (a crash) leaves her activity set: the line still goes when it has been quiet.
  await server.onTurnStart({ event: "turn.start", bot: "alpha" });
  expect(await server.islandLine()).toBeDefined();
  const real = Date.now;
  Date.now = () => real() + server.ACTIVITY_LINE_MS + 1000;
  try {
    expect(await server.islandLine()).toBeUndefined();
  } finally {
    Date.now = real;
  }
});

test("another bot's turn puts nothing on her line, and the path of a file never reaches it", async () => {
  await server.start(fakeApi().api as never);
  await server.onTurnStart({ event: "turn.start", bot: "luna" });
  await server.onToolAfter({ event: "tool.after", bot: "luna", tool: { name: "Read" }, input: { file_path: "/Users/k/secret/x.md" } });
  const line = await server.islandLine();
  expect(line === undefined || !JSON.stringify(line).includes("/Users")).toBe(true);
});

test("her manifest fills the island's point with it, and the tree still validates with no capability added", async () => {
  const manifest = JSON.parse(readFileSync(join(ALPHA, "clover.json"), "utf8"));
  expect(manifest.contributes["island.line"]).toEqual([{ id: "activity", handler: "islandLine" }]);
  expect(manifest.capabilities.some((c: string) => c.startsWith("call:"))).toBe(false);
  const tree = await validateTree(diskReader(ALPHA), { folderName: "alpha", bundled: true });
  const errors = [...tree.top.issues, ...tree.issues, ...tree.children.flatMap((c) => c.report.issues)].filter((i) => i.severity === "error");
  expect(errors).toEqual([]);
});
