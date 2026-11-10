// The holder folders a sandbox holds against renaming (every folder between a writable root and a fenced item) are
// also refused being made: a literal deny on macOS, a missing mount point on Linux. In a fresh home that would leave
// `~/.config` unmakeable, and a first tool install (`gh auth login` writing `~/.config/gh`) would fail (#392's
// review). So the daemon makes the missing ones itself, as the user and outside any sandbox, with normal permissions,
// before a run; the sandbox then only has to hold them where they are.
//
// Every missing folder between the root and the item is made, the item itself never (it may be a file, or a folder
// the sandbox denies outright). For a coding agent's settings (`~/.claude/settings.json`, `~/.codex/config.toml`:
// `agentOwned`) the agent's own folder isn't made either: empty, it would look like an install to the tool that owns
// it. Never through a link: a link on the way stops the making there.
import { lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

/** Makes the missing folders strictly between a writable root (`roots`) and each item (for an `agentOwned` one, its
 *  folder's parent), outside `skip` (the Clover home, which the core lays out itself). POSIX only; returns the folders
 *  it made. */
export function makeHolderFolders(items: readonly string[], roots: readonly string[], skip?: string, agentOwned: readonly string[] = []): string[] {
  if (process.platform === "win32") return [];
  const made: string[] = [];
  const owned = new Set(agentOwned);
  for (const d of [...items, ...agentOwned]) {
    if (d.includes("*") || (skip !== undefined && inside(d, skip))) continue;
    const root = roots.filter((r) => inside(d, r) && r !== d).sort((x, y) => y.length - x.length)[0];
    if (root === undefined) continue;
    const chain: string[] = [];
    for (let p = owned.has(d) ? dirname(dirname(d)) : dirname(d); inside(p, root) && p !== root; p = dirname(p)) chain.unshift(p);
    for (const p of chain) {
      let st: ReturnType<typeof lstatSync> | undefined;
      try { st = lstatSync(p); } catch { st = undefined; }
      if (st === undefined) {
        try { mkdirSync(p); made.push(p); } catch { break; } // the user's umask: normal permissions
        continue;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) break; // never through a link, never over a file
    }
  }
  return made;
}
