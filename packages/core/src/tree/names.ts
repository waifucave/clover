// Names in the folder tree, as each OS's disk compares them (spec §9.1; spike S6 edit 5 and its review round 2).
//
// A holder resolves every tree path on its own disk and asks its fence about the real path it lands on. Most of the
// canonical form comes from the disk itself (realpath gives the stored case on macOS and long names on Windows), but
// a name that doesn't exist yet, or a link's own name, has no real path to ask for. Those compare folded: APFS and
// NTFS ignore case by default and APFS ignores Unicode normalisation, so a fold that only matched names as typed let
// `.CLOVER` reach `.clover` on a Mac (S6, review round 2). The fold applies on every OS: on a case-sensitive disk it
// also matches `.CLOVER`, a different folder there, which costs nothing, and it covers ext4's case-folding folders and
// FAT or NTFS volumes mounted on Linux.
import type { Os } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";

/** This computer's OS, in the protocol's words. */
export function hostOs(platform: NodeJS.Platform = process.platform): Os {
  return platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
}

/** One name, folded: Unicode NFC, then case (upper then lower, so the Kelvin sign and the long s fold too). On
 *  Windows the trailing dots and spaces Win32 drops are dropped as well (`.clover.` opens `.clover`). */
export function foldName(name: string, os: Os): string {
  const s = name.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
  return os === "windows" ? s.replace(/[. ]+$/, "") : s;
}

/** Whether two names may be the same entry on that OS's disk. */
export function sameName(a: string, b: string, os: Os): boolean {
  return foldName(a, os) === foldName(b, os);
}

/** Device names Windows keeps in every folder: opening `NUL` or `com1.txt` reaches a device, never a file. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
/** Characters a Windows name can't hold; `:` would also name an alternate data stream. */
const WINDOWS_FORBIDDEN = /[<>:"|?*\\\u0000-\u001f]/;

/** Refuses a path segment the holder's disk would read as something other than a plain name: `invalid`. The tree's
 *  own split already refused empty, `.` and `..` segments, backslashes and NULs. */
export function checkSegment(segment: string, os: Os): void {
  if (segment === "" || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\0")) {
    throw new ContractError("invalid", `"${segment}" isn't a file name`);
  }
  if (os !== "windows") return;
  if (WINDOWS_FORBIDDEN.test(segment)) throw new ContractError("invalid", `"${segment}" holds a character Windows names can't`);
  // Win32 drops trailing dots and spaces, so `a.` and `a ` would open `a`: refused rather than aliased.
  if (/[. ]$/.test(segment)) throw new ContractError("invalid", `"${segment}" ends in a dot or a space, which Windows drops`);
  if (WINDOWS_RESERVED.test(segment)) throw new ContractError("invalid", `"${segment}" is a device name on Windows`);
}

/** Whether `name` could be a Windows 8.3 short name (`CLOVER~1`), which the disk answers to without listing it. */
export function mayBeShortName(name: string, os: Os): boolean {
  return os === "windows" && name.includes("~");
}
