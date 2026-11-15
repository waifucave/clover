// The sandbox's deny lists as the agent runtime can check them on this computer (the owner's try 14: every file tool of
// Alpha's came back "protected host path access refused", a Write to his Desktop included).
//
// The runtime's file-tool check (agent SDK 0.0.78 `hostCodePathAllowed`) resolves the session's every `denyRead` and
// `denyWrite` entry to its real path, at each call, inside one `try`: an entry that fails to resolve for any reason but
// "not there" (Bun's `realpathSync` opens the path, so macOS answers EPERM for a folder its privacy settings keep Clover
// out of, such as `~/Library/Mail`, and EACCES for one without permission; ENOTDIR for a name under a file) makes the
// check refuse EVERY path, whatever it is. The user's secret places are such folders on a Mac that hasn't given Clover
// Full Disk Access, which is every Mac by default.
//
// So an entry handed to the runtime is spelled so that resolving it can't fail, and still denies the same place: one
// of its names as a glob that matches that name in any letter case (`anyCase`: `Library` → `[lL][iI][bB][rR][aA][rR][yY]`).
// - The runtime resolves the spelling as written: no folder has that name (a `[` is in it), so it walks up to a folder
//   that resolves, and nothing throws.
// - A glob-shaped entry is matched by its regex, the place and everything under it (`recursiveGlobToSbplRegexSource`:
//   `^…(/.*)?$`), case-folded on macOS, against a path as written, its real path and its links' targets: so the place,
//   a file under it, and a link elsewhere into it are refused (a link's real path can't even be read: the check then
//   refuses the call anyway). The shell's Seatbelt profile gets the same regex.
// - The secret places always get it, on the place's own name (`~/Library/[mM][aA][iI][lL]`), so the place itself is
//   never opened to check it, whether Clover is let in there now or later; any other entry only when it wouldn't
//   resolve now, on its last name. Either goes up a name while that spelling still wouldn't resolve (a guarded folder
//   above it, or a file). Kept on the deepest name, the folder above keeps the runtime's ancestor fence: the shell
//   can't rename `~/Library` away from under the place, as with the plain entry.
//
// macOS only: there the file system opens a name in any case, so the glob names exactly the place. Linux's sandbox
// expands a glob by walking its folder at each command, and its folders have no such privacy settings.
import { realpathSync } from "node:fs";
import { posix } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import { secretReadPlaces } from "../contracts/fence";
import { anyCase } from "./sandbox-settings";

/** Whether the runtime resolves `path` without an error, as `resolveRealTarget` does: its real path, or, when it isn't
 *  there, its folder's, up to the root. */
export function resolvesInRuntime(path: string, realpath: (p: string) => string = realpathSync): boolean {
  for (let at = path; ;) {
    try {
      realpath(at);
      return true;
    } catch (err) {
      if ((err as { code?: unknown }).code !== "ENOENT") return false;
    }
    const up = posix.dirname(at);
    if (up === at) return true;
    at = up;
  }
}

const GLOB = /[*?[\]]/;

/** `name` as a glob segment that matches only it, in any letter case: `anyCase`, or for a name with no letter one of
 *  its characters as a two-member class (`[11]`), which the runtime reads as a glob (a one-member class is literal). */
function globName(name: string): string | undefined {
  const cased = anyCase(name, "macos");
  if (cased !== name) return cased;
  const i = [...name].findIndex((c) => !"!^-\\".includes(c));
  return i < 0 ? undefined : `${name.slice(0, i)}[${name[i]}${name[i]}]${name.slice(i + 1)}`;
}

/** `path` with its `index`th name (from the root, 1-based) spelled as a glob, or undefined when that name can't be. */
function withGlobAt(path: string, index: number): string | undefined {
  const names = path.split("/");
  const name = names[index];
  if (name === undefined || name === "" || GLOB.test(name)) return undefined;
  const g = globName(name);
  if (g === undefined) return undefined;
  names[index] = g;
  return names.join("/");
}

function inside(path: string, root: string): boolean {
  const p = path.toLowerCase(), r = root.toLowerCase().replace(/\/+$/, "");
  return p === r || p.startsWith(`${r}/`);
}

/** The deny entries as the runtime is handed them on macOS (see the file's header); elsewhere, as they are. An entry
 *  no spelling makes resolvable is kept as it is (the runtime then fails closed, as before). */
export function runtimeDenyForms(paths: readonly string[], o: { os: Os; userHome?: string; realpath?: (p: string) => string }): string[] {
  if (o.os !== "macos") return [...paths];
  const realpath = o.realpath ?? realpathSync;
  const home = o.userHome?.replace(/\/+$/, "");
  const secrets = home === undefined || home === "" ? [] : secretReadPlaces("macos", home).map((s) => s.path);
  const out: string[] = [];
  for (const path of paths) {
    if (!posix.isAbsolute(path)) { out.push(path); continue; }
    // A secret place, or a path under one: from the place's own name, whatever the disk says now (the place itself is
    // never opened). Any other entry: only one that wouldn't resolve, from its last name.
    const secret = secrets.find((s) => inside(path, s));
    const from = secret !== undefined ? secret.split("/").length - 1 : resolvesInRuntime(path, realpath) ? undefined : path.split("/").length - 1;
    if (from === undefined) { out.push(path); continue; }
    // The deepest name from there whose glob spelling resolves: its folder then keeps the runtime's ancestor fence
    // (`~/Library` can't be renamed away from under `~/Library/Mail`), as the plain entry's did.
    let found: string | undefined;
    for (let i = from; i >= 1 && found === undefined; i--) {
      const g = withGlobAt(path, i);
      if (g !== undefined && resolvesInRuntime(g, realpath)) found = g;
    }
    out.push(found ?? path);
  }
  return [...new Set(out)];
}
