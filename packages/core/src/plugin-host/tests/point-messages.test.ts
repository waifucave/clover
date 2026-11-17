// Point messages, a general piece of the plugin API, proven with plugins that have nothing to do with a figure: a
// metronome declares `metronome.beats` (a data point) and `metronome.dial` (a UI spot); a dancer fills the first, a
// dial skin the second, and a stranger fills neither. Each message goes only between the declarer and its fillers, in
// order, capped; a plugin that stops loses its listeners.
import { describe, expect, test } from "bun:test";
import { POINT_MESSAGES_PER_SECOND, POINT_MESSAGE_MAX_BYTES, type PointMessage } from "@waifucave/moss-plugin-sdk";
import type { Contribution, PluginRecord, RegisteredPoint } from "../../contracts/plugin-registry";
import { PointMessages, fillersOf } from "../api/point-messages";
import type { ApiCallContext } from "../api/router";

function world() {
  const state: Record<string, { enabled: boolean; state: string }> = {
    metronome: { enabled: true, state: "running" },
    dancer: { enabled: true, state: "running" },
    skin: { enabled: true, state: "running" },
    stranger: { enabled: true, state: "running" },
  };
  const entries: Contribution[] = [
    { point: "metronome.beats", pluginId: "dancer", ref: "metronome.beats/0", entryId: "feet", value: { id: "feet" }, state: "active" },
    { point: "metronome.quiet", pluginId: "dancer", ref: "metronome.quiet/0", entryId: "hush", value: { id: "hush" }, state: "active" },
    { point: "ui", pluginId: "skin", ref: "ui/0", entryId: "brass", value: { spot: "metronome.dial", id: "brass", component: "Brass" }, state: "active" },
    { point: "ui", pluginId: "stranger", ref: "ui/0", entryId: "other", value: { spot: "elsewhere.thing", id: "other", component: "X" }, state: "active" },
  ];
  const points: RegisteredPoint[] = [
    { name: "metronome.beats", shape: "list", declaredBy: { pluginId: "metronome", ref: "host" }, spot: false, active: true, decl: { shape: "list", fills: { ok: "it hears the beats" } } } as RegisteredPoint,
    { name: "metronome.dial", shape: "keyed", declaredBy: { pluginId: "metronome", ref: "ui/0" }, spot: true, active: true, decl: { shape: "keyed", fills: { ok: "it draws the dial" } } } as RegisteredPoint,
    // Declared with no `fills.ok` line: its fillers' OK cards say nothing of messages, so none go on it.
    { name: "metronome.quiet", shape: "list", declaredBy: { pluginId: "metronome", ref: "host" }, spot: false, active: true, decl: { shape: "list" } } as RegisteredPoint,
    { name: "hooks", shape: "list", declaredBy: "core", spot: false, active: true },
  ];
  let t = 1_000_000;
  const registry = {
    entries: (p: string) => entries.filter((c) => c.point === p),
    points: () => points,
    get: (id: string) => (state[id] === undefined ? undefined : ({ id, ...state[id] } as unknown as PluginRecord)),
  };
  const pm = new PointMessages({ registry, now: () => t });
  const ctx = (pluginId: string): ApiCallContext => ({ pluginId, process: "ui", caller: { kind: "plugin", pluginId }, record: registry.get(pluginId)!, path: "points.send" });
  return { pm, state, entries, registry, tick: (ms: number) => { t += ms; }, ctx, handlers: pm.handlers() };
}

describe("point messages (general: a metronome and its fillers)", () => {
  test("a point declared with no `fills.ok` line carries no message, either way, and says why; listening on it is refused too", () => {
    const w = world();
    expect(() => w.handlers["points.send"]!(w.ctx("metronome"), ["metronome.quiet", 1])).toThrow(/declares metronome.quiet with no `fills.ok` line/);
    expect(() => w.handlers["points.send"]!(w.ctx("dancer"), ["metronome.quiet", 1])).toThrow(/no `fills.ok` line/);
    expect(() => w.handlers["points.onMessage"]!(w.ctx("dancer"), ["metronome.quiet", () => undefined])).toThrow(/no `fills.ok` line/);
    // With the line (the beats): both ways go.
    expect(() => w.handlers["points.send"]!(w.ctx("metronome"), ["metronome.beats", 1])).not.toThrow();
    expect(() => w.handlers["points.send"]!(w.ctx("dancer"), ["metronome.beats", 1])).not.toThrow();
  });

  test("the declarer reaches every filler; a filler reaches the declarer; nobody else hears or sends", () => {
    const w = world();
    const heard: Record<string, PointMessage[]> = { metronome: [], dancer: [], stranger: [] };
    w.pm.listen("dancer", "metronome.beats", (m) => heard.dancer!.push(m));
    w.pm.listen("metronome", "metronome.beats", (m) => heard.metronome!.push(m));
    w.pm.listen("stranger", "metronome.beats", (m) => heard.stranger!.push(m));
    w.handlers["points.send"]!(w.ctx("metronome"), ["metronome.beats", { bpm: 120 }]);
    w.handlers["points.send"]!(w.ctx("dancer"), ["metronome.beats", { step: "left" }]);
    expect(heard.dancer).toEqual([{ from: "metronome", value: { bpm: 120 } }]);
    expect(heard.metronome).toEqual([{ from: "dancer", value: { step: "left" } }]);
    expect(heard.stranger).toEqual([]);
    expect(() => w.handlers["points.send"]!(w.ctx("stranger"), ["metronome.beats", 1])).toThrow(/neither declares nor fills/);
    // A filler can't aim at another filler; the declarer can aim at one filler only.
    expect(() => w.handlers["points.send"]!(w.ctx("dancer"), ["metronome.beats", 1, { to: "stranger" }])).toThrow(/sends only to its declarer/);
    expect(() => w.handlers["points.send"]!(w.ctx("metronome"), ["metronome.beats", 1, { to: "stranger" }])).toThrow(/no active entry/);
  });

  test("a UI spot's fillers are its `ui` entries", () => {
    const w = world();
    expect(fillersOf(w.registry, "metronome.dial", true)).toEqual(["skin"]);
    const got: unknown[] = [];
    w.pm.listen("skin", "metronome.dial", (m) => got.push(m.value));
    w.handlers["points.send"]!(w.ctx("metronome"), ["metronome.dial", { tick: 1 }, { to: "skin" }]);
    expect(got).toEqual([{ tick: 1 }]);
  });

  test("every message goes on, in order, never coalesced", () => {
    const w = world();
    const got: number[] = [];
    w.pm.listen("dancer", "metronome.beats", (m) => got.push(m.value as number));
    for (let i = 0; i < 40; i++) w.pm.send("metronome", "metronome.beats", i);
    expect(got).toEqual([...Array(40).keys()]);
  });

  test("caps: size and rate; a core point and a missing one take nothing", () => {
    const w = world();
    expect(() => w.pm.send("metronome", "metronome.beats", "x".repeat(POINT_MESSAGE_MAX_BYTES))).toThrow(/at most/);
    for (let i = 0; i < POINT_MESSAGES_PER_SECOND; i++) w.pm.send("metronome", "metronome.beats", i);
    expect(() => w.pm.send("metronome", "metronome.beats", "one too many")).toThrow(/this second/);
    w.tick(1000);
    expect(() => w.pm.send("metronome", "metronome.beats", "fine")).not.toThrow();
    expect(() => w.pm.send("metronome", "hooks", 1)).toThrow(/core point/);
    expect(() => w.pm.send("metronome", "nobody.declares", 1)).toThrow(/no plugin declares/);
    expect(() => w.pm.send("metronome", "metronome.beats", { f: () => 1 })).not.toThrow();
  });

  test("a filler that is off is no filler; a stopped plugin loses its listeners", () => {
    const w = world();
    const got: unknown[] = [];
    w.pm.listen("dancer", "metronome.beats", (m) => got.push(m.value));
    w.state.dancer!.state = "stopped";
    expect(w.pm.recipients("metronome", "metronome.beats")).toEqual([]);
    expect(() => w.handlers["points.send"]!(w.ctx("dancer"), ["metronome.beats", 1])).toThrow(/isn't running/);
    w.state.dancer!.state = "running";
    w.pm.endPlugin("dancer");
    w.pm.send("metronome", "metronome.beats", "after");
    expect(got).toEqual([]);
  });
});
