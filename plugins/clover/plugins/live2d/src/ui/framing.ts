// How a Live2D figure is framed in its box: by what is drawn, not by the model's canvas rectangle. A model's canvas has
// margins (and room for a long hair or a tail) that are empty; fitting it whole leaves the figure small and low, and a theme
// that asks for a waist crop (`--clover-avatar-crop`, `--clover-avatar-headroom`, as the 3D figure's reads them) gets nothing.
// Pure and small, so it is tested with plain numbers; the view (Mochi2D) is asked only for the drawn boxes and the scale.

/** A box in model units, y up. */
export interface Box { minX: number; minY: number; maxX: number; maxY: number }

/** The part of the figure the box shows, from the top: `show` of its height (0.56: to the waist), with `headroom` of its height above the head. */
export interface Crop { show: number; headroom: number }

/** What the runtime says about what it draws: which drawables are there, which are shown, and each one's box. */
export interface DrawnRuntime {
  model: { meshes: { ids: readonly string[] } };
  instance: { drawableVisible: ArrayLike<number>; drawableOpacity: ArrayLike<number> };
  drawableBounds(id: string): Box | null;
}

/** The union of the boxes of the drawables that are shown now (visible, opacity above 0, a box with some size), or null while nothing is. */
export function drawnBounds(rt: DrawnRuntime): Box | null {
  const ids = rt.model.meshes.ids;
  let out: Box | null = null;
  for (let i = 0; i < ids.length; i++) {
    if (!rt.instance.drawableVisible[i] || !(rt.instance.drawableOpacity[i]! > 0.01)) continue;
    const b = rt.drawableBounds(ids[i]!);
    if (!b || !Number.isFinite(b.minX + b.minY + b.maxX + b.maxY) || b.maxX <= b.minX || b.maxY <= b.minY) continue;
    out = out === null ? { ...b } : { minX: Math.min(out.minX, b.minX), minY: Math.min(out.minY, b.minY), maxX: Math.max(out.maxX, b.maxX), maxY: Math.max(out.maxY, b.maxY) };
  }
  return out;
}

/** The crop a stage's CSS asks for (`--clover-avatar-crop`: 0.2 to 1; `--clover-avatar-headroom`: 0 to 0.6, else 0.03), or undefined when it asks for none. */
export function readCrop(style: { getPropertyValue(name: string): string }): Crop | undefined {
  const num = (n: string): number => Number.parseFloat(style.getPropertyValue(n));
  const show = num("--clover-avatar-crop");
  if (!(Number.isFinite(show) && show >= 0.2 && show <= 1)) return undefined;
  const headroom = num("--clover-avatar-headroom");
  return { show, headroom: Number.isFinite(headroom) && headroom >= 0 && headroom <= 0.6 ? headroom : 0.03 };
}

/** The view that shows `crop` of the drawn figure `drawn` in a canvas of `px` CSS pixels, as Mochi2D's `setView` takes it (relative to the fitted view whose scale is `atFit` pixels per model unit). */
export function frameFor(drawn: Box, canvas: { left: number; right: number; bottom: number; top: number }, crop: Crop, px: { width: number; height: number }, atFit: number): { zoom: number; x: number; y: number } | null {
  const h = drawn.maxY - drawn.minY, w = drawn.maxX - drawn.minX;
  if (!(h > 0 && w > 0 && px.width > 0 && px.height > 0 && atFit > 0)) return null;
  const top = drawn.maxY + h * crop.headroom;
  const bottom = drawn.maxY - h * crop.show;
  // The scale that shows that much of the height; never so large that the figure's width leaves the box.
  const scale = Math.min(px.height / (top - bottom), (px.width * 0.98) / w);
  // The top stays where it was asked for; a width-limited figure shows more below it, not less above.
  const centreY = top - px.height / scale / 2;
  const centreX = (drawn.minX + drawn.maxX) / 2;
  return { zoom: scale / atFit, x: centreX - (canvas.left + canvas.right) / 2, y: centreY - (canvas.top + canvas.bottom) / 2 };
}
