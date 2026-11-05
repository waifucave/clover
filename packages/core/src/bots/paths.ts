// Where a bot's user data lives on this computer (spec §6.1 "User state lives outside the plugin folder", §6.5 "Where
// it lives", §9.1). Owner: lane D. Until C5 there is no folder tree, so the system prompt names these real paths
// (§6.5), and C5 changes the prompt, not the files.
//
// | Path                              | What                                   | Who writes it                       |
// | :-------------------------------- | :------------------------------------- | :---------------------------------- |
// | `<home>/bots/<bot>/memory/`       | `MEMORY.md` and the memory files       | the bot, with its file tools (§6.5) |
// | `<home>/bots/<bot>/agents/`       | its background agents' transcripts     | the core (lane K, §9.3)             |
// | `<home>/scratch/<bot>/`           | working files, never synced            | the bot                             |
// | `<home>/user-layers/<bot>.json`   | the user's changes to the bot (§6.1)   | the core only: in the fenced set    |
// | `<home>/transcripts/<bot>/`       | its sessions' event logs, and its core state | the core only               |
//
// `<bot>` is the bot's id with `/` written `--` (`pack--luna`, §5.1). The user layers' folder is part of the fenced
// set (§9.1 "bots' user layers"): lane C's fence names `userLayersDir(home)`.
import { join } from "node:path";
import { pluginIdToSegment } from "@waifucave/clover-protocol";
import { transcriptsDir } from "../sessions/ids";

export interface BotPaths {
  /** `<home>/bots/<bot>`: what the tree's `bots/<bot>/` will name (§9.1). */
  root: string;
  memory: string;
  agents: string;
  scratch: string;
}

export function botPaths(home: string, botId: string): BotPaths {
  const seg = pluginIdToSegment(botId);
  const root = join(home, "bots", seg);
  return { root, memory: join(root, "memory"), agents: join(root, "agents"), scratch: join(home, "scratch", seg) };
}

/** The fenced folder of every bot's user layer (§9.1). */
export function userLayersDir(home: string): string {
  return join(home, "user-layers");
}

export function userLayerFile(home: string, botId: string): string {
  return join(userLayersDir(home), `${pluginIdToSegment(botId)}.json`);
}

/** The core's own record of a bot on this computer (its starter memories copied, when it was first seen). */
export function botStateFile(home: string, botId: string): string {
  return join(transcriptsDir(home), pluginIdToSegment(botId), "bot.json");
}
