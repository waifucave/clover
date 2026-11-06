// Bots' memory is out of every agent's reach (the owner's decision for K-M3): an ACP or delegated agent, the delegating
// bot's own included, can't read or write any bot's memory folder (`<home>/bots/<bot>/memory/`, which the bot sees as
// `home/memory`). Denied by pattern, so a bot created after the agent started is covered too: every agent's sandbox
// gets `<home>/bots/*/memory` as a read denial (the runtime's sandbox and Claude Code's rules take globs), with each
// bot's folder named as well for a sandbox that doesn't, and `<home>/bots` whole as a write denial, which needs no glob
// (an agent never writes there: the daemon writes its transcripts). A permission request into any bot's memory is
// refused without a card, whatever the level. Lane C's fence refuses a root there (`checkAgentRoot`).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import { foldName, isInsideFolded, type SandboxPolicy } from "../contracts/fence";
import { botPaths } from "../bots/paths";
import { ContractError } from "../contracts/common";

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

/** The policy an agent's sandbox starts from. A bot's own Bash may work in its own memory (the controller's ruling: B's
 *  policy carries that as `ownMemory`, applied after the denials); an agent never may, so a policy that carries it is
 *  refused here and the agent doesn't start. */
export function agentPolicyOf(policy: SandboxPolicy): SandboxPolicy {
  if ((policy as SandboxPolicy & { ownMemory?: unknown }).ownMemory !== undefined) {
    throw new ContractError("refused", "an agent's sandbox may never carry a bot's own memory (ownMemory), so the agent wasn't started");
  }
  return policy;
}

/** Every bot's memory, as a pattern: `<home>/bots/<any bot>/memory` with a `*` for the bot. */
export function botMemoryPattern(home: string): string {
  return join(home, "bots", "*", "memory");
}

/** The policy with bots' memory denied: reads by the pattern and each known folder, writes by the pattern and the whole
 *  `<home>/bots`. */
export function withMemoryDenied(policy: SandboxPolicy, home: string, folders: readonly string[]): SandboxPolicy {
  const add = (list: readonly string[], more: readonly string[]) => [...list, ...more.filter((f, i) => !list.includes(f) && more.indexOf(f) === i)];
  return {
    ...policy,
    denyRead: add(policy.denyRead, [botMemoryPattern(home), ...folders]),
    denyWrite: add(policy.denyWrite, [join(home, "bots"), botMemoryPattern(home), ...folders]),
  };
}

/** Deny rules for the file tools: a read-denied folder for every file tool, a write-denied one for the editing ones. */
export function fileToolDenials(denyRead: readonly string[], denyWrite: readonly string[]): string[] {
  const rules = (folders: readonly string[], tools: readonly string[]) => folders
    .map((p) => p.replace(/[\\/]+$/, ""))
    .filter((p) => p !== "")
    .flatMap((p) => tools.flatMap((t) => [`${t}(/${p})`, `${t}(/${p}/**)`]));
  return [...new Set([...rules(denyRead, ["Read", "Edit", "Write", "Glob", "Grep", "NotebookEdit"]), ...rules(denyWrite, ["Edit", "Write", "NotebookEdit"])])];
}
