// The default bot's rename, carried to homes that already hold her (the owner's ruling of 2026-11-20: she is MOSS, coral,
// the kit's tile). A record an earlier build made says "Alpha", holds the earlier default's words and pins no face. Once,
// at the first start with this build, every part of her that is still exactly as an earlier default left it takes the
// new default, field by field; whatever the person changed is kept:
//   * name: exactly "Alpha", and the person's layer holds no name for her;
//   * instructions: the file is an earlier default's text (compared by hash, trailing space ignored), and the layer holds
//     no instructions for her;
//   * greeting: an earlier default's text, likewise;
//   * face: no pins at all gets the three.
// The step is recorded in `user-layers/moved/default-bot.json` (beside the move's journal, in the fenced folder) the first
// time her live record is looked at, whatever it changed, so it never runs twice: a person who later un-pins a trait or
// renames her is never overruled at the next start. A home where she is archived or absent is not marked: she is
// refreshed at the start after the person brings her back, if she is still untouched. Only the earlier defaults' hashes are
// kept here, to recognise them.
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { BotPatch, BotRecord, Text } from "@waifucave/moss-protocol";
import { writeJsonAtomic } from "../sessions/atomic-file";
import { DEFAULT_BOT_FACE, DEFAULT_BOT_GREETING, DEFAULT_BOT_ID, DEFAULT_BOT_INSTRUCTIONS, DEFAULT_BOT_NAME } from "./default-bot";
import type { UserLayerStore } from "./user-layer";

export const DEFAULT_BOT_REFRESH_FILE = ["user-layers", "moved", "default-bot.json"] as const;

const OLD_NAME = "Alpha";

const hash = (text: string): string => createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);

/** SHA-256 (first 16 hex digits) of every earlier default's instructions: the engine's own default of the build before
 *  this ruling, and the bundled `alpha` plugin's `bot/instructions.md` as it stood across its history (a home that moved
 *  her from the plugin era holds one of those). */
const OLD_INSTRUCTIONS = new Set([
  "39892f50c1799862", "718da5ebb6b5bc07", "dd710010569ae5f2", "a4b9409ba7f222ce", "6855e8ea00979d75", "51918ae507e4b90d",
]);
/** Likewise the greetings (the engine's, and the plugin's `bot/greeting.md`). */
const OLD_GREETINGS = new Set(["9adeec30946d0684", "eff1932000077e54", "6f261b7d51371a99"]);

interface Marker {
  refresh: 1;
  id: string;
  at: number;
  /** The fields it changed (none: all were the person's, or already new). */
  changed: string[];
}

/** What the store gives the step: her record and instructions, and a way to change them. */
export interface RefreshStore {
  record(id: string): BotRecord | undefined;
  instructions(id: string): string;
  edit(id: string, patch: BotPatch): Promise<unknown>;
}

const markerPath = (home: string) => join(home, ...DEFAULT_BOT_REFRESH_FILE);

/** Whether the step has run (or its marker is there and can't be read: then it is left alone). */
export function defaultBotRefreshed(home: string): boolean {
  try {
    lstatSync(markerPath(home));
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** The patch that takes her to the new default where she is still an earlier default's; empty when nothing is. */
export function refreshPatch(record: BotRecord, instructions: string, layer: { name?: Text; instructions?: string }): BotPatch {
  const patch: BotPatch = {};
  if (layer.name === undefined && record.name === OLD_NAME) patch.name = DEFAULT_BOT_NAME;
  if (layer.instructions === undefined && OLD_INSTRUCTIONS.has(hash(instructions))) patch.instructions = DEFAULT_BOT_INSTRUCTIONS;
  if (record.greeting !== undefined && OLD_GREETINGS.has(hash(record.greeting))) patch.greeting = DEFAULT_BOT_GREETING;
  if (record.face === undefined || Object.keys(record.face).length === 0) patch.face = DEFAULT_BOT_FACE;
  return patch;
}

/** Runs the step once. Returns the fields it changed, or undefined when it didn't run (already done, her record isn't
 *  there, or it isn't the default's own). */
export async function refreshDefaultBot(o: { home: string; store: RefreshStore; layers: Pick<UserLayerStore, "get">; now: () => number; warn?: (m: string) => void }): Promise<string[] | undefined> {
  // Everything here is inside the guard: a fault in this step is a line in the log, never a start that fails.
  try {
    if (defaultBotRefreshed(o.home)) return undefined;
    const record = o.store.record(DEFAULT_BOT_ID);
    // Hers only: made by the default, or moved from her plugin; a bot of the person's own that took the id is theirs.
    if (record === undefined || !(record.madeBy.kind === "default" || (record.madeBy.kind === "move" && record.madeBy.plugin === DEFAULT_BOT_ID))) return undefined;
    const patch = refreshPatch(record, o.store.instructions(DEFAULT_BOT_ID), o.layers.get(DEFAULT_BOT_ID));
    const changed = Object.keys(patch);
    if (changed.length > 0) await o.store.edit(DEFAULT_BOT_ID, patch);
    writeJsonAtomic(markerPath(o.home), { refresh: 1, id: DEFAULT_BOT_ID, at: o.now(), changed } satisfies Marker, { mode: 0o600 });
    return changed;
  } catch (err) {
    o.warn?.(`the default bot's rename wasn't carried over: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
