// Contract: Fence (spec §3.1, §4, §9.1 "Bots cannot raise their own access" and "The fence, precisely", §9.3).
// Owner: lane C.
//
// A core fence keeps bots' tools, and agents' commands through their own sandboxes, away from the files that hold
// settings, levels, credentials and bots' user layers, on every OS. The plugins folder and routine files are not
// fenced: bots write plugins and routines as files, and the app asks before loading a plugin or running a routine at
// a raised level. The fence judges only what models drive (a bot's tools, an agent's requests, a plugin's `files`
// calls); the user's own actions never ask it.
//
// One Fence per computer: each computer fences its own home, and the folder tree asks the fence of the computer that
// holds the files (§9.1 "Approvals follow the files"). Paths are absolute and canonical on that computer; the real
// implementation canonicalizes per OS (case, symlinks, junctions, 8.3 names, hard-link aliases), the fake is POSIX.
import type { Os } from "@waifucave/clover-protocol";
import { isInside, type Unsubscribe } from "./common";

/** The fenced set (§9.1), plus the files that hold secrets on Windows and Linux (§8.5). */
export const FENCED_KINDS = [
  "settings",
  "levels",
  "saved-rules",
  "connector-permissions",
  "trust",
  "device-list",
  "user-layers",
  "credential-store",
  /** The registry's own records (review S8): a bot that could write them would approve its own plugin. The OKs (each
   *  plugin's approved tree hash, child switches and card styling last OK'd), */
  "plugin-oks",
  /** the installed-plugins list that syncs (§8.5: ids, versions, hashes, on/off states, opt-outs), */
  "installed-plugins",
  /** and the user's confirmation that they are 18 or older (§5.7). */
  "adult-confirmation",
  /** Development folders themselves (§5.6): they reload on every change without asking. */
  "dev-folders",
  /** `<home>/plugin-data/<id>/` (§5.4), where add-ons live. */
  "plugin-data",
  /** The daemon's run folder: denied for reading too, as it is today. */
  "run-folder",
  /** Windows and Linux: the encrypted secrets file, hidden from reads too (§8.5, §9.1). */
  "secrets-file",
  /** Windows and Linux: any file holding the secrets file's key, hidden from reads too. */
  "key-file",
] as const;
export type FencedKind = (typeof FENCED_KINDS)[number];

/** The items whose contents the fence hides from reads as well as writes. */
export const READ_DENIED_KINDS: readonly FencedKind[] = ["run-folder", "secrets-file", "key-file"];

export interface FencedPath {
  kind: FencedKind;
  /** Absolute and canonical; a folder covers everything inside it. */
  path: string;
  deny: "write" | "read-write";
}

export type FenceOp =
  | { op: "read" | "list" | "stat"; path: string }
  | { op: "write" | "delete"; path: string }
  | { op: "move"; path: string; to: string };

export type FenceVerdict =
  | { allowed: true }
  | { allowed: false; reason: FencedKind | "clover-home"; path: string };

/** What a sandbox needs to hold the fence for one command runner: Bash (PowerShell on Windows), and each agent's own
 *  sandbox, whose format lane K writes from these arrays (Claude Code's deny rules, Codex's settings, §9.3). */
export interface SandboxPolicy {
  /** Commands may write here: the home and temp folders (§9.1), less `denyWrite`. */
  allowWrite: string[];
  denyWrite: string[];
  denyRead: string[];
  /** Programs that would hand work to an unfenced process: `open`, `launchctl` and `osascript` on macOS,
   *  `systemd-run --user` on Linux, the Task Scheduler on Windows (§3.1). */
  closedDoors: string[];
  /** Never reachable from a command, approved escapes included: the cloud metadata address first (§9.2). */
  blockedAddresses: string[];
  /** Today's sandboxed Bash has no network (spike S8 read it from source); lane C settles Clover's (S8 item 1). */
  network: "none" | "filtered";
}

export interface Fence {
  readonly os: Os;
  fencedSet(): readonly FencedPath[];
  /** One file operation by a bot, an agent or a plugin. A write, delete or move is refused inside a fenced item and
   *  on any folder that holds one (renaming an ancestor moves the item); a read only inside a read-denied item. Names
   *  compare folded on every OS (`foldName`), whether or not the item exists yet, and a name that isn't ASCII where
   *  Clover names things under its home is refused (`nonAsciiAlias`). */
  check(op: FenceOp): FenceVerdict;
  /** The first fenced item any of `paths` reaches, for any access: an agent's request touching one is always a card,
   *  at every level (§9.3). */
  touches(paths: readonly string[]): FencedPath | null;
  /** `Agent` refuses a root folder that holds the Clover home or a development folder (§5.6, §9.3). */
  checkAgentRoot(root: string): FenceVerdict;
  policy(): SandboxPolicy;
  /** The set changed: a development folder was added or removed, or a plugin's data folder appeared. */
  watch(fn: () => void): Unsubscribe;
}

/** The programs each OS's fence closes (§3.1). */
export const CLOSED_DOORS: Record<Os, readonly string[]> = {
  macos: ["open", "launchctl", "osascript"],
  linux: ["systemd-run"],
  windows: ["schtasks", "Register-ScheduledTask"],
};

/** Cloud metadata endpoints (§9.2): the bash fence blocks them, so a bot can't lift a VM's credentials. */
export const CLOUD_METADATA_ADDRESSES: readonly string[] = ["169.254.169.254", "fd00:ec2::254", "metadata.google.internal"];

/** One name as a case-folding file system could compare it: Unicode NFC, then upper case and back to lower, then NFC
 *  again. The round trip folds what lower case alone leaves: the long s (`ſettings` opens `settings` on APFS and NTFS),
 *  the dotless i, the Kelvin sign, and ß to ss. On Windows the trailing dots and spaces Win32 drops go too (`.clover.`
 *  opens `.clover`). Folding more than a disk does only refuses more. The fence folds on every OS: Linux has
 *  case-folding ext4 folders and mounted APFS, NTFS and exFAT homes (#179's review, F1). One function for every lane
 *  that compares names against the fenced set: the fence, the tree's holders, the core's own checks. */
export function foldName(name: string, os?: Os): string {
  const s = name.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
  return os === "windows" ? s.replace(/[. ]+$/, "") : s;
}

/** A whole path folded name by name, with `/` between; a `\` is read as `/` first, so `C:\Users\me` meets the fence's
 *  `C:/Users/me`. */
export function foldPath(path: string, os?: Os): string {
  return path.replace(/\\/g, "/").split("/").map((seg) => (seg === "" ? seg : foldName(seg, os))).join("/");
}

/** `isInside`, with both sides folded (`foldPath`). */
export function isInsideFolded(path: string, root: string, os?: Os): boolean {
  return isInside(foldPath(path, os), foldPath(root, os));
}

const NON_ASCII = /[^\x00-\x7f]/;
const namesOf = (path: string): string[] => path.replace(/\\/g, "/").split("/").filter((s) => s !== "");
const sameFolded = (a: readonly string[], b: readonly string[], os?: Os): boolean =>
  a.length === b.length && a.every((n, i) => foldName(n, os) === foldName(b[i]!, os));

/** The second wall (#179's review, F1): a name that isn't ASCII, where Clover names things itself, is refused, whatever
 *  a file system might fold it to. That is the Clover home's own top level and any folder under it that holds a fenced
 *  item (`plugins-state/` for `plugins-state/oks`). Clover never names one of those in another script, so a name there
 *  could only be an attempt at an alias by a rule this fold doesn't know. A bot's memory note or a plugin's asset may
 *  still have any name: those folders hold no fenced item. */
export function nonAsciiAlias(path: string, set: readonly FencedPath[], cloverHome: string, os?: Os): boolean {
  const names = namesOf(path);
  const home = namesOf(cloverHome);
  if (names.length <= home.length || !sameFolded(names.slice(0, home.length), home, os)) return false;
  const holders = set.map((item) => namesOf(item.path));
  for (let depth = home.length; depth < names.length; depth++) {
    if (!NON_ASCII.test(names[depth]!)) continue;
    const folder = names.slice(0, depth);
    if (depth === home.length || holders.some((item) => item.length > depth && sameFolded(item.slice(0, depth), folder, os))) return true;
  }
  return false;
}

export interface JudgeOptions {
  /** The computer's OS, for its folding rules (`foldName`). */
  os?: Os;
  /** The Clover home, for the second wall (`nonAsciiAlias`). */
  cloverHome?: string;
}

/** The verdict for `op` against a fenced set; the fake and any implementation share it. Names compare folded
 *  (`foldName`) on every OS, and with `cloverHome` a name that isn't ASCII where Clover names things is refused as
 *  `clover-home` (`nonAsciiAlias`). */
export function judge(set: readonly FencedPath[], op: FenceOp, o: JudgeOptions = {}): FenceVerdict {
  const writes = op.op === "write" || op.op === "delete" || op.op === "move";
  const paths = op.op === "move" ? [op.path, op.to] : [op.path];
  const inside = (p: string, r: string) => isInsideFolded(p, r, o.os);
  for (const path of paths) {
    for (const item of set) {
      if (writes) {
        if (inside(path, item.path) || inside(item.path, path)) return { allowed: false, reason: item.kind, path: item.path };
      } else if (item.deny === "read-write" && inside(path, item.path)) {
        return { allowed: false, reason: item.kind, path: item.path };
      }
    }
  }
  if (o.cloverHome !== undefined) {
    for (const path of paths) {
      if (nonAsciiAlias(path, set, o.cloverHome, o.os)) return { allowed: false, reason: "clover-home", path: o.cloverHome };
    }
  }
  return { allowed: true };
}
