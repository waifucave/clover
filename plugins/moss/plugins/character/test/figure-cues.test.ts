import { describe, expect, test } from "bun:test";
// The avatar plugin's own cue contract (its points' messages): what crosses, and the plain answer to a cue.
import { boxOrDefault, catalogueOf, cleanFigureBox, cleanFigureCapabilities, cleanFigureCue, cleanFigureNames, defaultFigureBox, judgeCue, type FigureReport } from "../client/figure-cues";

describe("the figure's cues", () => {
  test("a cue crosses only in one of its shapes, with names checked and a point kept inside the stage", () => {
    expect(cleanFigureCue({ type: "expression", name: "happy" })).toEqual({ type: "expression", name: "happy" });
    expect(cleanFigureCue({ type: "outfit", part: "hat", on: true, extra: 1 })).toEqual({ type: "outfit", part: "hat", on: true });
    expect(cleanFigureCue({ type: "pace", calm: false })).toEqual({ type: "pace", calm: false });
    expect(cleanFigureCue({ type: "lookAt", point: { x: 5, y: -9 } })).toEqual({ type: "lookAt", point: { x: 1, y: -1 } });
    expect(cleanFigureCue({ type: "lookAt", point: null })).toEqual({ type: "lookAt", point: null });
    for (const bad of [null, "x", {}, { type: "dance" }, { type: "expression" }, { type: "expression", name: "" }, { type: "expression", name: "a\nb" }, { type: "expression", name: "x".repeat(65) }, { type: "outfit", part: "hat" }, { type: "pace", calm: "yes" }, { type: "lookAt", point: { x: Number.NaN, y: 0 } }, { type: "lookAt" }]) {
      expect(cleanFigureCue(bad)).toBeUndefined();
    }
  });

  test("a renderer's names and capabilities keep only the known capabilities and clean names; the catalogue reads them", () => {
    expect(cleanFigureCapabilities(["expressions", "juggling", "expressions"])).toEqual(["expressions"]);
    const names = cleanFigureNames({ expressions: ["a", "a", "", "b"], motions: [], outfits: [{ name: "hat", on: false }, { name: "hat", on: true }, { name: 3 }] });
    expect(names).toEqual({ expressions: ["a", "b"], motions: [], outfits: [{ name: "hat", on: false }] });
    expect(cleanFigureNames(null)).toBeUndefined();
    expect(catalogueOf({ format: "live2d", renderer: "moss/live2d", capabilities: ["expressions"], ...(names ? { names } : {}) })).toEqual({ format: "live2d", renderer: "moss/live2d", capabilities: ["expressions"], expressions: ["a", "b"], motions: [], outfits: [{ name: "hat", on: false }] });
    expect(catalogueOf(undefined)).toBeUndefined();
  });

  test("a box is whole pixels; one that says only the canvas reads as the default, anchors the renderer gave kept", () => {
    expect(cleanFigureBox({ canvas: { width: 300.4, height: 500 }, figure: { x: 1.5, y: 2, width: 100, height: 200 }, anchors: { face: { x: 10.2, y: 20 }, tail: { x: 1, y: 1 } } }))
      .toEqual({ canvas: { width: 300, height: 500 }, figure: { x: 2, y: 2, width: 100, height: 200 }, anchors: { face: { x: 10, y: 20 } } });
    expect(cleanFigureBox({ canvas: { width: 0, height: 5 } })).toBeUndefined();
    expect(cleanFigureBox({ canvas: { width: Number.NaN, height: 5 } })).toBeUndefined();
    const d = boxOrDefault({ canvas: { width: 400, height: 600 }, anchors: { mouth: { x: 7, y: 8 } } })!;
    expect(d.estimated).toBe(true);
    expect(d.anchors?.mouth).toEqual({ x: 7, y: 8 });
    expect(d.anchors?.headTop).toBeDefined();
    expect(d.figure!.y).toBeLessThan(d.canvas.height / 2);
    expect(boxOrDefault({ canvas: { width: 1, height: 1 }, figure: { x: 0, y: 0, width: 1, height: 1 } })!.estimated).toBeUndefined();
    expect(defaultFigureBox({ width: 100, height: 100 }).anchors!.face!.x).toBe(50);
  });

  test("a cue a renderer can't play is answered plainly, never dropped", () => {
    const report: FigureReport = { format: "png", renderer: "luna/pngtuber", capabilities: ["expressions"], names: { expressions: ["happy", "sad"], motions: [], outfits: [] } };
    expect(judgeCue(undefined, { type: "expression", name: "happy" })).toMatchObject({ ok: false, reason: "no-renderer" });
    expect(judgeCue(report, { type: "expression", name: "happy" })).toBeUndefined();
    const outfit = judgeCue(report, { type: "outfit", part: "hat", on: true });
    expect(outfit).toMatchObject({ ok: false, reason: "unsupported" });
    expect((outfit as { message: string }).message).toContain("doesn't do outfits");
    const unknown = judgeCue(report, { type: "expression", name: "angry" });
    expect(unknown).toMatchObject({ ok: false, reason: "unknown-name" });
    expect((unknown as { message: string }).message).toContain("happy, sad");
    expect(judgeCue({ ...report, capabilities: ["lookat"] }, { type: "lookAt", point: null })).toBeUndefined();
  });
});
