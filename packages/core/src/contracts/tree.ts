// Contract: Tree (spec §6.5 "Where it lives", §9.1 "One folder tree across every computer" and "How it works").
// Owner: lane J.
//
// The bot sees `home/<Computer>/` for each connected computer, that computer's home folder, and `bots/<bot>/`, which
// always resolves to the computer running that bot (its memory and its agents' transcripts). Each call runs on the
// computer that holds the files, over the link: files are reached live, never synced. A path on a computer that is off
// answers `computer_offline` at once and never hangs.
//
// Beside the homes, each bot's tree has `home/memory/` (the owner's decision, #197): that bot's own memory folder,
// `<home>/bots/<bot>/memory/`, synced across the user's computers (lane H syncs it) rather than reached live, so it
// answers wherever the bot runs. It resolves for the caller's own bot (`TreeLocation.area` `memory`), and the fence's
// `bot-memory` item lets only that bot's main conversation and side threads read or write it; anything else is
// `fenced`. `memory` is therefore no computer's name (`RESERVED_COMPUTER_NAMES`). Lane J builds it.
//
// What the contract promises:
// * `resolve` says where a tree path lives; `toTreePath` goes the other way for paths inside a home folder. A path
//   never climbs out of its area: an empty, `.` or `..` segment, a backslash or a NUL makes it `invalid`, so
//   `home/Studio/../../etc/passwd` and `bots/alpha/../settings` resolve nowhere (review S9).
// * Every call says whom it is for (`as`, required): only the core's own code passes `{ kind: "core" }`, which the
//   fence doesn't judge; the user's own actions on this computer never ask it either.
// * Calls made for a bot, an agent or a plugin (`as` is not the user) are judged by the fence of the computer that
//   holds the files (§9.1 "Approvals follow the files"); a refused path answers `fenced`. Approval levels are the
//   ApprovalBroker's, before the call: `computersFor` lists the computers an action touches.
// * Another computer's call (`peer`, review N2) is the main path: the owner decided there are no OS mounts, so the
//   holder's daemon serves its files to the others over the link (`tree.*` with the `peer` role). The receiver stamps
//   `as` itself, `{ kind: "peer", device, sessionId }` from the link and the call's `session`, so a peer is never the
//   user or the core, and its calls are always fenced. A peer's write, remove, move, new folder or link is also judged
//   at the stricter of the holder's level and the call's `level` (`peerTreeDecision`): allowed runs; a refusal or
//   read-only answers `refused`; at "ask for risky actions" the holder runs its own safety reviewer on the change, as
//   it does for its own sessions (ruling R1), and what it judges safe runs; what it judges risky, can't judge, or the
//   level asks about anyway (a delete) needs `answer`, the user's signed answer bound to this call
//   (`treeCallBinding`), checked by `verifySignedAnswer` with the holder's own card for it, or it answers `refused`.
//   The card goes to the user's devices on the calling computer's side, and the signed answer travels with the call
//   (J-M2). A peer's change without `level` is `invalid`. Reads, lists, glob, grep and watches are fenced but never
//   asked about.
// * `watch` follows a folder (a code session's, never a whole home) on the computer that holds it: the tree paths
//   that changed, coalesced, or `resync` when the holder's watch dropped, since what changed meanwhile was never
//   reported (lane J). It is fenced as a listing is.
// * `move` works across computers (`mv home/Desktop1/project1 home/Studio/`); both must be on, and a peer's move is
//   judged at the strictest of both computers' levels and its own.
// * Glob and grep run where the files are and send back only results.
// * Tree paths are taken literally: `%2e%2e` is a file name, not `..`. No layer that puts tree paths in a URL (a
//   `clover-tree:` link, an editor tab) may decode them back into segments.
import {
  TREE_TRANSFER, callBindingInput, type CallBinding, type Caller, type FileStat, type Level, type SignedCardAnswer, type TreePath,
  type TreeTransferParams,
} from "@waifucave/clover-protocol";
import { levelDecision, strictestLevel } from "./approval-broker";
import { ContractError, type Unsubscribe } from "./common";
import { foldName } from "./fence";

export type { TreePath };

export interface TreeLocation {
  computer: string;
  /** The real, absolute path on that computer. */
  path: string;
  /** `home` for `home/<Computer>/…`, `bot` for `bots/<bot>/…`, `memory` for `home/memory/…` (the caller's bot's
   *  memory, synced). */
  area: "home" | "bot" | "memory";
  bot?: string;
}

export type TreeData = { encoding: "utf8"; text: string } | { encoding: "base64"; data: string };

export interface TreeCallOptions {
  /** Who the call is for: a bot's, an agent's, a plugin's or a peer's call is fenced. Required, so nothing is
   *  unfenced by default. */
  as: Caller;
  /** A peer's call only: the calling computer's level for it (§9.1), the stricter of the computers it touches. */
  level?: Level;
  /** A peer's call only: the user's signed answer bound to this call, where the stricter level asks. */
  answer?: SignedCardAnswer;
}

/** A change a peer's card binds: the wire method and its params without `session`, `level` and `answer`. */
export type TreeChange =
  | { method: "tree.write"; params: { path: string; data: TreeData; createDirs?: boolean; executable?: boolean } }
  | { method: "tree.remove"; params: { path: string; recursive?: boolean } }
  | { method: "tree.move"; params: { from: string; to: string } }
  | { method: "tree.mkdir"; params: { path: string } }
  | { method: "tree.symlink"; params: { path: string; target: string } }
  /** A move or copy between two computers (R15): the one call both holders judge and one card binds. */
  | { method: typeof TREE_TRANSFER; params: TreeTransferParams };

/** A watched folder's news. */
export type TreeWatchEvent = { type: "changed"; paths: string[] } | { type: "resync" };

/** The holder's safety reviewer, as it judges a peer's change at "ask for risky actions" (ruling R1). `unavailable`
 *  (no model can run) counts as risky. */
export type TreeReviewer = (change: TreeChange & { computer: string; as: Caller }) => Promise<"safe" | "risky" | "unavailable">;

/** What a signed answer for a peer's tree change on one computer binds (review N2): the method and its params as the
 *  caller sent them, with no `session`, `level` or `answer` (an answer can't bind itself). Keys left out stay out. A
 *  move or copy between computers binds `transferChange` instead. */
export function treeCallBinding(method: Exclude<TreeChange["method"], typeof TREE_TRANSFER>, params: Record<string, unknown>): TreeChange {
  const { session: _s, level: _l, answer: _a, ...rest } = params;
  return { method, params: rest } as TreeChange;
}

/** R15's one call for a move or copy between two computers (#179's review, F2), as lane J's holders build it: the
 *  operation, both tree paths, and both computers, each holder naming them from its own tree. */
export function transferChange(move: boolean, from: string, to: string, source: string, destination: string): TreeChange {
  return { method: TREE_TRANSFER, params: { operation: move ? "move" : "copy", from, to, source, destination } };
}

/** Whether a transfer's paths lie on the computers it names (#179's review, check 2): `from` on `source`, `to` on
 *  `destination`, as this holder's tree resolves them. A holder checks it before it judges, so an answer bound to
 *  one pair of computers can't move files between others. */
export function transferEndsHold(params: TreeTransferParams, resolve: (path: string) => { computer: string }): boolean {
  try {
    return resolve(params.from).computer === params.source && resolve(params.to).computer === params.destination;
  } catch {
    return false;
  }
}

/** The binding on R15's one card: `computer` is the destination, `source` the source, so either end checks the one
 *  answer against the card it rebuilds (`bindsComputer`). A holder's `CallCardRenderer` uses this for `tree.transfer`. */
export function transferBinding(params: TreeTransferParams, sha256: (text: string) => string): CallBinding {
  return { computer: params.destination, source: params.source, method: TREE_TRANSFER, params: sha256(callBindingInput(TREE_TRANSFER, params)) };
}

/** How the holder judges a peer's tree change (review N2, ruling R1): at the stricter of its own levels (both
 *  computers' for a move) and the call's, the way `tool.run` is. `allow` runs, `refuse` answers `refused`, `review`
 *  goes to the holder's own reviewer (safe runs; risky or unavailable needs a bound signed answer), `answer` needs a
 *  bound signed answer. A holder with no reviewer yet treats `review` as `answer`. */
export function peerTreeDecision(levels: readonly Level[], callLevel: Level, effect: "edit" | "delete" | "move"): "allow" | "refuse" | "review" | "answer" {
  const level = strictestLevel([...levels, callLevel])!;
  const d = levelDecision(level, effect);
  return d === "allow" ? "allow" : d === "deny" ? "refuse" : d === "review" ? "review" : "answer";
}

/** `noFollow` is honoured (lane J's #225); a value other than true or false is refused (`invalid`), never read as false
 *  (#234's check 2). Every door that takes the flag calls this first. */
export function checkNoFollow(opts: { noFollow?: unknown }): void {
  if (opts.noFollow === undefined || opts.noFollow === true || opts.noFollow === false) return;
  throw new ContractError("invalid", "noFollow must be true or false");
}

export interface Tree {
  /** Rejects `not_found` for an unknown computer, `invalid` for a path outside `home/` and `bots/`. */
  resolve(path: string): TreeLocation;
  /** A real path inside a computer's home folder, as a tree path; null outside it. */
  toTreePath(computer: string, realPath: string): string | null;
  /** `noFollow` (tree protocol 1.1, lane J's `tree/nofollow.ts`): no link anywhere on the way is followed; one is
   *  refused. For the user's own file viewers. To a peer on tree 1.0, which would drop it, it is refused here
   *  (`unsupported`), never sent. */
  stat(path: string, opts: TreeCallOptions & { noFollow?: boolean }): Promise<FileStat | null>;
  /** `noFollow`: as `stat`, in the same call: only a plain file reached without a link is read. */
  read(path: string, opts: TreeCallOptions & { encoding?: "utf8" | "base64"; noFollow?: boolean }): Promise<TreeData>;
  write(path: string, data: TreeData, opts: TreeCallOptions & { executable?: boolean }): Promise<void>;
  list(path: string, opts: TreeCallOptions): Promise<FileStat[]>;
  remove(path: string, opts: TreeCallOptions & { recursive?: boolean }): Promise<void>;
  move(from: string, to: string, opts: TreeCallOptions): Promise<void>;
  /** Tree paths matching a glob under `cwd` (a tree folder). */
  glob(pattern: string, opts: TreeCallOptions & { cwd: string }): Promise<string[]>;
  grep(pattern: string, opts: TreeCallOptions & { path: string; glob?: string; ignoreCase?: boolean; limit?: number }): Promise<{ path: string; line: number; text: string }[]>;
  /** Follows a folder's changes; the unsubscribe ends it. Fenced as a listing; rejects as `list` would. */
  /** Rejects `invalid` for a whole home (`home/<Computer>/` itself): a watch follows one folder in it. */
  watch(path: string, opts: TreeCallOptions, fn: (event: TreeWatchEvent) => void): Promise<Unsubscribe>;
  /** The computers an action on these tree paths touches, for the strictest-level rule (§9.1). */
  computersFor(paths: readonly string[]): string[];
}

/** The folder in each bot's tree that is its memory (`home/memory/`), and the computer names that would clash. */
export const MEMORY_TREE_FOLDER = "memory";
export const RESERVED_COMPUTER_NAMES: readonly string[] = [MEMORY_TREE_FOLDER];

/** The path inside the caller's bot's memory for a `home/memory/…` tree path, `""` for the folder itself, or undefined
 *  for any other path (or one that could climb out). */
export function memoryTreeRest(path: string): string | undefined {
  const split = splitTreePath(path);
  return split?.area === "home" && isReservedComputerName(split.name) ? split.rest : undefined;
}

/** Whether a computer name is reserved (`memory`), compared folded as a disk would (`foldName`), so `Memory` and
 *  `MEMORY` are it too (#197's check 4). */
export function isReservedComputerName(name: string): boolean {
  return RESERVED_COMPUTER_NAMES.some((r) => foldName(r) === foldName(name));
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
