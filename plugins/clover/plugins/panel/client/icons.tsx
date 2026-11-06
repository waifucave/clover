// The panel's line icons: Lucide's (ISC, `LICENSES/lucide-react.txt`), drawn in the text colour around
// them. 18 px at a 1.75 stroke in the bars, 16 px at Lucide's 2 in rows: both a 1.3 px line, as the
// reference app's icons are. Decorative: each is hidden from assistive tech, and the control or text
// beside it carries the meaning.
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  File,
  FileDiff,
  FileText,
  Folder,
  GitBranch,
  GitPullRequest,
  Globe,
  Image,
  Laptop,
  Maximize2,
  PanelRight,
  Puzzle,
  ShieldCheck,
  SquareTerminal,
  X,
  type LucideIcon,
} from "lucide-react";

function icon(Glyph: LucideIcon, size: number) {
  const Icon = () => <Glyph className="cl-panel-icon" size={size} strokeWidth={size >= 18 ? 1.75 : 2} aria-hidden="true" focusable="false" />;
  Icon.displayName = `Icon(${Glyph.displayName ?? "lucide"})`;
  return Icon;
}

// The bar's toggles and the panel headers.
export const IconSession = icon(PanelRight, 18);
export const IconTerminal = icon(SquareTerminal, 18);
export const IconDiff = icon(FileDiff, 18);
export const IconGlobe = icon(Globe, 18);
export const IconFolder = icon(Folder, 18);
export const IconMore = icon(Ellipsis, 18);
export const IconClose = icon(X, 18);
export const IconExpand = icon(Maximize2, 16);
export const IconPlugin = icon(Puzzle, 18);
// Rows.
export const IconChevronDown = icon(ChevronDown, 14);
export const IconChevronRight = icon(ChevronRight, 14);
export const IconComputer = icon(Laptop, 16);
export const IconLevel = icon(ShieldCheck, 16);
export const IconFolderRow = icon(Folder, 16);
export const IconBranch = icon(GitBranch, 16);
export const IconPage = icon(FileText, 16);
export const IconFile = icon(File, 16);
export const IconImage = icon(Image, 16);
export const IconDiffRow = icon(FileDiff, 16);
export const IconPullRequest = icon(GitPullRequest, 16);
export const IconAgent = icon(Bot, 16);
