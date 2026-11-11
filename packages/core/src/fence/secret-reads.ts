// The secret places in the user's home a bot never reads (`SECRET_READ_PLACES`, contracts/fence.ts), judged on the
// disk: a path is in one when the place it really reaches is, so a link from the bot's own folder to `~/.aws/credentials`
// is refused and a link inside `~/.ssh` that points out of it is judged where it points (readable when that is). Each
// place is taken as written and as it really is (a `~/.ssh` that is itself a link into a dotfiles folder holds what is
// there). Case-folded as the fence folds names (APFS and NTFS open `~/.AWS` as `~/.aws`).
import { lstatSync } from "node:fs";
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

/** Each place as written and as it really is. */
function placesOf(o: SecretReadOptions): { paths: string[]; cls: SecretClass; at: string }[] {
  return secretReadPlaces(o.os, o.userHome).map((p) => ({ at: p.path, cls: p.cls, paths: [...new Set([p.path, realPathOf(p.path, o.cwd)])] }));
}

/** The class of the secret place `path` really reaches, or undefined. */
export function secretPlaceOf(path: string, o: SecretReadOptions): SecretClass | undefined {
  const real = realPathOf(path, o.cwd);
  for (const p of placesOf(o)) if (p.paths.some((at) => isInsideFolded(real, at, o.os))) return p.cls;
  return undefined;
}

/** How many secret places that are on the disk lie inside the folder `root` really is: what a search from there skips. */
export function secretPlacesUnder(root: string, o: SecretReadOptions): number {
  const real = realPathOf(root, o.cwd);
  let n = 0;
  for (const p of placesOf(o)) {
    let there = false;
    try { lstatSync(p.at); there = true; } catch { /* not on this disk */ }
    if (there && p.paths.some((at) => isInsideFolded(at, real, o.os) && !isInsideFolded(real, at, o.os))) n++;
  }
  return n;
}

/** What a bot is told when it asks for a secret place: the class only, never the file's content or another path. */
export function secretReadRefusal(tool: string, asked: string, cls: SecretClass): string {
  return `${tool} was not run: ${asked} is in a place that holds ${cls}, which bots never read on this computer. `
    + "If the user wants it used, they can paste the value they choose into the conversation, or open the file themselves.";
}
