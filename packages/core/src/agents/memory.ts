// The Clover home is out of every agent's reach (the owner's decision on bots' memory, then #208's check 2): an ACP or
// delegated agent, the delegating bot's own included, can't read or write anything in the Clover home. Not a list of
// what holds a bot's memory or its conversations (memory, the runtimes' transcript stores, the sessions' event logs, the
// diffs, the scratch and output folders, the runtime's own state), which kept missing some: the whole home, by default.
// The manager already refuses a root inside it, and the daemon writes everything an agent leaves there (its transcript,
// its record). Nothing is carved out: no agent's command or tool has been shown to need a path in the home.
//
// The home goes into every agent's sandbox as a read and write denial, and into clover-code's file tools as deny rules
// and a check of each path as it really is (a link from the root into the home is refused too); a permission request
// that touches it is refused without a card, whatever the level. A bot's own memory (`ownMemory`) is a bot runner's,
// never an agent's.
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import { isInsideFolded, type SandboxPolicy } from "../contracts/fence";
import { ContractError } from "../contracts/common";

/** The policy an agent's sandbox starts from. A bot's own Bash may work in its own memory (the controller's ruling: B's
 *  policy carries that as `ownMemory`, applied after the denials); an agent never may, so a policy that carries it is
 *  refused here and the agent doesn't start. */
export function agentPolicyOf(policy: SandboxPolicy): SandboxPolicy {
  if ((policy as SandboxPolicy & { ownMemory?: unknown }).ownMemory !== undefined) {
    throw new ContractError("refused", "an agent's sandbox may never carry a bot's own memory (ownMemory), so the agent wasn't started");
  }
  // Nor a bot's open access to the Clover home (`botAccess`, the owner's ruling of November 9): bots' only.
  if ((policy as SandboxPolicy & { botAccess?: unknown }).botAccess !== undefined) {
    throw new ContractError("refused", "an agent's sandbox may never carry a bot's open access to the Clover home (botAccess), so the agent wasn't started");
  }
  return policy;
}

/** The policy with the whole Clover home denied to an agent, for reads and writes. */
export function withHomeDenied(policy: SandboxPolicy, home: string): SandboxPolicy {
  const add = (list: readonly string[]) => (list.includes(home) ? [...list] : [...list, home]);
  return { ...policy, denyRead: add(policy.denyRead), denyWrite: add(policy.denyWrite) };
}

/** A path as it really is: its real path, or for one that doesn't exist yet its nearest existing folder's, with the rest
 *  appended. */
export function realPathOf(path: string, cwd: string): string {
  let p = isAbsolute(path) ? path : resolve(cwd, path);
  const rest: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(p), ...rest.reverse());
    } catch {
      const up = dirname(p);
      if (up === p) return resolve(path);
      rest.push(p.slice(up.length).replace(/^[\\/]+/, ""));
      p = up;
    }
  }
}

/** How a path, as written or as it really is, reaches the Clover home: inside it, holding it (a search from there would
 *  walk into it), or not at all. */
export function homeReach(home: string, path: string, cwd: string, os?: Os): "inside" | "holds" | undefined {
  let realHome = home;
  try {
    realHome = realpathSync(home);
  } catch {
    realHome = home;
  }
  let holds = false;
  for (const p of new Set([isAbsolute(path) ? path : resolve(cwd, path), realPathOf(path, cwd)])) {
    for (const h of new Set([home, realHome])) {
      if (isInsideFolded(p, h, os)) return "inside";
      if (isInsideFolded(h, p, os)) holds = true;
    }
  }
  return holds ? "holds" : undefined;
}

/** Deny rules for the file tools: a read-denied folder for every file tool, a write-denied one for the editing ones. */
export function fileToolDenials(denyRead: readonly string[], denyWrite: readonly string[]): string[] {
  const rules = (folders: readonly string[], tools: readonly string[]) => folders
    .map((p) => p.replace(/[\\/]+$/, ""))
    .filter((p) => p !== "")
    .flatMap((p) => tools.flatMap((t) => [`${t}(/${p})`, `${t}(/${p}/**)`]));
  return [...new Set([...rules(denyRead, ["Read", "Edit", "Write", "Glob", "Grep", "NotebookEdit"]), ...rules(denyWrite, ["Edit", "Write", "NotebookEdit"])])];
}
