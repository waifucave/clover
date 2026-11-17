// The avatar plugin's figure, through its own points alone: the pick (its own setting, one figure at a time), the
// renderer of the figure's format (its UI spot, keyed), the renderer's report and the cues (point messages), the
// controllers' cues judged and answered, and the activity feed moving it.
import { type TestEntry as UiEntry, catalogSpot, fakeApi, fakeApprovals, fakeCore, runtimeWith, settle, TestLayer } from "@waifucave/moss-plugin-sdk/ui/testing";
import type { HostMessageCall, PointEntry } from "@waifucave/moss-plugin-sdk";
import * as React from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import type { EntryComponent } from "../client/local";
import { FigurePanel, FigureSettings } from "../client";
import { chosen, choicesOf, formatsOf, ownModelsOf } from "../client/choice";
import { cuesFor, followed } from "../client/mood";
import { figureTakesCall, TOOL_EVENT } from "../client/figure";
import { TOOL_EVENT as SERVER_TOOL_EVENT } from "../server/index";

afterEach(cleanup);

const pack = (pluginId: string, entryId: string, file: string, format: string, name = entryId): PointEntry => ({ pluginId, entryId, value: { id: entryId, name, file, format } });
const format = (pluginId: string, f: string, capabilities: string[]): PointEntry => ({ pluginId, entryId: f, value: { id: f, format: f, name: f, capabilities } });
const RENDERER = "moss.character.renderer";
const FIGURE = "moss.character.figure";

const spotOf = (name: string) => (name === RENDERER ? { name, shape: "keyed" as const, props: {}, declaredBy: "moss/character" } : catalogSpot(name));

async function mount(o: { packs: PointEntry[]; formats: PointEntry[]; settings?: Record<string, unknown>; activity?: unknown[]; component?: React.ReactElement }) {
  const watchers: ((a: unknown) => void)[] = [];
  // Its host half's messages (`host.on`) and what the figure answers it (`host.call`).
  const hostListeners: ((data: unknown, call?: HostMessageCall) => void)[] = [];
  const hostCalls: { name: string; args: unknown }[] = [];
  const api = fakeApi({
    host: { call: async (name: string, args: unknown) => { hostCalls.push({ name, args }); return true; }, on: (_e: string, l: (data: unknown, call?: HostMessageCall) => void) => { hostListeners.push(l); return () => undefined; } },
    pluginId: "moss/character",
    points: { "moss.character.packs": o.packs, "moss.character.formats": o.formats },
    settings: o.settings ?? {},
    activity: { list: async () => o.activity ?? [], watch: (_k: string, l: (a: unknown) => void) => { watchers.push(l); return () => undefined; } },
  } as never);
  const Draw: EntryComponent = ({ props }) => <div data-draw={JSON.stringify(props)} />;
  const entries = [...new Set(o.formats.map((f) => f.pluginId))].map((p) => ({ pluginId: p, id: p.split("/").pop()!, spot: RENDERER, key: (o.formats.find((f) => f.pluginId === p)!.value as { format: string }).format, component: "Draw" }) as UiEntry);
  const runtime = runtimeWith({ api: () => api, core: () => fakeCore({}), approvals: fakeApprovals(), spot: spotOf as never, entries, component: (_p, name) => (name === "Draw" ? Draw : undefined) });
  const view = render(<TestLayer runtime={runtime}>{o.component ?? React.createElement(FigurePanel as never, { props: { app: "code", session: "s1" } } as never)}</TestLayer>);
  await act(() => settle(8));
  const drawn = () => { const el = document.querySelector("[data-draw]"); return el === null ? undefined : JSON.parse(el.getAttribute("data-draw")!) as Record<string, unknown>; };
  return { api, view, drawn, hostCalls, tool: (data: unknown, call?: HostMessageCall) => { for (const l of hostListeners) l(data, call); }, activity: (a: unknown) => { for (const w of watchers) w(a); } };
}

describe("which figure shows (the plugin's own one-at-a-time rule)", () => {
  const packs = [pack("acme-figures", "fox", "/_t/acme-figures/fox/fox.vrm", "vrm"), pack("moss/alpha-figure", "alpha", "/_t/moss%2Falpha-figure/live2d/alpha.model3.json", "live2d")];
  const formats = formatsOf([format("moss/vrm", "vrm", ["expressions"]), format("moss/live2d", "live2d", ["expressions", "pace"])]);
  test("the person's pick, else the first a renderer draws; a pick whose format nothing draws gives way", () => {
    const choices = choicesOf(packs, []);
    expect(chosen("", choices, formats)?.id).toBe("pack:acme-figures#fox");
    expect(chosen("pack:moss/alpha-figure#alpha", choices, formats)?.id).toBe("pack:moss/alpha-figure#alpha");
    expect(chosen("pack:moss/alpha-figure#alpha", choices, formats.filter((f) => f.format !== "live2d"))?.id).toBe("pack:acme-figures#fox");
    expect(chosen("pack:gone#x", choices, formats)?.id).toBe("pack:acme-figures#fox");
    // An earlier MOSS's pick, kept as the pack's file: matched to the pack entry with that file.
    expect(chosen("url:/_t/moss%2Falpha-figure/live2d/alpha.model3.json", choices, formats)?.id).toBe("pack:moss/alpha-figure#alpha");
  });

  test("the person's own models (moved from an earlier MOSS) are served from the plugin's own data folder; a list that isn't one reads as none", () => {
    const own = ownModelsOf(JSON.stringify([{ name: "Hero", format: "live2d", file: "own/alpha/k3x9q2/hero.model3.json", credit: "by someone" }, { format: "vrm", file: "../out.vrm" }, { file: "x" }]));
    expect(own).toEqual([{ name: "Hero", format: "live2d", file: "own/alpha/k3x9q2/hero.model3.json", credit: "by someone" }]);
    const c = chosen("own:live2d:own/alpha/k3x9q2/hero.model3.json", choicesOf(packs, own), formats);
    expect(c).toMatchObject({ src: "/_d/moss%2Fcharacter/own/alpha/k3x9q2/hero.model3.json", format: "live2d", from: "own", license: "by someone" });
    expect(ownModelsOf("not json")).toEqual([]);
    expect(ownModelsOf(undefined)).toEqual([]);
  });
});

describe("the figure in its panel", () => {
  test("asks its renderer spot, keyed by the figure's format, for the figure's file, with a mount of its own", async () => {
    const m = await mount({ packs: [pack("moss/alpha-figure", "alpha", "/_t/a/alpha.model3.json", "live2d", "Alpha")], formats: [format("moss/live2d", "live2d", ["expressions"])] });
    expect(m.drawn()).toMatchObject({ src: "/_t/a/alpha.model3.json", file: "/_t/a/alpha.model3.json", format: "live2d", name: "Alpha" });
    expect(typeof m.drawn()!.mount).toBe("string");
  });

  test("no pack, or no renderer for its format: it says so, and draws nothing", async () => {
    await mount({ packs: [], formats: [format("moss/vrm", "vrm", [])] });
    expect(document.querySelector(".cl-figure__empty")).not.toBeNull();
    cleanup();
    await mount({ packs: [pack("x", "a", "/_t/x/a.skel", "spine")], formats: [format("moss/vrm", "vrm", [])] });
    expect(document.querySelector("[data-draw]")).toBeNull();
    expect(document.querySelector(".cl-figure__empty")).not.toBeNull();
  });

  test("until its renderer has said what its model has, the figure asks it again each second; once it has, no more", async () => {
    const m = await mount({ packs: [pack("p", "a", "/_t/p/a.vrm", "vrm")], formats: [format("moss/vrm", "vrm", ["expressions"])] });
    const mountId = m.drawn()!.mount as string;
    const asks = () => m.api.sent.filter((s) => s.point === RENDERER && (s.value as { ask?: unknown }).ask === "report");
    await act(() => Bun.sleep(1_150));
    expect(asks()).toEqual([{ point: RENDERER, to: "moss/vrm", value: { mount: mountId, ask: "report" } }]);
    await act(async () => { m.api.deliver(RENDERER, "moss/vrm", { mount: mountId, names: { expressions: ["happy"], motions: [], outfits: [] } }); await settle(4); });
    await act(() => Bun.sleep(1_150));
    expect(asks()).toHaveLength(1);
  });

  test("its own tools: a coding call reaches the panel only for the session beside it, a bot's only while it follows bots (off here); judged as a controller's cue, and answered to the host half", async () => {
    const m = await mount({ packs: [pack("p", "a", "/_t/p/a.vrm", "vrm")], formats: [format("moss/vrm", "vrm", ["expressions"])], settings: { followBots: false } });
    const mountId = m.drawn()!.mount as string;
    await act(async () => { m.api.deliver(RENDERER, "moss/vrm", { mount: mountId, names: { expressions: ["happy"], motions: [], outfits: [] } }); await settle(4); });
    await act(async () => {
      m.tool({ id: "1", cue: { type: "expression", name: "happy" } }, { session: "s1", kind: "coding" });
      m.tool({ id: "2", cue: { type: "expression", name: "angry" } }, { session: "s1", kind: "coding" });
      m.tool({ id: "3", cue: { type: "expression", name: "happy" } }, { session: "s2", kind: "coding" });
      m.tool({ id: "4", cue: { type: "expression", name: "happy" } }, { session: "b1", kind: "bot", bot: "alpha" });
      m.tool({ id: "5", cue: { type: "expression", name: "happy" } });
      m.tool({ id: "6", status: true }, { session: "s1", kind: "coding" });
      await settle(4);
    });
    const answers = m.hostCalls.filter((c) => c.name === "answered").map((c) => c.args as { id: string; result: { ok: boolean; reason?: string; message?: string; catalogue?: { expressions: string[] } } });
    expect(answers.map((a) => [a.id, a.result.ok, a.result.reason])).toEqual([["1", true, undefined], ["2", false, "unknown-name"], ["6", true, undefined]]);
    expect(answers[1]!.result.message).toBe('this model has no expression "angry"; it has: happy');
    expect(answers[2]!.result.catalogue!.expressions).toEqual(["happy"]);
    expect(m.api.sent.filter((x) => x.point === RENDERER && JSON.stringify(x.value).includes("cue"))).toEqual([{ point: RENDERER, to: "moss/vrm", value: { mount: mountId, cue: { type: "expression", name: "happy" } } }]);
  });

  test("on the screen a tool call from any coding session is taken; a bot's, anywhere, only while it follows bots", () => {
    const screen = { place: "screen" as const, followBotsSetting: false };
    expect(figureTakesCall(screen, { session: "s9", kind: "coding" })).toBe(true);
    expect(figureTakesCall(screen, { session: "s9", kind: "agent" })).toBe(true);
    expect(figureTakesCall(screen, { session: "b1", kind: "bot", bot: "alpha" })).toBe(false);
    expect(figureTakesCall({ place: "panel", session: "s1", followBotsSetting: true }, { session: "b1", kind: "bot", bot: "alpha" })).toBe(true);
    expect(figureTakesCall({ place: "panel", session: "s1", followBotsSetting: false }, { session: "s2", kind: "coding" })).toBe(false);
    expect(figureTakesCall({ ...screen, followBotsSetting: true }, { session: "b1", kind: "bot", bot: "alpha" })).toBe(true);
    expect(figureTakesCall({ ...screen, followBotsSetting: true }, undefined)).toBe(false);
    expect(TOOL_EVENT).toBe(SERVER_TOOL_EVENT);
  });

  test("a controller's cue is judged against the renderer's word and answered; one it can play goes to that renderer for that mount only", async () => {
    const m = await mount({ packs: [pack("p", "a", "/_t/p/a.vrm", "vrm")], formats: [format("moss/vrm", "vrm", ["expressions"])] });
    const mountId = m.drawn()!.mount as string;
    // The renderer says what its model has.
    await act(async () => { m.api.deliver(RENDERER, "moss/vrm", { mount: mountId, names: { expressions: ["happy"], motions: [], outfits: [] } }); await settle(4); });
    // Its word for another mount, or from a plugin that isn't its renderer, is nothing.
    await act(async () => { m.api.deliver(RENDERER, "moss/vrm", { mount: "elsewhere", names: { expressions: ["sad"], motions: [], outfits: [] } }); m.api.deliver(RENDERER, "stranger", { mount: mountId, names: { expressions: ["sad"], motions: [], outfits: [] } }); await settle(4); });
    const catalogue = m.api.sent.filter((s) => s.point === FIGURE && (s.value as { catalogue?: unknown }).catalogue !== undefined).at(-1)?.value as { catalogue: { expressions: string[] } };
    expect(catalogue.catalogue.expressions).toEqual(["happy"]);
    await act(async () => {
      m.api.deliver(FIGURE, "acme-moves", { id: "1", cue: { type: "expression", name: "happy" } });
      m.api.deliver(FIGURE, "acme-moves", { id: "2", cue: { type: "expression", name: "angry" } });
      m.api.deliver(FIGURE, "acme-moves", { id: "3", cue: { type: "motion", name: "wave" } });
      m.api.deliver(FIGURE, "acme-moves", { id: "4", cue: { type: "dance" } });
      await settle(4);
    });
    const answers = m.api.sent.filter((s) => s.point === FIGURE && s.to === "acme-moves").map((s) => s.value as { id: string; result: { ok: boolean; reason?: string } });
    expect(answers.map((a) => [a.id, a.result.ok, a.result.reason])).toEqual([["1", true, undefined], ["2", false, "unknown-name"], ["3", false, "unsupported"], ["4", false, "invalid"]]);
    const toRenderer = m.api.sent.filter((s) => s.point === RENDERER);
    expect(toRenderer).toContainEqual({ point: RENDERER, to: "moss/vrm", value: { mount: mountId, cue: { type: "expression", name: "happy" } } });
    expect(toRenderer.some((s) => JSON.stringify(s.value).includes("angry"))).toBe(false);
  });

  test("the session's activity moves it: a state plays the expression its model has, and the pace", async () => {
    const m = await mount({ packs: [pack("p", "a", "/_t/p/a.model3.json", "live2d")], formats: [format("moss/live2d", "live2d", ["expressions", "pace"])], activity: [{ subject: { kind: "sessions", id: "s1" }, state: "idle", since: 1 }] });
    const mountId = m.drawn()!.mount as string;
    await act(async () => { m.api.deliver(RENDERER, "moss/live2d", { mount: mountId, names: { expressions: ["Happy", "Thinking"], motions: [], outfits: [] } }); await settle(4); });
    await act(async () => { m.activity({ subject: { kind: "sessions", id: "s2" }, state: "done", since: 5 }); m.activity({ subject: { kind: "sessions", id: "s1" }, state: "thinking", since: 6 }); await settle(4); });
    const cues = m.api.sent.filter((s) => s.point === RENDERER).map((s) => (s.value as { cue: unknown }).cue);
    expect(cues).toContainEqual({ type: "expression", name: "Thinking" });
    expect(cues).toContainEqual({ type: "pace", calm: false });
    // The panel follows its own session only: the other session's `done` played nothing of its own.
    expect(cues).not.toContainEqual({ type: "expression", name: "Happy" });
  });
});

describe("what a state asks of the figure", () => {
  test("the expression the model has by a usual name (any case), and the pace only where the renderer does it", () => {
    expect(cuesFor("done", { expressions: ["Smile", "Joy"], motions: [], outfits: [] }, true)).toEqual([{ type: "expression", name: "Joy" }, { type: "pace", calm: true }]);
    expect(cuesFor("working", { expressions: [], motions: [], outfits: [] }, false)).toEqual([]);
    expect(cuesFor("stuck", undefined, true)).toEqual([{ type: "pace", calm: false }]);
  });
  test("beside a session it follows that one; on the screen, the most recent change", () => {
    const all = [{ subject: { kind: "sessions" as const, id: "a" }, state: "idle" as const, since: 1 }, { subject: { kind: "bots" as const, id: "alpha" }, state: "working" as const, since: 9 }];
    expect(followed(all, "a")?.state).toBe("idle");
    expect(followed(all, undefined)?.state).toBe("working");
    expect(followed(all, "zzz")).toBeUndefined();
  });
});

describe("its Settings section", () => {
  test("lists the figures, a press picks one (the plugin's own setting), and turns the screen on", async () => {
    const m = await mount({
      packs: [pack("moss/alpha-figure", "alpha", "/_t/a.model3.json", "live2d", "Alpha"), pack("acme", "fox", "/_t/fox.vrm", "vrm", "Fox")],
      formats: [format("moss/live2d", "live2d", [])],
      component: React.createElement(FigureSettings as never, { props: {} } as never),
    });
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-figure]")];
    expect(buttons.map((b) => [b.dataset.figure, b.getAttribute("aria-checked"), b.disabled])).toEqual([["pack:moss/alpha-figure#alpha", "true", false], ["pack:acme#fox", "false", true]]);
    await act(async () => { buttons[0]!.click(); await settle(2); });
    expect(m.api.stored.get("figure")).toBe("pack:moss/alpha-figure#alpha");
    const box = document.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    await act(async () => { box.click(); await settle(2); });
    expect(m.api.stored.get("onScreen")).toBe(true);
  });
});
