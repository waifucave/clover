// The settings this part reads and writes through the plugin API, each one declared in this plugin's manifest
// (`settings` in clover.json): the daemon refuses a key a manifest doesn't declare. A test keeps the two together.
import type { SettingsValues } from "./types";

type Appearance = SettingsValues["appearance"];
type Notifications = SettingsValues["notifications"];

export const APPEARANCE_KEYS = ["theme", "textSize"] as const satisfies readonly (keyof Appearance)[];
export const NOTIFICATION_KEYS = ["needsYou", "agentDone", "routineFailed", "sounds"] as const satisfies readonly (keyof Notifications)[];

export const settingKey = (group: "appearance" | "notifications", field: string): string => `${group}.${field}`;

/** Every key this part touches. */
export const OWN_SETTING_KEYS: readonly string[] = [
  ...APPEARANCE_KEYS.map((k) => settingKey("appearance", k)),
  ...NOTIFICATION_KEYS.map((k) => settingKey("notifications", k)),
];
