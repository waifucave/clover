// How Clover's own parts compare a name a plugin gives against one that is Clover's or a bot's: lane B's `foldTitle`,
// the fold the manifest check uses too, so a name the manifest takes is one the island and the pill take. It folds what
// a reader sees alike: compatibility forms, invisible characters, lookalike letters from other scripts and Latin's
// small capitals, accents, case, I/i/1/l, "rn" and "m", "vv" and "w", "cl" and "d", and every space and punctuation
// mark. Pure.

import { foldTitle } from "@waifucave/clover-plugin-sdk";

const BLANKS = /[\p{White_Space}\u115F\u1160\u3164\uFFA0\u2800]+/gu;

/** A name as a reader sees it: two names with the same skeleton read the same (B's `foldTitle`). */
export function nameSkeleton(name: string): string {
  return foldTitle(name);
}

/** Whether two names read the same. */
export function readsAs(a: string, b: string): boolean {
  return nameSkeleton(a) === nameSkeleton(b);
}

/** Bidi controls a shown name may not carry: one would turn "Servers · Home" around its separator. */
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** A name as Clover shows it beside its own words: bidi controls out, its blanks one space. */
export function shownName(name: string): string {
  return name.replace(BIDI, "").replace(BLANKS, " ").trim();
}
