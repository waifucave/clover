// The fence's policy for one runner as the agent runtime's sandbox settings (`SandboxSettingsConfig.filesystem`), for
// a sandbox the runtime builds itself (a bot's Bash in the turn-loop driver's `sandbox(ctx)`). The ruling: this is the
// single bot Bash sandbox builder.
//
// The controller's ruling: inside any sandbox config a DENY always wins over an ALLOW, whatever the order or how
// specific each is; the runtime renders it so (its denies come after its allows in the Seatbelt profile, and it has no
// `allowRead` at all). So nothing here is an allow meant to re-open part of a deny:
//
// - Writes. The runtime's writes are an allow list (its write roots and `allowWrite`); nothing else is writable. So
//   the Clover home is taken OUT of the allow list instead of denied and re-opened: a root that holds the home is
//   written out as its entries minus the way to the home (the user's home: one level, its own entries), and the folders
//   the runner keeps are added by name. The other sessions' `outputs/<id>` folders are never listed, so the settings
//   stay the same size however many sessions there are (#356's review: one deny per session would pass sandbox-exec's
//   1 MB argv limit at about 10k sessions). The home's deny is still written out entry by entry minus the way to each
//   kept folder, as a net under any root the runtime adds itself, except `outputs/`, which the allow list alone
//   covers (its other folders are a known gap only under such a root).
// - Reads. The runtime's reads are a deny list. A bot reads the whole home but what escalates (by name, and globs for
//   the provider-state sidecars); any other runner's home deny is written out minus the way to its kept folders, with
//   `outputs/` denied whole (this builder serves bots; another runner's own outputs aren't readable through it).
//
// Always, whether on the disk or not when the settings are built: the named fenced items (credentials, runtimes, the
// SDK's config copy and settings, cache/runs, the secrets files, the browser profiles, plugin-data, run/) denied for
// reads and writes, so one made mid-run is denied too; a write-deny on a name inside each kept folder, so the
// runtime's ancestor fence denies creating, removing or renaming the kept folder itself (its entry, not its insides:
// #356's review); and no `.git/hooks` (nor `<name>.git/hooks`) anywhere under a write root, as the macOS profile has.
import { readdirSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { SandboxSettingsConfig } from "@waifucave/clover-agent-sdk";
import { BOT_READ_DENIED, segmentMatches, type SandboxPolicy } from "../contracts/fence";

export interface SandboxSettingsOptions {
  /** A folder's entry names, or [] when it isn't a folder (tests pass a fake). */
  list?: (dir: string) => readonly string[];
  /** Windows-form paths (backslashes). */
  windows?: boolean;
}

/** The name written-denied inside each kept folder: the runtime's ancestor fence then holds the folder's own entry. */
export const KEPT_FOLDER_PIN = ".clover-kept-folder";

const realList = (dir: string): readonly string[] => {
  try { return readdirSync(dir); } catch { return []; }
};

/** The policy as the runtime's sandbox settings: literal paths and the policy's globs, no allow inside any deny. */
export function sandboxSettingsOf(policy: SandboxPolicy, home: string, o: SandboxSettingsOptions = {}): SandboxSettingsConfig {
  const p = o.windows ? win32 : posix;
  const list = o.list ?? realList;
  const fold = (s: string) => (o.windows ? s.toLowerCase() : s);
  const same = (a: string, b: string) => fold(a) === fold(b);
  const inside = (a: string, root: string) => same(a, root) || fold(a).startsWith(fold(root.endsWith(p.sep) ? root : `${root}${p.sep}`));
  const isPattern = (d: string) => d.includes("*");
  const open = policy.botAccess;
  const outputs = p.join(home, "outputs");

  // The folders kept for writing and for reading.
  const ownRw = [policy.ownOutputs, policy.ownScratch, policy.ownRoutines, policy.ownPluginData, policy.ownMemory].filter((x): x is string => x !== undefined);
  const writeKeep = [...ownRw];
  if (open !== undefined) {
    for (const x of list(open.scratch)) writeKeep.push(p.join(open.scratch, x));
    for (const x of list(open.bots)) writeKeep.push(p.join(open.bots, x, "memory"));
  }
  const readKeep = open !== undefined ? [home] : [...ownRw, ...(policy.ownBot === undefined ? [] : [policy.ownBot])];

  /** `root`'s entries minus the way to each kept folder, walked level by level; `outputs/` as `whole` says. */
  const except = (root: string, keep: readonly string[], outputsWhole: boolean | null): string[] => {
    if (keep.some((k) => inside(root, k))) return []; // the root itself is kept
    const toward = keep.filter((k) => inside(k, root));
    if (toward.length === 0) return [root];
    // The other sessions' outputs folders are never listed: denied whole (reads), or left to the allow list (writes).
    if (outputsWhole !== null && same(root, outputs)) return outputsWhole ? [root] : [];
    const out: string[] = [];
    for (const name of list(root)) {
      const e = p.join(root, name);
      if (toward.some((k) => inside(k, e))) out.push(...except(e, toward, outputsWhole));
      else out.push(e);
    }
    return out;
  };

  /** Whether a policy glob would cover a kept folder (`bots/*\/memory` for a runner that keeps a memory). */
  const globCovers = (glob: string, keep: string): boolean => {
    const g = glob.split(p.sep).filter((s) => s !== "");
    const k = keep.split(p.sep).filter((s) => s !== "");
    return g.length <= k.length && g.every((seg, i) => segmentMatches(k[i]!, seg, o.windows ? "windows" : "macos"));
  };

  // The named fenced items, by name whether they are there or not.
  const named = [...BOT_READ_DENIED.filter((segs) => !segs.some(isPattern)).map((segs) => p.join(home, ...segs)), p.join(home, "run")];

  /** The policy's denies plus the named items; the home's own deny written out; a deny holding a kept folder written
   *  out the same way; one strictly inside a kept folder kept as it is (a deny wins). */
  const denies = (list0: readonly string[], keep: readonly string[], outputsWhole: boolean): string[] => {
    const out: string[] = [];
    for (const d of [...list0, ...named]) {
      if (same(d, home)) { out.push(...except(home, keep, outputsWhole)); continue; }
      if (isPattern(d)) { if (!keep.some((k) => globCovers(d, k))) out.push(d); continue; }
      if (keep.some((k) => inside(k, d) && !same(k, d))) { out.push(...except(d, keep, outputsWhole)); continue; }
      if (keep.some((k) => same(k, d))) continue;
      out.push(d);
    }
    return out;
  };

  // Writes: the allow list with the home taken out of every root that holds it; the kept folders by name.
  const allowWrite: string[] = [];
  for (const a of policy.allowWrite) {
    if (inside(home, a)) allowWrite.push(...except(a, [home], null).filter((e) => !inside(e, home)));
    else if (!inside(a, home) || writeKeep.some((k) => inside(a, k))) allowWrite.push(a);
  }
  allowWrite.push(...writeKeep);
  const hookRoots = [...policy.allowWrite, ...writeKeep.filter((k) => !policy.allowWrite.some((a) => inside(k, a)))];
  // The runtime renders a glob deny recursively (the folder and all under it).
  const hooks = [...new Set(hookRoots)].map((r) => `${r}${p.sep}**${p.sep}*.git${p.sep}hooks`);
  const pins = writeKeep.filter((k) => !same(k, home)).map((k) => p.join(k, KEPT_FOLDER_PIN));

  return {
    enabled: true,
    filesystem: {
      allowWrite: [...new Set(allowWrite)],
      denyWrite: [...new Set([...denies(policy.denyWrite, writeKeep, false), ...pins, ...hooks])],
      denyRead: [...new Set(denies(policy.denyRead, readKeep, true))],
    },
  };
}
