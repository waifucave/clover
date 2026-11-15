import { describe, expect, test } from "bun:test";
import { drawnBounds, frameFor, readCrop, type DrawnRuntime } from "../src/ui/framing";

const rt = (boxes: Record<string, { minX: number; minY: number; maxX: number; maxY: number }>, visible: number[], opacity: number[]): DrawnRuntime => ({
  model: { meshes: { ids: Object.keys(boxes) } },
  instance: { drawableVisible: visible, drawableOpacity: opacity },
  drawableBounds: (id) => boxes[id] ?? null,
});

describe("what is drawn, not the canvas", () => {
  test("the drawn bounds are the union of the shown drawables; a hidden or clear one adds nothing", () => {
    const r = rt(
      { hair: { minX: -2, minY: 1, maxX: 2, maxY: 6 }, body: { minX: -1, minY: -4, maxX: 1, maxY: 1 }, ghost: { minX: -30, minY: -30, maxX: 30, maxY: 30 }, clear: { minX: -40, minY: 0, maxX: 40, maxY: 1 }, flat: { minX: 5, minY: 5, maxX: 5, maxY: 9 } },
      [1, 1, 0, 1, 1], [1, 1, 1, 0, 1],
    );
    expect(drawnBounds(r)).toEqual({ minX: -2, minY: -4, maxX: 2, maxY: 6 });
    expect(drawnBounds(rt({}, [], []))).toBeNull();
  });

  test("a crop is read from the stage's CSS: waist with headroom, a plain bust without any, nothing out of range", () => {
    const style = (o: Record<string, string>) => ({ getPropertyValue: (n: string) => o[n] ?? "" });
    expect(readCrop(style({ "--clover-avatar-crop": "0.56", "--clover-avatar-headroom": "0.12" }))).toEqual({ show: 0.56, headroom: 0.12 });
    expect(readCrop(style({ "--clover-avatar-crop": "0.56" }))).toEqual({ show: 0.56, headroom: 0.03 });
    expect(readCrop(style({ "--clover-avatar-crop": "0.56", "--clover-avatar-headroom": "0.9" }))).toEqual({ show: 0.56, headroom: 0.03 });
    expect(readCrop(style({}))).toBeUndefined();
    expect(readCrop(style({ "--clover-avatar-crop": "3" }))).toBeUndefined();
  });

  test("the frame shows the asked part of the drawn figure: its top with the headroom, its waist at the bottom, centred", () => {
    // A figure 10 units tall and 4 wide, off-centre in a canvas rectangle that is much taller (margins and hair room).
    const drawn = { minX: 1, minY: -10, maxX: 5, maxY: 0 };
    const canvas = { left: -10, right: 10, bottom: -30, top: 20 };
    const px = { width: 600, height: 700 };
    const v = frameFor(drawn, canvas, { show: 0.5, headroom: 0.1 }, px, 10)!;
    // Shows from 1 above the head to 5 below it: 6 units over 700 px.
    const scale = 700 / 6;
    expect(v.zoom).toBeCloseTo(scale / 10, 6);
    // The figure's centre column (x = 3) is at the canvas's centre; the view's top (y = 1) is the canvas's top edge.
    expect(v.x).toBeCloseTo(3 - 0, 6);
    expect(v.y + (canvas.top + canvas.bottom) / 2 + 700 / scale / 2).toBeCloseTo(1, 6);
  });

  test("a figure too wide for the box is scaled down to its width, keeping the top where it was asked for", () => {
    const drawn = { minX: -10, minY: -10, maxX: 10, maxY: 0 };
    const v = frameFor(drawn, { left: -10, right: 10, bottom: -10, top: 0 }, { show: 0.3, headroom: 0 }, { width: 100, height: 700 }, 1)!;
    expect(v.zoom).toBeCloseTo((100 * 0.98) / 20, 6);
    // The top of the view is the figure's top (y = 0).
    expect(v.y + -5 + 700 / v.zoom / 2).toBeCloseTo(0, 6);
  });

  test("nothing to frame without a size", () => {
    expect(frameFor({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, { left: 0, right: 1, bottom: 0, top: 1 }, { show: 0.5, headroom: 0 }, { width: 10, height: 10 }, 1)).toBeNull();
    expect(frameFor({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, { left: 0, right: 1, bottom: 0, top: 1 }, { show: 0.5, headroom: 0 }, { width: 0, height: 10 }, 1)).toBeNull();
  });
});

describe("the framing fixtures", () => {
  test("a tall figure in a large canvas and a small one in an empty canvas pass the model check, and the committed bust is unchanged", async () => {
    const { placeholderFiles, placeholderMocData } = await import("../src/placeholder/model");
    for (const shape of ["tall", "small"] as const) expect(Object.keys(placeholderFiles(shape)).sort()).toEqual(["alpha.moc3", "alpha.model3.json", "alpha.png"]);
    expect(placeholderMocData("tall").canvas).toMatchObject({ width: 2400, height: 3400 });
    expect(placeholderMocData("tall").artMeshes.ids).toContain("ArtMeshSkirt");
    expect(placeholderMocData("bust").canvas).toMatchObject({ width: 1024, height: 1024 });
  });
});
