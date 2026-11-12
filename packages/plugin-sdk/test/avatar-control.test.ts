import { describe, expect, test } from "bun:test";
import { AvatarControlHub, BOX_MIN_MS, cleanAvatarDown, cleanAvatarUp, type AvatarState } from "../src/ui/avatar-control";

const box = (w: number, x = 10) => ({ canvas: { width: w, height: 600 }, figure: { x, y: 20, width: 100, height: 200 } });
function make() {
  let t = 1_000;
  const timers: { at: number; fn: () => void }[] = [];
  const sent: AvatarState[] = [];
  const hub = new AvatarControlHub((s) => sent.push(s), {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { at: t + ms, fn }; timers.push(h); return h; },
    clearTimeout: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
  });
  const advance = (ms: number) => { t += ms; for (const h of timers.filter((x) => x.at <= t)) { timers.splice(timers.indexOf(h), 1); h.fn(); } };
  return { hub, sent, advance, timers };
}

describe("the avatar control hub", () => {
  test("a cue reaches each listener until it unsubscribes, and one that throws doesn't stop the rest", () => {
    const { hub } = make();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = hub.onCue((c) => a.push(c));
    hub.onCue(() => { throw new Error("x"); });
    hub.onCue((c) => b.push(c));
    const quiet = console.error;
    console.error = () => undefined;
    hub.cue({ type: "pace", calm: true });
    offA();
    hub.cue({ type: "pace", calm: false });
    console.error = quiet;
    expect(a).toEqual([{ type: "pace", calm: true }]);
    expect(b).toHaveLength(2);
  });

  test("the names go at once, and only when they change", () => {
    const { hub, sent } = make();
    const names = { expressions: ["a"], motions: [], outfits: [] };
    hub.setNames(names);
    hub.setNames({ ...names });
    expect(sent).toHaveLength(1);
    hub.setNames(undefined);
    expect(sent).toHaveLength(2);
  });

  test("the box is throttled, and a change smaller than a few pixels is none; the last one always goes", () => {
    const { hub, sent, advance } = make();
    hub.setBox(box(300));
    expect(sent).toHaveLength(1);
    hub.setBox(box(301, 11));
    expect(sent).toHaveLength(1);
    hub.setBox(box(400));
    expect(sent).toHaveLength(1);
    hub.setBox(box(420));
    advance(BOX_MIN_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.box!.canvas.width).toBe(420);
  });

  test("nothing goes while hidden; the latest goes when it shows again; a closed hub says nothing", () => {
    const { hub, sent, timers } = make();
    hub.setVisible(false);
    hub.setBox(box(300));
    hub.setBox(box(500));
    expect(sent).toHaveLength(0);
    expect(timers).toHaveLength(0);
    hub.setVisible(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.box!.canvas.width).toBe(500);
    hub.close();
    hub.setNames({ expressions: ["x"], motions: [], outfits: [] });
    hub.setBox(box(900));
    expect(sent).toHaveLength(1);
  });

  test("what crosses a frame is read again on each side, plain data only", () => {
    expect(cleanAvatarDown({ kind: "cue", cue: { type: "expression", name: "happy", extra: 1 } })).toEqual({ kind: "cue", cue: { type: "expression", name: "happy" } });
    expect(cleanAvatarDown({ kind: "cue", cue: { type: "nope" } })).toBeUndefined();
    expect(cleanAvatarDown({ kind: "other" })).toBeUndefined();
    expect(cleanAvatarUp({ kind: "state", names: null, box: null })).toEqual({ kind: "state", names: null, box: null });
    expect(cleanAvatarUp({ kind: "state", names: { expressions: ["a"], motions: [], outfits: [{ name: "hat", on: true }] }, box: box(300) })).toMatchObject({ kind: "state" });
    expect(cleanAvatarUp({ kind: "state", names: "x" })).toBeUndefined();
    expect(cleanAvatarUp({ kind: "state", box: { canvas: { width: -1, height: 1 } } })).toBeUndefined();
    expect(cleanAvatarUp(null)).toBeUndefined();
  });
});
