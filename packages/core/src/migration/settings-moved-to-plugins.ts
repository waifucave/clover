// Settings that moved from the core to a plugin: when a feature leaves the core for a plugin, the values the core kept
// for it become that plugin's own settings (`<home>/settings/plugins/<id>.json`), so the user's choices go with it.
// Every boot, under the lock, before anything reads them; applied once in effect (a moved value's source is removed,
// so the next boot finds nothing to move); a value the plugin's settings already hold is never overwritten; each move
// is logged in one line; never throws.
//
// The table is data, one row per setting: where the core kept it (a key of `settings/ui.json`, or a key of a bot's
// user-layer field) and where it lives now (the plugin, the scope, the key). No row is special-cased below.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { userLayersDir } from "../bots/paths";
import { filePluginSettings, type PluginSettingValues } from "../plugin-host/api/settings";
import { uiSettingsFile } from "../plugin-host/ui-settings";
import { removeFileDurably, writeJsonAtomic } from "../sessions/atomic-file";

/** Where the core kept a setting: `ui.json`'s `[object, key]`, or `key` of a bot's user-layer field (an object). */
export type MovedFrom = { ui: readonly [string, string] } | { botField: string; key: string };

/** One setting that moved: from the core's place to a plugin's setting. A bot field moves to the `bot` scope (per bot).
 *  A row with `value` moves nothing: where the core's value equals `when`, it writes `value` to the plugin's key (a
 *  setting the old value implied), and leaves the core's value to the row that moves it, which comes after it; `with`:
 *  only while the plugin's setting it names isn't set (the value it implies belongs with that one). */
export type SettingMove =
  | { from: { ui: readonly [string, string] }; plugin: string; scope: "account" | "device"; key: string; when?: string; value?: string; with?: string }
  | { from: { botField: string; key: string }; plugin: string; scope: "bot"; key: string; when?: string; value?: string; with?: string };

export const SETTINGS_MOVED_TO_PLUGINS: readonly SettingMove[] = [
  // Speaking replies left the core for MOSS Voice (F1): its switch, and each bot's voice.
  { from: { ui: ["voice", "speakReplies"] }, plugin: "moss/voice", scope: "account", key: "speakReplies" },
  // A provider picked before providers were their plugins' own: Fish Audio's entry was the only one, and it is
  // Fish Audio's plugin's.
  { from: { botField: "voice", key: "provider" }, when: "fish-audio", value: "moss/fish-audio", with: "provider", plugin: "moss/voice", scope: "bot", key: "providerPlugin" },
  { from: { botField: "voice", key: "provider" }, plugin: "moss/voice", scope: "bot", key: "provider" },
  { from: { botField: "voice", key: "voice" }, plugin: "moss/voice", scope: "bot", key: "voice" },
  { from: { botField: "voice", key: "model" }, plugin: "moss/voice", scope: "bot", key: "model" },
];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

interface Layer {
  path: string;
  stored: { bot: string; fields: Record<string, unknown> } & Record<string, unknown>;
  changed: boolean;
}

/** Applies every row; the lines it logged (one per setting moved), without the `migration: ` prefix. */
export function moveSettingsToPlugins(home: string, o: { log?: (line: string) => void; moves?: readonly SettingMove[] } = {}): string[] {
  const moves = o.moves ?? SETTINGS_MOVED_TO_PLUGINS;
  const moved: string[] = [];
  try {
    const store = filePluginSettings(home);
    const plugins = new Map<string, PluginSettingValues>();
    const settingsOf = (id: string) => plugins.get(id) ?? (plugins.set(id, store.read(id)), plugins.get(id)!);
    const touched = new Set<string>();

    // The core's places, read once.
    const uiFile = uiSettingsFile(home);
    const uiRead = moves.some((m) => "ui" in m.from) && existsSync(uiFile) ? readJsonFile(uiFile) : undefined;
    const ui = isObject(uiRead) ? uiRead : undefined;
    let uiChanged = false;
    const layers: Layer[] = [];
    if (moves.some((m) => "botField" in m.from)) {
      let names: string[] = [];
      try {
        names = readdirSync(userLayersDir(home)).filter((n) => n.endsWith(".json"));
      } catch {
        names = [];
      }
      for (const n of names) {
        const path = join(userLayersDir(home), n);
        const stored = readJsonFile(path);
        if (isObject(stored) && typeof stored.bot === "string" && isObject(stored.fields)) layers.push({ path, stored: stored as Layer["stored"], changed: false });
      }
    }

    for (const m of moves) {
      if ("ui" in m.from) {
        const [object, key] = m.from.ui;
        const holder = ui?.[object];
        if (!isObject(holder) || !(key in holder)) continue;
        const held = holder[key];
        const mine = settingsOf(m.plugin)[m.scope as "account" | "device"];
        const value = m.value === undefined ? held : m.when === undefined || held === m.when ? m.value : undefined;
        if (value !== undefined && !(m.key in mine) && !(m.with !== undefined && m.with in mine)) {
          mine[m.key] = value;
          touched.add(m.plugin);
          moved.push(`${object}.${key} → ${m.plugin}'s ${m.scope} setting ${m.key}${m.value === undefined ? "" : ` (${String(value)})`}`);
        }
        if (m.value !== undefined) continue;
        delete holder[key];
        if (Object.keys(holder).length === 0) delete ui![object];
        uiChanged = true;
        continue;
      }
      const { botField, key } = m.from;
      for (const l of layers) {
        const field = l.stored.fields[botField];
        if (!isObject(field) || !(key in field)) continue;
        const held = field[key];
        const bot = l.stored.bot;
        const mine = (settingsOf(m.plugin).bot[bot] ??= {});
        const value = m.value === undefined ? held : m.when === undefined || held === m.when ? m.value : undefined;
        if (typeof value === "string" && value !== "" && !(m.key in mine) && !(m.with !== undefined && m.with in mine)) {
          mine[m.key] = value;
          touched.add(m.plugin);
          moved.push(`${bot}'s ${botField}.${key} → ${m.plugin}'s bot setting ${m.key}${m.value === undefined ? "" : ` (${value})`}`);
        }
        if (m.value !== undefined) continue;
        delete field[key];
        if (Object.keys(field).length === 0) delete l.stored.fields[botField];
        l.changed = true;
      }
    }

    // The plugins' settings first: a crash between the two leaves the core's values, and the next boot moves them
    // again (never over what was already moved).
    for (const id of touched) store.write(id, plugins.get(id)!);
    if (uiChanged && ui !== undefined) writeJsonAtomic(uiFile, ui);
    for (const l of layers) {
      if (!l.changed) continue;
      if (Object.keys(l.stored.fields).length === 0) removeFileDurably(l.path);
      else writeJsonAtomic(l.path, l.stored);
    }
  } catch (err) {
    o.log?.(`migration: moving settings from the core to their plugins failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const line of moved) o.log?.(`migration: ${line}`);
  return moved;
}
