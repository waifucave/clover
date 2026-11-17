// The one-time move of plugin bots into records (spec §6.1, §13 Split 1; R5, G9; the contract's `BotRecords.move`).
// Owner: lane BT.
//
// What it READS, once, when the bot service starts with records as its source and no journal is there:
// * the plugin registry's `bot` entries, every one whatever its state (a plugin switched off still has a bot to move),
//   one per plugin (its id is the bot's id, `pack/luna` for a pack's child);
// * for each, its plugin's folder through the old loader (`loadPluginBot`): the instructions file, the greeting file and
//   the starter-memories folder its entry names, each inside the folder and never through a link out of it;
// * the user's layer over it (`user-layers/<seg>.json`): its name, instructions, model and effort win over the plugin's.
// What it WRITES, per bot that has no record yet (store.move): `bots/<seg>/instructions/instructions.md`, the starter
// memories into `bots/<seg>/memory/` when this computer never copied them (and the bot's state file saying so), then
// `bots/<seg>/bot.json` last; and, after every bot, the journal `user-layers/moved/bots.json`.
// What it leaves where it is: the bot's memory, agents' transcripts and conversation (`bots/<seg>/memory`, `agents`,
// `transcripts/<seg>/`, all under the same id), its routines, the user layer file (its LAN switch is still read from
// it), and the plugin itself: its Live2D figure, scenes and stage tools are a later lane's (an avatar pack).
//
// When something is missing or malformed:
// * a plugin whose record has no OK (never approved, refused) and isn't bundled: `failed`, "its plugin was never OK'd",
//   nothing written;
// * a bot entry whose files don't load (instructions missing, empty, a link out of the folder, a model tag that isn't a
//   qualified id): `failed`, with the loader's reason, nothing written;
// * a user layer that doesn't parse: its fields that do parse are taken (the user layer's own reader), the rest ignored;
// * a record already there under the id: `kept` (the move wrote it before a crash: `moved`);
// * an unreadable journal: the move doesn't run, and `bot.move.status` says so.
import { isAnyPluginId, type Text } from "@waifucave/moss-protocol";
import type { PluginRegistry } from "../contracts/plugin-registry";
import type { BotEntry } from "../contracts/sdk-types";
import { loadPluginBot } from "./plugin-bot";
import type { MoveInput } from "./records";
import { UserLayerStore } from "./user-layer";

/** Every plugin bot the registry knows, as the move takes it. */
export function pluginBotsForMove(registry: Pick<PluginRegistry, "entries" | "get">, home: string): MoveInput[] {
  const layers = new UserLayerStore(home);
  const out: MoveInput[] = [];
  const seen = new Set<string>();
  for (const c of registry.entries("bot")) {
    if (seen.has(c.pluginId) || !isAnyPluginId(c.pluginId)) continue;
    seen.add(c.pluginId);
    const record = registry.get(c.pluginId);
    if (record === undefined) continue;
    const entry = c.value as BotEntry;
    const name: Text = (entry as { name?: Text }).name ?? record.id;
    if (record.source !== "bundled" && record.okHash === undefined) {
      out.push({ plugin: record.id, id: record.id, name, instructions: "", failed: "its plugin was never OK'd" });
      continue;
    }
    const load = loadPluginBot(record, entry);
    if (!load.ok) {
      out.push({ plugin: record.id, id: record.id, name, instructions: "", failed: load.reason });
      continue;
    }
    const b = load.bot;
    const layer = layers.get(b.id);
    const userLayer = {
      ...(layer.name === undefined ? {} : { name: layer.name }),
      ...(layer.instructions === undefined ? {} : { instructions: layer.instructions }),
      ...(layer.model === undefined ? {} : { model: layer.model }),
      ...(layer.effort === undefined ? {} : { effort: layer.effort }),
    };
    out.push({
      plugin: record.id, id: b.id, name: b.entry.name, instructions: b.instructions,
      ...(b.greeting === undefined ? {} : { greeting: b.greeting }),
      // Item 124: a bot's model is the person's choice. The plugin's own model tag is carried only from MOSS's own
      // bundled plugin (its choice never asks); a third party's isn't (the bot runs on the person's default model until
      // they pick one), so no provider the person never picked is spent on after the move. The user layer's always is.
      ...(b.entry.model === undefined || record.source !== "bundled" ? {} : { model: b.entry.model.default }),
      ...(b.entry.model?.effort === undefined ? {} : { effort: b.entry.model.effort }),
      ...(Object.keys(userLayer).length === 0 ? {} : { userLayer }),
      ...(b.memorySeed === undefined ? {} : { memorySeed: b.memorySeed }),
    });
  }
  return out;
}

/** The plugin bots that have no record yet (`bot.move.status`'s `pending`, and the ids the store holds back). */
export function pendingPluginBots(registry: Pick<PluginRegistry, "entries">, has: (id: string) => boolean): string[] {
  const ids = new Set<string>();
  for (const c of registry.entries("bot")) if (isAnyPluginId(c.pluginId) && !has(c.pluginId)) ids.add(c.pluginId);
  return [...ids];
}
