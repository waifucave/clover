// Which files a bot may change without asking at "ask for risky actions" (§9.1, the owner's ruling: "bots are supposed
// to be autonomous most of the time"). An ordinary file is one in the user's own folders: inside their home, outside
// the places that hold their logins, settings and apps. The fence still refuses what it fences, and rule 3 still asks
// for what it touches, before this is ever asked; this only decides what is left between "runs" and "asks".
//
// Sensitive, so a change there still asks at ask-risky (and runs at accept edits):
//   * anything outside the user's home;
//   * a dotfile or dot-folder directly in the home (`~/.aws`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.config`), and so
//     everything under one;
//   * macOS: `~/Library` (Keychains, Application Support, Preferences) and anything inside an `.app` bundle;
//   * Windows: `AppData`;
//   * the Clover home, wherever it is.
//
// The path is the one the requester resolved (`resolveSessionPath`: every link followed, a name not made yet joined on
// to its nearest existing folder's real path), so a link from Downloads into `~/.ssh` is judged as `~/.ssh`. Names are
// compared as the disk compares them: folded for case and Unicode form on macOS and Windows, and on Windows with the
// trailing dots and spaces it drops, and an 8.3 short name (`APPDAT~1`) is never taken for ordinary.
import { lstatSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { Os } from "@waifucave/clover-protocol";

export interface OrdinaryPathsOptions {
  /** The user's home (its real path). */
  home: string;
  os: Os;
  /** Clover's home: never ordinary, wherever it is. */
  cloverHome?: string;
}

/** A name as the disk compares it. */
function folded(name: string, os: Os): string {
  let n = name.normalize("NFC");
  if (os === "windows") n = n.replace(/[. ]+$/, "");
  return os === "linux" ? n : n.toLowerCase();
}

/** The path's names after its root, folded; null for a path that isn't absolute or still names `..` or `.`. */
function names(path: string, os: Os): string[] | null {
  const p = os === "windows" ? win32 : posix;
  if (!p.isAbsolute(path)) return null;
  const root = p.parse(path).root;
  const parts = path.slice(root.length).split(os === "windows" ? /[\\/]+/ : /\/+/).filter((x) => x !== "");
  if (parts.some((x) => x === ".." || x === ".")) return null;
  const rootKey = folded(root.replace(/[\\/]+$/, ""), os);
  return [rootKey, ...parts.map((x) => folded(x, os))];
}

/** Whether `path` lies strictly inside `folder` (both as `names` gives them). */
function strictlyInside(path: readonly string[], folder: readonly string[]): boolean {
  return path.length > folder.length && folder.every((n, i) => path[i] === n);
}

/** Whether a change to `path` is a change to an ordinary file of the user's (see the head of this file). */
export function isOrdinaryPath(path: string, o: OrdinaryPathsOptions): boolean {
  const p = names(path, o.os);
  const home = names(o.home, o.os);
  if (p === null || home === null || !strictlyInside(p, home)) return false;
  if (o.cloverHome !== undefined) {
    const clover = names(o.cloverHome, o.os);
    if (clover === null || strictlyInside(p, clover) || p.length === clover.length && clover.every((n, i) => p[i] === n)) return false;
  }
  const first = p[home.length]!;
  if (first.startsWith(".")) return false;
  if (o.os === "macos" && first === "library") return false;
  if (o.os === "windows" && (first === "appdata" || p.some((n) => /~\d/.test(n)))) return false;
  if (o.os === "macos" && p.some((n) => n.endsWith(".app"))) return false;
  return true;
}

/** Whether every one of `paths` is ordinary (and there is at least one). */
export function allOrdinary(paths: readonly string[] | undefined, o: OrdinaryPathsOptions): boolean {
  return paths !== undefined && paths.length > 0 && paths.every((x) => isOrdinaryPath(x, o));
}

/** As `allOrdinary`, and on the disk: a file that is there with more than one name (a hard link, which no real path
 *  shows: `ln ~/.ssh/authorized_keys ~/Downloads/x`) is never ordinary, nor anything that can't be looked at. A name
 *  not made yet is judged by its path alone. */
export function allOrdinaryOnDisk(paths: readonly string[] | undefined, o: OrdinaryPathsOptions): boolean {
  if (!allOrdinary(paths, o)) return false;
  return paths!.every((x) => {
    try {
      const st = lstatSync(x);
      return st.isDirectory() || st.nlink <= 1;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT";
    }
  });
}
