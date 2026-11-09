// A path as the disk resolves it, for the fence (spec §9.1: "It resolves each path on its own disk, links
// included"). Components are walked in order from the root, so a `..` after a link climbs from where the link
// leads, not from where it sits, and a link is followed even when its target doesn't exist yet (writing through a
// dangling link creates its target). Whatever exists is then given the disk's own spelling (`realpath`: on Windows
// long names for 8.3 short ones, and the final path of a junction). The part that doesn't exist yet is kept as
// written; the fence folds it (fold.ts).
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

const MAX_LINKS = 40;

/** A path whose walk met more than `MAX_LINKS` links: the fence refuses it. */
export class TooManyLinks extends Error {
  constructor(path: string) { super(`more than ${MAX_LINKS} links on the way to ${path.slice(0, 200)}`); this.name = "TooManyLinks"; }
}

export function canonicalPath(input: string, platform: NodeJS.Platform = process.platform): string {
  const p = platform === "win32" ? win32 : posix;
  // Absolute without normalizing: `resolve` and `join` would take `..` lexically, before the links.
  const sep = platform === "win32" ? /[\\/]+/ : /\/+/;
  const abs = p.isAbsolute(input) ? input : `${process.cwd()}${p.sep}${input}`;
  const root = p.parse(abs).root;
  const queue = abs.slice(root.length).split(sep).filter((c) => c !== "");
  let at = root;
  let exists = true;
  let deepestReal = root;
  let links = 0;
  while (queue.length > 0) {
    const c = queue.shift()!;
    if (c === ".") continue;
    if (c === "..") {
      at = p.dirname(at);
      // Climbing back out of what doesn't exist may land on what does, whose links count again.
      if (!exists) { try { lstatSync(at); exists = true; } catch { /* still missing */ } }
      if (exists) deepestReal = at;
      continue;
    }
    const next = p.join(at, c);
    if (!exists) { at = next; continue; }
    let st: ReturnType<typeof lstatSync> | undefined;
    try { st = lstatSync(next); } catch { st = undefined; }
    if (st === undefined) { exists = false; at = next; continue; }
    if (st.isSymbolicLink()) {
      // Past MAX_LINKS (a loop, or a chain built to tire the walk) the path is refused, never judged half-walked.
      if (++links > MAX_LINKS) throw new TooManyLinks(input);
      let target: string;
      try { target = readlinkSync(next); } catch { at = next; deepestReal = next; continue; }
      // The target's components are walked in turn: from its root when absolute, else from the link's folder.
      if (p.isAbsolute(target)) {
        const r = p.parse(target).root;
        queue.unshift(...target.slice(r.length).split(sep).filter((x) => x !== ""));
        at = r;
      } else {
        queue.unshift(...target.split(sep).filter((x) => x !== ""));
      }
      deepestReal = at;
      continue;
    }
    at = next;
    deepestReal = next;
  }
  // The disk's spelling of what exists, then the rest as written.
  let real = deepestReal;
  try { real = realpathSync.native(deepestReal); } catch { /* keep the walked path */ }
  const rest = p.relative(deepestReal, at);
  return rest === "" ? real : p.join(real, rest);
}

/** Every link met on the way to `input`, each by its own path (its folder as the disk resolves it, then its own
 *  name), in the order the walk meets them: a folder link on the way (a stow-style `~/.config/git`) and each hop of
 *  a final chain (`~/.gitconfig` → `~/dotfiles/gitconfig` → …). A sandbox resolves a path before it judges it, so
 *  denying the end alone leaves each of these free to be removed and pointed elsewhere (#392's review): they are
 *  held under their own names. Past `MAX_LINKS`, `TooManyLinks`. */
export function linksOnTheWay(input: string, platform: NodeJS.Platform = process.platform): string[] {
  const p = platform === "win32" ? win32 : posix;
  const sep = platform === "win32" ? /[\\/]+/ : /\/+/;
  const abs = p.isAbsolute(input) ? input : `${process.cwd()}${p.sep}${input}`;
  const root = p.parse(abs).root;
  const queue = abs.slice(root.length).split(sep).filter((c) => c !== "");
  const out: string[] = [];
  let at = root;
  let links = 0;
  while (queue.length > 0) {
    const c = queue.shift()!;
    if (c === ".") continue;
    if (c === "..") { at = p.dirname(at); continue; }
    const next = p.join(at, c);
    let st: ReturnType<typeof lstatSync> | undefined;
    try { st = lstatSync(next); } catch { break; } // the rest isn't there: no link on it
    if (!st.isSymbolicLink()) { at = next; continue; }
    if (++links > MAX_LINKS) throw new TooManyLinks(input);
    out.push(next);
    let target: string;
    try { target = readlinkSync(next); } catch { break; }
    if (p.isAbsolute(target)) {
      const r = p.parse(target).root;
      queue.unshift(...target.slice(r.length).split(sep).filter((x) => x !== ""));
      at = r;
    } else {
      queue.unshift(...target.split(sep).filter((x) => x !== ""));
    }
  }
  return out;
}
