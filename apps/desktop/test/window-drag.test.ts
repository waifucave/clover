import { describe, expect, test } from "bun:test";
import { WindowDrag } from "../src/main/ui/window-drag";

describe("moving the window by its title area", () => {
  test("the window follows the mouse by the same distance, until the mouse comes up", () => {
    const d = new WindowDrag();
    expect(d.move(1, { x: 5, y: 5 })).toBeUndefined();
    d.start(1, { x: 100, y: 200 }, { x: 400, y: 300 });
    expect(d.move(1, { x: 450, y: 290 })).toEqual({ x: 150, y: 190 });
    expect(d.move(2, { x: 450, y: 290 })).toBeUndefined();
    d.end(1);
    expect(d.move(1, { x: 450, y: 290 })).toBeUndefined();
  });
});
