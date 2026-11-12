// The four-finger tap's recognizer on recorded trackpad frames (the old app's TapRecognizer, ported), the add-on's frame
// format, and the add-on's load. Nothing here reads a trackpad: the add-on is only loaded, never started.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FourFingerTap, TapRecognizer, loadTouches, samplesOf, type TouchAddon, type TouchSample } from "../src/main/touch-tap";

/** Four fingers at fixed places, each moved by `drift` per frame along x (0 = resting still). */
const four = (frame: number, drift = 0, ids = [11, 12, 13, 14]): TouchSample[] =>
  ids.map((id, i) => ({ id, x: 0.3 + i * 0.1 + drift * frame, y: 0.5 }));
/** Feeds frames at 100 Hz from t0; true when any fired. */
function feed(r: TapRecognizer, frames: TouchSample[][], t0 = 1000, step = 0.01): boolean[] {
  return frames.map((f, i) => r.ingest(f, t0 + i * step));
}
const fires = (out: boolean[]) => out.filter(Boolean).length;

describe("the four-finger tap recognizer", () => {
  test("four fingers down about 80 ms and lifted, still: one tap, on the lift", () => {
    const out = feed(new TapRecognizer(), [...Array.from({ length: 8 }, (_, i) => four(i)), []]);
    expect(fires(out)).toBe(1);
    expect(out.at(-1)).toBe(true);
    expect(out.slice(0, -1).every((x) => !x)).toBe(true);
  });
  test("two taps in a row are two taps (the state resets on every lift)", () => {
    const r = new TapRecognizer();
    const tap = Array.from({ length: 6 }, (_, i) => four(i));
    expect(fires(feed(r, [...tap, [], ...tap, []]))).toBe(2);
  });
  test("a rest, not a tap: down longer than 180 ms; a blip shorter than 25 ms", () => {
    expect(fires(feed(new TapRecognizer(), [...Array.from({ length: 30 }, (_, i) => four(i)), []]))).toBe(0);
    expect(fires(feed(new TapRecognizer(), [four(0), four(1), []], 1000, 0.01))).toBe(0); // 20 ms
  });
  test("one four-finger frame (a palm brushing the pad in one report) never fires", () => {
    expect(fires(feed(new TapRecognizer(), [four(0), []], 1000, 0.05))).toBe(0);
  });
  test("a Spaces swipe (four fingers travelling) is not a tap, however short", () => {
    expect(fires(feed(new TapRecognizer(), [...Array.from({ length: 8 }, (_, i) => four(i, 0.02)), []]))).toBe(0);
  });
  test("small drift inside the limits still taps; one finger drifting past the limit does not", () => {
    expect(fires(feed(new TapRecognizer(), [...Array.from({ length: 8 }, (_, i) => four(i, 0.001)), []]))).toBe(1);
    const wander = Array.from({ length: 8 }, (_, i) => four(i).map((t, k) => (k === 0 ? { ...t, y: t.y + i * 0.004 } : t)));
    expect(fires(feed(new TapRecognizer(), [...wander, []]))).toBe(0);
  });
  test("three fingers, two fingers, or five fingers are not a tap; a fifth finger joining spoils it", () => {
    const three = four(0).slice(0, 3);
    expect(fires(feed(new TapRecognizer(), [...Array.from({ length: 8 }, () => three), []]))).toBe(0);
    const five = [...four(0), { id: 15, x: 0.8, y: 0.5 }];
    expect(fires(feed(new TapRecognizer(), [...Array.from({ length: 8 }, () => five), []]))).toBe(0);
    expect(fires(feed(new TapRecognizer(), [four(0), four(1), five, four(3), four(4), []]))).toBe(0);
  });
  test("a finger swapped for another during the touch spoils it", () => {
    expect(fires(feed(new TapRecognizer(), [four(0), four(1), four(2, 0, [11, 12, 13, 99]), four(3), four(4), []]))).toBe(0);
  });
  test("fingers landing a frame apart (three, then the fourth) arm when the fourth is down, as the old app's did", () => {
    expect(fires(feed(new TapRecognizer(), [four(0).slice(0, 3), ...Array.from({ length: 6 }, (_, i) => four(i)), []]))).toBe(1);
  });
  test("a spoiled touch does not latch: the next clean tap fires", () => {
    const r = new TapRecognizer();
    const out = feed(r, [...Array.from({ length: 8 }, (_, i) => four(i, 0.02)), [], ...Array.from({ length: 6 }, (_, i) => four(i)), []]);
    expect(fires(out)).toBe(1);
  });
});

describe("the add-on's frames and the gesture around them", () => {
  test("a flat list of id, x, y is read as touch samples", () => {
    expect(samplesOf([1, 0.1, 0.2, 2, 0.3, 0.4])).toEqual([{ id: 1, x: 0.1, y: 0.2 }, { id: 2, x: 0.3, y: 0.4 }]);
    expect(samplesOf([])).toEqual([]);
  });
  test("frames from the add-on make one call per tap; stop stops the add-on; start is once", () => {
    const calls: string[] = [];
    let sink: ((t: number, flat: number[]) => void) | undefined;
    const addon: TouchAddon = { start: (cb) => { sink = cb; calls.push("start"); return true; }, reattach: () => { calls.push("reattach"); return true; }, stop: () => calls.push("stop") };
    let taps = 0;
    const g = new FourFingerTap(addon, () => taps++, () => undefined);
    g.start();
    g.start();
    const flat = (f: TouchSample[]) => f.flatMap((t) => [t.id, t.x, t.y]);
    for (let i = 0; i < 8; i++) sink!(1000 + i * 0.01, flat(four(i)));
    sink!(1000.08, []);
    expect(taps).toBe(1);
    g.reattach();
    g.stop();
    g.stop();
    g.reattach();
    expect(calls).toEqual(["start", "reattach", "stop"]);
  });
  test("an add-on that throws on start is one log line and the gesture off", () => {
    const lines: string[] = [];
    const addon: TouchAddon = { start: () => { throw new Error("boom"); }, reattach: () => { throw new Error("boom"); }, stop: () => { throw new Error("boom"); } };
    const g = new FourFingerTap(addon, () => undefined, (l) => lines.push(l));
    expect(g.start()).toBe(false);
    expect(lines).toEqual(["touches: four-finger tap off (boom)"]);
    expect(() => { g.reattach(); g.stop(); }).not.toThrow();
  });
  test("where there is no add-on the app does without the gesture", () => {
    const lines: string[] = [];
    expect(loadTouches("/nowhere/touches.node", (l) => lines.push(l), "darwin")).toBeUndefined();
    expect(lines[0]).toContain("no four-finger tap");
    expect(loadTouches("/nowhere/touches.node", () => undefined, "linux")).toBeUndefined();
  });
  const built = join(import.meta.dir, "..", "out", "main", "native", "touches.node");
  test.if(process.platform === "darwin" && existsSync(built))("the built add-on loads and offers start, reattach and stop (loading reads nothing)", () => {
    const addon = loadTouches(built, () => undefined);
    expect(addon).toBeDefined();
    expect(typeof addon!.start).toBe("function");
  });
});
