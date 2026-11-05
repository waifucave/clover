// The composer's line icons: Lucide's (ISC, `LICENSES/lucide-react.txt`), drawn in the text colour around
// them. 18 px at a 1.75 stroke in the box, 16 or 14 px at Lucide's 2 on the pills: a 1.3 px line, as the
// reference app's are. Decorative: the button beside each carries the label.
import { ArrowUp, Check, ChevronDown, File, Mic, Moon, Plus, ShieldCheck, Square, X, type LucideIcon } from "lucide-react";

function icon(Glyph: LucideIcon, size: number, fill = false) {
  const Icon = () => (
    <Glyph
      className="cl-composer-icon"
      size={size}
      strokeWidth={size >= 18 ? 1.75 : 2}
      fill={fill ? "currentColor" : "none"}
      aria-hidden="true"
      focusable="false"
    />
  );
  Icon.displayName = `Icon(${Glyph.displayName ?? "lucide"})`;
  return Icon;
}

export const IconPlus = icon(Plus, 18);
export const IconArrowUp = icon(ArrowUp, 16);
export const IconStop = icon(Square, 12, true);
export const IconMic = icon(Mic, 18);
export const IconCross = icon(X, 12);
export const IconFile = icon(File, 16);
export const IconChevronDown = icon(ChevronDown, 14);
export const IconCheck = icon(Check, 14);
export const IconMoon = icon(Moon, 16);
export const IconShield = icon(ShieldCheck, 14);
