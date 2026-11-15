// The stage's keeper: the store is the one source, so two module instances (her MCP server's and her hooks') never
// write over each other; each change is written and sent to her tab; at most 10 a second; the catalogue her tab hands
// over is checked; the scenes other plugins add through her point are published.
import { expect, test } from "bun:test";
import { CATALOG_KEY, SCENES_KEY, STAGE_KEY, STAGE_TOPIC } from "../stage";
import { StageStore } from "../store";
import { fakeApi } from "./fakes";

test("each change is read from the store, written back and sent to her tab; two instances never undo each other", async () => {
  const f = fakeApi();
  const tools = new StageStore(f.api), hooks = new StageStore(f.api);
  expect(await tools.change({ kind: "mood", mood: "joy" })).toMatchObject({ ok: true });
  expect(await hooks.change({ kind: "tally", tools: 1, day: "2026-11-11" })).toMatchObject({ ok: true });
  expect(f.store.get(STAGE_KEY)).toMatchObject({ v: 1, mood: "joy", tally: { tools: 1 } });
  expect(f.sent.map((m) => [m.event, (m.data as { mood: string }).mood])).toEqual([[STAGE_TOPIC, "joy"], [STAGE_TOPIC, "joy"]]);
  // A refused change writes nothing.
  const writes = f.writes.length;
  expect((await tools.change({ kind: "scene", scene: "moon" })).ok).toBe(false);
  expect(f.writes.length).toBe(writes);
});

test("at most 10 changes a second per instance; the rest are refused, then it goes on", async () => {
  const f = fakeApi();
  let now = 5_000;
  const s = new StageStore(f.api, { now: () => now });
  const moods = ["calm", "joy", "sad", "alert"];
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => s.change({ kind: "mood", mood: moods[i % 4]! }).then((r) => r.ok || r.said)));
  expect(results.filter((r) => r === true)).toHaveLength(10);
  expect(results.slice(10)).toEqual(["Her stage is changing too fast; try again in a moment.", "Her stage is changing too fast; try again in a moment."]);
  now += 1_000;
  expect((await s.change({ kind: "clearPins" })).ok).toBe(true);
});

test("a count is never refused for the rate: a burst of tool calls is all counted", async () => {
  const f = fakeApi();
  const s = new StageStore(f.api, { now: () => 5_000 });
  const results = await Promise.all(Array.from({ length: 25 }, () => s.change({ kind: "tally", tools: 1, day: "2026-11-12" }).then((r) => r.ok)));
  expect(results.every((r) => r)).toBe(true);
  expect(f.store.get(STAGE_KEY)).toMatchObject({ tally: { tools: 25, day: "2026-11-12" } });
  // And it takes nothing of the second's allowance from the changes that are limited.
  expect((await s.change({ kind: "mood", mood: "joy" })).ok).toBe(true);
});

test("the catalogue is checked and kept; toggles the new model lacks go; a stored stage reads back", async () => {
  const f = fakeApi({ settings: { scene: "study" } });
  const s = new StageStore(f.api);
  expect((await s.read()).state.scene).toBe("study");
  expect(await s.setCatalog({ v: 1, expressions: ["smile"], motions: [], outfit: ["hat", "scarf"] })).toEqual({ ok: true });
  expect(f.store.get(CATALOG_KEY)).toEqual({ v: 1, expressions: ["smile"], motions: [], outfit: ["hat", "scarf"] });
  await s.change({ kind: "outfit", part: "scarf", on: true });
  await s.setCatalog({ v: 1, expressions: [], motions: [], outfit: ["hat"] });
  expect((await s.read()).state.outfit).toEqual({});
  expect(await s.setCatalog({ v: 3 })).toMatchObject({ ok: false });
  expect((await new StageStore(f.api).read()).catalog).toEqual({ v: 1, expressions: [], motions: [], outfit: ["hat"] });
});

test("a page calling setCatalog in a loop: the same catalogue writes nothing; at most 6 new ones a minute are kept", async () => {
  const f = fakeApi();
  let now = 1_000;
  const s = new StageStore(f.api, { now: () => now });
  const cat = (n: number) => ({ v: 1, expressions: [`e${n}`], motions: [], outfit: [] });
  expect(await s.setCatalog(cat(0))).toEqual({ ok: true });
  for (let i = 0; i < 50; i++) expect(await s.setCatalog(cat(0))).toEqual({ ok: true });
  expect(f.writes.filter((k) => k === CATALOG_KEY)).toHaveLength(1);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => s.setCatalog(cat(i + 1)).then((r) => r.ok)));
  expect(results.filter(Boolean)).toHaveLength(5);
  expect(f.writes.filter((k) => k === CATALOG_KEY)).toHaveLength(6);
  expect(f.store.get(CATALOG_KEY)).toEqual(cat(5));
  // Junk is refused before it's counted or written.
  expect((await s.setCatalog({ v: 1, expressions: ["<b>"] })).ok).toBe(false);
  now += 60_000;
  expect(await s.setCatalog(cat(9))).toEqual({ ok: true });
  expect(f.store.get(CATALOG_KEY)).toEqual(cat(9));
});

test("scenes: hers and the ones other plugins add through alpha.scenes, published for her tools and her tab", async () => {
  const f = fakeApi({ scenes: [
    { pluginId: "alpha/extras", value: { id: "seaside", title: "Seaside at dusk" } },
    { pluginId: "other", value: { id: "meadow", title: "A second meadow" } },
    { pluginId: "other", value: { id: "Bad Id", title: "x" } },
    { pluginId: "other", value: { id: "dusk", title: "Dusk\u202e\u0000 sky" } },
  ] });
  const s = new StageStore(f.api);
  const scenes = await s.refreshScenes();
  expect(scenes.map((x) => x.id)).toEqual(["meadow", "study", "starry", "rain", "seaside", "dusk"]);
  expect(scenes.find((x) => x.id === "dusk")!.title).toBe("Dusk   sky");
  expect(f.store.get(SCENES_KEY)).toContainEqual({ id: "seaside", title: "Seaside at dusk", from: "alpha/extras" });
  expect((await new StageStore(f.api).change({ kind: "scene", scene: "seaside" })).ok).toBe(true);
});
