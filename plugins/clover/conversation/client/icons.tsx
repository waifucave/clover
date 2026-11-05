// The conversation's line icons: Lucide's (ISC, `LICENSES/lucide-react.txt`), drawn in the text colour
// around them, so a theme recolours them with the words they sit beside. 16 px at Lucide's 2 stroke, a
// 1.3 px line, as the reference app's are. Decorative: each is hidden from assistive tech, and the control
// or the text next to it carries the meaning.
import {
  ArrowDown,
  Bot,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Clock,
  Copy,
  Check,
  Ellipsis,
  File,
  Image,
  Info,
  MessageSquare,
  Minus,
  Pause,
  Plug,
  ShieldCheck,
  SquareTerminal,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";

function icon(Glyph: LucideIcon, size = 16) {
  const Icon = () => <Glyph className="cl-conv-icon" size={size} strokeWidth={2} aria-hidden="true" focusable="false" />;
  Icon.displayName = `Icon(${Glyph.displayName ?? "lucide"})`;
  return Icon;
}

export const IconCheck = icon(Check);
export const IconCross = icon(X);
export const IconDash = icon(Minus);
export const IconDots = icon(Ellipsis);
export const IconPause = icon(Pause);
export const IconChevron = icon(ChevronRight, 14);
export const IconCopy = icon(Copy);
export const IconShield = icon(ShieldCheck);
export const IconQuestion = icon(CircleHelp);
export const IconClock = icon(Clock);
export const IconAgent = icon(Bot);
export const IconTerminal = icon(SquareTerminal);
export const IconInfo = icon(Info);
export const IconWarning = icon(TriangleAlert);
export const IconError = icon(CircleAlert);
export const IconPlug = icon(Plug);
export const IconFile = icon(File);
export const IconImage = icon(Image);
export const IconArrowDown = icon(ArrowDown);
export const IconMessage = icon(MessageSquare);

/** Clover's own mark: four round leaves around a centre, in Clover's pink (the one place the brand colour
 *  shows; controls follow the OS accent). */
export const IconClover = () => (
  <svg className="cl-conv-icon cl-conv-mark" width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <g fill="currentColor">
      <circle cx="8" cy="4.6" r="2.9" />
      <circle cx="11.4" cy="8" r="2.9" />
      <circle cx="8" cy="11.4" r="2.9" />
      <circle cx="4.6" cy="8" r="2.9" />
    </g>
  </svg>
);
