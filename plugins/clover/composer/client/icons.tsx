// Line icons in the text colour around them; decorative (the button carries the label).
import type { ReactNode } from "react";

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      className="cl-composer-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconPlus = () => (<Svg><path d="M8 3.5v9M3.5 8h9" /></Svg>);
export const IconArrowUp = () => (<Svg><path d="M8 12.5v-9M4.5 7L8 3.5 11.5 7" /></Svg>);
export const IconStop = () => (<Svg><rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none" /></Svg>);
export const IconMic = () => (<Svg><rect x="6" y="2.5" width="4" height="7" rx="2" /><path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5v1.5" /></Svg>);
export const IconCross = () => (<Svg size={12}><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></Svg>);
export const IconFile = () => (<Svg><path d="M4.5 2.5h4.5l2.5 2.5v8.5h-7z" /><path d="M9 2.5V5h2.5" /></Svg>);
export const IconChevronDown = () => (<Svg size={12}><path d="M4 6l4 4 4-4" /></Svg>);
export const IconCheck = () => (<Svg size={14}><path d="M3.5 8.5l3 3 6-7" /></Svg>);
export const IconMoon = () => (<Svg><path d="M12.5 9.5A5 5 0 0 1 6.5 3.5a5 5 0 1 0 6 6z" /></Svg>);
