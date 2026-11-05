// The settings window's line icons: Lucide's (ISC, `LICENSES/lucide-react.txt`), drawn in the text colour
// around them, 16 px at Lucide's 2 stroke (a 1.3 px line, as the reference app's). Decorative: each is
// hidden from assistive tech, and the control or text beside it carries the meaning.
import { Bell, Bot, ChartColumn, Check, MonitorSmartphone, Palette, Puzzle, Search, ShieldCheck, User, X, type LucideIcon } from "lucide-react";
import type { SettingsSection } from "./types";

function icon(Glyph: LucideIcon, size = 16) {
  const Icon = () => <Glyph className="cl-settings-icon" size={size} strokeWidth={2} aria-hidden="true" focusable="false" />;
  Icon.displayName = `Icon(${Glyph.displayName ?? "lucide"})`;
  return Icon;
}

export const SECTION_ICONS: Record<SettingsSection, () => ReturnType<ReturnType<typeof icon>>> = {
  account: icon(User),
  devices: icon(MonitorSmartphone),
  appearance: icon(Palette),
  notifications: icon(Bell),
  plugins: icon(Puzzle),
  levels: icon(ShieldCheck),
  bots: icon(Bot),
  usage: icon(ChartColumn),
};
export const IconClose = icon(X, 18);
export const IconSearch = icon(Search);
export const IconCheck = icon(Check);
export const IconPlugin = icon(Puzzle);
