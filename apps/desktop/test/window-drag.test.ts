import { describe, expect, test } from "bun:test";
import { DRAG_PRESS_WINDOW_MS, placeWindow, TitleDrag } from "../src/main/ui/window-drag";

const ok = { shell: true, titleHeight: 45, cardPending: false, window: { x: 100, y: 200 }, cursor: { x: 400, y: 300 } };

describe("moving the window by its title area", () => {
  test("a seen press in the title area starts it; the window follows the cursor read by the main process until the release", () => {
    let t = 0;
    const d = new TitleDrag(() => t);
    d.down(1, { button: "left", x: 50, y: 10 });
    expect(d.start(1, ok)).toEqual({ ok: true });
    expect(d.move(1, { x: 450, y: 290 }, false)).toEqual({ x: 150, y: 190 });
    expect(d.move(2, { x: 450, y: 290 }, false)).toBeUndefined();
    expect(d.end(1)).toEqual({ x: 100, y: 200 });
    expect(d.move(1, { x: 450, y: 290 }, false)).toBeUndefined();
  });
  test("refused: not the shell", () => {
    const d = new TitleDrag(() => 0);
    d.down(1, { button: "left", x: 50, y: 10 });
    expect(d.start(1, { ...ok, shell: false }).ok).toBe(false);
  });
  test("refused: no press the main process saw, a non-primary press, or one too old", () => {
    let t = 0;
    const d = new TitleDrag(() => t);
    expect(d.start(1, ok).ok).toBe(false);
    d.down(1, { button: "right", x: 50, y: 10 });
    expect(d.start(1, ok).ok).toBe(false);
    d.down(1, { button: "left", x: 50, y: 10 });
    t = DRAG_PRESS_WINDOW_MS + 1;
    expect(d.start(1, ok).ok).toBe(false);
  });
  test("one press starts one drag", () => {
    const d = new TitleDrag(() => 0);
    d.down(1, { button: "left", x: 50, y: 10 });
    expect(d.start(1, ok).ok).toBe(true);
    expect(d.start(1, ok).ok).toBe(false);
  });
  test("refused: the press was below the title area", () => {
    const d = new TitleDrag(() => 0);
    d.down(1, { button: "left", x: 50, y: 45 });
    expect(d.start(1, ok).ok).toBe(false);
  });
  test("refused while a sealed card is pending, and a card appearing ends a drag", () => {
    const d = new TitleDrag(() => 0);
    d.down(1, { button: "left", x: 50, y: 10 });
    expect(d.start(1, { ...ok, cardPending: true }).ok).toBe(false);
    d.down(1, { button: "left", x: 50, y: 10 });
    expect(d.start(1, ok).ok).toBe(true);
    expect(d.move(1, { x: 450, y: 290 }, true)).toBeUndefined();
    expect(d.isGoing(1)).toBe(false);
  });
  test("refused: the cursor's place unknown", () => {
    const d = new TitleDrag(() => 0);
    d.down(1, { button: "left", x: 50, y: 10 });
    expect(d.start(1, { ...ok, cursor: undefined }).ok).toBe(false);
  });
});

describe("a cursor between pixels, or not a number", () => {
  const begin = () => {
    const d = new TitleDrag(() => 0);
    d.down(1, { button: "left", x: 50, y: 10 });
    d.start(1, { ...ok, cursor: { x: 400.5, y: 300.25 } });
    return d;
  };
  test("the window's place is whole numbers", () => {
    const to = begin().move(1, { x: 450.75, y: 290.3 }, false)!;
    expect(Number.isInteger(to.x) && Number.isInteger(to.y)).toBe(true);
  });
  test("a cursor that isn't finite moves nothing, and the drag goes on from the next good read", () => {
    const d = begin();
    for (const c of [{ x: Number.NaN, y: 1 }, { x: 1, y: Number.POSITIVE_INFINITY }, { x: Number.NEGATIVE_INFINITY, y: Number.NaN }]) expect(d.move(1, c, false)).toBeUndefined();
    expect(d.isGoing(1)).toBe(true);
    expect(d.move(1, { x: 450, y: 290 }, false)).toBeDefined();
  });
  test("setPosition gets integers for a fractional place, and is not called for one that isn't finite", () => {
    const calls: number[][] = [];
    const win = { setPosition: (...a: number[]) => { if (a.some((n) => !Number.isInteger(n))) throw new TypeError("Error processing argument at index 0, conversion failure"); calls.push(a); } };
    placeWindow(win, { x: 150.6, y: 189.4 });
    expect(calls).toEqual([[151, 189]]);
    placeWindow(win, { x: Number.NaN, y: 1 });
    placeWindow(win, undefined);
    expect(calls).toHaveLength(1);
  });
});
