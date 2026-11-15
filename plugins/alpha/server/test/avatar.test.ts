// Her stage tools reach her figure through the public avatar calls (`api.avatar`), never through a message of their
// own: a name is checked against the catalogue the renderer published, a cue the renderer won't play is the tool's
// refusal (and the stage keeps what it had), and the figure's own names are what stage_status lists.
import { expect, test } from "bun:test";
import { CATALOG_KEY, STAGE_KEY } from "../stage";
import { StageStore } from "../store";
import { runStageTool } from "../tools";
import { fakeApi, fakeAvatar, MODEL } from "./fakes";

const setup = (o: Parameters<typeof fakeAvatar>[0] = { catalogue: MODEL }) => {
  const f = fakeApi();
  const a = fakeAvatar(o);
  let t = 0;
  const s = new StageStore({ ...f.api, avatar: a.avatar }, { now: () => (t += 200) });
  return { f, a, s, run: (name: string, args: unknown = {}) => runStageTool(name, args, s, f.api.settings.get) };
};

test("set_expression, play_motion and toggle_outfit cue her figure with the renderer's own names", async () => {
  const { a, run } = setup();
  expect(await run("set_expression", { name: "smile" })).toMatchObject({ content: [{ text: "Expression: smile" }] });
  expect(await run("play_motion", { name: "wave" })).toMatchObject({ content: [{ text: "Motion: wave" }] });
  expect(await run("toggle_outfit", { part: "hat" })).toMatchObject({ content: [{ text: "Outfit: hat on" }] });
  expect(await run("toggle_outfit", { part: "hat" })).toMatchObject({ content: [{ text: "Outfit: hat off" }] });
  expect(a.cues).toEqual([
    { type: "expression", name: "smile" }, { type: "motion", name: "wave" },
    { type: "outfit", part: "hat", on: true }, { type: "outfit", part: "hat", on: false },
  ]);
});

test("the catalogue comes from the renderer, so stage_status lists its names; a wrong name is refused with them", async () => {
  const { f, a, run } = setup();
  expect(await run("set_expression", { name: "nope" })).toMatchObject({ isError: true, content: [{ text: 'The model has no expression "nope". The expressions this model has: "smile", "love".' }] });
  expect(a.cues).toEqual([]);
  expect(f.store.get(CATALOG_KEY)).toEqual({ v: 1, expressions: ["smile", "love"], motions: ["wave"], outfit: ["hat"] });
  const st = JSON.parse((await run("stage_status")).content[0]!.text.split("\n")[1]!);
  expect(st.names_this_model_has).toEqual({ expressions: ["smile", "love"], motions: ["wave"], outfit_parts: ["hat"] });
});

test("a cue the renderer answers plainly with no is the tool's refusal, and the stage keeps what it had", async () => {
  const { f, run } = setup({ catalogue: MODEL, answer: () => ({ ok: false, reason: "unsupported", message: "this renderer (x) doesn't do outfits" }) });
  expect(await run("toggle_outfit", { part: "hat" })).toMatchObject({ isError: true, content: [{ text: "this renderer (x) doesn't do outfits" }] });
  expect(f.store.get(STAGE_KEY)).toBeUndefined();
});

test("no renderer: the catalogue is empty and the tool says so plainly", async () => {
  const { run } = setup({});
  expect(await run("set_expression", { name: "smile" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("hasn't loaded a model") }] });
});

test("celebrate cues the best joyful expression the model has; a turn running looks at the conversation, then back", async () => {
  const { a, s } = setup();
  await s.change({ kind: "celebrate" });
  await s.change({ kind: "activity", activity: { kind: "thinking", label: "thinking" } });
  await s.change({ kind: "activity", activity: { kind: "tool", label: "Read" } });
  await s.change({ kind: "activity" });
  await new Promise((r) => setTimeout(r, 0));
  expect(a.cues).toEqual([{ type: "expression", name: "love" }, { type: "lookAt", point: { x: 0, y: 0.7 } }, { type: "lookAt", point: null }]);
});

test("a model that loads again gets her outfit back on", async () => {
  const { a, s } = setup();
  await s.change({ kind: "outfit", part: "hat", on: true });
  a.cues.length = 0;
  await s.reapplyOutfit();
  expect(a.cues).toEqual([{ type: "outfit", part: "hat", on: true }]);
});
