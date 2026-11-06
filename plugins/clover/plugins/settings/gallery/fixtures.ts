// Mock settings and languages for the gallery and the tests.
import type { Language, SettingsValues } from "../client/types";

export const VALUES: SettingsValues = {
  account: { name: "Sam", main: "Studio" },
  appearance: { theme: "system", textSize: "default" },
  language: { id: "en-US", name: "English (United States)" },
  notifications: { needsYou: true, agentDone: true, routineFailed: true, sounds: false },
  plugins: [
    { id: "clover", name: "Clover", source: "Bundled", state: "on", oks: ["Reads your bots and conversations", "Answers cards", "Uses your computers' files"] },
    { id: "tarot-panel", name: "Tarot panel", source: "From the plugin index", state: "on", oks: ["Reads conversations"] },
    { id: "weather-routine", name: "Weather routine", source: "From the plugin index", state: "waiting", oks: ["Reaches api.weather.example"] },
    { id: "story-mode", name: "Story mode", source: "From a folder: home/Laptop/code/story-mode", state: "failed", oks: [] },
  ],
  themes: [
    { id: "clover", name: "Clover" },
    { id: "alpha-tab", name: "Alpha's tab" },
  ],
  theme: "clover",
  levels: [
    { computer: "Studio", here: true, level: "risky" },
    { computer: "Laptop", level: "ask", requested: "accept-edits" },
    { computer: "Cloud computer", level: "automatic" },
  ],
  levelOptions: [
    { id: "read-only", label: "Read only" },
    { id: "ask", label: "Ask first" },
    { id: "risky", label: "Ask when risky" },
    { id: "accept-edits", label: "Accept edits" },
    { id: "automatic", label: "Fully automatic" },
  ],
  devices: [
    { id: "d1", name: "Studio", kind: "computer", here: true, main: true },
    { id: "d2", name: "Laptop", kind: "computer" },
    { id: "d3", name: "iPhone", kind: "phone" },
  ],
};

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
