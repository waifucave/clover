// How the fence compares names (spec §9.1 "The holder enforces its own rules"; J-M1's review B1; B-M1's contract
// review). A fenced name in another case, another Unicode form, or another spelling the disk takes as the same name
// must not lead past the fence, whether or not the item exists yet.
//   - Folded on every OS, Linux included: NFC, then `toUpperCase().toLowerCase()`. APFS and NTFS take `ſettings` as
//     `settings`; the plain NFC-plus-lowercase fold missed it, as it misses `ß` (→ `ss`) and the Kelvin sign
//     (U+212A → `k`). Folding where a disk doesn't fold only fences more. (B's shared fold, coming in B-M1, is the
//     same function; this one is swapped for it when it lands.)
//   - On Windows, a name also drops its trailing dots and spaces, and an alternate data stream (`settings.json:x`,
//     `settings.json::$DATA`) names its file: NTFS opens the same file for each.
//   - Under the Clover home, a name component that isn't plain ASCII is refused outright (`nonAsciiUnderHome`):
//     nothing Clover keeps there has one, so no folding rule has to be right about it.
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

/** Whether `path` (absolute, canonical) lies under `cloverHome` with a component below it that isn't plain
 *  printable ASCII; the component when it does. */
export function nonAsciiUnderHome(path: string, cloverHome: string, os: Os): string | null {
  const p = components(path, os).filter((c) => c !== "");
  const h = components(cloverHome, os).filter((c) => c !== "");
  if (p.length <= h.length) return null;
  for (let i = 0; i < h.length; i++) if (foldName(diskName(p[i]!, os)) !== foldName(diskName(h[i]!, os))) return null;
  for (const c of p.slice(h.length)) if (!/^[\x20-\x7e]*$/.test(c)) return c;
  return null;
}
