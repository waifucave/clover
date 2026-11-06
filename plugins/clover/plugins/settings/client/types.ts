// The settings window's props: the values it shows and one door back for every change. A change to the
// core's settings goes straight to the host; anything sensitive (a computer's level, removing a device)
// becomes a sealed card there (spec §5.5). The window closes Settings while a card it draws waits, so
// asking from here closes it and the card shows in its place. A change still waiting on a card drawn
// elsewhere (asked from another device) shows here as asked for, beside the level that holds.
// Its sections are Clover's own (spec §5.8, §12); a page with nothing to set yet says so.

import type { ReactNode } from "react";

/** Clover's own sections. Usage is the usage plugin's, which fills `settings.section` (the controller's R3). */
export type SettingsSection = "account" | "devices" | "appearance" | "notifications" | "plugins" | "levels" | "bots";

/** A plugin's state (lane B's `PLUGIN_STATES`, spec §5.1): found and waiting for the user's OK, refused, invalid, off,
 *  waiting for a point another plugin declares, running, stopped after crashes, or blocked (revoked). */
export type PluginState = "found" | "refused" | "invalid" | "off" | "waiting" | "running" | "stopped" | "blocked";

export interface SettingsPlugin {
  id: string;
  name: string;
  /** Where it came from: bundled, the plugin index, a folder. */
  source: string;
  state: PluginState;
  /** Switched on: the toggle. A plugin can be on and still waiting or stopped. */
  enabled: boolean;
  /** Why it is in that state: "waiting for `island.tab`", what stopped it. */
  reason?: string;
  /** What it may do, each an OK the user gave it, in plain words. */
  oks: string[];
  /** The settings its manifest declares (§5.1 "Settings"), with their values. */
  settings?: SettingField[];
}

/** One setting a plugin's manifest declares (lane B's `PluginSettingView`, with the manifest's options and limits). A
 *  `secret` field never carries its value: only whether one is stored. */
export interface SettingField {
  key: string;
  type: "string" | "number" | "boolean" | "enum" | "color" | "secret";
  title: string;
  description?: string;
  /** The value in effect: the user's, else the default. */
  value?: unknown;
  /** The user set it; for a secret, a value is stored. */
  set: boolean;
  required: boolean;
  /** A changed default waits for the user's OK. */
  defaultPending?: boolean;
  options?: { value: string; title: string }[];
  min?: number;
  max?: number;
}

/** A plugin's settings, under its name. */
export interface PluginSettingsGroup {
  pluginId: string;
  name: string;
  fields: SettingField[];
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
  /** Light, dark or the system's, and the text size: the user's UI choices (`ui.settings`). */
  appearance: { theme: "light" | "dark" | "system"; textSize: "small" | "default" | "large" };
  language: { id: string; name: string };
  /** The plugins that notify (`notifiers`: desktop notifications, the phone's push), each with the settings it
   *  declares: when to notify, and with sound. A notifier's choices are its own settings, which it reads. */
  notifiers: PluginSettingsGroup[];
  plugins: SettingsPlugin[];
  /** The installed themes (spec §5.5: a theme is a plugin). */
  themes: { id: string; name: string }[];
  theme: string;
  levels: SettingsComputerLevel[];
  /** Clover's levels, from the most careful. */
  levelOptions: { id: string; label: string }[];
  devices: SettingsDevice[];
  /** The bots, for the Bots page: each opens in the bot editor. */
  bots?: { id: string; name: string }[];
}

/** A section a plugin adds (`settings.section`): its title, and what its page draws. */
export interface ExtraSection {
  id: string;
  title: string;
  render: () => ReactNode;
}

export interface SettingsModalProps {
  /** One of Clover's own sections, or an added one's id. */
  section: SettingsSection | string;
  onSection: (section: SettingsSection | string) => void;
  /** A row to bring into view and mark: a device's id on Devices, a plugin's id on Plugins, a computer's name on
   *  Levels, a bot's id on Bots. Other sections have nothing to mark. */
  item?: string;
  onClose: () => void;
  values: SettingsValues;
  /** One door for every plain change: a dotted path into `values` (`appearance.theme`) and the new value. */
  onChange: (path: string, value: unknown) => void;
  onOpenLanguage: () => void;
  onOpenPluginManager?: () => void;
  /** A found plugin's OK, reviewed on a sealed card (§5.1, §5.5): loading it is a sensitive change. */
  onReviewOk?: (id: string) => void;
  /** Change one of a plugin's declared settings (`plugin.settings.set`); `null` goes back to the default. */
  onPluginSetting?: (pluginId: string, key: string, value: unknown) => void;
  /** A plugin's logs (spec §5.8). */
  onOpenPluginLogs?: (id: string) => void;
  /** Ask to change a computer's level: always a sealed card (spec §5.5). */
  onRequestLevel?: (computer: string, level: string) => void;
  /** Ask to remove a device: a sealed card too. */
  onRemoveDevice?: (id: string) => void;
  /** Ask to make a computer the main one: a sealed card too (§6.4). */
  onMakeMain?: (id: string) => void;
  /** Pairing a device without an account (§8.1): the code this device shows, or the four words both show. */
  pairing?: SettingsPairing;
  /** Show a code here for another device to enter. */
  onPairBegin?: () => void;
  /** Enter the code another device shows. */
  onPairJoin?: (code: string) => void;
  /** The four words match on both devices: adding it is a sealed card. */
  onPairConfirm?: () => void;
  onPairCancel?: () => void;
  /** Sections plugins add, after Clover's own. */
  extraSections?: ExtraSection[];
  /** A plugin's log, shown on the Plugins page in place of the list. */
  logs?: { name: string; lines: string[]; onBack: () => void };
  /** Open a bot in the bot editor. */
  onEditBot?: (id: string) => void;
}

/** A pairing under way: the code to enter on the other device, then the four words both show. */
export interface SettingsPairing {
  code?: string;
  words?: string[];
  /** Asked for: its card waits. */
  confirming?: boolean;
  /** It ended without a device: why, in words. */
  ended?: string;
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
