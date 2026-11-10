// A bot as its plugin declares it (spec §5.9 `Bot`, §6.1): the `bot` entry of a plugin's manifest, read from the
// plugin registry, with the files it names read from the plugin's folder. Owner: lane D.
//
// * **One bot per plugin**, and the bot's id is the plugin's id. A pack of bots keeps each one in a child plugin, so
//   a pack's bots are `pack/luna` and `pack/nova` (§6.1), whose files and folders write the `/` as `--` (§5.1).
// * Only an active `bot` entry of a plugin that is on is a bot. A plugin switched off, refused, blocked or removed
//   takes its bot away; its memory and its conversation stay under its id for when it comes back (§6.1).
// * The registry's validator already checked that the files exist inside the folder (B-M1, `validateTree`); reading
//   them checks again, so a symlink planted later still can't lead out of the folder.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { Contribution, PluginRecord, PluginRegistry } from "../contracts/plugin-registry";
import type { BotEntry } from "../contracts/sdk-types";
import { plainOf } from "../approvals/strings";
import { MODEL_ID_RE } from "./user-layer";

/** The longest `<bot-instructions>` a bot's plugin may give, as the user layer's (protocol `UserLayerPatch`). */
export const INSTRUCTIONS_MAX_CHARS = 200_000;
export const GREETING_MAX_CHARS = 20_000;

export interface PluginBot {
  /** The bot's id: its plugin's id (`alpha`, `pack/luna`). */
  id: string;
  /** The plugin's folder on this computer. */
  folder: string;
  /** Where the record the bot (and its model tag) came from was loaded from: `bundled` only for Clover's own staged
   *  copy (the registry's `bundledDirs`); whether its tags are the staged bytes' is the bot side's `bundledChoice`. */
  source: PluginRecord["source"];
  entry: BotEntry;
  /** Set by the bot service once per load (never here): whether `entry`'s model tag and voice are the ones Clover's
   *  own bundled plugin chose, as staging verified its bytes (`BotServiceOptions.bundledChoice`). */
  bundled?: { model: boolean; voice: boolean };
  /** The plugin's `<bot-instructions>` text. */
  instructions: string;
  greeting?: string;
  /** The plugin's starter-memories folder, as a real path. */
  memorySeed?: string;
}

export type PluginBotLoad = { ok: true; bot: PluginBot } | { ok: false; id: string; reason: string };

/** A file a manifest path names, as a real path inside the plugin's folder, or undefined. */
export function pluginPath(folder: string, path: string): string | undefined {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) return undefined;
  const full = resolve(folder, path);
  if (!existsSync(full)) return undefined;
  let realFolder: string;
  let real: string;
  try {
    realFolder = realpathSync(folder);
    real = realpathSync(full);
  } catch {
    return undefined;
  }
  return real === realFolder || real.startsWith(realFolder + sep) ? real : undefined;
}

function readText(folder: string, path: string, max: number): { ok: true; text: string } | { ok: false; reason: string } {
  const real = pluginPath(folder, path);
  if (real === undefined) return { ok: false, reason: `"${path}" isn't a file inside the plugin's folder` };
  if (!statSync(real).isFile()) return { ok: false, reason: `"${path}" isn't a file` };
  let text = readFileSync(real, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.length > max) return { ok: false, reason: `"${path}" is longer than ${max} characters` };
  return { ok: true, text };
}

export function loadPluginBot(record: Pick<PluginRecord, "id" | "folder" | "source">, entry: BotEntry): PluginBotLoad {
  const instructions = readText(record.folder, entry.instructions, INSTRUCTIONS_MAX_CHARS);
  if (!instructions.ok) return { ok: false, id: record.id, reason: `its instructions: ${instructions.reason}` };
  if (instructions.text.trim() === "") return { ok: false, id: record.id, reason: "its instructions are empty" };
  // A model the plugin names must be a qualified id (`<provider>/<model>`): its provider is what the user is asked
  // about, and nothing else may ride in the tag (#311 B2).
  if (entry.model !== undefined && !MODEL_ID_RE.test(entry.model.default)) {
    return { ok: false, id: record.id, reason: `its model "${plainOf(entry.model.default).slice(0, 200)}" isn't a qualified model id (<provider>/<model>)` };
  }
  const bot: PluginBot = { id: record.id, folder: record.folder, source: record.source, entry: structuredClone(entry), instructions: instructions.text };
  if (entry.greeting !== undefined) {
    const greeting = readText(record.folder, entry.greeting, GREETING_MAX_CHARS);
    if (!greeting.ok) return { ok: false, id: record.id, reason: `its greeting: ${greeting.reason}` };
    if (greeting.text.trim() !== "") bot.greeting = greeting.text.trim();
  }
  if (entry.memory !== undefined) {
    const seed = pluginPath(record.folder, entry.memory);
    if (seed === undefined || !statSync(seed).isDirectory()) return { ok: false, id: record.id, reason: `its starter memories: "${entry.memory}" isn't a folder inside the plugin` };
    bot.memorySeed = seed;
  }
  return { ok: true, bot };
}

/** Every bot the registry's plugins declare now: one per plugin that is on, whose `bot` entry is active. */
export function botEntries(registry: Pick<PluginRegistry, "entries" | "get">): { record: PluginRecord; contribution: Contribution<BotEntry> }[] {
  const out: { record: PluginRecord; contribution: Contribution<BotEntry> }[] = [];
  const seen = new Set<string>();
  for (const c of registry.entries("bot")) {
    if (c.state !== "active" || seen.has(c.pluginId)) continue;
    const record = registry.get(c.pluginId);
    if (record === undefined || record.state !== "running") continue;
    seen.add(c.pluginId);
    out.push({ record, contribution: c });
  }
  return out;
}
