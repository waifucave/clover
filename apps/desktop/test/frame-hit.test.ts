import { describe, expect, test } from "bun:test";
import { frameChainAt, hitScript, type HitFrame } from "../src/main/frame-hit";

// A window as the walk sees it: each frame answers for the iframe at a point, in its own coordinates.
const frame = (id: string, url: string, over: { at: { x: number; y: number; w: number; h: number }; child: HitFrame } | undefined, extra: HitFrame[] = []): HitFrame => ({
  id,
  url,
  children: over === undefined ? extra : [over.child, ...extra],
  ask: async (x, y) => (over !== undefined && x >= over.at.x && x < over.at.x + over.at.w && y >= over.at.y && y < over.at.y + over.at.h ? { src: over.child.url, x: over.at.x, y: over.at.y } : null),
});

describe("the frames a press landed in", () => {
  const part = frame("3:3", "clover-plugin://p/part", undefined);
  const layer = frame("2:2", "clover-plugin://p/layer", { at: { x: 10, y: 20, w: 100, h: 50 }, child: part });
  const other = frame("4:4", "clover-plugin://q/layer", undefined);
  const root = frame("1:1", "clover-core://app/", { at: { x: 100, y: 100, w: 300, h: 200 }, child: layer }, [other]);

  test("the frame under the pointer and the frames it sits in, outermost first, the main frame left out", async () => {
    expect(await frameChainAt(root, 105, 105)).toEqual(["2:2"]); // over the layer's own content
    expect(await frameChainAt(root, 100 + 10 + 5, 100 + 20 + 5)).toEqual(["2:2", "3:3"]); // over the part inside it
  });

  test("a point over the root's own content is in no plugin's frame", async () => {
    expect(await frameChainAt(root, 5, 5)).toEqual([]);
  });

  test("a frame that does not answer ends the walk where it is, and a hop with no matching child stops it", async () => {
    const silent: HitFrame = { ...layer, ask: () => Promise.reject(new Error("hung")) };
    expect(await frameChainAt(frame("1:1", "x", { at: { x: 0, y: 0, w: 500, h: 500 }, child: silent }), 5, 5)).toEqual(["2:2"]);
    const lost: HitFrame = { id: "1:1", url: "x", children: [], ask: async () => ({ src: "clover-plugin://nowhere", x: 0, y: 0 }) };
    expect(await frameChainAt(lost, 5, 5)).toEqual([]);
  });

  test("the hop's script asks for an iframe at rounded numbers only", () => {
    expect(hitScript(10.4, 20.6)).toContain("elementFromPoint(10, 21)");
  });
});
