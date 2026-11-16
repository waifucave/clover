// The settings plugin's client entry: Settings on the runtime (`main` keyed `settings`), the settings window it draws,
// and the language chooser. It imports no CSS: `client.css` lists the stylesheet (lane B).
export { okWords, SettingsEntry } from "./entry";
export type { SettingsEntryProps } from "./entry";
export { LanguageChooser } from "./LanguageChooser";
export { SECTIONS, SettingsModal, sectionsMatching } from "./SettingsModal";
export { TOKENS } from "./tokens";
export type * from "./types";
