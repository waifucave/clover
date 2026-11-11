// Which files a bot may change without asking at "ask for risky actions" (§9.1, the owner's ruling: "bots are supposed
// to be autonomous most of the time"). An ordinary file is one in the user's own folders: inside their home, outside
// the places that hold their logins, settings, apps and the code that runs later. The fence still refuses what it
// fences, and rule 3 still asks for what it touches, before this is ever asked; this only decides what is left between
// "runs", "the reviewer judges" and "asks".
//
// Three classes (the controller's amended ruling R1):
//   * card, at ask for risky actions and accept edits, with no reviewer: anything in a `.git` at any depth (a folder,
//     or a `.git` file, a worktree's or a submodule's, whose `gitdir:` names where its hooks are: hooks and config run
//     code later outside any sandbox), or in a `<name>.git` folder (a bare repository's usual name); on the disk, any
//     git directory by its content (`HEAD`, `objects`, `config` side by side, whatever it is called), the folder a
//     repository's config names for its hooks (`core.hooksPath`) and the files it includes (`include.path`,
//     `includeIf`), and a file with more than one name inside a repository (one of its names could be a hook); and
//     anything in a folder on the user's PATH (a program put there runs the next time the user types its name);
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
import { existsSync, lstatSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { posix, win32 } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import { gitIncludedFiles, readGitConfigFile } from "../fence/run-later";

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
  if (p.slice(1).some((n) => n.endsWith(".git"))) return "card";
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

/** As `pathsClass`, and on the disk (see the head of this file): a git directory by its content, a repository's
 *  configured hooks folder and included files, and a file with more than one name (a hard link, which no real path
 *  shows: `ln ~/.ssh/authorized_keys ~/Downloads/x`) are never ordinary, nor anything that can't be looked at; a
 *  repository whose config can't be read is never ordinary either (nothing is guessed). A name not made yet is judged
 *  by its path and the folders above it. */
export function pathsClassOnDisk(paths: readonly string[] | undefined, o: OrdinaryPathsOptions): PathClass {
  let worst = pathsClass(paths, o);
  if (worst === "card" || paths === undefined) return worst;
  const raise = (c: PathClass) => { if (CLASS_RANK[c] > CLASS_RANK[worst]) worst = c; };
  for (const x of paths) {
    const repo = repositoryOf(x, o);
    if (repo.kind === "git-dir") return "card";
    if (repo.kind === "repo") {
      if (repo.config === undefined) raise("review");
      else if (repo.config.some((f) => { const folder = names(f, o.os); const at = names(x, o.os); return folder !== null && at !== null && within(at, folder); })) return "card";
    }
    try {
      const st = lstatSync(x);
      if (!st.isDirectory() && st.nlink > 1) {
        if (repo.kind === "repo") return "card";
        // Outside any repository, a file with another name that reads as a git config (a link to a repo's
        // `.git/config`): one of its names is a config that runs code, so a card; any other, the reviewer.
        if (/^\s*\[\s*core\s*\]/im.test(readGitConfigFile(x) ?? "")) return "card";
        raise("review");
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") raise("review");
    }
  }
  return worst;
}

/** The most folders `repositoryOf` climbs. */
const CLIMB_MAX = 64;

/** Where `path` is as git sees it: inside a git directory (found by its content), inside a repository's working tree
 *  (with the hooks folder and the included files its config names, or `config: undefined` when that can't be read),
 *  or neither. */
function repositoryOf(path: string, o: OrdinaryPathsOptions): { kind: "git-dir" } | { kind: "repo"; config: string[] | undefined } | { kind: "none" } {
  const p = o.os === "windows" ? win32 : posix;
  const isDir = (x: string) => { try { return statSync(x).isDirectory(); } catch { return false; } };
  const isFile = (x: string) => { try { return statSync(x).isFile(); } catch { return false; } };
  let dir = isDir(path) ? path : p.dirname(path);
  for (let i = 0; i < CLIMB_MAX; i++) {
    if (isFile(p.join(dir, "HEAD")) && isDir(p.join(dir, "objects")) && isFile(p.join(dir, "config"))) return { kind: "git-dir" };
    const dotGit = p.join(dir, ".git");
    if (isDir(dotGit)) return { kind: "repo", config: repoConfigPaths(dotGit, dir, o) };
    if (isFile(dotGit)) {
      const text = readGitConfigFile(dotGit);
      const m = text === undefined ? null : /^gitdir:\s*(.+?)\s*$/m.exec(text);
      return { kind: "repo", config: m === null ? undefined : repoConfigPaths(p.resolve(dir, m[1]!), dir, o) };
    }
    const up = p.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return { kind: "none" };
}

/** Folders the look never enters: package installs and the OS's own (no repository config of the user's is there). */
const SCAN_SKIPPED = new Set(["node_modules", "Library", ".Trash", ".cache", ".npm", ".bun", ".cargo", ".rustup"]);

/** The most folders `gitRunLaterPlaces` looks in below a root, and how deep. */
const SCAN_DIRS_MAX = 3_000;
const SCAN_DEPTH_MAX = 6;

/** What git would run later for a write root's repositories (the adversarial review on stage 2): the places the
 *  config of the repository `root` is in, or of any repository found under it (a `.git` folder or file, or a git
 *  directory by its content, at most `SCAN_DEPTH_MAX` deep and `SCAN_DIRS_MAX` folders), names for hooks
 *  (`core.hooksPath`) or includes. `complete` is false when the look stopped at a bound, or a config couldn't be read:
 *  what it found is still given. */
export function gitRunLaterPlaces(root: string, o: OrdinaryPathsOptions, budget: { left: number } = { left: SCAN_DIRS_MAX }): { places: string[]; complete: boolean } {
  const p = o.os === "windows" ? win32 : posix;
  const places: string[] = [];
  let complete = true;
  const take = (r: ReturnType<typeof repositoryOf>) => {
    if (r.kind !== "repo") return;
    if (r.config === undefined) complete = false;
    else places.push(...r.config);
  };
  take(repositoryOf(root, o));
  const walk = (dir: string, depth: number) => {
    if (depth > SCAN_DEPTH_MAX) { complete = false; return; }
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (--budget.left < 0) { complete = false; return; }
      const at = p.join(dir, e.name);
      if (e.name === ".git") {
        const gitDir = e.isDirectory() ? at : (() => {
          const m = /^gitdir:\s*(.+?)\s*$/m.exec(readGitConfigFile(at) ?? "");
          return m === null ? undefined : p.resolve(dir, m[1]!);
        })();
        const cfg = gitDir === undefined ? undefined : repoConfigPaths(gitDir, dir, o);
        if (cfg === undefined) complete = false;
        else places.push(...cfg);
        continue;
      }
      if (!e.isDirectory() || e.isSymbolicLink() || SCAN_SKIPPED.has(e.name)) continue;
      const head = p.join(at, "HEAD");
      if (existsSync(head) && existsSync(p.join(at, "objects")) && existsSync(p.join(at, "config"))) {
        const cfg = repoConfigPaths(at, at, o);
        if (cfg === undefined) complete = false;
        else places.push(...cfg);
        continue;
      }
      walk(at, depth + 1);
    }
  };
  walk(root, 1);
  return { places: [...new Set(places)], complete };
}

/** The places a repository's config names that run code later: `core.hooksPath` (relative to the working tree) and
 *  every file it includes, followed as git does (ten deep, each once). A linked worktree's git directory names the
 *  main one in `commondir`: its config is the repository's, and the worktree's own `config.worktree` is read too.
 *  Undefined when the config is there and can't be read, or `commondir` can't. */
function repoConfigPaths(gitDir: string, worktree: string, o: OrdinaryPathsOptions): string[] | undefined {
  const p = o.os === "windows" ? win32 : posix;
  let common = gitDir;
  const commondir = p.join(gitDir, "commondir");
  if (existsSync(commondir)) {
    const named = readGitConfigFile(commondir)?.trim();
    if (named === undefined || named === "") return undefined;
    common = p.resolve(gitDir, named);
  }
  const first = p.join(common, "config");
  const out: string[] = [];
  const seen = new Set<string>();
  let unreadable = false;
  const visit = (file: string, depth: number) => {
    if (depth > 10 || seen.has(file)) return;
    seen.add(file);
    const text = readGitConfigFile(file);
    if (text === undefined) {
      if (file === first && existsSync(file)) unreadable = true;
      return;
    }
    out.push(...hooksPathsIn(text, o, worktree));
    for (const inc of gitIncludedFiles(text, o.os, o.home, p.dirname(file))) {
      out.push(inc);
      visit(inc, depth + 1);
    }
  };
  visit(first, 0);
  for (const own of new Set([p.join(gitDir, "config.worktree"), p.join(common, "config.worktree")])) visit(own, 0);
  if (unreadable) return undefined;
  // As the paths they are compared with: each with its links followed where it is there.
  return out.flatMap((x) => { try { const r = realpathSync.native(x); return r === x ? [x] : [x, r]; } catch { return [x]; } });
}

/** Each `core.hooksPath` a config text sets, as a path (`~/` expanded; a relative one is the working tree's). */
function hooksPathsIn(text: string, o: OrdinaryPathsOptions, worktree: string): string[] {
  const p = o.os === "windows" ? win32 : posix;
  const out: string[] = [];
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)[#;].*$/, "").trim();
    const head = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]$/.exec(line);
    if (head) { section = head[1]!.toLowerCase(); continue; }
    const kv = /^hookspath\s*=\s*(.*)$/i.exec(line);
    if (kv === null || section !== "core") continue;
    let v = kv[1]!.trim().replace(/^"(.*)"$/, "$1");
    if (v === "") continue;
    if (v.startsWith("~/") || v.startsWith("~\\")) v = p.join(o.home, v.slice(2));
    out.push(p.isAbsolute(v) ? p.normalize(v) : p.resolve(worktree, v));
  }
  return out;
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
