// The fence's policy for one runner as the agent runtime's sandbox settings (`SandboxSettingsConfig.filesystem`), for
// a sandbox the runtime builds itself (a bot's Bash in the turn-loop driver's `sandbox(ctx)`).
//
// The controller's ruling: inside any sandbox config a DENY always wins over an ALLOW, whatever the order or how
// specific each is. So the runner's own folders are never an allow that re-opens part of a denied Clover home: the
// home's deny is written out as the home's entries minus the way to each folder the runner keeps, level by level (a
// glob can't leave one name out), and every other deny stays as it is, so none of them is ever re-opened. The list is
// what is on the disk when the settings are built (a session's sandbox is built when its runtime is): the fenced
// items are denied by name whether they are there or not, and an entry that appears later is the known gap the
// fence's own check still covers for every tool call.
//
// What a runner keeps: to write, its own folders (`own…`) and, for a bot's own sessions (`botAccess`, the owner's
// rulings of November 9), every bot's folder in `scratch` and every bot's `memory`; to read, the same and the bot's
// own folder, or for a bot the whole home but what the policy read-denies by name.
import { readdirSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { SandboxSettingsConfig } from "@waifucave/clover-agent-sdk";
import type { SandboxPolicy } from "../contracts/fence";

export interface SandboxSettingsOptions {
  /** A folder's entry names, or [] when it isn't a folder (tests pass a fake). */
  list?: (dir: string) => readonly string[];
  /** Windows-form paths (backslashes). */
  windows?: boolean;
}

const realList = (dir: string): readonly string[] => {
  try { return readdirSync(dir); } catch { return []; }
};

/** The policy as the runtime's sandbox settings: literal paths, no allow inside any deny. */
export function sandboxSettingsOf(policy: SandboxPolicy, home: string, o: SandboxSettingsOptions = {}): SandboxSettingsConfig {
  const p = o.windows ? win32 : posix;
  const list = o.list ?? realList;
  const fold = (s: string) => (o.windows ? s.toLowerCase() : s);
  const inside = (a: string, root: string) => fold(a) === fold(root) || fold(a).startsWith(fold(root.endsWith(p.sep) ? root : `${root}${p.sep}`));
  const isPattern = (d: string) => d.includes("*");
  const open = policy.botAccess;

  // The folders kept for writing and for reading.
  const ownRw = [policy.ownOutputs, policy.ownScratch, policy.ownRoutines, policy.ownPluginData, policy.ownMemory].filter((x): x is string => x !== undefined);
  const writeKeep = [...ownRw];
  if (open !== undefined) {
    for (const x of list(open.scratch)) writeKeep.push(p.join(open.scratch, x));
    for (const x of list(open.bots)) writeKeep.push(p.join(open.bots, x, "memory"));
  }
  const readKeep = open !== undefined ? [home] : [...ownRw, ...(policy.ownBot === undefined ? [] : [policy.ownBot])];

  /** `root`'s entries minus the way to each kept folder, walked level by level. */
  const except = (root: string, keep: readonly string[]): string[] => {
    if (keep.some((k) => inside(root, k))) return []; // the root itself is kept
    const toward = keep.filter((k) => inside(k, root));
    if (toward.length === 0) return [root];
    const out: string[] = [];
    for (const name of list(root)) {
      const e = p.join(root, name);
      if (toward.some((k) => inside(k, e))) out.push(...except(e, toward));
      else out.push(e);
    }
    return out;
  };

  /** The policy's denies, the home's own deny written out; patterns the kept folders would fall under dropped. */
  const denies = (list0: readonly string[], keep: readonly string[]): string[] => {
    const out: string[] = [];
    for (const d of list0) {
      if (fold(d) === fold(home)) { out.push(...except(home, keep)); continue; }
      // A deny that holds a kept folder is written out the same way; one strictly inside it stays (a deny wins).
      if (keep.some((k) => inside(k, d) && fold(k) !== fold(d))) { out.push(...except(d, keep)); continue; }
      if (keep.some((k) => fold(k) === fold(d))) continue;
      // A glob that would cover a kept folder (`bots/*/memory` for a bot that writes every bot's memory) goes: what it
      // covers is listed above by name.
      if (isPattern(d) && open !== undefined) continue;
      out.push(d);
    }
    return [...new Set(out)];
  };

  return {
    enabled: true,
    filesystem: {
      allowWrite: [...new Set([...policy.allowWrite, ...writeKeep])],
      denyWrite: denies(policy.denyWrite, writeKeep),
      denyRead: denies(policy.denyRead, readKeep),
    },
  };
}
