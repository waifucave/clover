// The sidebar's line icons: Lucide's (ISC, `LICENSES/lucide-react.txt`), drawn in the text colour around
// them. Decorative: each is hidden from assistive tech, and the control or text beside it carries the
// meaning. 18 px at a 1.75 stroke for the rows, 16 px at Lucide's 2 for small marks: both a 1.3 px line,
// as the reference app's icons are.
import {
  Archive,
  ArrowRight,
  ChartColumn,
  ChevronDown,
  ChevronRight,
  CodeXml,
  Folder,
  GitBranch,
  Globe,
  Grid2x2,
  Link,
  MessagesSquare,
  PanelLeft,
  Pause,
  Plus,
  Puzzle,
  Search,
  Settings,
  ShieldCheck,
  X,
  type LucideIcon,
} from "lucide-react";

function icon(Glyph: LucideIcon, size: number) {
  const Icon = () => <Glyph className="cl-sidebar-icon" size={size} strokeWidth={size >= 18 ? 1.75 : 2} aria-hidden="true" focusable="false" />;
  Icon.displayName = `Icon(${Glyph.displayName ?? "lucide"})`;
  return Icon;
}

export const IconBots = icon(MessagesSquare, 16);
export const IconCode = icon(CodeXml, 16);
export const IconPlus = icon(Plus, 18);
export const IconPlusSmall = icon(Plus, 16);
export const IconSearch = icon(Search, 18);
export const IconPlugins = icon(Puzzle, 18);
export const IconChevronDown = icon(ChevronDown, 14);
export const IconChevronRight = icon(ChevronRight, 14);
export const IconBranch = icon(GitBranch, 14);
export const IconGear = icon(Settings, 18);
export const IconClose = icon(X, 14);
export const IconShield = icon(ShieldCheck, 16);
export const IconPause = icon(Pause, 16);
export const IconLink = icon(Link, 16);
export const IconArrow = icon(ArrowRight, 16);
export const IconSidebar = icon(PanelLeft, 18);
export const IconFolder = icon(Folder, 18);
export const IconGlobe = icon(Globe, 18);
export const IconArchive = icon(Archive, 18);
export const IconChart = icon(ChartColumn, 18);
export const IconGrid = icon(Grid2x2, 18);

/** Clover's own mark: four round leaves around a centre, in Clover's pink (the one place the brand colour
 *  shows; controls follow the OS accent). */
export const CloverMark = ({ size = 16 }: { size?: number }) => (
  <svg className="cl-sidebar-icon cl-sidebar-mark" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <g fill="currentColor">
      <circle cx="8" cy="4.6" r="2.9" />
      <circle cx="11.4" cy="8" r="2.9" />
      <circle cx="8" cy="11.4" r="2.9" />
      <circle cx="4.6" cy="8" r="2.9" />
    </g>
  </svg>
);
