// The shell's line icons, drawn in the text colour around them (`currentColor`). Decorative: each is
// hidden from assistive tech, and the control or text beside it carries the meaning.
import type { ReactNode } from "react";

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      className="cl-shell-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconBots = () => (<Svg><path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11A1.5 1.5 0 0 1 3 9.5z" /></Svg>);
export const IconCode = () => (<Svg><path d="M6 4.5L2.5 8 6 11.5M10 4.5L13.5 8 10 11.5" /></Svg>);
export const IconPlus = () => (<Svg><path d="M8 3v10M3 8h10" /></Svg>);
export const IconSearch = () => (<Svg><circle cx="7" cy="7" r="4" /><path d="M10 10l3 3" /></Svg>);
export const IconOutputs = () => (<Svg><rect x="5" y="2.5" width="8.5" height="8.5" rx="1.5" /><path d="M11 13.5H4A1.5 1.5 0 0 1 2.5 12V5" /></Svg>);
export const IconCustomize = () => (<Svg><rect x="2.5" y="5" width="11" height="8" rx="1.5" /><path d="M6 5V3.5h4V5" /></Svg>);
export const IconMore = () => (<Svg><path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.2" /></Svg>);
export const IconChevronDown = () => (<Svg size={12}><path d="M4.5 6.5L8 10l3.5-3.5" /></Svg>);
export const IconChevronRight = () => (<Svg size={12}><path d="M6.5 4.5L10 8l-3.5 3.5" /></Svg>);
export const IconBranch = () => (<Svg size={13}><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><path d="M4.5 5v6M11.5 7c0 2.5-3 3-6.5 4" /></Svg>);
export const IconGear = () => (<Svg><path d="M12.90 7.01 L14.54 7.14 L14.54 8.86 L12.90 8.99 L12.17 10.76 L13.23 12.02 L12.02 13.23 L10.76 12.17 L8.99 12.90 L8.86 14.54 L7.14 14.54 L7.01 12.90 L5.24 12.17 L3.98 13.23 L2.77 12.02 L3.83 10.76 L3.10 8.99 L1.46 8.86 L1.46 7.14 L3.10 7.01 L3.83 5.24 L2.77 3.98 L3.98 2.77 L5.24 3.83 L7.01 3.10 L7.14 1.46 L8.86 1.46 L8.99 3.10 L10.76 3.83 L12.02 2.77 L13.23 3.98 L12.17 5.24 Z" /><circle cx="8" cy="8" r="2" /></Svg>);
export const IconClose = () => (<Svg size={12}><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></Svg>);
export const IconShield = () => (<Svg><path d="M8 2.5l4.5 1.8v3.4c0 2.8-1.9 4.9-4.5 5.8-2.6-.9-4.5-3-4.5-5.8V4.3L8 2.5z" /></Svg>);
export const IconPause = () => (<Svg><path d="M6 4.5v7M10 4.5v7" /></Svg>);
export const IconLink = () => (<Svg><path d="M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1" /></Svg>);
export const IconSidebar = () => (<Svg><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M6.5 3v10" /></Svg>);
export const IconFolder = () => (<Svg><path d="M2.5 4.5A1 1 0 0 1 3.5 3.5h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" /></Svg>);
export const IconGlobe = () => (<Svg><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.7 5.9 5.7 8s.7 3.9 2.3 5.5" /></Svg>);
export const IconArchive = () => (<Svg><rect x="2.5" y="3" width="11" height="3" rx="1" /><path d="M3.5 6v6a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6M6.5 8.5h3" /></Svg>);
export const IconChart = () => (<Svg><path d="M3 13V3M3 13h10M6 11V8M9 11V5.5M12 11V7" /></Svg>);
export const IconGrid = () => (<Svg><rect x="3" y="3" width="4" height="4" rx="1" /><rect x="9" y="3" width="4" height="4" rx="1" /><rect x="3" y="9" width="4" height="4" rx="1" /><rect x="9" y="9" width="4" height="4" rx="1" /></Svg>);

/** Clover's own mark: four round leaves around a centre, filled in the text colour. */
export const CloverMark = ({ size = 16 }: { size?: number }) => (
  <svg className="cl-shell-icon cl-shell-mark" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <g fill="currentColor">
      <circle cx="8" cy="4.6" r="2.9" />
      <circle cx="11.4" cy="8" r="2.9" />
      <circle cx="8" cy="11.4" r="2.9" />
      <circle cx="4.6" cy="8" r="2.9" />
    </g>
  </svg>
);
