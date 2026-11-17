// Contract: BotRecords (spec revision 19, §6.1 "A bot is engine data", "A bot's data is its folder under the home's
// `bots/`", §6.2, §6.9; items 101, 113, 114; G8, R5). Owner: lane BT (bots as engine data and the move).
//
// A bot is a folder under the home (`bots/<seg>/`) with its record (`bot.json`, the user's), its instructions file
// (`instructions.md`, the `<bot-instructions>` block read at each turn), its memory and its agents' transcripts.
//
// What the contract promises:
// * `create` makes a record and an instructions file; the id comes from the name (lowercase letters, digits and single
//   hyphens, a letter first, as a plugin id; `bot` when the name gives none), made unique with `-2`, `-3`…; an id is
//   never reused while its folder exists.
// * `edit` is the user's: a field set to `null` goes back to what the name or the user's default gives.
// * Instructions follow `instructionsEditRule`: the bot itself and a bot that made it write with no card, another bot
//   gets `card` (nothing is written until the user's yes), a session that is no bot's is refused.
// * The move runs once: each plugin bot becomes a record with the same id (the user's layer over the plugin's values,
//   `madeBy: move`); an id that already has a record is kept as it is; the journal is written once, and a second `move`
//   changes nothing and answers the first journal.
import type { BotFace, BotMaker, BotMoveJournal, BotPatch, BotRecordView, BotVoice, Text } from "@waifucave/moss-protocol";
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
  /** Its plugin's default voice (`moss.voice.defaults`), if any. */
  voice?: BotVoice;
  /** The user's layer over the plugin's values (`user-layers/<bot>.json`): its fields win. */
  userLayer?: { name?: Text; instructions?: string; model?: string; effort?: string };
}

export type InstructionsEditor = { kind: "user" } | { kind: "bot"; id: string } | { kind: "other" };

export interface BotRecords {
  list(): BotRecordView[];
  get(id: string): BotRecordView | undefined;
  create(input: { name: Text; instructions?: string; model?: string; effort?: string; voice?: BotVoice; face?: BotFace }, by: BotMaker): Promise<BotRecordView>;
  edit(id: string, patch: BotPatch): Promise<BotRecordView>;
  remove(id: string): Promise<void>;
  instructions(id: string): string;
  writeInstructions(editor: InstructionsEditor, id: string, text: string): Promise<{ written: true } | { written: false; card: true }>;
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
