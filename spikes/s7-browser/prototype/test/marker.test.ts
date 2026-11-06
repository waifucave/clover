import { describe, expect, test } from "bun:test";
import { ageMs, CELL, checksum, COLS, decodeMarker, markerBits, markerCells, MARKER_HEIGHT, MARKER_WIDTH, rgbaReader, ROWS } from "../src/shared/marker.ts";

/** Paint the marker into an RGBA buffer at `scale` image px per CSS px, on a grey page, with optional noise. */
function paint(timeMs: number, frame: number, scale: number, width = 1280, height = 200, noise = 0): { data: Uint8Array; width: number; height: number } {
  const w = Math.round(width * scale), h = Math.round(height * scale);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = 128; data[i + 3] = 255; }
  const cells = markerCells(timeMs, frame);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const v = cells[r]![c] ? 255 : 0;
      for (let y = Math.round(r * CELL * scale); y < Math.round((r + 1) * CELL * scale); y++) {
        for (let x = Math.round(c * CELL * scale); x < Math.round((c + 1) * CELL * scale); x++) {
          const o = (y * w + x) * 4;
          const n = noise === 0 ? 0 : Math.round((Math.random() - 0.5) * 2 * noise);
          data[o] = data[o + 1] = data[o + 2] = Math.max(0, Math.min(255, v + n));
        }
      }
    }
  }
  return { data, width: w, height: h };
}

describe("frame marker", () => {
  test("48 data bits: time24, frame16, check8", () => {
    expect(markerBits(0x123456, 0xbeef).length).toBe(48);
    expect(MARKER_WIDTH).toBe(520);
    expect(MARKER_HEIGHT).toBe(40);
  });

  for (const scale of [1, 2, 0.5, 0.75]) {
    test(`round trip at scale ${scale}`, () => {
      const t = 1_762_300_000_123;
      const img = paint(t, 4242, scale);
      const m = decodeMarker(rgbaReader(img.data, img.width, img.height), scale);
      expect(m).not.toBeNull();
      expect(m!.t24).toBe(t & 0xffffff);
      expect(m!.frame).toBe(4242);
    });
  }

  test("survives pixel noise (JPEG- or video-like)", () => {
    const t = Date.now();
    const img = paint(t, 7, 1, 1280, 200, 60);
    expect(decodeMarker(rgbaReader(img.data, img.width, img.height), 1)?.t24).toBe(t & 0xffffff);
  });

  test("no marker: a flat page decodes to null", () => {
    const w = 1280, h = 100;
    const data = new Uint8Array(w * h * 4).fill(255);
    expect(decodeMarker(rgbaReader(data, w, h), 1)).toBeNull();
    expect(decodeMarker(rgbaReader(new Uint8Array(w * h * 4), w, h), 1)).toBeNull();
  });

  test("a wrong scale or a corrupted cell fails the check", () => {
    const t = Date.now();
    const img = paint(t, 99, 1);
    // flip one data cell (row 0, column 5)
    for (let y = 0; y < CELL; y++) for (let x = 5 * CELL; x < 6 * CELL; x++) { const o = (y * img.width + x) * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = 255 - img.data[o]!; }
    const m = decodeMarker(rgbaReader(img.data, img.width, img.height), 1);
    if (m !== null) expect(checksum(m.t24, m.frame)).not.toBe(-1); // only the check can let it through, 1 in 256
    expect(m === null || m.t24 !== (t & 0xffffff) || m.frame !== 99).toBe(true);
  });

  test("too small to read", () => {
    const img = paint(Date.now(), 1, 0.1);
    expect(decodeMarker(rgbaReader(img.data, img.width, img.height), 0.1)).toBeNull();
  });

  test("ageMs is signed and wraps at 2^24 ms", () => {
    expect(ageMs(1000, 900)).toBe(100);
    expect(ageMs(900, 1000)).toBe(-100);
    expect(ageMs(0x1000005, 0xfffffb)).toBe(10); // across the wrap
  });
});
