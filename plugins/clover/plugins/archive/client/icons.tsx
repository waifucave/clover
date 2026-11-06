// The archive's line icons: Lucide's (ISC, `LICENSES/lucide-react.txt`), 16 px at Lucide's 2 stroke. Decorative: the
// text beside each carries the meaning.
import { Archive, Search, type LucideIcon } from "lucide-react";

function icon(Glyph: LucideIcon, size = 16) {
  const Icon = () => <Glyph className="cl-archive-icon" size={size} strokeWidth={2} aria-hidden="true" focusable="false" />;
  Icon.displayName = `Icon(${Glyph.displayName ?? "lucide"})`;
  return Icon;
}

export const IconSearch = icon(Search);
export const IconArchive = icon(Archive, 20);
