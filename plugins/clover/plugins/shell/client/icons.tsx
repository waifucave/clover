// The frame's line icons: Lucide's (ISC, `LICENSES/lucide-react.txt`), drawn in the text colour around them. 18 px at
// a 1.75 stroke in the bars, 16 px at Lucide's 2 elsewhere: both a 1.3 px line, as the reference app's icons are.
// Decorative: each is hidden from assistive tech, and the control or text beside it carries the meaning.
import { Bot, ChevronDown, Ellipsis, FileDiff, Folder, Globe, Maximize2, PanelRight, PencilLine, Puzzle, SquareTerminal, X, type LucideIcon } from "lucide-react";

function icon(Glyph: LucideIcon, size: number, className = "cl-panel-icon") {
  const Icon = () => <Glyph className={className} size={size} strokeWidth={size >= 18 ? 1.75 : 2} aria-hidden="true" focusable="false" />;
  Icon.displayName = `Icon(${Glyph.displayName ?? "lucide"})`;
  return Icon;
}

export const IconChevronDown = () => <ChevronDown className="cl-window-icon" size={14} strokeWidth={2} aria-hidden="true" focusable="false" />;

// The bar's toggles and the panel headers.
export const IconSession = icon(PanelRight, 18);
export const IconTerminal = icon(SquareTerminal, 18);
export const IconDiff = icon(FileDiff, 18);
export const IconGlobe = icon(Globe, 18);
export const IconFolder = icon(Folder, 18);
export const IconAgent = icon(Bot, 18);
export const IconMore = icon(Ellipsis, 18);
export const IconClose = icon(X, 18);
export const IconExpand = icon(Maximize2, 16);
export const IconPlugin = icon(Puzzle, 18);
export const IconEdit = icon(PencilLine, 18);
