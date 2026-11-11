// Mocked indexes and what they hold, as the core's `plugin.index.list` and `plugin.index.search` answer (lane B's
// `IndexView`, `IndexEntryView`), for the gallery and the tests.
import type { IndexEntryView, IndexView, PluginDetail, PluginSummary } from "../../shell/runtime/types";
import type { SettingRow } from "../client/entry";

/** Thursday, November 5, 2026, 16:30 UTC (the gallery's clock). */
export const NOW = Date.UTC(2026, 10, 5, 16, 30);

export const INDEXES: IndexView[] = [
  { url: "https://github.com/waifucave/clover-index", name: "Clover index", keys: ["ed25519:4f1a…"], official: true, lastCheckedAt: NOW - 12 * 60_000 },
  { url: "https://plugins.example.net/index.json", name: "Friends' plugins", keys: ["ed25519:9c0e…"], official: false, lastCheckedAt: NOW - 3 * 3_600_000 },
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

// ---- what is installed, as `plugin.list` and `plugin.get` answer ----


const summary = (id: string, name: string, o: Partial<PluginSummary> = {}): PluginSummary => ({
  id, name, version: "1.0.0", state: "running", enabled: true, source: "index", class: "code", namespace: id.replace(/[^a-z0-9]/g, "").slice(0, 40), scope: "both", adult: false, children: [], dev: false, ...o,
});

export const INSTALLED: PluginSummary[] = [
  summary("clover", "Clover", { source: "bundled", version: "0.4.0", children: ["clover/shell", "clover/settings"] }),
  summary("clover/shell", "Shell", { parent: "clover", source: "bundled" }),
  summary("clover/settings", "Settings", { parent: "clover", source: "bundled" }),
  summary("tarot-panel", "Tarot panel", { version: "1.2.0", description: "Draws a card each morning and keeps a reading journal beside the conversation." }),
  summary("weather-routine", "Weather routine", { version: "0.3.1", state: "found", enabled: false, reason: "waiting for your OK" }),
  summary("mcp-linear", "linear", { source: "wrapped", version: "0.0.0" }),
  summary("story-mode", "Story mode", { source: "index", state: "blocked", enabled: false, reason: "revoked by Friends' plugins: it sends your conversations to a server it doesn't name" }),
  summary("terminal-plus", "Terminal plus", { version: "0.9.0", state: "off", enabled: false }),
  summary("my-panel", "My panel", { source: "dev", dev: true, state: "stopped", reason: "plugin stopped: it crashed three times in two minutes" }),
];

export function installedDetail(id: string): PluginDetail {
  const s = INSTALLED.find((p) => p.id === id)!;
  const tarot = id === "tarot-panel";
  const linear = id === "mcp-linear";
  return {
    ...s,
    manifest: {
      manifest: 1, id, name: s.name, version: s.version,
      ...(tarot ? { description: "Draws a card each morning and keeps a reading journal beside the conversation.", contributes: { mcpServers: { tarot: { type: "host", tools: { DrawCard: "preload", ReadJournal: "on-demand" } } }, agents: [{ id: "reader", name: "Reader", backend: "claude-code" }] } } : {}),
      ...(linear ? { contributes: { mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } } } } : {}),
    },
    provenance: linear ? { by: "user-app", at: NOW, wrapped: { from: "mcp-config" } } : { by: "user-app", at: NOW, index: { url: INDEXES[0]!.url, version: s.version } },
    capabilities: tarot ? ["conversation.read", "notify", "network:api.tarot.example"] : [],
    networkHosts: tarot ? ["api.tarot.example"] : [],
    helperPermissions: [],
    issues: [],
    logTail: [],
    pinned: false,
  } as PluginDetail;
}

export const INSTALLED_SETTINGS: Record<string, SettingRow[]> = {
  "tarot-panel": [
    { key: "deck", type: "string", title: "Deck", scope: "account", value: "Rider–Waite", set: true },
    { key: "spread", type: "enum", title: { en: "Spread", ja: "スプレッド" }, scope: "account", options: ["three", { value: "celtic", title: "Celtic cross" }], value: "celtic", set: false },
    { key: "cards", type: "number", title: "Cards a day", scope: "account", min: 1, max: 10, value: 3, set: false },
    { key: "reversed", type: "boolean", title: "Reversed cards", scope: "account", value: false, set: false },
    { key: "region", type: "string", title: "Region", scope: "account", value: "eu", set: false, asks: true },
    { key: "voice", type: "string", title: "Reading voice", scope: "bot", value: "calm", set: false },
    { key: "TAROT_KEY", type: "secret", title: "Tarot API key", scope: "account", set: true },
  ],
};

export const INSTALLED_LOG = ["09:12:04 started", "09:12:05 drew The Star for today", "09:40:11 journal saved"];

/** What `plugin.ui` answers for the pictures: each plugin's own image, by id. */
export const INSTALLED_ICONS: Record<string, string> = { "tarot-panel": "assets/tarot card.png" };
