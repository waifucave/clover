// Which files a bot may change without asking at "ask for risky actions" (§9.1, the owner's ruling: "bots are supposed
// to be autonomous most of the time"). An ordinary file is one in the user's own folders: inside their home, outside
// the places that hold their logins, settings, apps and the code that runs later. The fence still refuses what it
// fences, and rule 3 still asks for what it touches, before this is ever asked; this only decides what is left between
// "runs", "the reviewer judges" and "asks".
//
// Three classes (the controller's amended ruling R1):
//   * card, at ask for risky actions and accept edits, with no reviewer: anything in a `.git` at any depth (a folder,
//     or a `.git` file, a worktree's or a submodule's, whose `gitdir:` names where its hooks are: hooks and config run
//     code later outside any sandbox), and anything in a folder on the user's PATH (a program put there runs the next
//     time the user types its name);
//   * review (the reviewer, then a card when it isn't sure), and run at accept edits: anything outside the user's home;
//     a dotfile or dot-folder directly in the home (`~/.aws`, `~/.kube`, `~/.config`) and everything under one; macOS
//     `~/Library` and anything inside an `.app` bundle; Windows `AppData` and any 8.3 short name; the Clover home; a
//     dot-entry deeper down (`~/Projects/x/.env`, `.vscode`, `.github`); a file with more than one name (a hard link);
//   * ordinary: everything else in the home.
//
// The path is the one the requester resolved (`resolveSessionPath`: every link followed, a name not made yet joined on
// to its nearest existing folder's real path), so a link from Downloads into `~/.ssh` is judged as `~/.ssh`. Names are
// compared as the disk compares them: folded for case and Unicode form on macOS and Windows, and on Windows with the
// trailing dots and spaces it drops (`.GIT.` is `.git`), and an 8.3 short name (`APPDAT~1`) is never taken for
// ordinary.
import { lstatSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { Os } from "@waifucave/clover-protocol";

export interface OrdinaryPathsOptions {
  /** The user's home (its real path). */
  home: string;
  os: Os;
  /** Clover's home: never ordinary, wherever it is. */
  cloverHome?: string;
  /** The folders on the user's PATH (their real paths; `pathFolders`): anything inside one is a card. */
  pathFolders?: readonly string[];
}

/** What a change to a path is at ask for risky actions: see the head of this file. */
export type PathClass = "ordinary" | "review" | "card";

const CLASS_RANK: Record<PathClass, number> = { ordinary: 0, review: 1, card: 2 };

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

/** Whether `path` is `folder` or inside it. */
function within(path: readonly string[], folder: readonly string[]): boolean {
  return path.length >= folder.length && folder.every((n, i) => path[i] === n);
}

/** The class of a change to `path` (see the head of this file). */
export function pathClass(path: string, o: OrdinaryPathsOptions): PathClass {
  const p = names(path, o.os);
  if (p === null) return "review";
  if (p.slice(1).includes(".git")) return "card";
  for (const f of o.pathFolders ?? []) {
    const folder = names(f, o.os);
    if (folder !== null && folder.length > 1 && within(p, folder)) return "card";
  }
  const home = names(o.home, o.os);
  if (home === null || !strictlyInside(p, home)) return "review";
  if (o.cloverHome !== undefined) {
    const clover = names(o.cloverHome, o.os);
    if (clover === null || within(p, clover)) return "review";
  }
  const first = p[home.length]!;
  if (o.os === "macos" && first === "library") return "review";
  if (o.os === "windows" && (first === "appdata" || p.some((n) => /~\d/.test(n)))) return "review";
  if (o.os === "macos" && p.some((n) => n.endsWith(".app"))) return "review";
  // A dot-entry, directly in the home or deeper down.
  if (p.slice(home.length).some((n) => n.startsWith("."))) return "review";
  return "ordinary";
}

/** Whether a change to `path` is a change to an ordinary file of the user's. */
export function isOrdinaryPath(path: string, o: OrdinaryPathsOptions): boolean {
  return pathClass(path, o) === "ordinary";
}

/** The strictest class of `paths`; none at all is `review` (a change that names no file is never taken for ordinary). */
export function pathsClass(paths: readonly string[] | undefined, o: OrdinaryPathsOptions): PathClass {
  if (paths === undefined || paths.length === 0) return "review";
  let worst: PathClass = "ordinary";
  for (const x of paths) {
    const c = pathClass(x, o);
    if (CLASS_RANK[c] > CLASS_RANK[worst]) worst = c;
  }
  return worst;
}

/** Whether every one of `paths` is ordinary (and there is at least one). */
export function allOrdinary(paths: readonly string[] | undefined, o: OrdinaryPathsOptions): boolean {
  return pathsClass(paths, o) === "ordinary";
}

/** As `pathsClass`, and on the disk: a file that is there with more than one name (a hard link, which no real path
 *  shows: `ln ~/.ssh/authorized_keys ~/Downloads/x`) is never ordinary, nor anything that can't be looked at. A name
 *  not made yet is judged by its path alone. */
export function pathsClassOnDisk(paths: readonly string[] | undefined, o: OrdinaryPathsOptions): PathClass {
  const c = pathsClass(paths, o);
  if (c !== "ordinary") return c;
  const onDisk = paths!.every((x) => {
    try {
      const st = lstatSync(x);
      return st.isDirectory() || st.nlink <= 1;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT";
    }
  });
  return onDisk ? "ordinary" : "review";
}

/** As `allOrdinary`, on the disk (`pathsClassOnDisk`). */
export function allOrdinaryOnDisk(paths: readonly string[] | undefined, o: OrdinaryPathsOptions): boolean {
  return pathsClassOnDisk(paths, o) === "ordinary";
}

/** The folders on a PATH value, as `pathClass` compares them: absolute entries only (an empty entry or `.` stands for
 *  whatever folder a command runs in, which is no folder of the user's in particular, so it is left out), each as
 *  written and, when it exists, with its links followed. Cached on the value only while every entry was there: one
 *  not made yet (a `~/bin` the dotfiles name) is looked at again on the next call, so a link it becomes is followed. */
export function pathFolders(value: string | undefined, os: Os): readonly string[] {
  const v = value ?? "";
  if (cachedPath?.value === v && cachedPath.os === os) return cachedPath.folders;
  const p = os === "windows" ? win32 : posix;
  const folders: string[] = [];
  let complete = true;
  for (const raw of v.split(os === "windows" ? ";" : ":")) {
    const e = raw.trim().replace(/^"(.*)"$/, "$1");
    if (e === "" || !p.isAbsolute(e)) continue;
    const written = p.normalize(e);
    if (!folders.includes(written)) folders.push(written);
    try {
      const real = realpathSync.native(written);
      if (!folders.includes(real)) folders.push(real);
    } catch {
      complete = false;
    }
  }
  cachedPath = complete ? { value: v, os, folders } : undefined;
  return folders;
}

let cachedPath: { value: string; os: Os; folders: readonly string[] } | undefined;
