// Contract: Tree (spec §6.5 "Where it lives", §9.1 "One folder tree across every computer" and "How it works").
// Owner: lane J.
//
// The bot sees `home/<Computer>/` for each connected computer, that computer's home folder, and `bots/<bot>/`, which
// always resolves to the computer running that bot (its memory and its agents' transcripts). Each call runs on the
// computer that holds the files, over the link: files are reached live, never synced. A path on a computer that is off
// answers `computer_offline` at once and never hangs.
//
// What the contract promises:
// * `resolve` says where a tree path lives; `toTreePath` goes the other way for paths inside a home folder. A path
//   never climbs out of its area: an empty, `.` or `..` segment, a backslash or a NUL makes it `invalid`, so
//   `home/Studio/../../etc/passwd` and `bots/alpha/../settings` resolve nowhere (review S9).
// * Every call says whom it is for (`as`, required): only the core's own code passes `{ kind: "core" }`, which the
//   fence doesn't judge; the user's own actions never ask it either.
// * Calls made for a bot, an agent or a plugin (`as` is not the user) are judged by the fence of the computer that
//   holds the files (§9.1 "Approvals follow the files"); a refused path answers `fenced`. Approval levels are the
//   ApprovalBroker's, before the call: `computersFor` lists the computers an action touches.
// * `move` works across computers (`mv home/Desktop1/project1 home/Studio/`); both must be on.
// * Glob and grep run where the files are and send back only results.
// * Mounts (spike S6: FSKit, FUSE, WinFsp) serve other programs through the same calls; nothing here depends on them.
import type { Caller, FileStat, TreePath } from "@waifucave/clover-protocol";

export type { TreePath };

export interface TreeLocation {
  computer: string;
  /** The real, absolute path on that computer. */
  path: string;
  /** `home` for `home/<Computer>/…`, `bot` for `bots/<bot>/…`. */
  area: "home" | "bot";
  bot?: string;
}

export type TreeData = { encoding: "utf8"; text: string } | { encoding: "base64"; data: string };

export interface TreeCallOptions {
  /** Who the call is for: a bot's, an agent's or a plugin's call is fenced. Required, so nothing is unfenced by
   *  default. */
  as: Caller;
}

export interface Tree {
  /** Rejects `not_found` for an unknown computer, `invalid` for a path outside `home/` and `bots/`. */
  resolve(path: string): TreeLocation;
  /** A real path inside a computer's home folder, as a tree path; null outside it. */
  toTreePath(computer: string, realPath: string): string | null;
  stat(path: string, opts: TreeCallOptions): Promise<FileStat | null>;
  read(path: string, opts: TreeCallOptions & { encoding?: "utf8" | "base64" }): Promise<TreeData>;
  write(path: string, data: TreeData, opts: TreeCallOptions & { executable?: boolean }): Promise<void>;
  list(path: string, opts: TreeCallOptions): Promise<FileStat[]>;
  remove(path: string, opts: TreeCallOptions & { recursive?: boolean }): Promise<void>;
  move(from: string, to: string, opts: TreeCallOptions): Promise<void>;
  /** Tree paths matching a glob under `cwd` (a tree folder). */
  glob(pattern: string, opts: TreeCallOptions & { cwd: string }): Promise<string[]>;
  grep(pattern: string, opts: TreeCallOptions & { path: string; glob?: string; ignoreCase?: boolean; limit?: number }): Promise<{ path: string; line: number; text: string }[]>;
  /** The computers an action on these tree paths touches, for the strictest-level rule (§9.1). */
  computersFor(paths: readonly string[]): string[];
}

/** Splits a tree path: `home/Studio/a/b` → `{ area: "home", name: "Studio", rest: "a/b" }`; null for anything that
 *  isn't one, or could climb out of its area (an empty, `.` or `..` segment, a backslash, a NUL). */
export function splitTreePath(path: string): { area: "home" | "bots"; name: string; rest: string } | null {
  if (path.includes("\\") || path.includes("\0")) return null;
  const segments = path.replace(/\/+$/, "").split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  const [area, name, ...rest] = segments;
  if ((area !== "home" && area !== "bots") || name === undefined) return null;
  return { area, name, rest: rest.join("/") };
}
