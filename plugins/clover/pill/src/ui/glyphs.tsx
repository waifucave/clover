// The pill's glyphs: small shapes in place of the SF Symbols Winter's pill drew (stop.fill, arrow.up, mic.fill,
// ellipsis, the full-screen arrows, hand.raised.fill, exclamationmark.triangle.fill, the checkmark and the
// tool symbols its plume throws). Each is path data in a 16 × 16 box, so the same shape draws as an SVG in
// the bar and on a canvas in the plume.

import type { ReactElement, SVGProps } from "react";
import type { ToolGlyph } from "../model/plume";

interface Shape {
  d: string;
  /** Stroke width; a shape without one is filled. */
  stroke?: number;
  /** Drawn in the colour under the glyph: a hole cut through it. */
  cut?: boolean;
}

const circle = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
const rounded = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;

export type PillGlyphName =
  | "stop"
  | "arrowUp"
  | "mic"
  | "ellipsis"
  | "expand"
  | "hand"
  | "question"
  | "link"
  | "warning"
  | "check"
  | "xmark"
  | "chevronLeft"
  | "chevronDown"
  | "open"
  | "spinner"
  | ToolGlyph;

export const GLYPHS: Readonly<Record<PillGlyphName, readonly Shape[]>> = {
  stop: [{ d: rounded(3.5, 3.5, 9, 9, 1.6) }],
  arrowUp: [{ d: "M8 13.2V3.4M3.7 7.7 8 3.4l4.3 4.3", stroke: 2.1 }],
  mic: [{ d: rounded(5.5, 1.2, 5, 8.6, 2.5) }, { d: "M3.4 7.6a4.6 4.6 0 0 0 9.2 0M8 12.2v2.6", stroke: 1.6 }],
  ellipsis: [{ d: `${circle(3.4, 8, 1.45)}${circle(8, 8, 1.45)}${circle(12.6, 8, 1.45)}` }],
  expand: [{ d: "M9.6 2.4h4v4M13.6 2.4 9.2 6.8M6.4 13.6h-4v-4M2.4 13.6l4.4-4.4", stroke: 1.8 }],
  hand: [
    { d: rounded(3.1, 6.6, 9.6, 8.6, 3.6) },
    { d: "M4.6 3.6v5M6.95 2v6M9.3 2.5v5.6", stroke: 2 },
    { d: "M11.55 3.95v4.5", stroke: 1.9 },
    { d: "M12.95 8.14 11.25 10.86", stroke: 2 },
  ],
  question: [
    { d: "M3.4 1.6h9.2A2.4 2.4 0 0 1 15 4v6a2.4 2.4 0 0 1-2.4 2.4H8l-3.5 2.8v-2.8H3.4A2.4 2.4 0 0 1 1 10V4a2.4 2.4 0 0 1 2.4-2.4z" },
    { d: "M6.4 5.3a1.65 1.65 0 0 1 3.2.5c0 1.1-1.6 1.3-1.6 2.3", stroke: 1.5, cut: true },
    { d: circle(8, 10.2, 0.85), cut: true },
  ],
  link: [{ d: "M6.8 9.2 9.2 6.8M7.4 4.6 8.6 3.4a2.6 2.6 0 0 1 3.7 3.7L11.1 8.3M8.6 11.4 7.4 12.6a2.6 2.6 0 0 1-3.7-3.7l1.2-1.2", stroke: 1.7 }],
  warning: [
    { d: "M8 1.6c.5 0 .9.3 1.2.8l5.4 9.7c.5.9-.1 2-1.2 2H2.6c-1.1 0-1.7-1.1-1.2-2l5.4-9.7c.3-.5.7-.8 1.2-.8z" },
    { d: "M8 5.6v3.5", stroke: 1.7, cut: true },
    { d: circle(8, 11.5, 0.9), cut: true },
  ],
  check: [{ d: "M3.6 8.4 6.7 11.4 12.5 4.7", stroke: 2.1 }],
  xmark: [{ d: "M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4", stroke: 2.1 }],
  chevronLeft: [{ d: "M10 3.6 5.6 8l4.4 4.4", stroke: 2.1 }],
  chevronDown: [{ d: "M4 6.2 8 10.2l4-4", stroke: 1.9 }],
  open: [{ d: "M5 11 11 5M6.2 5H11v4.8", stroke: 2 }],
  spinner: [{ d: "M8 2.2a5.8 5.8 0 1 1-5.8 5.8", stroke: 2 }],
  terminal: [{ d: "M2.8 4.2 6.6 8l-3.8 3.8M8.4 12.2h5", stroke: 1.9 }],
  doc: [
    { d: "M4 1.8h5L12.6 5.4v7.8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1z", stroke: 1.5 },
    { d: "M8.8 2v3.6h3.6M5.4 8.6h4.8M5.4 11.2h4.8", stroke: 1.4 },
  ],
  pencil: [{ d: "M10.8 2.4 13.6 5.2 6 12.8l-3.6.8.8-3.6zM9.2 4l2.8 2.8", stroke: 1.6 }],
  search: [{ d: `${circle(6.9, 6.9, 4.3)}M10.1 10.1 13.9 13.9`, stroke: 1.9 }],
  globe: [{ d: `${circle(8, 8, 6.2)}M1.8 8h12.4M8 1.8c-2.2 2-2.2 10.4 0 12.4M8 1.8c2.2 2 2.2 10.4 0 12.4`, stroke: 1.4 }],
  people: [
    { d: `${circle(5.7, 5, 2.4)}${circle(11.4, 5.6, 1.9)}` },
    { d: "M1.4 13.6c0-2.6 1.9-4.4 4.3-4.4s4.3 1.8 4.3 4.4z" },
    { d: "M10.6 9.5c2.5-.5 4.4 1.1 4.4 4.1h-3.8c0-1.6-.2-2.9-.6-4.1z" },
  ],
  checklist: [{ d: "M2.4 4.3l1.3 1.3 2.2-2.4M2.4 10l1.3 1.3 2.2-2.4M8 4.6h5.6M8 10.3h5.6", stroke: 1.6 }],
  box: [{ d: "M8 1.8 13.6 4.8v6.4L8 14.2 2.4 11.2V4.8zM2.4 4.8 8 7.8l5.6-3M8 7.8v6.4", stroke: 1.5 }],
  sparkle: [{ d: "M8 1.2C8.7 5.3 10.7 7.3 14.8 8 10.7 8.7 8.7 10.7 8 14.8 7.3 10.7 5.3 8.7 1.2 8 5.3 7.3 7.3 5.3 8 1.2z" }],
};

export interface GlyphProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: PillGlyphName;
  /** CSS size; defaults to the font size. */
  size?: number | string;
}

export function Glyph({ name, size = "1em", ...rest }: GlyphProps): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false" data-glyph={name} {...rest}>
      {GLYPHS[name].map((shape, i) =>
        shape.stroke !== undefined ? (
          <path key={i} d={shape.d} fill="none" stroke={shape.cut ? "var(--glyph-cut, #000)" : "currentColor"} strokeWidth={shape.stroke} strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path key={i} d={shape.d} fill={shape.cut ? "var(--glyph-cut, #000)" : "currentColor"} />
        ),
      )}
    </svg>
  );
}

/** The 2D drawing calls a glyph needs: a real canvas context, or a test's recorder. */
export interface GlyphCanvas {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  fill(path: Path2D): void;
  stroke(path: Path2D): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
}

/** Draws a glyph centred on (x, y), `side` wide, in `color`; its cuts in `under`. Needs `Path2D` (every browser). */
export function drawGlyph(ctx: GlyphCanvas, name: PillGlyphName, x: number, y: number, side: number, color: string, under: string): void {
  if (typeof Path2D === "undefined") return;
  ctx.save();
  ctx.translate(x - side / 2, y - side / 2);
  ctx.scale(side / 16, side / 16);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const shape of GLYPHS[name]) {
    const path = new Path2D(shape.d);
    const tint = shape.cut ? under : color;
    if (shape.stroke !== undefined) {
      ctx.strokeStyle = tint;
      ctx.lineWidth = shape.stroke;
      ctx.stroke(path);
    } else {
      ctx.fillStyle = tint;
      ctx.fill(path);
    }
  }
  ctx.restore();
}
