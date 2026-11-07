// Where a bot's user data lives on this computer (spec §6.1 "User state lives outside the plugin folder", §6.5 "Where
// it lives", §9.1). Owner: lane D. Until C5 there is no folder tree, so the system prompt names these real paths
// (§6.5), and C5 changes the prompt, not the files.
//
// | Path                              | What                                   | Who writes it                       |
// | :-------------------------------- | :------------------------------------- | :---------------------------------- |
// | `<home>/bots/<bot>/memory/`       | `MEMORY.md` and the memory files: the tree's `home/memory/` | the bot's own sessions, with Write and Edit (§6.5) |
// | `<home>/bots/<bot>/agents/`       | its background agents' transcripts     | the core (lane K, §9.3)             |
// | `<home>/scratch/<bot>/`           | working files, never synced            | the bot                             |
// | `<home>/user-layers/<bot>.json`   | the user's changes to the bot (§6.1)   | the core only: in the fenced set    |
// | `<home>/transcripts/<bot>/`       | its sessions' event logs, and its core state | the core only               |
//
// `<bot>` is the bot's id with `/` written `--` (`pack--luna`, §5.1). The user layers' folder is part of the fenced
// set (§9.1 "bots' user layers"): lane C's fence names `userLayersDir(home)`.
import { isAbsolute, join, relative, sep } from "node:path";
import { botSegment, sessionFileStem, transcriptsDir } from "../sessions/ids";

export interface BotPaths {
  /** `<home>/bots/<bot>`: what the tree's `bots/<bot>/` will name (§9.1). */
  root: string;
  memory: string;
  agents: string;
  scratch: string;
}

/** Where a bot's memory is in its folder tree (§6.5, the owner's 2026-11-06 decision): `home/memory/`, beside
 *  `home/<Computer>/`, synced across all the user's computers (lane H), mapped onto `botPaths(…).memory` here (lane J).
 *  Only the bot's own sessions (its main conversation and side threads) reach it; coding sessions, agents and other
 *  bots don't (lanes C and B's per-caller fence). */
export const MEMORY_TREE_PATH = "home/memory";

export function botPaths(home: string, botId: string): BotPaths {
  const seg = botSegment(botId);
  const root = join(home, "bots", seg);
  return { root, memory: join(root, "memory"), agents: join(root, "agents"), scratch: join(home, "scratch", seg) };
}

/** A session's scratch folder on this computer (§6.5): its bot's (`<home>/scratch/<bot>/`), or for a session with no
 *  bot (a coding session the user started) one of its own, `<home>/scratch/_/<session>/`. Never synced. */
export function sessionScratchDir(home: string, session: { id: string; bot?: string }): string {
  return session.bot === undefined ? join(home, "scratch", "_", sessionFileStem(session.id)) : botPaths(home, session.bot).scratch;
}

/** A folder of this computer as a folder-tree path (§9.1): `home/<Computer>/` and its place under the user's home
 *  folder. Undefined for a folder outside the user's home (a test's temp home), which the tree doesn't name. */
export function homeTreePath(o: { userHome: string; computer: string; dir: string }): string | undefined {
  const rel = relative(o.userHome, o.dir);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return `home/${o.computer}/${rel.split(sep).join("/")}`;
}

/** The fenced folder of every bot's user layer (§9.1). */
export function userLayersDir(home: string): string {
  return join(home, "user-layers");
}

export function userLayerFile(home: string, botId: string): string {
  return join(userLayersDir(home), `${botSegment(botId)}.json`);
}

/** The core's own record of a bot on this computer (its starter memories copied, when it was first seen). */
export function botStateFile(home: string, botId: string): string {
  return join(transcriptsDir(home), botSegment(botId), "bot.json");
}
