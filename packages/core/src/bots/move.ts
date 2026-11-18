// The one-time move of plugin bots into records (spec §6.1, §13 Split 1; R5, G9; the contract's `BotRecords.move`).
// Owner: lane BT.
//
// WHICH bots it moves: the bots that existed before the split ("pre-split"), decided from what the home holds, never
// from the moment the move first runs. A bot is pre-split when ANY of these holds:
//   (a) the journal (`user-layers/moved/bots.json`) names it (any outcome: a run before this one took it in);
//   (b) there is no journal yet (this is the first run) and the plugin registry lists a plugin that brings it;
//   (c) the home holds the plugin era's own record of it, dated before the journal's first completion (`at`, which a
//       later run never moves forward; every date counts while there is no journal):
//       * `transcripts/<seg>/bot.json`, the old bot service's state file (`{ bot, firstSeen, seededMemory }`), dated by
//         `firstSeen`; with records as the source only the move writes it, for a bot it moves;
//       * `transcripts/<seg>/b_<seg>.meta.json`, the bot's one conversation, `kind: "bot"`, dated by `startedAt`;
//       each names the bot's id in its `bot` field (`example-notes/bot` in the folder `example-notes--bot`), which must
//       be the folder's. A bot folder or a user layer alone is not a record of a bot that ran, and neither is the
//       conversation of an id a record the move didn't make holds (the person's own bot, live or archived).
// A plugin installed after the first completion is none of these: the journal doesn't name it, the first run didn't
// see it, and with records as the source nothing opens a plugin's bot, so the home holds no conversation or state file
// of it dated before. It makes no bot (spec decision 101: no plugin ships a bot).
//
// WHAT a moved record is made of:
// * a plugin the registry lists with a valid manifest that brings the bot (running, waiting for its OK, stopped, off),
//   through its folder (`loadPluginBot`: the instructions, greeting and starter-memories files its entry names, each
//   inside the folder); its manifest's name; the user's layer (`user-layers/<seg>.json`) over them (name,
//   instructions, model, effort). The model and effort are the user layer's, or the plugin's own only for MOSS's
//   bundled plugin (item 124: a bot's model is the person's choice). No face is pinned: the face shown is the one its
//   id gives, as for any bot with no pins.
// * a bot whose plugin is gone (no record in the registry and no folder under `plugins/`) or whose plugin no longer
//   brings it: from the plugin era's records alone: the user layer's name, else the conversation meta's `title`, else
//   the id; the user layer's instructions, else none (its plugin's file went with it); the user layer's model and
//   effort only. It goes straight into the archive (`archive/bots/<seg>/`), whole, as a bot whose plugin the person
//   switched off does: neither was in the person's list before the split, and `bot.restore` brings it back with its
//   conversation, memory and routines.
// * `madeBy: { kind: "move", plugin: <its id> }` (a bot's id is its plugin's, §6.1). `own-bot` parts reach it from that
//   plugin id only (the controller's ruling of 2026-11-17), whether the plugin came over or is installed again later.
//
// When something is missing or malformed:
// * a plugin that brings the bot but was never OK'd and has no record of the bot running before: `failed` ("its plugin
//   was never OK'd"), nothing written; tried again at each start, and moved once it is OK'd;
// * a bot entry whose files don't load (instructions missing, empty, a link out of the folder): `failed`, with why;
// * a plugin that is invalid or refused (a state that can be passing), or one whose folder is under `plugins/` but the
//   registry doesn't list: `failed`, tried again at the next start;
// * a state file or meta that is a link, has a second name, is over 64 KB or doesn't parse: not a record of a bot;
// * a user layer that doesn't parse: its fields that do parse are taken (the user layer's own reader), the rest ignored;
// * an unreadable journal: the move doesn't run, and `bot.move.status` says so (`held`, with the reason).
// A `moved` or `kept` entry is final: the bot isn't brought back once the person archives it, or removes its files.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BOT_ARCHIVE_DIR, BOT_MOVE_JOURNAL, BOT_RECORD_FILE, BotMoveJournal, isAnyPluginId, pluginIdFromSegment, topPluginIdOf, type Text } from "@waifucave/moss-protocol";
import type { PluginRecord, PluginRegistry } from "../contracts/plugin-registry";
import type { BotEntry } from "../contracts/sdk-types";
import { botSegment, mainSessionIdFor, sessionFileStem, transcriptsDir } from "../sessions/ids";
import { DEFAULT_BOT_ID } from "./default-bot";
import { BOT_RECORD_MAX_BYTES, readRecordFile } from "./made-by";
import { loadPluginBot } from "./plugin-bot";
import type { MoveInput } from "./records";
import { UserLayerStore, type UserLayer } from "./user-layer";

type Registry = Pick<PluginRegistry, "list" | "entries" | "get">;

/** Every plugin that brings a bot, whatever its state (an entry list holds only the plugins that are on, and a bot of
 *  one switched off must be moved too): its record, and its manifest's `bot` entry as validated. */
function pluginsWithBots(registry: Registry): { record: PluginRecord; entry: BotEntry }[] {
  const out = new Map<string, { record: PluginRecord; entry: BotEntry }>();
  for (const record of registry.list()) {
    const entry = (record.manifest as { contributes?: { bot?: unknown } } | undefined)?.contributes?.bot;
    if (entry !== undefined && entry !== null && typeof entry === "object" && !Array.isArray(entry) && isAnyPluginId(record.id)) out.set(record.id, { record, entry: entry as BotEntry });
  }
  for (const c of registry.entries("bot")) {
    const record = registry.get(c.pluginId);
    if (record !== undefined && !out.has(c.pluginId) && isAnyPluginId(c.pluginId)) out.set(c.pluginId, { record, entry: c.value as BotEntry });
  }
  return [...out.values()];
}

/** The journal as it is on the disk (undefined when there is none, or it doesn't parse: the move is then held). */
export function readMoveJournal(home: string): BotMoveJournal | undefined {
  const parsed = BotMoveJournal.safeParse(readSmallJson(join(home, ...BOT_MOVE_JOURNAL.split("/"))));
  return parsed.success ? parsed.data : undefined;
}

/** A small JSON file the core wrote, as it is on the disk: undefined for a link, a second name, over 64 KB or malformed. */
function readSmallJson(path: string): unknown {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1 || st.size > BOT_RECORD_MAX_BYTES) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The plugin era's record of a bot that ran on this home: its id, when, and the title its conversation had. */
export interface PreSplitBot {
  id: string;
  at: number;
  title?: string;
}

/** The bots the home holds the plugin era's record of (rule (c) above), dated before `before` when given. */
export function preSplitBots(home: string, before: number | undefined): Map<string, PreSplitBot> {
  const out = new Map<string, PreSplitBot>();
  const root = transcriptsDir(home);
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return out; }
  for (const seg of names.slice(0, 4096)) {
    if (seg === "_" || seg.startsWith(".")) continue;
    const dir = join(root, seg);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const named = (v: unknown): string | undefined => (typeof v === "string" && isAnyPluginId(v) && botSegment(v) === seg ? v : undefined);
    const state = readSmallJson(join(dir, "bot.json")) as { bot?: unknown; firstSeen?: unknown } | undefined;
    const fromState = named(state?.bot);
    // The conversation's meta, under the id the state file names, else the folder's own.
    const metaId = fromState ?? named(pluginIdFromSegment(seg));
    const meta = metaId === undefined ? undefined : readSmallJson(join(dir, `${sessionFileStem(mainSessionIdFor(metaId))}.meta.json`)) as { kind?: unknown; bot?: unknown; startedAt?: unknown; title?: unknown } | undefined;
    const metaOk = meta !== undefined && meta.kind === "bot" && named(meta.bot) === metaId;
    const id = fromState ?? (metaOk ? metaId : undefined);
    const at = fromState !== undefined && typeof state?.firstSeen === "number" ? state.firstSeen : metaOk && typeof meta.startedAt === "number" ? meta.startedAt : undefined;
    if (id === undefined || at === undefined) continue;
    const found: PreSplitBot = { id, at };
    if (metaOk && typeof meta.title === "string" && meta.title.trim() !== "") found.title = meta.title.trim().slice(0, 200);
    if (before !== undefined && !(found.at < before)) continue;
    out.set(found.id, found);
  }
  return out;
}

const layerFields = (layer: UserLayer) => ({
  ...(layer.name === undefined ? {} : { name: layer.name }),
  ...(layer.instructions === undefined ? {} : { instructions: layer.instructions }),
  ...(layer.model === undefined ? {} : { model: layer.model }),
  ...(layer.effort === undefined ? {} : { effort: layer.effort }),
});

/** What the move reads at a start, with the journal as it is: which plugin bots and which bots of the home's own records
 *  are pre-split, and where each one's plugin is. */
interface Survey {
  journal: BotMoveJournal | undefined;
  plugins: { record: PluginRecord; entry: BotEntry }[];
  home: Map<string, PreSplitBot>;
}

/** Whether a record the move didn't make holds the id (live or archived): the person's own bot, or one a bot made, whose
 *  conversation is the records era's, not a plugin bot's. */
function heldByAnother(home: string, id: string): boolean {
  const seg = botSegment(id);
  const madeBy = (readRecordFile(join(home, "bots", seg, BOT_RECORD_FILE)) ?? readRecordFile(join(home, ...BOT_ARCHIVE_DIR.split("/"), seg, "bot", BOT_RECORD_FILE)))?.madeBy;
  return madeBy !== undefined && !(madeBy.kind === "move" && madeBy.plugin === id) && !(madeBy.kind === "default" && id === DEFAULT_BOT_ID);
}

function survey(registry: Registry, home: string, journal: BotMoveJournal | undefined): Survey {
  const named = new Set((journal?.bots ?? []).map((b) => b.id));
  const evidence = preSplitBots(home, journal?.at);
  for (const id of [...evidence.keys()]) if (!named.has(id) && heldByAnother(home, id)) evidence.delete(id);
  // Rules (a), (b) and (c) for a plugin that brings a bot.
  const plugins = pluginsWithBots(registry).filter((p) => journal === undefined || named.has(p.record.id) || evidence.has(p.record.id));
  return { journal, plugins, home: evidence };
}

/** The pre-split plugin bots the registry lists, as the move takes them (the inputs before the default bot). */
export function pluginBotsForMove(registry: Registry, home: string, journal: BotMoveJournal | undefined = readMoveJournal(home)): MoveInput[] {
  const s = survey(registry, home, journal);
  const layers = new UserLayerStore(home);
  const out: MoveInput[] = [];
  for (const { record, entry } of s.plugins) {
    const name: Text = (entry as { name?: Text }).name ?? record.id;
    // A state that can be passing at a start (a manifest that didn't read, a refusal the person may not have made):
    // the bot isn't moved, and is tried again at the next start.
    if (record.state === "invalid" || record.state === "refused") {
      out.push({ plugin: record.id, id: record.id, name, instructions: "", failed: `its plugin is ${record.state}${record.reason === undefined ? "" : ` (${record.reason.slice(0, 300)})`}; it is tried again at the next start` });
      continue;
    }
    // Never OK'd, and never ran here: nothing of the person's is in it yet, and its words were never OK'd. A plugin
    // waiting for its OK again (its files changed for MOSS in the copy) whose bot ran before is moved now.
    if (record.source !== "bundled" && record.okHash === undefined && !s.home.has(record.id)) {
      out.push({ plugin: record.id, id: record.id, name, instructions: "", failed: "its plugin was never OK'd" });
      continue;
    }
    const load = loadPluginBot(record, entry);
    if (!load.ok) {
      out.push({ plugin: record.id, id: record.id, name, instructions: "", failed: load.reason });
      continue;
    }
    const b = load.bot;
    const userLayer = layerFields(layers.get(b.id));
    out.push({
      plugin: record.id, id: b.id, name: b.entry.name, instructions: b.instructions,
      ...(b.greeting === undefined ? {} : { greeting: b.greeting }),
      // Item 124: a bot's model is the person's choice. The plugin's own model tag is carried only from MOSS's own
      // bundled plugin (its choice never asks); a third party's isn't (the bot runs on the person's default model until
      // they pick one), so no provider the person never picked is spent on after the move. The user layer's always is.
      ...(b.entry.model === undefined || record.source !== "bundled" ? {} : { model: b.entry.model.default }),
      ...(b.entry.model?.effort === undefined || record.source !== "bundled" ? {} : { effort: b.entry.model.effort }),
      ...(Object.keys(userLayer).length === 0 ? {} : { userLayer }),
      ...(b.memorySeed === undefined ? {} : { memorySeed: b.memorySeed }),
      // A plugin the person switched off (their recorded decision: the plugin's own switch), or one that is off: its bot
      // goes into the archive, whole, for the person to bring back on purpose, never live.
      ...(!record.enabled || record.state === "off" ? { archive: true as const } : {}),
    });
  }
  return out;
}

/** The pre-split bots no listed plugin brings (rule (c), and a `failed` entry of one), as the move takes them: after the
 *  plugin bots and the default bot, so a bot either of those moves isn't taken from here too. `except`: ids moved
 *  otherwise (the default bot). */
export function leftoverBotsForMove(registry: Registry, home: string, journal: BotMoveJournal | undefined = readMoveJournal(home), except: ReadonlySet<string> = new Set()): MoveInput[] {
  const s = survey(registry, home, journal);
  const brought = new Set(s.plugins.map((p) => p.record.id));
  const layers = new UserLayerStore(home);
  const out: MoveInput[] = [];
  for (const bot of s.home.values()) {
    if (brought.has(bot.id) || except.has(bot.id)) continue;
    const layer = layers.get(bot.id);
    const name: Text = layer.name ?? bot.title ?? bot.id;
    const record = registry.get(bot.id);
    if (record !== undefined && (record.state === "invalid" || record.state === "refused")) {
      out.push({ plugin: bot.id, id: bot.id, name, instructions: "", failed: `its plugin is ${record.state}${record.reason === undefined ? "" : ` (${record.reason.slice(0, 300)})`}; it is tried again at the next start` });
      continue;
    }
    // A folder the registry doesn't list (its own: `plugins/<id>`, a pack's child `plugins/<pack>/plugins/<child>`), while
    // nothing of its top plugin is listed either: found late, not gone (a listed pack lists every child it has).
    const top = topPluginIdOf(bot.id);
    const own = bot.id === top ? join(home, "plugins", top) : join(home, "plugins", top, "plugins", bot.id.slice(top.length + 1));
    if (record === undefined && registry.get(top) === undefined && existsSync(own)) {
      out.push({ plugin: bot.id, id: bot.id, name, instructions: "", failed: "its plugin's folder is there but MOSS hasn't listed it yet; it is tried again at the next start" });
      continue;
    }
    // Its plugin is gone, or no longer brings it: from the plugin era's records, into the archive.
    const userLayer = layerFields(layer);
    out.push({
      plugin: bot.id, id: bot.id, name, instructions: "",
      ...(Object.keys(userLayer).length === 0 ? {} : { userLayer }),
      archive: true,
    });
  }
  return out;
}

/** Everything the move takes at a start, in order: the pre-split plugin bots the registry lists, then `offered` (the
 *  default bot), then the pre-split bots no listed plugin brings. A plugin input of an offered id that can't be moved (the
 *  bundled `alpha` as a stale record still says, its bot files gone with her plugin's bot) gives way to the offered one,
 *  so she isn't left without a record; the move takes the first input of each id. */
export function moveInputs(registry: Registry, home: string, journal: BotMoveJournal | undefined, offered: readonly MoveInput[] = []): MoveInput[] {
  const plugins = pluginBotsForMove(registry, home, journal);
  const usable = offered.length === 0 ? plugins : plugins.filter((b) => !(b.failed !== undefined && offered.some((d) => d.id === b.id)));
  return [...usable, ...offered, ...leftoverBotsForMove(registry, home, journal, new Set(offered.map((d) => d.id)))];
}

/** The pre-split bots that have no record yet (`bot.move.status`'s `pending`, and the ids the store holds back): what a
 *  later start may still move. */
export function pendingPluginBots(registry: Registry, home: string, has: (id: string) => boolean, journal: BotMoveJournal | undefined = readMoveJournal(home)): string[] {
  const s = survey(registry, home, journal);
  const settled = new Set((journal?.bots ?? []).filter((b) => b.outcome !== "failed").map((b) => b.id));
  // A `failed` entry counts while its plugin is listed or the home holds a record of it; one whose plugin went away
  // before its bot ever ran here has nothing left to move.
  const failed = (journal?.bots ?? []).filter((b) => b.outcome === "failed" && (registry.get(b.id) !== undefined || s.home.has(b.id))).map((b) => b.id);
  const ids = new Set([...s.plugins.map((p) => p.record.id), ...s.home.keys(), ...failed]);
  return [...ids].filter((id) => !settled.has(id) && !has(id));
}
