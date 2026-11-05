// Line icons in the text colour around them; decorative (the control carries the label).
import type { ReactNode } from "react";
import type { AppGlyph } from "./types";

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      className="cl-sidebar-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** The wordmark's four-leaf clover (a stand-in until lane G draws the real mark). */
export const IconClover = () => (
  <Svg size={18}>
    <circle cx="5.5" cy="5.5" r="2.5" fill="currentColor" stroke="none" />
    <circle cx="10.5" cy="5.5" r="2.5" fill="currentColor" stroke="none" />
    <circle cx="5.5" cy="10.5" r="2.5" fill="currentColor" stroke="none" />
    <circle cx="10.5" cy="10.5" r="2.5" fill="currentColor" stroke="none" />
    <path d="M10.5 10.5c.8 1.6 1.9 2.6 3.2 3.2" />
  </Svg>
);
export const IconPlus = () => (<Svg><path d="M8 3.5v9M3.5 8h9" /></Svg>);
export const IconSidebar = () => (<Svg><rect x="2.5" y="3" width="11" height="10" rx="2" /><path d="M6.5 3v10" /></Svg>);
export const IconGear = () => (<Svg><circle cx="8" cy="8" r="2" /><path d="M8 2.5v1.6M8 11.9v1.6M2.5 8h1.6M11.9 8h1.6M4.1 4.1l1.1 1.1M10.8 10.8l1.1 1.1M4.1 11.9l1.1-1.1M10.8 5.2l1.1-1.1" /></Svg>);
export const IconPuzzle = () => (<Svg><path d="M6.5 3.5a1.5 1.5 0 0 1 3 0V5h2.5v2.5h-1a1.5 1.5 0 0 0 0 3h1V13H9.5v-1a1.5 1.5 0 0 0-3 0v1H4v-2.5h1a1.5 1.5 0 0 0 0-3H4V5h2.5z" /></Svg>);
export const IconTerminal = () => (<Svg><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M5 6.5l2 1.5-2 1.5M8.5 10h2.5" /></Svg>);
export const IconCross = () => (<Svg size={12}><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></Svg>);
export const IconCheck = () => (<Svg size={14}><path d="M3.5 8.5l3 3 6-7" /></Svg>);
export const IconDots = () => (<Svg size={14}><path d="M4 8h.01M8 8h.01M12 8h.01" strokeWidth="2.2" /></Svg>);
export const IconDash = () => (<Svg size={14}><path d="M4.5 8h7" /></Svg>);
export const IconPause = () => (<Svg size={14}><path d="M6 4.5v7M10 4.5v7" /></Svg>);
export const IconClock = () => (<Svg size={14}><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></Svg>);
export const IconWarning = () => (<Svg><path d="M8 2.8l5.5 9.7h-11L8 2.8z" /><path d="M8 6.8v2.6M8 11h.01" /></Svg>);
export const IconLink = () => (<Svg><path d="M6.5 9.5l3-3M5.5 7.5l-1 1a2.1 2.1 0 0 0 3 3l1-1M10.5 8.5l1-1a2.1 2.1 0 0 0-3-3l-1 1" /></Svg>);
export const IconShield = () => (<Svg><path d="M8 2.5l4.5 1.8v3.4c0 2.8-1.9 4.9-4.5 5.8-2.6-.9-4.5-3-4.5-5.8V4.3L8 2.5z" /></Svg>);

const GLYPHS: Record<AppGlyph, () => ReactNode> = {
  globe: () => (<Svg><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.5 2.3 5.5S9.6 11.9 8 13.5C6.4 11.9 5.7 10 5.7 8S6.4 4.1 8 2.5z" /></Svg>),
  archive: () => (<Svg><rect x="2.5" y="3" width="11" height="3" rx="1" /><path d="M3.5 6v6.5h9V6M6.5 8.5h3" /></Svg>),
  chart: () => (<Svg><path d="M3 13h10M4.5 11V8M8 11V4.5M11.5 11V6.5" /></Svg>),
  grid: () => (<Svg><rect x="3" y="3" width="4" height="4" rx="1" /><rect x="9" y="3" width="4" height="4" rx="1" /><rect x="3" y="9" width="4" height="4" rx="1" /><rect x="9" y="9" width="4" height="4" rx="1" /></Svg>),
};

export function Glyph({ name }: { name: AppGlyph }) {
  return <>{GLYPHS[name]()}</>;
}
