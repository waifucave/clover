import { describe, expect, test } from "bun:test";
import { apiCallAllowed } from "@waifucave/clover-plugin-sdk";
import { AvatarService, AVATAR_CHANGED_EVENT, AVATAR_CUE_EVENT, AVATAR_CUES_PER_SECOND } from "../api/avatar";

const report = (over: object = {}) => ({ format: "live2d", renderer: "clover/live2d", capabilities: ["expressions", "outfits"], names: { expressions: ["happy", "sad"], motions: [], outfits: [{ name: "hat", on: false }] }, box: { canvas: { width: 400, height: 600 } }, ...over });
const make = () => {
  const events: { type: string; [k: string]: unknown }[] = [];
  const svc = new AvatarService((e) => events.push(e));
  return { svc, events, h: svc.handlers() };
};
const ctx = (pluginId: string) => ({ pluginId, process: "ui", caller: { kind: "plugin", pluginId }, record: {}, path: "avatar.cue" }) as never;

describe("avatar cues in the core", () => {
  test("a cue with nothing drawn is answered plainly, and sends nothing", () => {
    const { h, events } = make();
    expect(h["avatar.cue"]!(ctx("alpha"), [{ type: "expression", name: "happy" }])).toMatchObject({ ok: false, reason: "no-renderer" });
    expect(events).toEqual([]);
  });

  test("the stage's report is read, the catalogue and the box answer for the plugin's own bot only", () => {
    const { h } = make();
    h["avatar.report"]!(ctx("clover/character"), ["alpha", report()]);
    expect(h["avatar.catalogue"]!(ctx("alpha"), [])).toMatchObject({ format: "live2d", expressions: ["happy", "sad"], outfits: [{ name: "hat", on: false }], capabilities: ["expressions", "outfits"] });
    expect(h["avatar.catalogue"]!(ctx("luna"), [])).toBeUndefined();
    expect(h["avatar.box"]!(ctx("alpha"), [])).toMatchObject({ estimated: true, canvas: { width: 400, height: 600 } });
    // A child plugin acts for its top-level plugin's bot.
    expect(h["avatar.catalogue"]!(ctx("alpha/tab"), [])).toBeDefined();
    h["avatar.report"]!(ctx("clover/character"), ["alpha", undefined]);
    expect(h["avatar.catalogue"]!(ctx("alpha"), [])).toBeUndefined();
  });

  test("a cue the renderer can play goes to the stage that reported, for its bot; the rest are answered, unsupported or unknown", () => {
    const { h, events } = make();
    h["avatar.report"]!(ctx("clover/character"), ["alpha", report()]);
    events.length = 0;
    expect(h["avatar.cue"]!(ctx("alpha"), [{ type: "expression", name: "happy" }])).toEqual({ ok: true });
    expect(events).toEqual([{ type: "plugin_ui_message", pluginId: "clover/character", event: AVATAR_CUE_EVENT, value: { bot: "alpha", cue: { type: "expression", name: "happy" } } }]);
    expect(h["avatar.cue"]!(ctx("alpha"), [{ type: "motion", name: "wave" }])).toMatchObject({ ok: false, reason: "unsupported" });
    expect(h["avatar.cue"]!(ctx("alpha"), [{ type: "expression", name: "furious" }])).toMatchObject({ ok: false, reason: "unknown-name" });
    expect(h["avatar.cue"]!(ctx("alpha"), [{ type: "dance" }])).toMatchObject({ ok: false, reason: "invalid" });
    expect(events).toHaveLength(1);
  });

  test("a plugin's cues are capped a second", () => {
    const { h } = make();
    h["avatar.report"]!(ctx("clover/character"), ["alpha", report()]);
    for (let i = 0; i < AVATAR_CUES_PER_SECOND; i++) h["avatar.cue"]!(ctx("alpha"), [{ type: "expression", name: "happy" }]);
    expect(() => h["avatar.cue"]!(ctx("alpha"), [{ type: "expression", name: "happy" }])).toThrow("cues this second");
  });

  test("a change reaches the plugin's own layer as a message and its host half's watch, once per real change", () => {
    const { h, events } = make();
    const seen: unknown[] = [];
    const off = h["avatar.watch"]!(ctx("alpha"), [(c: unknown) => seen.push(c)]) as () => void;
    h["avatar.report"]!(ctx("clover/character"), ["alpha", report()]);
    h["avatar.report"]!(ctx("clover/character"), ["alpha", report()]);
    h["avatar.report"]!(ctx("clover/character"), ["luna", report()]);
    expect(seen.map((c) => (c as { kind: string }).kind)).toEqual(["catalogue", "box"]);
    expect(events.filter((e) => e.event === AVATAR_CHANGED_EVENT && e.pluginId === "alpha")).toHaveLength(2);
    off();
    h["avatar.report"]!(ctx("clover/character"), ["alpha", report({ box: { canvas: { width: 500, height: 600 } } })]);
    expect(seen).toHaveLength(2);
  });

  test("a bad report is refused, and the catalog gates who may call what", () => {
    const { h } = make();
    expect(() => h["avatar.report"]!(ctx("clover/character"), ["alpha", { nope: 1 }])).toThrow("report");
    expect(() => h["avatar.report"]!(ctx("clover/character"), [3, undefined])).toThrow("bot's id");
    expect(apiCallAllowed("avatar.cue", "ui", ["avatar.control"])).toBe(true);
    expect(apiCallAllowed("avatar.cue", "ui", ["avatar.read"])).toBe(false);
    expect(apiCallAllowed("avatar.cue", "clover", ["avatar.control"])).toBe(true);
    expect(apiCallAllowed("avatar.catalogue", "own", ["avatar.read"])).toBe(true);
    expect(apiCallAllowed("avatar.report", "ui", ["avatar.report"])).toBe(true);
    expect(apiCallAllowed("avatar.report", "own", ["avatar.report"])).toBe(false);
  });
});
