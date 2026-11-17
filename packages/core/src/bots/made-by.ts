// Who may write a bot's instructions with the normal Write and Edit (spec §6.1, item 114; lane BT): the bot itself and
// the bot that made it, read from the records on the disk each time a check or a policy is built (the fence's
// `instructionsOf`), so a bot made a moment ago counts at once and nothing cached can go stale. Owner: lane BT.
//
// Read as it is on the disk, failing closed: a record that doesn't parse names no maker, and a bot whose `bots/<x>` or
// `bots/<x>/instructions` isn't a plain folder (a link, a file) is left out, so a write there is never opened through
// a link the fence would judge by its own name.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BOT_RECORD_FILE, BotRecord, isAnyPluginId } from "@waifucave/moss-protocol";

/** The longest `bot.json` read: a record is a few hundred bytes. */
export const BOT_RECORD_MAX_BYTES = 64 * 1024;

export const plainFolder = (path: string): boolean => {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
};

/** A `bot.json` as it is on the disk, or undefined (missing, a link, too big, malformed). */
export function readRecordFile(path: string): BotRecord | undefined {
  try {
    const st = lstatSync(path);
    // A second name (a hard link) means someone other than the core could have written it: no record.
    if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1 || st.size > BOT_RECORD_MAX_BYTES) return undefined;
    const parsed = BotRecord.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The bots whose instructions `bot` writes with no card: itself and every bot whose record names it as maker, each only
 *  while its folder and its instructions folder are plain folders. */
export function instructionsReach(mossHome: string, bot: string): string[] {
  if (!isAnyPluginId(bot)) return [];
  const bots = join(mossHome, "bots");
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(bots);
  } catch {
    return [];
  }
  for (const name of names) {
    const folder = join(bots, name);
    if (!plainFolder(folder) || !plainFolder(join(folder, "instructions"))) continue;
    const record = readRecordFile(join(folder, BOT_RECORD_FILE));
    if (record === undefined || record.id.replace("/", "--") !== name) continue;
    if (record.id === bot || (record.madeBy.kind === "bot" && record.madeBy.id === bot)) out.push(record.id);
  }
  return out;
}
