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
  FileText,
  Globe,
  Image,
  Info,
  MessageSquare,
  Minus,
  Pause,
  Pencil,
  Plug,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  Wrench,
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
export const IconFileText = icon(FileText);
export const IconGlobe = icon(Globe);
export const IconPencil = icon(Pencil);
export const IconSparkles = icon(Sparkles);
export const IconWrench = icon(Wrench);
export const IconImage = icon(Image);
export const IconArrowDown = icon(ArrowDown);
export const IconMessage = icon(MessageSquare);

/** MOSS's own mark (assets/brand/moss-code/, docs/moss-brand.md): the Shards mark's one path in the kit's single-colour cut, as the source SVG draws it
 *  (scripts/brand-icons.test.ts holds it to them). It wears `plugin.moss.mark`: Night on light themes, Paper on
 *  dark ones; controls follow the OS accent. */
export const MOSS_MARK_PATH =
  "M674.7 145.6 L645.8 131.9 L603.5 119.2 L574.1 112.4 L542.8 107.8 L508.5 106.8 L481 108.3 L441 112.9 L406.2 120.5 L361.7 135.1 L324.2 153.4 L289.4 172.8 L265 191 L229.9 222.6 L200.3 254.4 L170.8 293.9 L150.8 329.2 L131.1 371.9 L129.6 376.8 L400.4 478.2 Z M863.3 365.3 L842.6 319 L827.8 292.2 L803.6 256.6 L776.5 225.2 L749 198.3 L717.6 175.1 L698.5 163.9 L424.9 491.1 L447.6 499.7 L830 702.2 L841.4 682.1 L859.3 643 L874 598.2 L880.5 572.7 L885.3 525.4 L887 491.1 L884.7 458.4 L877.8 412.9 Z M396.4 875.9 L419.4 881.5 L451.4 886.7 L485.5 888.8 L537.2 887.4 L579.8 881.4 L622.6 869.1 L669.7 850.7 L704.5 832.7 L735.6 811.6 L762.6 789.5 L786.1 766 L807.4 741.7 L818.7 726.7 L605.8 614.7 Z M125.1 402.1 L124.7 403.3 L117.3 433 L111.2 476.4 L109.5 502.5 L111 536.3 L114.1 565.2 L121.6 605.3 L131.1 633.7 L139.5 657.4 L153 685.3 L172.4 716 L195.1 746.7 L220.7 775.9 L257.4 807.5 L288.9 827.8 L322 847.6 L348.6 859.6 L364.8 865.3 L581.3 601.6 L441.2 525.9 Z";

export const IconMoss = ({ size = 16 }: { size?: number } = {}) => (
  <svg className="cl-conv-icon cl-conv-mark" width={size} height={size} viewBox="86 86 828 828" aria-hidden="true" focusable="false">
    <path fill="currentColor" d={MOSS_MARK_PATH} />
  </svg>
);
