// Her stage tools, through her MCP server: each changes only the stage; a wrong name is refused with the names she
// has; stage_status reads the stage and her settings.
import { expect, test } from "bun:test";
import { serveMcp } from "../mcp";
import { StageStore } from "../store";
import { CONTAINED_TOOLS, READ_ONLY_TOOLS, runStageTool, STAGE_TOOLS } from "../tools";
import { fakeApi } from "./fakes";

test("each tool changes the stage, or says why not with the valid names", async () => {
  const f = fakeApi({ settings: { nickname: "Sam", reactions: false } });
  const s = new StageStore(f.api);
  const run = (name: string, args: unknown = {}) => runStageTool(name, args, s, f.api.settings.get);
  expect(await run("set_expression", { name: "smile" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("hasn't loaded a model") }] });
  await s.setCatalog({ v: 1, expressions: ["smile"], motions: ["wave"], outfit: ["hat"] });
  expect(await run("set_expression", { name: "smile" })).toEqual({ content: [{ type: "text", text: "Expression: smile." }] });
  expect(await run("play_motion", { name: "spin" })).toMatchObject({ isError: true, content: [{ text: 'The model has no motion "spin". Its motions: wave.' }] });
  expect(await run("set_scene", { scene: "rain" })).toEqual({ content: [{ type: "text", text: "Scene: rain." }] });
  expect(await run("toggle_outfit", { part: "hat" })).toEqual({ content: [{ type: "text", text: "hat: on." }] });
  const pinned = await run("pin_note", { text: "Ship the build" });
  const id = /Pinned as (\w+)\./.exec(pinned.content[0]!.text)![1]!;
  expect(await run("unpin_note", { id })).toEqual({ content: [{ type: "text", text: `Unpinned ${id}.` }] });
  expect(await run("celebrate")).toEqual({ content: [{ type: "text", text: "Celebrating!" }] });
  const status = JSON.parse((await run("stage_status")).content[0]!.text);
  expect(status).toMatchObject({ scene: "rain", mood: "joy", outfit: { hat: true }, model: { expressions: ["smile"] }, settings: { nickname: "Sam", reactions: false } });
  expect(await run("rm_rf")).toMatchObject({ isError: true });
});

test("her lists: every tool but stage_status is display-only; stage_status only reads; every tool says it changes nothing else", () => {
  expect(new Set([...CONTAINED_TOOLS, ...READ_ONLY_TOOLS])).toEqual(new Set(STAGE_TOOLS.map((t) => t.name)));
  expect(CONTAINED_TOOLS.filter((t) => READ_ONLY_TOOLS.includes(t))).toEqual([]);
  for (const t of STAGE_TOOLS) expect([t.name, /only (changes her own stage|reads)/.test(t.description)]).toEqual([t.name, true]);
  for (const t of STAGE_TOOLS.filter((x) => CONTAINED_TOOLS.includes(x.name))) expect(t.description).toContain("her hooks never change or block anything");
});

test("the MCP server lists her tools and answers a call", async () => {
  const f = fakeApi();
  const s = new StageStore(f.api);
  const out: Record<string, unknown>[] = [];
  const transport: Parameters<typeof serveMcp>[0] = { start: async () => {}, send: async (m) => void out.push(m), close: async () => {} };
  await serveMcp(transport, { name: "stage", version: "1.0.0", tools: STAGE_TOOLS, call: (n, a) => runStageTool(n, a, s, f.api.settings.get) });
  transport.onmessage!({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  transport.onmessage!({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  transport.onmessage!({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "set_mood", arguments: { mood: "joy" } } });
  transport.onmessage!({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } });
  await Bun.sleep(10);
  expect(out.find((m) => m.id === 1)).toMatchObject({ result: { protocolVersion: "2025-06-18", serverInfo: { name: "stage" } } });
  expect((out.find((m) => m.id === 2) as { result: { tools: unknown[] } }).result.tools).toHaveLength(STAGE_TOOLS.length);
  expect(out.find((m) => m.id === 3)).toMatchObject({ result: { content: [{ text: "Mood: joy." }] } });
  expect(out.find((m) => m.id === 4)).toMatchObject({ error: { code: -32602 } });
});
