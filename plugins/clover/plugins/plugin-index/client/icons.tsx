// The plugin index browser's line icons: Lucide's (ISC, `LICENSES/lucide-react.txt`), 16 px at Lucide's 2 stroke.
// Decorative: the control or text beside each carries the meaning.
import { BadgeCheck, Puzzle, Search, type LucideIcon } from "lucide-react";

function icon(Glyph: LucideIcon, size = 16) {
  const Icon = () => <Glyph className="cl-plugin-index-icon" size={size} strokeWidth={2} aria-hidden="true" focusable="false" />;
  Icon.displayName = `Icon(${Glyph.displayName ?? "lucide"})`;
  return Icon;
}

export const IconSearch = icon(Search);
export const IconPlugin = icon(Puzzle, 20);
export const IconOfficial = icon(BadgeCheck, 14);
