// Clover's session ids and where each session's files live (spec §6.1 "User state lives outside the plugin folder",
// §6.3, §8.5 "Transcripts"). Owner: lane D.
//
// A bot's main conversation has an id that follows from the bot's id alone (`b_<segment>`), so the bot finds the same
// conversation after a restart, after its plugin is updated or switched off and on, and after its index is lost. Other
// sessions get a minted id with a prefix per kind. Every session's event log sits under `<home>/transcripts/`, in a
// folder per bot (its id with `/` written `--`, §5.1) or `_` for sessions with no bot. The transcripts are core storage,
// not part of the folder tree (§9.1): bots reach their memory and their agents' transcripts through `bots/<bot>/`, never
// this event log.
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { isAnyPluginId, pluginIdToSegment, type SessionKind } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";

/** The prefix of a minted id, per kind. A bot's main conversation is never minted: it is `mainSessionIdFor(bot)`. */
export const SESSION_ID_PREFIX: Readonly<Record<SessionKind, string>> = {
  bot: "b_",
  "side-thread": "t_",
  agent: "a_",
  coding: "c_",
};

export function mintSessionId(kind: SessionKind): string {
  return `${SESSION_ID_PREFIX[kind]}${randomBytes(6).toString("hex")}`;
}

/** The one conversation of a bot (§6.3): the same id on every boot, for `alpha` `b_alpha`, for `pack/luna`
 *  `b_pack--luna`. */
export function mainSessionIdFor(botId: string): string {
  return `b_${botSegment(botId)}`;
}

/** `<home>/transcripts`: every session's event log and its meta file. */
export function transcriptsDir(home: string): string {
  return join(home, "transcripts");
}

/** A bot's id as one path segment (`/` written `--`). Anything that isn't a plugin id is refused before it can name a
 *  path, so no id leads out of the folder it is joined to. */
export function botSegment(bot: string): string {
  if (!isAnyPluginId(bot)) throw new ContractError("invalid", `"${bot.slice(0, 80)}" isn't a bot's id`);
  return pluginIdToSegment(bot);
}

/** The folder holding a session's files: its bot's segment, or `_` for a session with no bot (no plugin id is `_`). */
export function sessionFolder(home: string, bot: string | undefined): string {
  return join(transcriptsDir(home), bot === undefined ? "_" : botSegment(bot));
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** A session's file name without its extension. The protocol's ids may hold `.` and `:`, which some file systems
 *  refuse or rewrite (Windows drops trailing dots and refuses `:`), so an id that isn't plainly safe is named by its
 *  hash; the meta file keeps the real id. */
export function sessionFileStem(id: string): string {
  if (/^[A-Za-z0-9_-]{1,96}$/.test(id) && !WINDOWS_RESERVED.test(id)) return id;
  return `h-${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
}

export function sessionLogPath(home: string, bot: string | undefined, id: string): string {
  return join(sessionFolder(home, bot), `${sessionFileStem(id)}.ndjson`);
}

export function sessionMetaPath(home: string, bot: string | undefined, id: string): string {
  return join(sessionFolder(home, bot), `${sessionFileStem(id)}.meta.json`);
}
