// Her "Her room" scene's art (client/meadow-art.ts): the same size and scheme always draw the same scene, every number
// in it is a number, the sprites stay few and only ever move by a transform and an opacity, and nothing in her scene's
// files animates on its own (the idle budget: a leftover CSS animation once cost a tenth of a core).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { backdropSvg, drawsMeadow, grassMarkup, orbOf, palette, spriteFrame, spritesHtml, spritesOf, SPRITES_MAX } from "../../client/meadow-art";

const CLIENT = join(import.meta.dir, "..", "..", "client");
const SIZES = [[2000, 1300], [760, 1000], [1440, 900], [320, 480], [3840, 2160]] as const;
const bad = /NaN|undefined|Infinity/;

describe("the meadow's art", () => {
  test("the same size and scheme draw the same scene; night and day differ", () => {
    for (const [w, h] of SIZES) {
      for (const dark of [true, false]) {
        const a = backdropSvg(w, h, dark);
        expect(backdropSvg(w, h, dark)).toBe(a);
        expect(a.match(bad)).toBeNull();
        expect(a).toContain(`viewBox="0 0 ${w} ${h}"`);
        expect(a).toContain(palette(dark).sky[0]);
      }
      expect(backdropSvg(w, h, true)).not.toBe(backdropSvg(w, h, false));
    }
  });

  test("the night has stars and craters, the day neither; the moon stays in the window", () => {
    expect(backdropSvg(2000, 1300, true)).toContain('fill="#fff"');
    expect(backdropSvg(2000, 1300, false)).not.toContain('fill="#fff"');
    for (const [w, h] of SIZES) {
      const o = orbOf(w, h);
      expect(o.x + o.r).toBeLessThanOrEqual(w);
      expect(o.x - o.r).toBeGreaterThanOrEqual(0);
      expect(o.y - o.r).toBeGreaterThanOrEqual(0);
    }
  });

  test("a few sprites at any size, each placed by its transform alone, at rest where spritesOf put them", () => {
    for (const [w, h] of SIZES) {
      for (const dark of [true, false]) {
        const sprites = spritesOf(w, h, dark);
        expect(sprites.length).toBeLessThanOrEqual(SPRITES_MAX);
        expect(sprites.filter((s) => s.kind === "glow")).toHaveLength(1);
        if (!dark) expect(sprites.some((s) => s.kind === "twinkle")).toBe(false);
        const html = spritesHtml(sprites);
        expect(html.match(bad)).toBeNull();
        expect(html.match(/data-sprite=/g)?.length).toBe(sprites.length);
        expect(html.match(/left:0;top:0;/g)?.length).toBe(sprites.length);
        expect(html).not.toMatch(/animation|transition/);
      }
    }
  });

  test("a frame of a sprite is only a transform and an opacity, finite, and petals drift but stay about the window", () => {
    const [w, h] = [2000, 1300];
    for (const s of spritesOf(w, h, true)) {
      for (const t of [0, 0.5, 7, 333, 86_400]) {
        const fr = spriteFrame(s, t, w, h);
        expect(Object.keys(fr).sort()).toEqual(["opacity", "transform"]);
        expect(`${fr.transform} ${fr.opacity}`.match(bad)).toBeNull();
        expect(Number(fr.opacity)).toBeGreaterThanOrEqual(0);
        expect(Number(fr.opacity)).toBeLessThanOrEqual(1);
        const [x, y] = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(fr.transform)!.slice(1).map(Number);
        expect(x!).toBeGreaterThan(-80);
        expect(x!).toBeLessThan(w + 80);
        if (s.kind === "petal") { expect(y!).toBeGreaterThan(-60); expect(y!).toBeLessThan(h + 60); }
      }
      if (s.kind === "petal") expect(spriteFrame(s, 30, w, h).transform).not.toBe(spriteFrame(s, 0, w, h).transform);
    }
  });

  test("the grass in front of her: the same frame draws the same grass, to the frame's size, never taking a pointer", () => {
    for (const [w, h] of [[1240, 300], [760, 150], [2000, 300], [400, 90]] as const) {
      for (const dark of [true, false]) {
        const g = grassMarkup(w, h, dark);
        expect(grassMarkup(w, h, dark)).toBe(g);
        expect(g.match(bad)).toBeNull();
        expect(g).toContain(`viewBox="0 0 ${w} ${h}"`);
        expect(g).toContain("pointer-events:none");
        expect(g).toContain(palette(dark).grass[2]);
      }
    }
  });

  test("the meadow is her meadow and any scene another plugin adds; study, starry and rain keep their own art", () => {
    for (const s of ["meadow", "beach", "night-market"]) expect(drawsMeadow(s)).toBe(true);
    for (const s of ["study", "starry", "rain"]) expect(drawsMeadow(s)).toBe(false);
  });

  test("nothing in her scene's files animates on its own: no keyframes, no CSS animation", () => {
    for (const f of ["backdrop.tsx", "meadow-art.ts", "meadow-layer.ts", "foreground.tsx"]) {
      const src = readFileSync(join(CLIENT, f), "utf8");
      expect([f, /@keyframes|animation\s*:/.test(src)]).toEqual([f, false]);
    }
    expect(readFileSync(join(CLIENT, "foreground.tsx"), "utf8")).toContain("pointer-events: none !important");
  });
});
