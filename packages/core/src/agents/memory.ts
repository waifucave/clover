// Bots' memory is out of every agent's reach (the owner's decision for K-M3): an ACP or delegated agent, the delegating
// bot's own included, can't read or write any bot's memory folder (`<home>/bots/<bot>/memory/`, which the bot sees as
// `home/memory`). The folders go into every agent's sandbox as read and write denials, and a permission request that
// touches one is refused without a card, whatever the level. Lane C's fence refuses a root there (`checkAgentRoot`).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import { foldName, isInsideFolded, type SandboxPolicy } from "../contracts/fence";
import { botPaths } from "../bots/paths";

/** Every bot's memory folder on this computer: each folder under `<home>/bots/`, and the delegating bot's even before it
 *  has one. */
export function botMemoryFolders(home: string, bot?: string): string[] {
  const out = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(join(home, "bots"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    names = [];
  }
  for (const n of names) out.add(join(home, "bots", n, "memory"));
  if (bot !== undefined) out.add(botPaths(home, bot).memory);
  return [...out].sort();
}

/** Whether a path is in a bot's memory folder: any `<home>/bots/<x>/memory`, compared folded, so a bot that appears after
 *  the agent started is covered too. A folder that holds one (a bot's own, the home) is the fence's and the cards'
 *  business; the sandbox's denials keep the memory out of what a read of it sees. */
export function touchesBotMemory(home: string, path: string, os?: Os): boolean {
  const bots = join(home, "bots");
  if (!isInsideFolded(path, bots, os)) return false;
  const rest = path.split(/[\\/]+/).filter(Boolean).slice(bots.split(/[\\/]+/).filter(Boolean).length);
  return rest.length >= 2 && foldName(rest[1]!, os) === "memory";
}

/** The policy with the memory folders denied for reads and writes. */
export function withMemoryDenied(policy: SandboxPolicy, folders: readonly string[]): SandboxPolicy {
  const add = (list: readonly string[]) => [...list, ...folders.filter((f) => !list.includes(f))];
  return { ...policy, denyRead: add(policy.denyRead), denyWrite: add(policy.denyWrite) };
}

/** Deny rules for the file tools: a read-denied folder for every file tool, a write-denied one for the editing ones. */
export function fileToolDenials(denyRead: readonly string[], denyWrite: readonly string[]): string[] {
  const rules = (folders: readonly string[], tools: readonly string[]) => folders
    .map((p) => p.replace(/[\\/]+$/, ""))
    .filter((p) => p !== "")
    .flatMap((p) => tools.flatMap((t) => [`${t}(/${p})`, `${t}(/${p}/**)`]));
  return [...new Set([...rules(denyRead, ["Read", "Edit", "Write", "Glob", "Grep", "NotebookEdit"]), ...rules(denyWrite, ["Edit", "Write", "NotebookEdit"])])];
}
