// The settings window's props: the values it shows and one door back for every change. A change to the
// core's settings goes straight to the host; anything sensitive (a computer's level, removing a device)
// becomes a sealed card there (spec §5.5). The window closes Settings while a card it draws waits, so
// asking from here closes it and the card shows in its place. A change still waiting on a card drawn
// elsewhere (asked from another device) shows here as asked for, beside the level that holds.
// Its sections are Clover's own (spec §5.8, §12); a page with nothing to set yet says so.

export type SettingsSection = "account" | "devices" | "appearance" | "notifications" | "plugins" | "levels" | "bots" | "usage";

/** A plugin's state, as the plugin manager knows it (spec §5.8). */
export type PluginState = "on" | "off" | "failed" | "waiting";

export interface SettingsPlugin {
  id: string;
  name: string;
  /** Where it came from: bundled, the plugin index, a folder. */
  source: string;
  state: PluginState;
  /** What it may do, each an OK the user gave it, in plain words. */
  oks: string[];
}

export interface SettingsDevice {
  id: string;
  name: string;
  kind: "computer" | "phone" | "web";
  /** This device. */
  here?: boolean;
  main?: boolean;
}

/** One computer's level (spec §9.1: levels are per computer). */
export interface SettingsComputerLevel {
  computer: string;
  /** This device. */
  here?: boolean;
  level: string;
  /** A change asked for, its card still waiting (one drawn on another device). */
  requested?: string;
}

export interface SettingsValues {
  account: { name: string; main: string };
  appearance: { theme: "light" | "dark" | "system"; textSize: "small" | "default" | "large" };
  language: { id: string; name: string };
  notifications: { needsYou: boolean; agentDone: boolean; routineFailed: boolean; sounds: boolean };
  plugins: SettingsPlugin[];
  /** The installed themes (spec §5.5: a theme is a plugin). */
  themes: { id: string; name: string }[];
  theme: string;
  levels: SettingsComputerLevel[];
  /** Clover's levels, from the most careful. */
  levelOptions: { id: string; label: string }[];
  devices: SettingsDevice[];
}

export interface SettingsModalProps {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
  values: SettingsValues;
  /** One door for every plain change: a dotted path into `values` (`appearance.theme`) and the new value. */
  onChange: (path: string, value: unknown) => void;
  onOpenLanguage: () => void;
  onOpenPluginManager?: () => void;
  /** A plugin's logs (spec §5.8). */
  onOpenPluginLogs?: (id: string) => void;
  /** Ask to change a computer's level: always a sealed card (spec §5.5). */
  onRequestLevel?: (computer: string, level: string) => void;
  /** Ask to remove a device: a sealed card too. */
  onRemoveDevice?: (id: string) => void;
}

export interface Language {
  id: string;
  /** Its name in itself. */
  native: string;
  /** Its name in the language the app shows now. */
  name: string;
}

export interface LanguageChooserProps {
  languages: Language[];
  current: string;
  onPick: (id: string) => void;
  onClose: () => void;
}
