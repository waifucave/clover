// Her hooks only observe: each returns nothing, so none rewrites an input, a result or a message, adds a note, or
// denies or holds a call; and none is on tool.before, where a slow or crashed hook would refuse the call. They react
// on her own bot's sessions only, and with reactions off only the tally moves.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stageHooks, toolLabel } from "../hooks";
import { StageStore } from "../store";
import { ALPHA, fakeApi } from "./fakes";

const manifest = JSON.parse(readFileSync(join(ALPHA, "clover.json"), "utf8"));

test("every hook only observes: it returns nothing, and none is on an event whose return could steer", async () => {
  const f = fakeApi();
  const s = new StageStore(f.api);
  await s.change({ kind: "mood", mood: "joy" });
  const h = stageHooks({ store: s, bot: "alpha", reactions: async () => true, today: () => "2026-11-11" });
  const outs = [
    await h.onTurnStart({ event: "turn.start", bot: "alpha" }),
    await h.onToolAfter({ event: "tool.after", bot: "alpha", tool: { name: "Write" }, input: { file_path: "/Users/k/Documents/secret/story.md", content: "x" } }),
    await h.onTurnEnd({ event: "turn.end", bot: "alpha", outcome: "failed" }),
  ];
  expect(outs).toEqual([undefined, undefined, undefined]);
  // In the manifest: observe-only events, a handler each, and never tool.before / message.in / message.out / turn.start notes.
  const hooks = manifest.contributes.hooks as { on: string[]; handler: string }[];
  expect(hooks.flatMap((x) => x.on).sort()).toEqual(["tool.after", "turn.end", "turn.start"]);
  for (const x of hooks) expect(x.on.some((e) => ["tool.before", "message.in", "message.out"].includes(e))).toBe(false);
  const after = (await s.read()).state;
  expect(after).toMatchObject({ mood: "sad", tally: { turns: 1, tools: 1 } });
  expect(after.activity).toBeUndefined();
});

test("a completed turn keeps the mood her own tool chose", async () => {
  const f = fakeApi();
  const s = new StageStore(f.api);
  const h = stageHooks({ store: s, bot: "alpha", reactions: async () => true, today: () => "2026-11-11" });
  await h.onTurnStart({ bot: "alpha" });
  await s.change({ kind: "mood", mood: "joy" });
  await h.onToolAfter({ bot: "alpha", tool: { name: "mcp__alpha-stage__set_mood" } });
  await h.onTurnEnd({ bot: "alpha", outcome: "completed" });
  expect((await s.read()).state.mood).toBe("joy");
});

test("only her own sessions; reactions off move only the tally; a tool's label names the file, never its path", async () => {
  const f = fakeApi();
  const s = new StageStore(f.api);
  let on = false;
  const h = stageHooks({ store: s, bot: "alpha", reactions: async () => on, today: () => "2026-11-11" });
  await h.onTurnStart({ bot: "luna" });
  await h.onToolAfter({ bot: "luna", tool: { name: "Read" } });
  await h.onTurnEnd({ bot: "luna" });
  expect((await s.read()).state.tally).toBeUndefined();
  await h.onTurnStart({ bot: "alpha" });
  await h.onTurnEnd({ bot: "alpha", outcome: "interrupted" });
  expect((await s.read()).state).toMatchObject({ mood: "calm", tally: { turns: 1, tools: 0 } });
  on = true;
  await h.onToolAfter({ bot: "alpha", tool: { name: "Write" }, input: { file_path: "/Users/k/Documents/secret/story.md" } });
  expect((await s.read()).state.activity).toEqual({ kind: "tool", label: "Write story.md" });
  await h.onTurnEnd({ bot: "alpha", outcome: "interrupted" });
  expect((await s.read()).state.mood).toBe("alert");
  expect(toolLabel("mcp__alpha-stage__set_mood", {})).toBe("set_mood");
  expect(toolLabel("Read", { path: "C:\\Users\\k\\notes.txt" })).toBe("Read notes.txt");
});
