// The browser view's line icons: Lucide's (ISC, `LICENSES/lucide-react.txt`), pinned at lucide-react 1.61.0. In bars
// they are 18 px at stroke 1.75, in rows 16 px at stroke 2 (a 1.3 px line either way, as the reference app's).
// Decorative: the button or row beside each carries the label.
import { ArrowLeft, ArrowRight, CircleAlert, Globe, Hand, LoaderCircle, MousePointer2, Pause, Pencil, Plus, RotateCw, Square, Type, X } from "lucide-react";

const bar = { size: 18, strokeWidth: 1.75 } as const;
const row = { size: 16, strokeWidth: 2 } as const;
const common = { className: "cl-browser-icon", "aria-hidden": true, focusable: false } as const;

// Bars: the toolbar, the new-tab button and the annotate strip.
export const IconBack = () => <ArrowLeft {...bar} {...common} />;
export const IconForward = () => <ArrowRight {...bar} {...common} />;
export const IconReload = () => <RotateCw {...bar} {...common} />;
export const IconPlus = () => <Plus {...bar} {...common} />;
export const IconPointer = () => <MousePointer2 {...bar} {...common} />;
export const IconPen = () => <Pencil {...bar} {...common} />;
export const IconBox = () => <Square {...bar} {...common} />;
export const IconText = () => <Type {...bar} {...common} />;
export const IconStop = () => <X {...bar} {...common} />;

// Rows: a tab, and a line of text.
export const IconGlobe = () => <Globe {...row} {...common} />;
export const IconClose = () => <X size={14} strokeWidth={2} {...common} />;
export const IconAlert = () => <CircleAlert {...row} {...common} />;
export const IconPause = () => <Pause {...row} {...common} />;
export const IconHeld = () => <Hand size={14} strokeWidth={2} {...common} />;
/** A tab's globe while its page loads; the stylesheet turns it. */
export const IconLoading = () => <LoaderCircle {...row} {...common} data-spin="" />;
