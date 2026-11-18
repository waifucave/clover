// Contract: BotRecords (spec revision 19, §6.1 "A bot is engine data", "A bot's data is its folder under the home's
// `bots/`", §6.2, §6.9; items 101, 114; G8, R5; the controller's rulings of 2026-11-17). Owner: lane BT (bots as engine data
// and the move).
//
// A bot is a folder under the home (`bots/<seg>/`) with its record (`bot.json`, the user's), its instructions file
// (`instructions/instructions.md`, the `<bot-instructions>` block read at each turn), its memory and its agents'
// transcripts. A bot holds no plugin's data: what a plugin keeps per bot is that plugin's own bot-scoped setting, which a
// window lists and sets for one bot here, generically (`pluginSettings`, `setPluginSetting`).
//
// What the contract promises:
// * `create` (the person's) makes a record and an instructions file; the id comes from the name (lowercase letters,
//   digits and single hyphens, a letter first, as a plugin id; `bot` when the name gives none), made unique with `-2`,
//   `-3`…; an id is never reused while a bot or an archived bot holds it.
// * A bot makes a bot through the `MakeBot` tool (`proposeByBot`): nothing exists until the person's yes on an OK card that
//   names the maker (`answerProposal`); the maker sets name, instructions and face; the model defaults to the maker's and
//   must be one the person has set up.
// * `edit` is the user's: a field set to `null` goes back to what the name or the user's default gives.
// * Instructions follow `instructionsEditRule`: the bot itself and a bot that made it write with no card, another bot
//   gets `card` (nothing is written until the user's yes), a session that is no bot's is refused.
// * `remove` archives: the bot leaves the list and comes back whole with `restore` (its record, instructions and plugin
//   settings); nothing is deleted.
// * A plugin's bot-scoped settings are read and set per bot; a setting of another scope, or one the plugin doesn't
//   declare, is refused.
// * The move: each plugin bot it is given becomes a record with the same id (the user's layer over the plugin's values,
//   `madeBy: move`); an id that already has a record is kept as it is. It runs at each start for what the journal
//   doesn't settle yet (a bot it is given that the journal doesn't name, a `failed` entry): a `moved` or `kept` entry is
//   final, and a run that settles nothing new changes nothing and answers the journal as it was (read 65's S4). The
//   journal's `at` is its first completion and never moves forward. Which bots it is given is the caller's: the bots
//   that existed before the split, decided from what the home holds (`bots/move.ts`), so a bot plugin installed after
//   the first completion is never given and makes no bot (decision 101).
import type { ArchivedBot, BotFace, BotMaker, BotMoveJournal, BotPatch, BotRecordView, MakeBotInput, MakeBotResult, Text } from "@waifucave/moss-protocol";
import type { Unsubscribe } from "./common";

/** A plugin bot as the move reads it (`bots/plugin-bot.ts`'s `PluginBot` and the user layer over it). */
export interface PluginBotForMove {
  plugin: string;
  id: string;
  name: Text;
  instructions: string;
  greeting?: string;
  model?: string;
  effort?: string;
  /** The user's layer over the plugin's values (`user-layers/<bot>.json`): its fields win. */
  userLayer?: { name?: Text; instructions?: string; model?: string; effort?: string };
}

export type InstructionsEditor = { kind: "user" } | { kind: "bot"; id: string } | { kind: "other" };

/** One plugin's bot-scoped settings with one bot's values. */
export interface BotPluginSettings {
  pluginId: string;
  settings: { key: string; value: unknown; set: boolean }[];
}

/** A bot's proposal of a new bot, waiting for the person's OK card, which names its maker. */
export interface BotProposal {
  id: string;
  maker: string;
  input: MakeBotInput;
}

export interface BotRecords {
  list(): BotRecordView[];
  get(id: string): BotRecordView | undefined;
  create(input: { name: Text; instructions?: string; model?: string; effort?: string; face?: BotFace }, by: BotMaker): Promise<BotRecordView>;
  /** The `MakeBot` tool: `setUp` is the models the person has set up. */
  proposeByBot(maker: string, input: MakeBotInput, setUp: readonly string[]): Promise<{ proposal: BotProposal; card: true } | Extract<MakeBotResult, { outcome: "refused" }>>;
  proposals(): BotProposal[];
  answerProposal(id: string, yes: boolean): Promise<MakeBotResult>;
  edit(id: string, patch: BotPatch): Promise<BotRecordView>;
  /** Archives it. */
  remove(id: string): Promise<void>;
  archived(): ArchivedBot[];
  restore(id: string): Promise<BotRecordView>;
  instructions(id: string): string;
  writeInstructions(editor: InstructionsEditor, id: string, text: string): Promise<{ written: true } | { written: false; card: true }>;
  pluginSettings(bot: string): BotPluginSettings[];
  setPluginSetting(bot: string, pluginId: string, key: string, value: unknown): Promise<void>;
  move(bots: readonly PluginBotForMove[]): Promise<BotMoveJournal>;
  journal(): BotMoveJournal | undefined;
  watch(fn: (change: { bot: BotRecordView } | { removed: string }) => void): Unsubscribe;
}

/** A bot's id from its name (above); `taken` says which ids are in use. */
export function botIdFromName(name: string, taken: (id: string) => boolean): string {
  const base = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 36).replace(/-+$/, "");
  const stem = base.length >= 2 ? base : "bot";
  if (!taken(stem)) return stem;
  for (let n = 2; ; n++) if (!taken(`${stem}-${n}`)) return `${stem}-${n}`;
}
