// A press over a sealed button that no sealed page heard (sealed-miss.ts, lane RT round 5): the app tells the button's page to say
// "press again"; a press nowhere near a button, or one a sealed page heard, is nothing.
import { describe, expect, test } from "bun:test";
import { buttonAt, inWindow, MISS_BOUND_MS, MissWatch } from "../src/main/sealed-miss";

describe("a press no sealed page heard", () => {
  const button = { token: "t1", box: inWindow({ x: 10, y: 5, width: 66, height: 34 }, [{ x: 200, y: 60 }, { x: 24, y: 0 }]) };

  test("the button's box in the window is its own box moved by each frame above it", () => {
    expect(button.box).toEqual({ x: 234, y: 65, width: 66, height: 34 });
  });

  test("delivered to the embedding document at the button's spot: after the bound it is a missed press over that button, once", () => {
    let t = 0;
    const w = new MissWatch(() => t);
    w.down(1, { x: 260, y: 80 });
    expect(w.missed(1)).toBeUndefined(); // not yet: the page has the bound to say it got it
    t += MISS_BOUND_MS;
    const p = w.missed(1)!;
    expect(buttonAt(p, [button])?.token).toBe("t1");
    expect(w.missed(1)).toBeUndefined(); // told once
    // The next press, which the page hears: nothing.
    w.down(1, { x: 260, y: 80 });
    w.heard(1);
    t += MISS_BOUND_MS;
    expect(w.missed(1)).toBeUndefined();
  });

  test("a press nowhere near a button is no notice; a press the sealed page heard is none; another window's word doesn't count", () => {
    let t = 0;
    const w = new MissWatch(() => t);
    w.down(1, { x: 10, y: 10 });
    t += MISS_BOUND_MS;
    expect(buttonAt(w.missed(1)!, [button])).toBeUndefined();
    w.down(1, { x: 260, y: 80 });
    w.heard(2);
    t += MISS_BOUND_MS;
    expect(w.missed(1)).toBeDefined();
  });

  test("a button with no size is never hit; the edges count", () => {
    expect(buttonAt({ x: 234, y: 65 }, [button])?.token).toBe("t1");
    expect(buttonAt({ x: 300, y: 99 }, [button])?.token).toBe("t1");
    expect(buttonAt({ x: 301, y: 99 }, [button])).toBeUndefined();
    expect(buttonAt({ x: 0, y: 0 }, [{ token: "t0", box: { x: 0, y: 0, width: 0, height: 0 } }])).toBeUndefined();
  });
});
