// WCAG 2.x relative luminance and contrast, for the theme tests (and for anyone tuning a theme).
// Colours are `#RGB`, `#RRGGBB` or `#RRGGBBAA`; a translucent colour is composited over the ground
// it is drawn on before it is measured, the way brand.md §3.5 measured Winter's palette.

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0…1 */
  a: number;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isHexColor(value: string): boolean {
  return HEX.test(value);
}

export function parseHex(value: string): Rgba {
  const m = HEX.exec(value);
  if (!m) throw new Error(`not a hex colour: ${value}`);
  let hex = m[1]!;
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
}

/** `top` drawn over an opaque `ground`. */
export function composite(top: Rgba, ground: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + ground.r * (1 - a),
    g: top.g * a + ground.g * (1 - a),
    b: top.b * a + ground.b * (1 - a),
    a: 1,
  };
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(c: Rgba): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** The contrast of `fg` on `bg` (both hex). A translucent `bg` is first composited on `under`. */
export function contrast(fg: string, bg: string, under = "#FFFFFF"): number {
  const ground = composite(parseHex(bg), parseHex(under));
  const ink = composite(parseHex(fg), ground);
  const [hi, lo] = [luminance(ink), luminance(ground)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
