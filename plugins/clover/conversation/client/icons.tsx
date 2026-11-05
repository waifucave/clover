// Line icons drawn in the text colour around them (`currentColor`), so a theme recolours them with
// the words they sit beside. Decorative: each is hidden from assistive tech, and the control or the
// text next to it carries the meaning.
import type { ReactNode } from "react";

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      className="cl-conv-icon"
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

export const IconCheck = () => (<Svg><path d="M3.5 8.5l3 3 6-7" /></Svg>);
export const IconCross = () => (<Svg><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></Svg>);
export const IconDash = () => (<Svg><path d="M4.5 8h7" /></Svg>);
export const IconDots = () => (<Svg><path d="M4 8h.01M8 8h.01M12 8h.01" strokeWidth="2.2" /></Svg>);
export const IconPause = () => (<Svg><path d="M6 4.5v7M10 4.5v7" /></Svg>);
export const IconChevron = () => (<Svg><path d="M6 4l4 4-4 4" /></Svg>);
export const IconCopy = () => (<Svg><rect x="5.5" y="5.5" width="7" height="7" rx="1.5" /><path d="M3.5 10.5v-6a1 1 0 0 1 1-1h6" /></Svg>);
export const IconShield = () => (<Svg><path d="M8 2.5l4.5 1.8v3.4c0 2.8-1.9 4.9-4.5 5.8-2.6-.9-4.5-3-4.5-5.8V4.3L8 2.5z" /></Svg>);
export const IconQuestion = () => (<Svg><circle cx="8" cy="8" r="5.5" /><path d="M6.6 6.4a1.5 1.5 0 1 1 2.1 1.4c-.5.2-.7.6-.7 1.1M8 11h.01" /></Svg>);
export const IconClock = () => (<Svg><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></Svg>);
export const IconAgent = () => (<Svg><rect x="3" y="5" width="10" height="7.5" rx="2" /><path d="M8 2.5V5M6 8.5h.01M10 8.5h.01" strokeWidth="1.8" /></Svg>);
export const IconTerminal = () => (<Svg><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M5 6.5l2 1.5-2 1.5M8.5 10h2.5" /></Svg>);
export const IconInfo = () => (<Svg><circle cx="8" cy="8" r="5.5" /><path d="M8 7.2v3.3M8 5.2h.01" /></Svg>);
export const IconWarning = () => (<Svg><path d="M8 2.8l5.5 9.7h-11L8 2.8z" /><path d="M8 6.8v2.6M8 11h.01" /></Svg>);
export const IconError = () => (<Svg><circle cx="8" cy="8" r="5.5" /><path d="M8 5.2v3.3M8 10.8h.01" /></Svg>);
export const IconPlug = () => (<Svg><path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2a3.5 3.5 0 0 1-7 0v-2zM8 11v2.5" /></Svg>);
export const IconFile = () => (<Svg><path d="M4.5 2.5h4.5l2.5 2.5v8.5h-7z" /><path d="M9 2.5V5h2.5" /></Svg>);
export const IconImage = () => (<Svg><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" /><circle cx="6" cy="6.8" r="1" /><path d="M13.5 10.5l-3-3-5 5" /></Svg>);
export const IconArrowDown = () => (<Svg><path d="M8 3.5v9M4.5 9l3.5 3.5L11.5 9" /></Svg>);
export const IconMessage = () => (<Svg><path d="M3 4.5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11h0a1.5 1.5 0 0 1-1-1.5z" /></Svg>);
