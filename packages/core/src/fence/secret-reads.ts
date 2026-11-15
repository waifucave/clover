// The secret places in the user's home a bot never reads or writes (`SECRET_READ_PLACES`, contracts/fence.ts), judged
// on the disk: a path is in one when the place it really reaches is, so a link from the bot's own folder to
// `~/.aws/credentials` is refused and a link inside `~/.ssh` that points out of it is judged where it points (readable
// when that is). Each place is taken as written and as it really is (a `~/.ssh` that is itself a link into a dotfiles
// folder holds what is there). Case-folded as the fence folds names (APFS and NTFS open `~/.AWS` as `~/.aws`).
//
// A path is judged as the runtime opens it (its Read, Grep and Glob trim the path and resolve it against the session's
// folder, with no `~` expansion: index-q1vv1628.js, read.ts `resolve(ctx.cwd, input.file_path.trim())`), and also with
// a leading `~` or `~/` expanded to the user's home, as a shell or a later tool would read it: either form in a place
// refuses.
import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import { isInsideFolded, secretReadPlaces, type SecretClass } from "../contracts/fence";
import { realPathOf } from "../agents/memory";

export interface SecretReadOptions {
  /** The user's home, where the places are. */
  userHome: string;
  os: Os;
  /** The folder a relative path is the session's. */
  cwd: string;
}

/** The places, each as written and as it really is, and whether it is on the disk. */
interface Place { paths: string[]; cls: SecretClass; there: boolean }

/** How long the places' real paths are kept (a search judges every hit against the same places). */
const PLACES_TTL_MS = 5_000;
let cache: { key: string; at: number; places: Place[] } | undefined;

/** Forgets the places' real paths (a test that moves a place makes it a link). */
export function forgetPlaces(): void { cache = undefined; }

/** The places for a user's home, their real paths looked up at most once in `PLACES_TTL_MS` (a place made a link
 *  meanwhile is judged by its old real path until then, and by its written one always). */
export function placesOf(userHome: string, os: Os): Place[] {
  const key = `${os}\0${userHome}`;
  const now = Date.now();
  if (cache !== undefined && cache.key === key && now - cache.at < PLACES_TTL_MS) return cache.places;
  const places = secretReadPlaces(os, userHome).map((p): Place => {
    let there = false;
    try { lstatSync(p.path); there = true; } catch { /* not on this disk */ }
    return { cls: p.cls, there, paths: [...new Set([p.path, realPathOf(p.path, userHome)])] };
  });
  cache = { key, at: now, places };
  return places;
}

/** The forms a path asked for is judged in: as the runtime opens it, and with a leading `~` expanded. */
export function askedForms(path: string, o: Pick<SecretReadOptions, "userHome" | "cwd">): string[] {
  const t = path.trim();
  const forms = [isAbsolute(t) ? resolve(t) : resolve(o.cwd, t)];
  if (t === "~") forms.push(o.userHome);
  else if (t.startsWith("~/") || t.startsWith("~\\")) forms.push(join(o.userHome, t.slice(2)));
  return forms;
}

/** The class of the secret place `path` really reaches, in any form it is asked in, or undefined. */
export function secretPlaceOf(path: string, o: SecretReadOptions, places: Place[] = placesOf(o.userHome, o.os)): SecretClass | undefined {
  for (const form of askedForms(path, o)) {
    const real = realPathOf(form, o.cwd);
    for (const p of places) if (p.paths.some((at) => isInsideFolded(real, at, o.os))) return p.cls;
  }
  return undefined;
}

/** Whether any secret place on the disk lies inside the folder `root` really is: what a search from there skips. */
export function secretPlacesUnder(root: string, o: SecretReadOptions, places: Place[] = placesOf(o.userHome, o.os)): boolean {
  return askedForms(root, o).some((form) => {
    const real = realPathOf(form, o.cwd);
    return places.some((p) => p.there && p.paths.some((at) => isInsideFolded(at, real, o.os) && !isInsideFolded(real, at, o.os)));
  });
}

/** What a bot is told when it asks for a secret place: the class only, never the file's content or another path. */
export function secretReadRefusal(tool: string, asked: string, cls: SecretClass): string {
  return `${tool} was not run: ${asked} is in a place that holds ${cls}, which bots never read or change on this computer. `
    + "If the user wants it used, they can paste the value they choose into the conversation, or open the file themselves.";
}

/** The line a search's result carries when its folder holds secret places: no path in them, and no count (a count
 *  would say how many of the listed apps are installed). */
export const SKIPPED_NOTE = "(some protected places were skipped: credentials, keys and sign-ins a bot never reads)";
