// The panel's line icons, in the text colour around them. Decorative: hidden from assistive tech.
import type { ReactNode } from "react";

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg className="cl-panel-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const IconSession = () => (<Svg><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M5 6h6M5 8.5h6M5 11h3.5" /></Svg>);
export const IconTerminal = () => (<Svg><path d="M3 4.5L6.5 8 3 11.5M8 11.5h5" /></Svg>);
export const IconDiff = () => (<Svg><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M8 5v4M6 7h4M6 11h4" /></Svg>);
export const IconGlobe = () => (<Svg><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.7 5.9 5.7 8s.7 3.9 2.3 5.5" /></Svg>);
export const IconFolder = () => (<Svg><path d="M2.5 4.5A1 1 0 0 1 3.5 3.5h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" /></Svg>);
export const IconMore = () => (<Svg><path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.2" /></Svg>);
export const IconClose = () => (<Svg size={14}><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></Svg>);
export const IconExpand = () => (<Svg size={14}><path d="M9.5 3h3.5v3.5M13 3L9 7M6.5 13H3V9.5M3 13l4-4" /></Svg>);
export const IconChevronDown = () => (<Svg size={12}><path d="M4.5 6.5L8 10l3.5-3.5" /></Svg>);
export const IconChevronRight = () => (<Svg size={12}><path d="M6.5 4.5L10 8l-3.5 3.5" /></Svg>);
export const IconComputer = () => (<Svg><rect x="2.5" y="3.5" width="11" height="7.5" rx="1" /><path d="M5.5 13.5h5" /></Svg>);
export const IconBranch = () => (<Svg><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><path d="M4.5 5v6M11.5 7c0 2.5-3 3-6.5 4" /></Svg>);
export const IconPhone = () => (<Svg><rect x="5" y="2" width="6" height="12" rx="1.5" /><path d="M7.5 12h1" /></Svg>);
export const IconArtifact = () => (<Svg><rect x="5" y="2.5" width="8.5" height="8.5" rx="1.5" /><path d="M11 13.5H4A1.5 1.5 0 0 1 2.5 12V5" /></Svg>);
export const IconFile = () => (<Svg><path d="M4.5 2.5h4.5l2.5 2.5v8.5h-7z" /><path d="M9 2.5V5h2.5" /></Svg>);
export const IconImage = () => (<Svg><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" /><circle cx="6" cy="6.8" r="1" /><path d="M13.5 10.5l-3-3-5 5" /></Svg>);
export const IconPullRequest = () => (<Svg><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="12.5" r="1.5" /><path d="M4.5 5v6M11.5 11V6.5A2 2 0 0 0 9.5 4.5H7" /></Svg>);
export const IconAgent = () => (<Svg><rect x="3" y="5" width="10" height="7.5" rx="2" /><path d="M8 2.5V5M6 8.5h.01M10 8.5h.01" strokeWidth="1.8" /></Svg>);
