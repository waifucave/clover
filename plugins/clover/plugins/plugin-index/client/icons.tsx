// The plugin index browser's line icons: Lucide's (ISC, `LICENSES/lucide-react.txt`), 16 px at Lucide's 2 stroke.
// Decorative: the control or text beside each carries the meaning.
import { BadgeCheck, Puzzle, Search, type LucideIcon } from "lucide-react";
import { CLOVER_MARK_PATH } from "../../sidebar/client/icons";

function icon(Glyph: LucideIcon, size = 16) {
  const Icon = () => <Glyph className="cl-plugin-index-icon" size={size} strokeWidth={2} aria-hidden="true" focusable="false" />;
  Icon.displayName = `Icon(${Glyph.displayName ?? "lucide"})`;
  return Icon;
}

export const IconSearch = icon(Search);
export const IconPlugin = icon(Puzzle, 20);
export const IconOfficial = icon(BadgeCheck, 14);

/** Clover's own mark (the sidebar's, assets/brand/clover/), for the bundled `clover` tree's row. It wears
 *  `plugin.clover.mark`. */
export const CloverMark = ({ size = 20 }: { size?: number }) => (
  <svg className="cl-plugin-index-icon cl-plugin-index__mark" width={size} height={size} viewBox="0 0 200 200" aria-hidden="true" focusable="false">
    <path fill="currentColor" transform="translate(6 6) scale(0.94)" d={CLOVER_MARK_PATH} />
  </svg>
);
