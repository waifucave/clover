// The working plume on a canvas (Winter's `PlumeLayerView`): every puff a disc in its heat's colour over a
// soft radial glow, the sparks over the puffs, and each thrown tool a white disc carrying its glyph in the
// plume's cool colour. The model is `WorkingAnimation`; this draws it, once a frame while it runs, or once
// for a still (the gallery's frames, reduced motion).

import { useEffect, useLayoutEffect, useRef, type ReactElement } from "react";
import { PALETTES, GLOW, GLOW_ALPHAS, GLOW_REACH, PLUME, PropulsionPlume, WorkingAnimation, cssRgb, plumeColor, type PlumePalette, type PlumeThrow } from "../model/plume";
import { PILL } from "../model/metrics";
import { drawGlyph, type GlyphCanvas } from "./glyphs";

/** The frame clock the pill runs on: the browser's, or a test's. */
export interface FrameTimers {
  now(): number;
  requestFrame(callback: (time: number) => void): number;
  cancelFrame(id: number): void;
}

/** The most pictures a second the plume draws: its flame reads smooth at 60 and costs half as much on a 120 Hz display. */
export const PLUME_FPS = 60;

export const BROWSER_FRAMES: FrameTimers = {
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
};

/** The drawing calls the plume makes: a canvas context, or a test's recorder. */
export interface PlumeCanvas extends GlyphCanvas {
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  fill(path?: Path2D): void;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): { addColorStop(offset: number, color: string): void };
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  globalAlpha: number;
}

export interface PlumeLayout {
  width: number;
  height: number;
  /** The nozzle's distance from the trailing edge: behind the stop circle. */
  emitterInset: number;
}

/** The nozzle's place in the pill: on the stop circle's centre. */
export const PILL_EMITTER_INSET = PILL.trailingPadding + PILL.sendCircleSize / 2;

const TILE_DISC = "#FFFFFF";
const SITE_GLYPH = "#737373";

/** Draws one frame of `plume` into `ctx`, laid out in a `width` × `height` box (CSS pixels, scaled by `ratio`). */
export function drawPlume(ctx: PlumeCanvas, plume: PropulsionPlume, layout: PlumeLayout, palette: PlumePalette = PALETTES.blue, ratio = 1): void {
  const { width, height } = layout;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const emitterX = width - layout.emitterInset;
  const tailX = PropulsionPlume.tailX(height);
  const midY = height / 2;
  const circles = plume.circles(height, midY, emitterX, tailX);

  // The glows first, under every disc, as Winter's glow layer sat under its disc layer.
  for (const c of circles) {
    if (c.spark) continue;
    const radius = c.diameter * GLOW_REACH;
    const gradient = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, radius);
    const color = plumeColor(c.heat, palette);
    GLOW.locations.forEach((location, i) => gradient.addColorStop(location, cssRgb(color, GLOW_ALPHAS[i]! * GLOW.strength)));
    ctx.fillStyle = gradient as unknown as CanvasGradient;
    ctx.beginPath();
    ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const c of circles) {
    ctx.globalAlpha = c.spark ? 0.95 : 1;
    ctx.fillStyle = cssRgb(plumeColor(c.heat, palette));
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.diameter / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const cool = cssRgb(plumeColor(0, palette));
  for (const tile of plume.tiles(height, midY, emitterX, tailX)) {
    ctx.fillStyle = TILE_DISC;
    ctx.beginPath();
    ctx.arc(tile.x, tile.y, tile.side / 2, 0, Math.PI * 2);
    ctx.fill();
    if ("tool" in tile.item.kind) drawGlyph(ctx, tile.item.kind.tool, tile.x, tile.y, tile.side * 0.5, cool, TILE_DISC);
    else drawGlyph(ctx, "globe", tile.x, tile.y, tile.side * 0.58, SITE_GLYPH, TILE_DISC);
  }
}

/** A throw the gallery schedules: thrown `at` seconds into a still. */
export interface ScheduledThrow {
  at: number;
  item: PlumeThrow;
}

/** The plume `at` seconds after it started, each scheduled throw seen at its time; stepped at 60 frames a second. */
export function plumeStill(at: number, throws: readonly ScheduledThrow[] = [], repeating: readonly PlumeThrow[] = [], seed: number = PLUME.defaultSeed): WorkingAnimation {
  const animation = new WorkingAnimation(seed);
  animation.tick(0, []);
  const steps = Math.round(at * 60);
  for (let i = 1; i <= steps; i++) {
    const t = i / 60;
    animation.tick(1 / 60, throws.filter((s) => s.at <= t).map((s) => s.item), repeating);
  }
  return animation;
}

export interface PlumeProps {
  width: number;
  height: number;
  emitterInset?: number;
  palette?: PlumePalette;
  /** The tools and sites this turn used, in order; each new one is thrown once. */
  thrown?: readonly PlumeThrow[];
  /** The running round's throws, thrown again in turn while it runs. */
  repeating?: readonly PlumeThrow[];
  /** False: the plume holds still (reduced motion), drawn once. */
  animates?: boolean;
  seed?: number;
  /** A fixed frame instead of a running plume: the gallery's. */
  still?: { at: number; throws?: readonly ScheduledThrow[] };
  timers?: FrameTimers;
  className?: string;
}

export function Plume({ width, height, emitterInset = PILL_EMITTER_INSET, palette = PALETTES.blue, thrown = [], repeating = [], animates = true, seed, still, timers = BROWSER_FRAMES, className }: PlumeProps): ReactElement {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const animation = useRef<WorkingAnimation | null>(null);
  const latest = useRef({ thrown, repeating, palette, width, height, emitterInset });
  latest.current = { thrown, repeating, palette, width, height, emitterInset };
  const ratio = typeof window === "undefined" ? 1 : Math.min(3, window.devicePixelRatio || 1);

  const paint = () => {
    const ctx = canvas.current?.getContext("2d") as PlumeCanvas | null | undefined;
    if (!ctx || !animation.current) return;
    const l = latest.current;
    drawPlume(ctx, animation.current.plume, { width: l.width, height: l.height, emitterInset: l.emitterInset }, l.palette, ratio);
  };

  // A still: built and drawn once for its moment.
  useLayoutEffect(() => {
    if (!still) return;
    animation.current = plumeStill(still.at, still.throws ?? [], repeating, seed);
    paint();
  });

  useEffect(() => {
    if (still) return;
    animation.current ??= new WorkingAnimation(seed);
    if (!animates) {
      animation.current.tick(0, latest.current.thrown, latest.current.repeating, false);
      paint();
      return;
    }
    // At most PLUME_FPS pictures a second (a 120 Hz display draws every other frame; the idle budget, OQ 33),
    // on a steady schedule with a few milliseconds' grace for frames landing early.
    let last = timers.now();
    let due = last;
    let frame = timers.requestFrame(function step() {
      const now = timers.now();
      if (now >= due - 4) {
        const dt = (now - last) / 1000;
        last = now;
        due += 1000 / PLUME_FPS;
        if (due <= now) due = now + 1000 / PLUME_FPS;
        animation.current!.tick(dt, latest.current.thrown, latest.current.repeating, true);
        paint();
      }
      frame = timers.requestFrame(step);
    });
    return () => timers.cancelFrame(frame);
    // The loop reads the latest props through `latest`; only these restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animates, still === undefined, timers, seed]);

  return <canvas ref={canvas} className={className} width={Math.round(width * ratio)} height={Math.round(height * ratio)} style={{ width, height, display: "block" }} data-plume="" />;
}
