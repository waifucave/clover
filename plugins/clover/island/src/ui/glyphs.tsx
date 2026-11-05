// The island's glyphs: small SVGs in place of the SF Symbols Winter's island drew (hand.raised.fill,
// bolt.fill, questionmark.bubble.fill, link, lock.fill, xmark, checkmark, arrow.up.right, chevrons,
// checkmark.circle). Each takes the current colour and sizes to its font size, as a symbol does.

import type { ReactElement, SVGProps } from "react";

export type GlyphName =
  | "hand"
  | "bolt"
  | "question"
  | "link"
  | "lock"
  | "xmark"
  | "check"
  | "open"
  | "chevronLeft"
  | "chevronRight"
  | "checkCircle";

const STROKE = { fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" } as const;

const PATHS: Record<GlyphName, ReactElement> = {
  hand: (
    <g fill="currentColor">
      <rect x="3.1" y="6.6" width="9.6" height="8.6" rx="3.6" />
      <rect x="3.6" y="2.6" width="2" height="7" rx="1" />
      <rect x="5.95" y="1" width="2" height="8" rx="1" />
      <rect x="8.3" y="1.5" width="2" height="7.6" rx="1" />
      <rect x="10.6" y="3" width="1.9" height="6.4" rx="0.95" />
      <rect x="11.1" y="6.9" width="2" height="5.2" rx="1" transform="rotate(32 12.1 9.5)" />
    </g>
  ),
  bolt: <path fill="currentColor" d="M9.4 0.8 3 9.1h4.3L6.4 15.2l6.6-8.4H8.6z" />,
  question: (
    <g>
      <path fill="currentColor" d="M3.4 1.6h9.2A2.4 2.4 0 0 1 15 4v6a2.4 2.4 0 0 1-2.4 2.4H8l-3.5 2.8v-2.8H3.4A2.4 2.4 0 0 1 1 10V4a2.4 2.4 0 0 1 2.4-2.4z" />
      <path {...STROKE} stroke="var(--glyph-cut, #000)" strokeWidth="1.5" d="M6.4 5.3a1.65 1.65 0 0 1 3.2.5c0 1.1-1.6 1.3-1.6 2.3" />
      <circle cx="8" cy="10.2" r="0.85" fill="var(--glyph-cut, #000)" />
    </g>
  ),
  link: (
    <g {...STROKE} strokeWidth="1.7">
      <path d="M6.8 9.2 9.2 6.8" />
      <path d="M7.4 4.6 8.6 3.4a2.6 2.6 0 0 1 3.7 3.7L11.1 8.3" />
      <path d="M8.6 11.4 7.4 12.6a2.6 2.6 0 0 1-3.7-3.7l1.2-1.2" />
    </g>
  ),
  lock: (
    <g>
      <path {...STROKE} strokeWidth="1.6" d="M5.2 7V5.1a2.8 2.8 0 0 1 5.6 0V7" />
      <rect x="3.2" y="6.6" width="9.6" height="7.6" rx="2" fill="currentColor" />
    </g>
  ),
  xmark: <path {...STROKE} strokeWidth="2.1" d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4" />,
  check: <path {...STROKE} strokeWidth="2.1" d="M3.6 8.4 6.7 11.4 12.5 4.7" />,
  open: <path {...STROKE} strokeWidth="2" d="M5 11 11 5M6.2 5H11v4.8" />,
  chevronLeft: <path {...STROKE} strokeWidth="2.1" d="M10 3.6 5.6 8l4.4 4.4" />,
  chevronRight: <path {...STROKE} strokeWidth="2.1" d="M6 3.6 10.4 8 6 12.4" />,
  checkCircle: (
    <g {...STROKE} strokeWidth="0.9">
      <circle cx="8" cy="8" r="6.6" />
      <path d="M5.2 8.2 7.1 10.1 10.9 6" />
    </g>
  ),
};

export interface GlyphProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: GlyphName;
  /** CSS size; defaults to the font size. */
  size?: number | string;
}

export function Glyph({ name, size = "1em", ...rest }: GlyphProps): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false" data-glyph={name} {...rest}>
      {PATHS[name]}
    </svg>
  );
}

export function kindGlyph(kind: "approval" | "link" | "question"): GlyphName {
  return kind === "question" ? "question" : kind === "link" ? "link" : "hand";
}
