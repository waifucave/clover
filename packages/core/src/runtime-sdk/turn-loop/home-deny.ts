// The Clover home is default-deny for a coding session's Bash: it reads the folders it is given and nothing else.
// Owner: lane A. A coding session's list (its store, run folder, outputs and working directories) is built here by
// `homeDenyRead`; a bot's comes from lane C's fence (`sandboxSettingsOf`).
//
// A sandbox can't say "deny this folder but allow that one inside it": Seatbelt and the SDK's bubblewrap backend apply
// a read denial after the allows, and the SDK's `allowRead` isn't enforced on either. So every folder on the way to a
// kept one is denied entry by entry: every name in it but the kept ones. A literal list of those names would be a
// snapshot (a bot made later would be readable) and would grow with the folder (one entry per session in `outputs/`,
// past what a sandbox profile carries). So the names are denied by pattern instead: the complement of the kept names,
// spelled in the sandbox's glob grammar, one class per letter of a kept name (`[0-9A-Za-z_]` less that letter, and
// `.` and `-` on their own). That is bounded by the kept names' length, whatever is in the folder, and it is live:
// Seatbelt matches the patterns at each access, and the SDK's bubblewrap backend expands them at each command start.
//
// The grammar has no negated class, so a name whose first letter off the kept names is outside `[0-9A-Za-z_.-]` isn't
// matched by any pattern: such names are listed literally as they are when the list is built. Every name Clover makes
// in these folders (session ids, run ids, project keys, bot ids) is in that alphabet; a project key may hold other
// letters, but only as a kept name. The fenced set's paths in the home are denied by name too (`homeNamedDenials`).
import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import { fenceLayout } from "../../fence/layout";
import { escapeSandboxGlobPath } from "../host/run-home/settings";

/** The generated config copies of a run folder or a staging root (the MCP fold with stdio servers' `env`, the
 *  official child's credentials): never readable by a runner's Bash. */
export const CONFIG_COPY_FILES = [".clover.json", ".claude.json", ".credentials.json"] as const;

const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
/** The letters a name may start its difference from the kept names with and still be matched by a pattern. */
const PATTERN_ALPHABET = new Set([...ALNUM, ".", "-"]);

export function hostOsOf(platform: NodeJS.Platform = process.platform): Os {
  return platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
}

/** Paths in the home denied by name, whether or not they exist yet: the fenced set's paths inside the home on this OS,
 *  and the secrets file and its keys (a file secret store's, on every OS). */
export function homeNamedDenials(home: string, os: Os = hostOsOf()): string[] {
  const out = new Set<string>();
  for (const paths of Object.values(fenceLayout(home, os))) for (const p of paths) if (strictlyInside(p, home)) out.add(resolve(p));
  for (const name of ["secrets.enc", "secrets.key", "secrets.key.cred"]) out.add(join(resolve(home), name));
  return [...out].sort();
}

/** The config copies under every staging root, at any depth, in the sandbox's glob grammar. */
export function configCopyDenies(staging: { base: string; prefix: string }): string[] {
  const root = `${escapeSandboxGlobPath(resolve(staging.base))}/${staging.prefix}*`;
  return [...CONFIG_COPY_FILES.map((f) => `${root}/**/${f}`), `${root}/**/backups`];
}

/** The config copies in a runtime's own home (`dir`): at its top, spelled exactly, and at any depth below it. The
 *  runtime reads its own top-level MCP list past a denial only when that denial names the file exactly (the agent SDK's
 *  `readOwnGlobalMcpControl`); a pattern that also matches it would keep the session's MCP servers from loading. */
export function ownHomeConfigDenies(dir: string): string[] {
  const d = escapeSandboxGlobPath(resolve(dir));
  // A top-level copy that is a link (a run folder's `.claude.json` points at its `.clover.json`) is left to its target's
  // denial: naming it would deny the target too, past the exact spelling the runtime's own read needs.
  const isLink = (f: string) => { try { return lstatSync(join(dir, f)).isSymbolicLink(); } catch { return false; } };
  return [...CONFIG_COPY_FILES.filter((f) => !isLink(f)).map((f) => `${d}/${f}`), `${d}/backups`, ...CONFIG_COPY_FILES.map((f) => `${d}/*/**/${f}`), `${d}/*/**/backups`];
}

export interface HomeDenySpec {
  home: string;
  /** Folders in the home readable whole (a folder outside the home is ignored; the home itself keeps everything). */
  keep: readonly string[];
  /** Folders inside a kept one where only some entries are readable, by name. */
  only?: readonly { parent: string; names: readonly string[] }[];
  /** Paths inside a kept folder denied anyway, as they are (already in the glob grammar). */
  deny?: readonly string[];
  /** Whose names fold case (`darwin`): a kept letter is kept in both cases there. Default: this computer. */
  platform?: NodeJS.Platform;
}

/** Everything in the home a runner may not read, in the sandbox's glob grammar (`HomeDenySpec`). */
export function homeDenyRead(spec: HomeDenySpec): string[] {
  const root = resolve(spec.home);
  const platform = spec.platform ?? process.platform;
  const out: string[] = [];
  const kept = [...new Set(spec.keep.map((k) => resolve(k)))].filter((k) => k === root || strictlyInside(k, root));
  if (!kept.includes(root)) {
    // The tree of kept folders: a node is kept whole, or walked into.
    interface Node { whole: boolean; children: Map<string, Node> }
    const tree: Node = { whole: false, children: new Map() };
    for (const k of kept) {
      let node = tree;
      for (const seg of relative(root, k).split(sep)) {
        if (node.whole) break;
        let next = node.children.get(seg);
        if (next === undefined) node.children.set(seg, (next = { whole: false, children: new Map() }));
        node = next;
      }
      node.whole = true;
      node.children.clear();
    }
    const walk = (dir: string, node: Node): void => {
      out.push(...namesOtherThan(dir, [...node.children.keys()], platform));
      for (const [name, child] of node.children) if (!child.whole) walk(join(dir, name), child);
    };
    walk(root, tree);
  }
  for (const o of spec.only ?? []) out.push(...namesOtherThan(resolve(o.parent), o.names, platform));
  // The names that matter, before they exist; not those a kept folder holds or that hold one.
  const keptAll = kept.filter((k) => !(spec.only ?? []).some((o) => k === resolve(o.parent) || strictlyInside(resolve(o.parent), k)));
  for (const p of homeNamedDenials(root, hostOsOf(platform))) {
    if (keptAll.some((k) => k === p || strictlyInside(k, p) || strictlyInside(p, k))) continue;
    out.push(escapeSandboxGlobPath(p));
  }
  out.push(...(spec.deny ?? []));
  return [...new Set(out)];
}

/** The deny entries for every entry of `dir` whose name isn't one of `names`: the complement patterns, and the names
 *  in it now that no pattern matches. */
export function namesOtherThan(dir: string, names: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const fold = platform === "darwin";
  interface Trie { end: boolean; next: Map<string, Trie> }
  const trie: Trie = { end: false, next: new Map() };
  const key = (c: string) => (fold ? c.toLowerCase() : c);
  for (const name of new Set(names)) {
    if (name === "") continue;
    let t = trie;
    for (const c of name) {
      let n = t.next.get(key(c));
      if (n === undefined) t.next.set(key(c), (n = { end: false, next: new Map() }));
      t = n;
    }
    t.end = true;
  }
  const base = escapeSandboxGlobPath(dir);
  const out: string[] = [];
  // Each prefix of a kept name: the names that leave the kept ones at the next letter, the prefix itself when it isn't
  // kept, and, past a kept name no other one extends, every longer name.
  const visit = (prefix: string, t: Trie): void => {
    const spelled = `${base}/${escapeSandboxGlobPath(prefix)}`;
    if (prefix !== "" && t.end && t.next.size === 0) {
      out.push(`${spelled}?*`);
      return;
    }
    const taken = new Set<string>();
    for (const c of t.next.keys()) { taken.add(c); if (fold) { taken.add(c.toLowerCase()); taken.add(c.toUpperCase()); } }
    const cls = classOf([...ALNUM].filter((c) => !taken.has(c)));
    if (cls !== "") out.push(`${spelled}[${cls}]*`);
    for (const c of [".", "-"]) if (!taken.has(c)) out.push(`${spelled}${c}*`);
    if (prefix !== "" && !t.end) out.push(spelled);
    for (const [c, n] of t.next) visit(prefix + c, n);
  };
  visit("", trie);
  // The names here now that leave the kept ones at a letter outside the patterns' alphabet.
  let present: string[] = [];
  try { present = readdirSync(dir); } catch { /* not there yet: nothing to list */ }
  for (const name of present) {
    let t: Trie | undefined = trie;
    let covered = true;
    let kept = false;
    for (const [i, c] of [...name].entries()) {
      const n: Trie | undefined = t.next.get(key(c));
      if (n !== undefined) { t = n; if (i === [...name].length - 1) kept = n.end; continue; }
      covered = t.end && t.next.size === 0 ? true : PATTERN_ALPHABET.has(c);
      break;
    }
    if (!kept && !covered) out.push(`${base}/${escapeSandboxGlobPath(name)}`);
  }
  return out;
}

/** A bracket class body for `letters` (all from `ALNUM`), as ranges whose ends are letters or digits. */
function classOf(letters: readonly string[]): string {
  const order = [...ALNUM];
  const idx = new Set(letters.map((c) => order.indexOf(c)));
  let out = "";
  for (let i = 0; i < order.length; i++) {
    if (!idx.has(i)) continue;
    let j = i;
    // A run stays inside one of digits, capitals, `_`, small letters, so each range is plain.
    while (idx.has(j + 1) && group(order[j + 1]!) === group(order[i]!)) j++;
    out += j > i + 1 ? `${order[i]}-${order[j]}` : order.slice(i, j + 1).join("");
    i = j;
  }
  return out;
}

function group(c: string): number {
  return /[0-9]/.test(c) ? 0 : /[A-Z]/.test(c) ? 1 : c === "_" ? 2 : 3;
}

export function strictlyInside(p: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(p));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
