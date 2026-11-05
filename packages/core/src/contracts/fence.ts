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
   *  on any folder that holds one (renaming an ancestor moves the item); a read only inside a read-denied item. */
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

/** The verdict for `op` against a fenced set; the fake and any implementation share it. */
export function judge(set: readonly FencedPath[], op: FenceOp): FenceVerdict {
  const writes = op.op === "write" || op.op === "delete" || op.op === "move";
  const paths = op.op === "move" ? [op.path, op.to] : [op.path];
  for (const path of paths) {
    for (const item of set) {
      if (writes) {
        if (isInside(path, item.path) || isInside(item.path, path)) return { allowed: false, reason: item.kind, path: item.path };
      } else if (item.deny === "read-write" && isInside(path, item.path)) {
        return { allowed: false, reason: item.kind, path: item.path };
      }
    }
  }
  return { allowed: true };
}
