// Mock settings and languages for the gallery and the tests.
import type { Language, SettingsValues } from "../client/types";

export const VALUES: SettingsValues = {
  account: { name: "Sam", main: "Studio" },
  appearance: { theme: "system", textSize: "default" },
  language: { id: "en-US", name: "English (United States)" },
  // What the notifier plugins declare (each its own settings, §5.1): desktop notifications', as asked of its lane.
  notifiers: [
    {
      pluginId: "clover/notifications",
      name: "Desktop notifications",
      fields: [
        { key: "needsYou", type: "boolean", title: "When a bot needs you", description: "An approval or a question is waiting.", value: true, set: false, required: false },
        { key: "agentDone", type: "boolean", title: "When a background agent finishes", value: true, set: false, required: false },
        { key: "routineFailed", type: "boolean", title: "When a routine fails", value: true, set: false, required: false },
        { key: "sounds", type: "boolean", title: "Sounds", value: false, set: false, required: false },
      ],
    },
    { pluginId: "clover/push", name: "Phone notifications", fields: [] },
  ],
  plugins: [
    { id: "clover", name: "Clover", source: "Bundled", state: "running", enabled: true, oks: ["Reads your bots and conversations", "Answers cards", "Uses your computers' files"] },
    { id: "tarot-panel", name: "Tarot panel", source: "From the plugin index", state: "running", enabled: true, oks: ["Reads conversations"] },
    {
      id: "weather-routine", name: "Weather routine", source: "From the plugin index", state: "found", enabled: false, oks: ["Reaches api.weather.example"],
      settings: [
        { key: "city", type: "string", title: "City", value: "Lisbon", set: true, required: true },
        { key: "units", type: "enum", title: "Units", value: "metric", set: false, required: false, options: [{ value: "metric", title: "Celsius" }, { value: "imperial", title: "Fahrenheit" }] },
        { key: "hour", type: "number", title: "Hour of the forecast", value: 7, set: false, required: false, min: 0, max: 23 },
        { key: "apiKey", type: "secret", title: "API key", set: true, required: true },
      ],
    },
    { id: "story-mode", name: "Story mode", source: "From a folder: home/Laptop/code/story-mode", state: "stopped", enabled: true, adult: true, reason: "Stopped after three crashes in two minutes", oks: [] },
  ],
  themes: [
    { id: "clover", name: "Clover" },
    { id: "alpha-tab", name: "Alpha's tab" },
  ],
  theme: "clover",
  levels: [
    { computer: "Studio", here: true, level: "ask-risky" },
    { computer: "Laptop", level: "ask", requested: "accept-edits" },
    { computer: "Cloud computer", level: "automatic" },
  ],
  levelOptions: [
    { id: "read-only", label: "Read only" },
    { id: "ask", label: "Ask first" },
    { id: "ask-risky", label: "Ask when risky" },
    { id: "accept-edits", label: "Accept edits" },
    { id: "automatic", label: "Fully automatic" },
  ],
  devices: [
    { id: "d1", name: "Studio", kind: "computer", here: true, main: true },
    { id: "d2", name: "Laptop", kind: "computer" },
    { id: "d3", name: "iPhone", kind: "phone" },
  ],
  bots: [
    { id: "alpha", name: "Alpha" },
    { id: "beta", name: "Beta" },
  ],
};

/** A stopped plugin's log tail. */
export const LOG_LINES: string[] = [
  "14:02:11 started (pid 4121)",
  "14:02:12 registered the stage for Alpha",
  "14:05:40 TypeError: Cannot read properties of undefined (reading 'scene')",
  "14:05:40     at Stage.render (client/stage.tsx:88:14)",
  "14:05:41 restarted (pid 4188)",
  "14:05:44 TypeError: Cannot read properties of undefined (reading 'scene')",
  "14:05:45 restarted (pid 4190)",
  "14:05:49 TypeError: Cannot read properties of undefined (reading 'scene')",
  "14:05:49 stopped after three crashes in two minutes",
];

export const LANGUAGES: Language[] = [
  { id: "am", native: "አማርኛ", name: "Amharic" },
  { id: "bn", native: "বাংলা", name: "Bangla" },
  { id: "zh-Hans", native: "中文（简体）", name: "Chinese (Simplified)" },
  { id: "zh-Hant", native: "中文（繁體）", name: "Chinese (Traditional)" },
  { id: "da", native: "Dansk", name: "Danish" },
  { id: "nl", native: "Nederlands", name: "Dutch" },
  { id: "en-US", native: "English (United States)", name: "English (United States)" },
  { id: "en-GB", native: "English (United Kingdom)", name: "English (United Kingdom)" },
  { id: "fil", native: "Filipino", name: "Filipino" },
  { id: "fi", native: "Suomi", name: "Finnish" },
  { id: "fr", native: "Français", name: "French" },
  { id: "de", native: "Deutsch", name: "German" },
  { id: "gu", native: "ગુજરાતી", name: "Gujarati" },
  { id: "hi", native: "हिन्दी", name: "Hindi" },
  { id: "id", native: "Bahasa Indonesia", name: "Indonesian" },
  { id: "it", native: "Italiano", name: "Italian" },
  { id: "ja", native: "日本語", name: "Japanese" },
  { id: "ko", native: "한국어", name: "Korean" },
  { id: "pl", native: "Polski", name: "Polish" },
  { id: "pt-BR", native: "Português (Brasil)", name: "Portuguese (Brazil)" },
  { id: "es", native: "Español", name: "Spanish" },
  { id: "sv", native: "Svenska", name: "Swedish" },
  { id: "tr", native: "Türkçe", name: "Turkish" },
  { id: "uk", native: "Українська", name: "Ukrainian" },
];
