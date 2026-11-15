// The watches a frame opened on its plugin's connection end with the frame (§5.4 "Turns": a dead frame's take ends
// with it): noted per mount, forgotten when the part ends one itself, handed back when the frame goes.
import { describe, expect, test } from "bun:test";
import { FrameWatches } from "../src/main/ui/frame-watches";

describe("a frame's watches", () => {
  test("each frame's own: one ended by its part is forgotten; the rest come back once when the frame goes", () => {
    const w = new FrameWatches();
    w.add("m1", "tarot", "w_a");
    w.add("m1", "tarot", "w_b");
    w.add("m2", "cards", "w_c");
    w.forget("m1", "w_a");
    w.forget("m2", "w_unknown");
    expect(w.size).toBe(2);
    expect(w.gone("m1")).toEqual([{ pluginId: "tarot", watch: "w_b" }]);
    expect(w.gone("m1")).toEqual([]);
    expect(w.gone("m3")).toEqual([]);
    expect(w.gone("m2")).toEqual([{ pluginId: "cards", watch: "w_c" }]);
    expect(w.size).toBe(0);
  });
});
