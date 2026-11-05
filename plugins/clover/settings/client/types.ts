// The settings window's props: the values it shows and one door back for every change. A change to
// the core's settings from this layer goes straight to the host; anything sensitive (a device, a
// level) becomes a sealed card there (spec §5.5).

export type SettingsSection =
  | "account" | "usage" | "appearance" | "bots" | "capabilities" | "notifications" | "privacy" | "customize" | "code" | "devices" | "desktop";

export interface SettingsPlugin {
  id: string;
  name: string;
  /** Where it came from: bundled, the plugin index, a folder. */
  source: string;
  enabled: boolean;
}

export interface SettingsDevice {
  id: string;
  name: string;
  kind: "computer" | "phone" | "web";
  /** This device. */
  here?: boolean;
  main?: boolean;
}

export interface SettingsValues {
  account: { name: string; main: string };
  appearance: { theme: "light" | "dark" | "system"; textSize: "small" | "default" | "large" };
  language: { id: string; name: string };
  notifications: { needsYou: boolean; agentDone: boolean; routineFailed: boolean; sounds: boolean };
  plugins: SettingsPlugin[];
  themes: { id: string; name: string }[];
  theme: string;
  code: { branchPrefix: string; labelSessions: boolean; transcript: "normal" | "thinking" | "everything"; draftPrs: boolean; outputStyle: string };
  outputStyles: { id: string; name: string }[];
  devices: SettingsDevice[];
}

export interface SettingsModalProps {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
  values: SettingsValues;
  /** One door for every change: a dotted path into `values` (`appearance.theme`) and the new value. */
  onChange: (path: string, value: unknown) => void;
  onOpenLanguage: () => void;
  onOpenPluginManager?: () => void;
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
