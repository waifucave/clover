import { describe, expect, test } from "bun:test";
import { apiCallAllowed, withImplied, SPEECH_AHEAD_MAX_MS, SPEECH_CUES_PER_SECOND, SPEECH_FRAMES_MAX, SPEECH_FRAMES_PER_SECOND } from "@waifucave/clover-plugin-sdk";
import { AvatarService, AVATAR_CHANGED_EVENT, AVATAR_CUE_EVENT, AVATAR_CUES_PER_SECOND } from "../api/avatar";

const report = (over: object = {}) => ({ format: "live2d", renderer: "clover/live2d", capabilities: ["expressions", "outfits", "lipsync"], names: { expressions: ["happy", "sad"], motions: [], outfits: [{ name: "hat", on: false }] }, box: { canvas: { width: 400, height: 600 } }, ...over });
const make = (now: () => number = Date.now) => {
  const events: { type: string; [k: string]: unknown }[] = [];
  const svc = new AvatarService((e) => events.push(e), now);
  return { svc, events, h: svc.handlers() };
};
/** A call's context: `granted` is what the plugin's OK covers (the router has already held `avatar.cue` to `avatar.control`). */
const ctx = (pluginId: string, granted: string[] = ["avatar.control"]) => ({ pluginId, process: "ui", caller: { kind: "plugin", pluginId }, record: { granted }, path: "avatar.cue" }) as never;

describe("avatar cues in the core", () => {
  test("a cue with nothing drawn is answered plainly, and sends nothing", () => {
    const { h, events } = make();
    expect(h["avatar.cue"]!(ctx("alpha"), [{ type: "expression", name: "happy" }])).toMatchObject({ ok: false, reason: "no-renderer" });
    expect(events).toEqual([]);
  });

  test("the stage's report is read, the catalogue and the box answer for the plugin's own bot only", () => {
    const { h } = make();
    h["avatar.report"]!(ctx("clover/character"), ["alpha", report()]);
    expect(h["avatar.catalogue"]!(ctx("alpha"), [])).toMatchObject({ format: "live2d", expressions: ["happy", "sad"], outfits: [{ name: "hat", on: false }], capabilities: ["lipsync", "expressions", "outfits"] });
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

describe("who may move which bot's figure", () => {
  const speech = (t0: number, n = 3) => ({ type: "speech", frames: Array.from({ length: n }, (_, i) => ({ t: t0 + i * 20, rms: 0.5 })) });

  test("a plugin cues its own bot; another bot is refused, saying why, unless the plugin holds avatar.control.all", () => {
    const { h, events } = make();
    h["avatar.report"]!(ctx("clover/character"), ["alpha", report()]);
    h["avatar.report"]!(ctx("clover/character"), ["luna", report()]);
    events.length = 0;
    // Its own bot, or a child of the plugin: with avatar.control alone. Naming its own bot is the default spelled out.
    expect(h["avatar.cue"]!(ctx("luna"), [{ type: "expression", name: "happy" }])).toEqual({ ok: true });
    expect(h["avatar.cue"]!(ctx("luna/tab"), [{ type: "expression", name: "happy" }, { bot: "luna" }])).toEqual({ ok: true });
    // Another bot: refused with the capability that would allow it; nothing reached the stage, for a cue or for speech.
    expect(() => h["avatar.cue"]!(ctx("luna"), [{ type: "expression", name: "happy" }, { bot: "alpha" }])).toThrow("avatar.control.all");
    expect(() => h["avatar.cue"]!(ctx("luna"), [speech(Date.now()), { bot: "alpha" }])).toThrow("only its own bot");
    expect(events.map((e) => (e.value as { bot: string }).bot)).toEqual(["luna", "luna"]);
    // With avatar.control.all: any bot, every kind of cue, to the stage that reported that bot.
    const all = ["avatar.control", "avatar.control.all"];
    expect(h["avatar.cue"]!(ctx("voice", all), [{ type: "expression", name: "happy" }, { bot: "alpha" }])).toEqual({ ok: true });
    expect(h["avatar.cue"]!(ctx("voice", all), [speech(Date.now()), { bot: "alpha" }])).toEqual({ ok: true });
    expect(events.at(-1)).toMatchObject({ pluginId: "clover/character", event: AVATAR_CUE_EVENT, value: { bot: "alpha", cue: { type: "speech" } } });
    // A bot nothing draws is answered, not refused.
    expect(h["avatar.cue"]!(ctx("voice", all), [speech(Date.now()), { bot: "nobody" }])).toMatchObject({ ok: false, reason: "no-renderer" });
    // A bad second argument.
    expect(() => h["avatar.cue"]!(ctx("voice", all), [speech(Date.now()), { bot: 7 }])).toThrow("bot's id");
    expect(() => h["avatar.cue"]!(ctx("voice", all), [speech(Date.now()), "alpha"])).toThrow("{ bot? }");
  });

  test("avatar.control.all carries avatar.control with it, and is gated by the catalog like it", () => {
    expect(apiCallAllowed("avatar.cue", "ui", withImplied(["avatar.control.all"]))).toBe(true);
    expect(apiCallAllowed("avatar.cue", "ui", ["avatar.control.all"])).toBe(false); // the router reads grants through withImplied
    expect(apiCallAllowed("avatar.cue", "ui", withImplied(["avatar.read"]))).toBe(false);
    expect(withImplied(["avatar.control.all", "avatar.control"])).toEqual(["avatar.control.all", "avatar.control"]);
    expect(withImplied(["files"])).toEqual(["files"]);
  });
});

describe("speech: the mouth's levels", () => {
  const now = 1_800_000_000_000;
  const levels = (n: number, from = now + 100, step = 20) => Array.from({ length: n }, (_, i) => ({ t: from + i * step, rms: 0.3 }));

  test("a batch stamped ahead of the clock goes whole to the stage, rounded and clamped; the renderer must declare lipsync", () => {
    const { h, events } = make(() => now);
    h["avatar.report"]!(ctx("clover/character"), ["alpha", report()]);
    events.length = 0;
    expect(h["avatar.cue"]!(ctx("alpha"), [{ type: "speech", frames: [{ t: now + 500.4, rms: 7, centroid: -5 }, { t: now + 520, rms: -1 }] }])).toEqual({ ok: true });
    expect(events).toEqual([{ type: "plugin_ui_message", pluginId: "clover/character", event: AVATAR_CUE_EVENT, value: { bot: "alpha", cue: { type: "speech", frames: [{ t: now + 500, rms: 1, centroid: 0 }, { t: now + 520, rms: 0 }] }, from: "alpha" } }]);
    // A renderer without lipsync is told so, plainly; a bot nothing draws likewise.
    h["avatar.report"]!(ctx("clover/character"), ["luna", report({ capabilities: ["expressions"] })]);
    expect(h["avatar.cue"]!(ctx("luna"), [{ type: "speech", frames: levels(2) }])).toMatchObject({ ok: false, reason: "unsupported", message: expect.stringContaining("lip-sync") });
    expect(h["avatar.cue"]!(ctx("ghost"), [{ type: "speech", frames: levels(2) }])).toMatchObject({ ok: false, reason: "no-renderer" });
    expect(events.filter((e) => e.event === AVATAR_CUE_EVENT)).toHaveLength(1);
  });

  test("a batch is bounded: at most SPEECH_FRAMES_MAX levels, strictly rising stamps, finite numbers, none further ahead than SPEECH_AHEAD_MAX_MS", () => {
    const { h, events } = make(() => now);
    h["avatar.report"]!(ctx("clover/character"), ["alpha", report()]);
    events.length = 0;
    const cue = (frames: unknown, extra: object = {}) => h["avatar.cue"]!(ctx("alpha"), [{ type: "speech", frames, ...extra }]);
    expect(cue(levels(SPEECH_FRAMES_MAX))).toEqual({ ok: true });
    expect(cue(levels(SPEECH_FRAMES_MAX + 1))).toMatchObject({ ok: false, reason: "invalid", message: expect.stringContaining(String(SPEECH_FRAMES_MAX)) });
    expect(cue([{ t: now + 100, rms: 0.5 }, { t: now + 100, rms: 0.5 }])).toMatchObject({ ok: false, reason: "invalid", message: expect.stringContaining("strictly rising") });
    expect(cue([{ t: now + 100, rms: 0.5 }, { t: now + 90, rms: 0.5 }])).toMatchObject({ ok: false, reason: "invalid" });
    expect(cue([{ t: now + 100, rms: Number.NaN }])).toMatchObject({ ok: false, reason: "invalid" });
    expect(cue([{ t: "now", rms: 0.5 }])).toMatchObject({ ok: false, reason: "invalid" });
    expect(cue([{ t: now + 100, rms: 0.5, centroid: "bright" }])).toMatchObject({ ok: false, reason: "invalid" });
    expect(cue([])).toMatchObject({ ok: false, reason: "invalid", message: expect.stringContaining("cut") });
    expect(cue("nope")).toMatchObject({ ok: false, reason: "invalid" });
    expect(cue(levels(1, now + SPEECH_AHEAD_MAX_MS + 1))).toMatchObject({ ok: false, reason: "invalid", message: expect.stringContaining("ahead") });
    expect(cue(levels(1, now + SPEECH_AHEAD_MAX_MS))).toEqual({ ok: true });
    expect(cue([], { cut: true })).toEqual({ ok: true });
    expect(cue(levels(1), { cut: "yes" })).toMatchObject({ ok: false, reason: "invalid" });
    expect(events.map((e) => ((e.value as { cue: { frames: unknown[]; cut?: true } }).cue))).toEqual([
      expect.objectContaining({ frames: expect.any(Array) }), expect.objectContaining({ frames: expect.any(Array) }), { type: "speech", frames: [], cut: true },
    ]);
    expect((events[0]!.value as { cue: { frames: unknown[] } }).cue.frames).toHaveLength(SPEECH_FRAMES_MAX);
  });

  test("speech has a window of its own: SPEECH_CUES_PER_SECOND cues and SPEECH_FRAMES_PER_SECOND levels a second, and it never uses the expressions' 20", () => {
    let t = now;
    const { h } = make(() => t);
    h["avatar.report"]!(ctx("clover/character"), ["alpha", report()]);
    for (let i = 0; i < SPEECH_CUES_PER_SECOND; i++) expect(h["avatar.cue"]!(ctx("alpha"), [{ type: "speech", frames: levels(3) }])).toEqual({ ok: true });
    expect(() => h["avatar.cue"]!(ctx("alpha"), [{ type: "speech", frames: levels(3) }])).toThrow("speech cues");
    // The mouth being full leaves the figure's other cues untouched.
    expect(h["avatar.cue"]!(ctx("alpha"), [{ type: "expression", name: "happy" }])).toEqual({ ok: true });
    // A new second, a new window; the levels' own cap holds even with few cues.
    t += 1_000;
    for (let i = 0; i < Math.floor(SPEECH_FRAMES_PER_SECOND / SPEECH_FRAMES_MAX); i++) expect(h["avatar.cue"]!(ctx("alpha"), [{ type: "speech", frames: levels(SPEECH_FRAMES_MAX) }])).toEqual({ ok: true });
    expect(() => h["avatar.cue"]!(ctx("alpha"), [{ type: "speech", frames: levels(SPEECH_FRAMES_MAX) }])).toThrow("mouth levels");
    t += 1_000;
    expect(h["avatar.cue"]!(ctx("alpha"), [{ type: "speech", frames: levels(3) }])).toEqual({ ok: true });
    // Another plugin's window is its own.
    expect(h["avatar.cue"]!(ctx("alpha/tab"), [{ type: "speech", frames: levels(3) }])).toEqual({ ok: true });
  });
});

describe("more than one stage (the stage is a plugin like any other)", () => {
  const ours = "clover/character";
  const theirs = "mystage";

  test("any plugin id may report: the door asks the grant, never the id", () => {
    const { h, events } = make();
    expect(h["avatar.report"]!(ctx(theirs, ["avatar.report"]), ["alpha", report()])).toBeUndefined();
    expect(h["avatar.catalogue"]!(ctx("alpha"), [])).toMatchObject({ format: "live2d" });
    expect(h["avatar.cue"]!(ctx("alpha"), [{ type: "expression", name: "happy" }])).toEqual({ ok: true });
    expect(events.at(-1)).toMatchObject({ pluginId: theirs, event: AVATAR_CUE_EVENT });
  });

  test("two stages do not overwrite each other: cues follow the stage that spoke last, and fall back when it leaves", () => {
    const { svc, h, events } = make();
    h["avatar.report"]!(ctx(ours), ["alpha", report()]);
    h["avatar.report"]!(ctx(theirs), ["alpha", report({ format: "vrm", renderer: "x/vrm", capabilities: ["expressions"] })]);
    expect(h["avatar.catalogue"]!(ctx("alpha"), [])).toMatchObject({ format: "vrm" });
    h["avatar.cue"]!(ctx("alpha"), [{ type: "expression", name: "happy" }]);
    expect(events.at(-1)).toMatchObject({ pluginId: theirs });
    // The stage that drew it stops: the other's report is what is left to answer.
    svc.endStage(theirs);
    expect(h["avatar.catalogue"]!(ctx("alpha"), [])).toMatchObject({ format: "live2d" });
    h["avatar.cue"]!(ctx("alpha"), [{ type: "expression", name: "happy" }]);
    expect(events.at(-1)).toMatchObject({ pluginId: ours });
  });

  test("a stopped stage's report is gone: nothing answers for the bot, the plugin's watch hears it, and its return reports again", () => {
    const { svc, h } = make();
    const seen: string[] = [];
    h["avatar.watch"]!(ctx("alpha"), [(c: { kind: string }) => seen.push(c.kind)]);
    h["avatar.report"]!(ctx(theirs), ["alpha", report()]);
    seen.length = 0;
    svc.endStage(theirs);
    expect(h["avatar.catalogue"]!(ctx("alpha"), [])).toBeUndefined();
    expect(h["avatar.cue"]!(ctx("alpha"), [{ type: "expression", name: "happy" }])).toMatchObject({ ok: false, reason: "no-renderer" });
    expect(seen).toEqual(["catalogue", "box"]);
    h["avatar.report"]!(ctx(ours), ["alpha", report()]);
    expect(h["avatar.catalogue"]!(ctx("alpha"), [])).toBeDefined();
    // Ending a stage that holds nothing changes nothing.
    seen.length = 0;
    svc.endStage("nobody");
    expect(seen).toEqual([]);
  });
});
