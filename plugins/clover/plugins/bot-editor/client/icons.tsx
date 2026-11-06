// The bot editor's line icons: Lucide's (ISC, `LICENSES/lucide-react.txt`), 16 px at Lucide's 2 stroke. Decorative:
// the control or text beside each carries the meaning.
import { ArrowLeft, Check, type LucideIcon } from "lucide-react";

function icon(Glyph: LucideIcon, size = 16) {
  const Icon = () => <Glyph className="cl-bot-editor-icon" size={size} strokeWidth={2} aria-hidden="true" focusable="false" />;
  Icon.displayName = `Icon(${Glyph.displayName ?? "lucide"})`;
  return Icon;
}

export const IconBack = icon(ArrowLeft);
export const IconCheck = icon(Check, 14);
