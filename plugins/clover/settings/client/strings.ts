// Every string the settings window shows, for the move to `clover.` keys (plan, F-M3).
import type { PluginState, SettingsSection } from "./types";

export const S = {
  title: "Settings",
  close: "Close settings",
  search: "Find a setting",
  sections: "Sections",
  section: {
    account: "Account",
    devices: "Devices",
    appearance: "Appearance",
    notifications: "Notifications",
    plugins: "Plugins",
    levels: "Levels",
    bots: "Bots",
    usage: "Usage",
  } satisfies Record<SettingsSection, string>,
  later: "Nothing to set here yet.",
  laterDetail: "This page fills in with a later milestone.",
  noMatch: "No setting matches",
  // Account.
  name: "Your name",
  nameDetail: "What your bots call you.",
  main: "Main computer",
  mainDetail: "The computer that runs your bots when it's on.",
  // Devices.
  devices: "Paired devices",
  devicesDetail: "Every device sees every bot. Removing one asks you on a card first.",
  thisDevice: "This device",
  mainDevice: "Main",
  remove: (name: string) => `Remove ${name}`,
  removeLabel: "Remove",
  // Appearance.
  theme: "Light or dark",
  themeDetail: "Or follow the system.",
  themes: { light: "Light", dark: "Dark", system: "System" } as const,
  themePlugin: "Theme",
  themePluginDetail: "Themes are plugins: install one and it shows here.",
  textSize: "Text size",
  textSizes: { small: "Small", default: "Default", large: "Large" } as const,
  language: "Language",
  languageDetail: "For the app, the cards and the bots' replies to you.",
  change: "Change",
  // Notifications.
  notifyNeedsYou: "When a bot needs you",
  notifyNeedsYouDetail: "An approval or a question is waiting.",
  notifyAgentDone: "When a background agent finishes",
  notifyRoutineFailed: "When a routine fails",
  notifySounds: "Sounds",
  // Plugins.
  plugins: "Installed plugins",
  pluginsDetail: "Each runs with only the OKs you gave it. Turn one off to stop everything it adds.",
  pluginState: { on: "On", off: "Off", failed: "Stopped after an error", waiting: "Waits for your OK" } satisfies Record<PluginState, string>,
  pluginOks: (oks: string[]) => (oks.length === 0 ? "Asks for nothing" : oks.join(" · ")),
  pluginLogs: "Logs",
  pluginLogsFor: (name: string) => `${name}'s logs`,
  pluginManager: "Open the plugin manager",
  // Levels.
  levels: "Each computer's level",
  levelsDetail: "What its bots may do without asking you first. A change raises a card for you to answer.",
  levelFor: (computer: string) => `${computer}'s level`,
  levelAsked: (label: string) => `${label} asked for`,
  // The language chooser.
  chooseLanguage: "Language",
  searchLanguages: "Find a language",
  closeLanguages: "Close the language list",
  noLanguage: "No language matches",
};
