// Mocked indexes and what they hold, as the core's `plugin.index.list` and `plugin.index.search` answer (lane B's
// `IndexView`, `IndexEntryView`), for the gallery and the tests.
import type { IndexEntryView, IndexView } from "../../shell/runtime/types";

/** Thursday, November 5, 2026, 16:30 UTC (the gallery's clock). */
export const NOW = Date.UTC(2026, 10, 5, 16, 30);

export const INDEXES: IndexView[] = [
  { url: "https://github.com/waifucave/clover-index", name: "Clover index", key: "ed25519:4f1a…", official: true, lastCheckedAt: NOW - 12 * 60_000 },
  { url: "https://plugins.example.net/index.json", name: "Friends' plugins", key: "ed25519:9c0e…", official: false, lastCheckedAt: NOW - 3 * 3_600_000 },
];

const OFFICIAL = INDEXES[0]!.url;
const FRIENDS = INDEXES[1]!.url;
const v = (...versions: string[]) => versions.map((version, i) => ({ version, hash: `sha256-${i}` }));

export const ENTRIES: IndexEntryView[] = [
  { id: "tarot-panel", index: OFFICIAL, name: "Tarot panel", description: "Draws a card each morning and keeps a reading journal beside the conversation.", versions: v("1.0.0", "1.2.0"), installed: "1.2.0" },
  { id: "weather-routine", index: OFFICIAL, name: "Weather routine", description: "A routine that checks the forecast at 7 and tells your bot when to bring an umbrella.", versions: v("0.3.1") },
  { id: "chibi-pack", index: OFFICIAL, name: "Chibi pack", description: "Six small VRM avatars with portraits, for any bot.", versions: v("2.0.0", "2.1.0"), installed: "2.0.0" },
  { id: "terminal-plus", index: FRIENDS, name: "Terminal plus", description: "A terminal panel with split panes and saved layouts.", versions: v("0.9.0") },
  { id: "story-mode", index: FRIENDS, name: "Story mode", description: "Turns a bot's tab into a visual novel.", versions: v("0.1.0"), adult: true },
];
