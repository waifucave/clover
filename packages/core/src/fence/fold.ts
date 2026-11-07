// How the fence compares names (spec §9.1 "The holder enforces its own rules"; J-M1's review B1; B-M1's contract
// review). A fenced name in another case, another Unicode form, or another spelling the disk takes as the same name
// must not lead past the fence, whether or not the item exists yet.
//   - Folded on every OS, Linux included: NFC, then `toUpperCase().toLowerCase()`. APFS and NTFS take `ſettings` as
//     `settings`; the plain NFC-plus-lowercase fold missed it, as it misses `ß` (→ `ss`) and the Kelvin sign
//     (U+212A → `k`). Folding where a disk doesn't fold only fences more. (B's shared fold, coming in B-M1, is the
//     same function; this one is swapped for it when it lands.)
//   - On Windows, a name also drops its trailing dots and spaces, and an alternate data stream (`settings.json:x`,
//     `settings.json::$DATA`) names its file: NTFS opens the same file for each.
//   - Where Clover names things itself (the Clover home's top level, and any folder holding a fenced item), a name
//     that isn't ASCII is refused outright (`nonAsciiAlias`), so no folding rule has to be right about it.
import type { Os } from "@waifucave/clover-protocol";

/** One name, as the fence compares it. */
export function foldName(name: string): string {
  return name.normalize("NFC").toUpperCase().toLowerCase();
}

/** One path component as `os`'s disks open it: Windows drops trailing dots and spaces and reads a stream suffix as
 *  its file. `.` and `..` stay as they are. */
export function diskName(component: string, os: Os): string {
  if (os !== "windows" || component === "." || component === "..") return component;
  const stream = component.indexOf(":");
  const base = stream >= 0 ? component.slice(0, stream) : component;
  return base.replace(/[. ]+$/, "") || base;
}

/** A path's components with `/` and, on Windows, `\` as separators; a drive (`C:`) stays the first component. */
export function components(path: string, os: Os): string[] {
  return (os === "windows" ? path.replace(/\\/g, "/") : path).split("/");
}

/** A whole absolute path, folded and with each component as the disk opens it, `/`-separated. */
export function foldPath(path: string, os: Os): string {
  const parts = components(path, os);
  const out = parts.map((p, i) => (os === "windows" && i === 0 && /^[A-Za-z]:$/.test(p) ? p.toLowerCase() : foldName(diskName(p, os))));
  return out.join("/");
}

/** The second wall, as B's contract builds it (`nonAsciiAlias`, B-M1 #179; the controller's ruling): a name that
 *  isn't ASCII where Clover names things itself is refused, whatever a disk might fold it to. That is the Clover home's
 *  own top level and any folder under it that holds a fenced item (`plugins-state/` for `plugins-state/oks`). A bot's
 *  memory note or a plugin's asset may have any name: those folders hold no fenced item. The non-ASCII name found, or
 *  null. (Swapped for B's once #179 is on main.) */
export function nonAsciiAlias(path: string, fenced: readonly string[], cloverHome: string, os: Os): string | null {
  const names = components(path, os).filter((c) => c !== "");
  const home = components(cloverHome, os).filter((c) => c !== "");
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((n, i) => foldName(diskName(n, os)) === foldName(diskName(b[i]!, os)));
  if (names.length <= home.length || !same(names.slice(0, home.length), home)) return null;
  const holders = fenced.map((p) => components(p, os).filter((c) => c !== ""));
  for (let depth = home.length; depth < names.length; depth++) {
    if (/^[\x00-\x7f]*$/.test(names[depth]!)) continue;
    const folder = names.slice(0, depth);
    if (depth === home.length || holders.some((item) => item.length > depth && same(item.slice(0, depth), folder))) return names[depth]!;
  }
  return null;
}
