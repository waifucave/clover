// A bot's child agents (the in-process subagents and Clover's coding agent started by a bot) are never wider than
// their bot, by construction (the coordinator's ruling on stage 2's review):
//
// * **One builder.** A child's command sandbox is drawn by the bot's own builder (`botSandboxSettings`): the run-later
//   denies over every root, the child's working folder included (the runtime always writes its cwd, so it is one of
//   the roots the denies are drawn under: `ownFolders`), the secret places denied for reads and writes, the PATH
//   folders held, git directories by content, the Clover home denied. The backend then puts `botSandbox()` on it
//   (enforce on, no unsandboxed command, `BOT_SANDBOX` last). A backend that draws a bot's child without it refuses
//   to start.
// * **Its commands card unless the bot holds the root** (`childCommandsHeld`): with a RequestAccess grant covering the
//   child's root (the conversation's or a kept one), a command runs in that sandbox with no card, as the bot's own;
//   without one, every command asks on a card, decided at each command (a grant withdrawn mid-run cards again). An
//   agent's root is never inside the bot's own folders: the fence's `checkAgentRoot` refuses the Clover home.
// * **Its file tools never write a run-later place** (`childRunsLater`): by the child's drawn denies, by name, and by
//   the path classes, refused before any card.
import { realpathSync } from "node:fs";
import type { SandboxSettingsConfig } from "@waifucave/clover-agent-sdk";
import type { Level, Os } from "@waifucave/clover-protocol";
import type { SandboxPolicy } from "../contracts/fence";
import type { AgentStartSpec } from "../contracts/agent-backend";
import { botSandboxSettings, rootCovered, runLaterByName } from "../fence/sandbox-settings";
import { pathFolders as pathFoldersOf, pathsClassOnDisk } from "../approvals/ordinary-paths";

export interface BotChildHomes {
  /** The Clover home. */
  cloverHome: string;
  /** The user's home. */
  userHome: string;
  os: Os;
  /** The folders on the user's PATH, read at each draw (the bot's own read). */
  pathFolders?: () => readonly string[];
}

/** The PATH's folders as the bot's sandbox reads them. */
export function hostPathFolders(os: Os): readonly string[] {
  return pathFoldersOf(os === "windows" ? process.env.Path ?? process.env.PATH : process.env.PATH, os);
}

/** A bot's child's command sandbox, by the bot's builder: before `botSandbox()`, which the backend puts on last. Its
 *  write roots are its policy's (temp: `botChildPolicy`), never wider than the bot's at that level. */
export function botChildSandboxSettings(policy: SandboxPolicy, o: BotChildHomes & { root: string; level: Level | undefined }): SandboxSettingsConfig {
  return botSandboxSettings(policy, {
    cloverHome: o.cloverHome, userHome: o.userHome, level: o.level, ownFolders: [o.root],
    pathFolders: (o.pathFolders ?? (() => hostPathFolders(o.os)))(),
    ...(o.os === "windows" ? { windows: true } : {}),
  });
}

/** Whether a bot's child's file write to `path` (absolute) is a run-later place: covered by the child's drawn
 *  `denyWrite`, a run-later name or fixed PATH folder (`runLaterByName`), or the path classes' card (a git directory,
 *  what a repository's config names, a folder on the PATH). Fails closed: true when any of it can't be worked out. */
export function botChildRunsLater(policy: SandboxPolicy, o: BotChildHomes & { root: string; level: Level | undefined }, path: string): boolean {
  try {
    const real = realPathOrNearest(path);
    const homes = { os: o.os, userHome: o.userHome, cloverHome: o.cloverHome };
    if (runLaterByName(path, homes) || runLaterByName(real, homes)) return true;
    const deny = botChildSandboxSettings(policy, o).filesystem?.denyWrite ?? [];
    if (rootCovered(real, deny, o.os)) return true;
    const folders = (o.pathFolders ?? (() => hostPathFolders(o.os)))();
    return pathsClassOnDisk([real], { home: o.userHome, os: o.os, cloverHome: o.cloverHome, pathFolders: folders }) === "card";
  } catch {
    return true;
  }
}

/** The bot's own shell write roots as its sandbox draws them at `level` (`botSandboxSettings`, its grants and own
 *  folders included), with its grants: a bot's child whose root these cover runs its commands with no card. At accept
 *  edits they are the home's ordinary top-level folders; at the default level its own folders and temp, where an
 *  agent's root can't be. */
export function botShellWriteRoots(botPolicy: SandboxPolicy, o: BotChildHomes & { level: Level | undefined; grants: readonly string[]; ownFolders: readonly string[] }): string[] {
  const drawn = botSandboxSettings(botPolicy, {
    cloverHome: o.cloverHome, userHome: o.userHome, level: o.level, grantedWrite: o.grants, ownFolders: o.ownFolders,
    pathFolders: (o.pathFolders ?? (() => hostPathFolders(o.os)))(), ...(o.os === "windows" ? { windows: true } : {}),
  });
  return [...o.grants, ...(drawn.filesystem?.allowWrite ?? [])];
}

/** Whether `folders` (the bot's grants, or its drawn shell write roots) cover `root`: one that is the root, or holds
 *  it, compared by real paths only (the review's blocker on cb5bac9a6: a path as written would let a link inside a
 *  granted folder stand for a folder outside it). A root or folder whose real path can't be read covers nothing. */
export function grantsCover(folders: readonly string[], root: string, os: Os): boolean {
  const real = realPathOf(root);
  if (real === undefined) return false;
  return folders.some((g) => {
    const rg = realPathOf(g);
    return rg !== undefined && rootCovered(real, [rg], os);
  });
}

/** A path's real path, or undefined when it can't be read. */
export function realPathOf(path: string): string | undefined {
  try { return realpathSync.native(path); } catch { return undefined; }
}

function realPathOrNearest(path: string): string {
  try { return realpathSync.native(path); } catch { return path; }
}

/** The backends' `botChild` (subagent-backend.ts `BotChildSandbox`) for these homes: the child drawn by the bot's
 *  builder at the level the manager handed (`level` on the spec), and its run-later check. */
export function botChildFor(homes: Omit<BotChildHomes, "os"> & { os?: Os }): { sandbox(spec: AgentStartSpec): SandboxSettingsConfig; runsLater(spec: AgentStartSpec, path: string): boolean } {
  const os: Os = homes.os ?? (process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux");
  const h: BotChildHomes = { ...homes, cloverHome: realPathOrNearest(homes.cloverHome), userHome: realPathOrNearest(homes.userHome), os };
  const levelOf = (spec: AgentStartSpec) => (spec as AgentStartSpec & { level?: Level }).level;
  return {
    sandbox: (spec) => botChildSandboxSettings(spec.fence, { ...h, root: spec.root, level: levelOf(spec) }),
    runsLater: (spec, path) => botChildRunsLater(spec.fence, { ...h, root: spec.root, level: levelOf(spec) }, path),
  };
}
