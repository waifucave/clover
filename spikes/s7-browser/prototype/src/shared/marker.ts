// The frame marker: a strip of black and white cells, fixed at the page's top-left corner, that encodes the time it
// was drawn (the low 24 bits of Date.now(), in ms) and a draw counter. Any picture of the page (capturePage, a CDP
// screenshot or screencast frame, a WebRTC or WebCodecs video frame) can be decoded back to "when was this drawn",
// so freshness and end-to-end latency are measured from the pixels themselves, on one machine's clock.
//
// Layout, in CSS pixels: 2 rows x 26 cells of CELL px. Each row starts with a white sync cell and ends with a black
// one; the 24 cells between carry data bits (1 = white). 48 data bits: time24, frame16, check8.
// Pure: no DOM, Node or Bun APIs, so the pages, the Electron main process and Bun all share it.

export const CELL = 20;
export const COLS = 26;
export const ROWS = 2;
export const DATA_PER_ROW = COLS - 2;
export const MARKER_WIDTH = CELL * COLS;
export const MARKER_HEIGHT = CELL * ROWS;
const MASK24 = 0xffffff;

export interface Marker {
  /** Date.now() & 0xFFFFFF when the marker was drawn. */
  t24: number;
  /** The page's draw counter, & 0xFFFF. */
  frame: number;
}

export function checksum(t24: number, frame: number): number {
  const t0 = t24 & 0xff, t1 = (t24 >>> 8) & 0xff, t2 = (t24 >>> 16) & 0xff;
  const f0 = frame & 0xff, f1 = (frame >>> 8) & 0xff;
  // A rotate-and-xor mix, so a strip that is all black or all white never passes.
  let c = 0xa5;
  for (const b of [t0, t1, t2, f0, f1]) c = (((c << 1) | (c >>> 7)) & 0xff) ^ b;
  return c;
}

/** The 48 data bits, most significant first: time24, frame16, check8. */
export function markerBits(timeMs: number, frame: number): boolean[] {
  const t24 = Math.floor(timeMs) & MASK24;
  const f16 = frame & 0xffff;
  const c8 = checksum(t24, f16);
  const bits: boolean[] = [];
  for (let i = 23; i >= 0; i--) bits.push(((t24 >>> i) & 1) === 1);
  for (let i = 15; i >= 0; i--) bits.push(((f16 >>> i) & 1) === 1);
  for (let i = 7; i >= 0; i--) bits.push(((c8 >>> i) & 1) === 1);
  return bits;
}

/** Each cell's colour, row by row, sync cells included (true = white). */
export function markerCells(timeMs: number, frame: number): boolean[][] {
  const bits = markerBits(timeMs, frame);
  const rows: boolean[][] = [];
  for (let r = 0; r < ROWS; r++) {
    rows.push([true, ...bits.slice(r * DATA_PER_ROW, (r + 1) * DATA_PER_ROW), false]);
  }
  return rows;
}

/** Something that answers a pixel's luminance (0–255) at image coordinates. */
export interface PixelReader {
  readonly width: number;
  readonly height: number;
  lum(x: number, y: number): number;
}

/** A reader over 4-byte pixels (RGBA or BGRA: luminance treats the colour channels alike). */
export function rgbaReader(data: Uint8Array | Uint8ClampedArray, width: number, height: number): PixelReader {
  return {
    width,
    height,
    lum(x, y) {
      const xi = Math.min(width - 1, Math.max(0, Math.round(x)));
      const yi = Math.min(height - 1, Math.max(0, Math.round(y)));
      const o = (yi * width + xi) * 4;
      return ((data[o] ?? 0) + (data[o + 1] ?? 0) + (data[o + 2] ?? 0)) / 3;
    },
  };
}

/** Average luminance of a small square around a cell's centre (robust to JPEG and video noise). */
function cellLum(px: PixelReader, cx: number, cy: number, half: number): number {
  let sum = 0, n = 0;
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) { sum += px.lum(cx + dx, cy + dy); n++; }
  }
  return sum / n;
}

/**
 * Decode the marker from a picture whose top-left is the page's viewport top-left. `scale` is image pixels per CSS
 * pixel (image width / the page's innerWidth). Returns null when the strip is not there or its check fails.
 */
export function decodeMarker(px: PixelReader, scale: number, originX = 0, originY = 0): Marker | null {
  const cell = CELL * scale;
  if (cell < 3) return null;
  if (originX + MARKER_WIDTH * scale > px.width + 1 || originY + MARKER_HEIGHT * scale > px.height + 1) return null;
  const half = Math.max(0, Math.min(3, Math.floor(cell / 5)));
  const bits: boolean[] = [];
  for (let r = 0; r < ROWS; r++) {
    const cy = originY + (r + 0.5) * cell;
    const first = cellLum(px, originX + 0.5 * cell, cy, half);
    const last = cellLum(px, originX + (COLS - 0.5) * cell, cy, half);
    if (first < 160 || last > 95) return null; // sync cells: white then black
    for (let c = 1; c <= DATA_PER_ROW; c++) bits.push(cellLum(px, originX + (c + 0.5) * cell, cy, half) >= 128);
  }
  let t24 = 0, frame = 0, check = 0;
  for (let i = 0; i < 24; i++) t24 = (t24 << 1) | (bits[i] ? 1 : 0);
  for (let i = 24; i < 40; i++) frame = (frame << 1) | (bits[i] ? 1 : 0);
  for (let i = 40; i < 48; i++) check = (check << 1) | (bits[i] ? 1 : 0);
  t24 >>>= 0;
  if (checksum(t24, frame) !== check) return null;
  return { t24, frame };
}

/** How long ago (ms) a marker drawn at t24 was, seen at nowMs: signed, in [-2^23, 2^23). */
export function ageMs(nowMs: number, t24: number): number {
  let d = ((Math.floor(nowMs) & MASK24) - t24) & MASK24;
  if (d >= 0x800000) d -= 0x1000000;
  return d;
}

/** A canvas-like target the pages draw on (CanvasRenderingContext2D satisfies it). */
export interface MarkerCanvas {
  fillStyle: unknown;
  fillRect(x: number, y: number, w: number, h: number): void;
}

/** Draw the marker at (0, 0) of a context sized MARKER_WIDTH x MARKER_HEIGHT CSS px (scaled by the caller). */
export function drawMarker(ctx: MarkerCanvas, timeMs: number, frame: number): void {
  const rows = markerCells(timeMs, frame);
  for (let r = 0; r < ROWS; r++) {
    const row = rows[r]!;
    for (let c = 0; c < COLS; c++) {
      ctx.fillStyle = row[c] ? "#ffffff" : "#000000";
      ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
    }
  }
}
