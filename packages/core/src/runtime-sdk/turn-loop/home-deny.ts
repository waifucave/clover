// The Clover home is default-deny for a tool runner's Bash (the owner's November 6 ruling): the runner reads its own
// folders there and nothing else. Owner: lane A.
//
// A sandbox can't say "deny the home but allow these folders inside it": Seatbelt and the SDK's Linux sandbox apply
// a read denial after the allows, so a denied home hides the own folders too. So the denial is the literal list of
// everything in the home that isn't on the way to a kept folder: each entry of the home is denied, unless it is a kept
// folder (left alone) or holds one (walked into, the same way, one level down).
//
// It is a snapshot taken when the session's sandbox is built. A name made in the home later isn't in the list, so the
// names that matter (the fenced set's paths in the home: the sessions' logs, the secrets file and its key, the run
// folder, the credential index…) are denied by name too, whether or not they exist yet.
import { lstatSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep, isAbsolute } from "node:path";
import { fenceLayout } from "../../fence/layout";

/** Paths in the home denied by name, whether or not they exist yet: the fenced set's paths inside the home, on every
 *  OS (a file secret store's files included), and the secrets file's sealed key. */
export function homeNamedDenials(home: string): string[] {
  const out = new Set<string>();
  const os = process.platform === "win32" ? "windows" : "linux";
  for (const paths of Object.values(fenceLayout(home, os))) for (const p of paths) if (strictlyInside(p, home)) out.add(resolve(p));
  out.add(join(resolve(home), "secrets.key.cred"));
  return [...out].sort();
}

/** Everything in `home` that a runner whose own folders are `keep` may not read, as literal paths. A kept folder that
 *  isn't in the home is ignored; a keep that is the home itself denies nothing. */
export function homeDenyReadExcept(home: string, keep: readonly string[]): string[] {
  const root = resolve(home);
  const kept = [...new Set(keep.map((k) => resolve(k)))].filter((k) => k === root || strictlyInside(k, root));
  if (kept.includes(root)) return [];
  const denied: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // gone, or not a folder: nothing in it to list
    }
    for (const name of names.sort()) {
      const p = join(dir, name);
      if (kept.includes(p)) continue;
      if (!kept.some((k) => strictlyInside(k, p))) {
        denied.push(p);
        continue;
      }
      // On the way to a kept folder: walked into when it is a real folder. A link there is denied: what it points at
      // isn't known to be the runner's.
      let isDir = false;
      try { isDir = lstatSync(p).isDirectory(); } catch { /* gone */ }
      if (isDir) walk(p);
      else denied.push(p);
    }
  };
  walk(root);
  const out = new Set(denied);
  for (const p of homeNamedDenials(root)) {
    if (kept.some((k) => k === p || strictlyInside(k, p) || strictlyInside(p, k))) continue;
    if (denied.some((d) => d === p || strictlyInside(p, d))) continue;
    out.add(p);
  }
  return [...out].sort();
}

function strictlyInside(p: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(p));
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
