// The avatar plugin's own tools (server/): each call goes to the figures with ui.send and the first answer is the
// result; a refused name says what the model has; no figure taking it says so plainly; a late answer is nothing.
import { expect, test } from "bun:test";
import { ANSWER_MS, ask, TOOL_EVENT, ui } from "../server/index";
import { FIGURE_TOOLS, NO_FIGURE, runFigureTool } from "../server/tools";
import manifest from "../moss.json";

test("the manifest's figure server: the host half, on demand; it serves exactly these tools, none on a list that skips the card", () => {
  const m = manifest as unknown as { host: { entry: string }; contributes: { mcpServers: { figure: Record<string, unknown> } } };
  expect(m.host.entry).toBe("server/index.ts");
  expect(m.contributes.mcpServers.figure).toEqual({ type: "host", tools: { "*": "on-demand" }, instructions: "server/instructions.md" });
  expect(FIGURE_TOOLS.map((t) => t.name)).toEqual(["set_expression", "play_motion", "toggle_outfit", "figure_status"]);
});

test("a call goes to the figures and comes back with the first answer; a refused name, no figure and the status read plainly", async () => {
  const sent: { event: string; value: { id: string; cue?: unknown; status?: true } }[] = [];
  const api = { ui: { send: async (event: string, value: unknown) => { sent.push({ event, value: value as never }); } } } as never;
  // A figure takes it and answers ok; a second answer to the same call is nothing.
  const one = ask(api, { cue: { type: "expression", name: "happy" } }, 1_000);
  await Bun.sleep(0);
  expect(sent[0]).toEqual({ event: TOOL_EVENT, value: { id: sent[0]!.value.id, cue: { type: "expression", name: "happy" } } });
  expect(ui.answered({ id: sent[0]!.value.id, result: { ok: true } })).toBe(true);
  expect(ui.answered({ id: sent[0]!.value.id, result: { ok: false } })).toBe(false);
  expect(await one).toEqual({ ok: true });
  // Through the tool: the refusal is the figure's words, with what the model has.
  const said = (r: { content: { text: string }[]; isError?: boolean }) => [r.content[0]!.text, r.isError === true];
  expect(said(await runFigureTool("set_expression", { name: "angry" }, async () => ({ ok: false, reason: "unknown-name", message: 'this model has no expression "angry"; it has: happy, sad' }))))
    .toEqual(['this model has no expression "angry"; it has: happy, sad', true]);
  expect(said(await runFigureTool("play_motion", { name: "wave" }, async () => undefined))).toEqual([NO_FIGURE, true]);
  expect(said(await runFigureTool("toggle_outfit", { part: "hat", on: true }, async (r) => (JSON.stringify(r.cue) === JSON.stringify({ type: "outfit", part: "hat", on: true }) ? { ok: true } : { ok: false, message: "wrong cue" }))))
    .toEqual(["The avatar's hat is on.", false]);
  expect(said(await runFigureTool("figure_status", {}, async (r) => (r.status === true ? { ok: true, catalogue: { renderer: "moss/vrm", expressions: ["happy"], motions: [], outfits: [{ name: "hat", on: false }] } } : undefined))))
    .toEqual(["The avatar (drawn by moss/vrm) has expressions: happy; motions: none; outfit parts: hat (off).", false]);
  // No figure answers in time: undefined (the tool says NO_FIGURE).
  expect(await ask(api, { status: true }, 20)).toBeUndefined();
  expect(ANSWER_MS).toBeGreaterThanOrEqual(1_000);
});
