// One-shot moves of values the core used to keep for a plugin into that plugin's own settings
// (`<home>/settings/plugins/<id>.json`), so a feature re-founded as a plugin keeps the user's choices. Every boot,
// under the lock, before anything reads them; idempotent (once moved, the core's field is gone and there is nothing
// left to move); a value the plugin's settings already hold is never overwritten; never throws.
//
// The table is data, one row per move. Its only row today is F1's (Clover Voice re-founded on general capabilities):
// the speak-replies switch (`settings/ui.json` → `voice.speakReplies`) becomes the plugin's account setting
// `speakReplies`, and each bot's voice (its user layer's `voice`: `{ provider, voice, model? }`) becomes its bot
// settings `provider`, `voice` and `model`. The core reads neither field any more.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { userLayersDir } from "../bots/paths";
import { filePluginSettings, type PluginSettingValues } from "../plugin-host/api/settings";
import { uiSettingsFile } from "../plugin-host/ui-settings";
import { removeFileDurably, writeJsonAtomic } from "../sessions/atomic-file";

/** One move: a key of `ui.json` into an account setting, and a user-layer field into bot settings. */
export interface FieldMove {
  plugin: string;
  /** `ui.json`'s `[object, key]` → the plugin's account setting. */
  ui?: { from: readonly [string, string]; to: string };
  /** A user-layer field (an object) → bot settings, field by field (`{ provider: "provider", … }`). */
  userLayer?: { from: string; to: Readonly<Record<string, string>> };
}

export const FIELD_MOVES: readonly FieldMove[] = [
  { plugin: "clover/voice", ui: { from: ["voice", "speakReplies"], to: "speakReplies" }, userLayer: { from: "voice", to: { provider: "provider", voice: "voice", model: "model" } } },
];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Runs every move; what moved, for the log. */
export function moveFieldsToPluginSettings(home: string, o: { log?: (line: string) => void; moves?: readonly FieldMove[] } = {}): string[] {
  const moved: string[] = [];
  for (const move of o.moves ?? FIELD_MOVES) {
    try {
      moved.push(...moveOne(home, move));
    } catch (err) {
      o.log?.(`migration: moving ${move.plugin}'s settings out of the core failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const line of moved) o.log?.(`migration: ${line}`);
  return moved;
}

function moveOne(home: string, move: FieldMove): string[] {
  const store = filePluginSettings(home);
  let values: PluginSettingValues | undefined;
  const settings = (): PluginSettingValues => (values ??= store.read(move.plugin));
  const moved: string[] = [];
  const writes: (() => void)[] = [];

  if (move.ui !== undefined) {
    const file = uiSettingsFile(home);
    const ui = existsSync(file) ? readJsonFile(file) : undefined;
    const [object, key] = move.ui.from;
    if (isObject(ui) && object in ui) {
      const held = isObject(ui[object]) ? (ui[object] as Record<string, unknown>)[key] : undefined;
      if (held !== undefined && !(move.ui.to in settings().account)) {
        settings().account[move.ui.to] = held;
        moved.push(`${object}.${key} → ${move.plugin}'s ${move.ui.to}`);
      }
      const { [object]: _gone, ...rest } = ui;
      writes.push(() => writeJsonAtomic(file, rest));
    }
  }

  if (move.userLayer !== undefined) {
    const dir = userLayersDir(home);
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      names = [];
    }
    for (const n of names) {
      const path = join(dir, n);
      const stored = readJsonFile(path);
      if (!isObject(stored) || typeof stored.bot !== "string" || !isObject(stored.fields) || !(move.userLayer.from in stored.fields)) continue;
      const bot = stored.bot;
      const value = stored.fields[move.userLayer.from];
      if (isObject(value)) {
        const mine = (settings().bot[bot] ??= {});
        for (const [from, to] of Object.entries(move.userLayer.to)) {
          if (typeof value[from] === "string" && value[from] !== "" && !(to in mine)) mine[to] = value[from];
        }
        moved.push(`${bot}'s ${move.userLayer.from} → ${move.plugin}'s bot settings`);
      }
      const { [move.userLayer.from]: _gone, ...fields } = stored.fields;
      writes.push(() => (Object.keys(fields).length === 0 ? removeFileDurably(path) : writeJsonAtomic(path, { ...stored, fields })));
    }
  }

  // The plugin's settings first: a crash between the two leaves the core's field, and the next boot moves it again
  // (never over what was already moved).
  if (values !== undefined && moved.length > 0) store.write(move.plugin, values);
  for (const w of writes) w();
  return moved;
}
