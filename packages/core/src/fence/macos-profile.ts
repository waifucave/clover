// macOS: the fence as a Seatbelt profile, for a command run under it (bots' Bash, a hook's command; spec §9.1). Built
// from the fence's `SandboxPolicy`, on the base the inherited sandboxed Bash ran on for months (deny by default,
// processes, a few mach services, reads anywhere, writes only under the allowed roots), then the fence's denies.
//
// Measured on a real `/usr/bin/sandbox-exec` (macOS 26, APFS), and pinned by the tests that run it:
//   * literal, subpath and regex rules match the way the volume does: `LEVELS`, `KEY.json` and `levelſ` are caught by
//     a lower-case rule on a case-insensitive volume, so the fence's fold needs no character classes here;
//   * renaming a folder that holds a fenced item is a write to that folder only, so each such folder inside a writable
//     root gets its own literal deny (creating files inside it stays allowed);
//   * a hard link from a fenced file is refused under the write deny, and a symbolic link is followed to its target;
//   * names that aren't ASCII where Clover names things (the home's top level, and folders that hold a fenced item):
//     refused by a deny on every new name there followed by an allow for ASCII names, which the sandbox also takes
//     for the names that fold to ASCII (`ſ`, `ß`, the Kelvin sign) as the disk does.
import { dirname } from "node:path";
import type { SandboxPolicy } from "../contracts/fence";
import type { CallerPlaces } from "./per-caller";

export interface MacProfileInput {
  readonly policy: SandboxPolicy;
  /** The Clover home: its top level is where Clover names things. */
  readonly cloverHome: string;
  /** macOS's per-user temp folder (`getconf DARWIN_USER_TEMP_DIR`): `mktemp` writes there whatever TMPDIR says. */
  readonly perUserTemp?: string | null;
  /** Programs' real paths for `closedDoors` (default: where macOS keeps them). */
  readonly doorPaths?: Readonly<Record<string, readonly string[]>>;
  /** The runner's caller (`callerPlaces`): bots' memory and the bot driver's state, after the denies. */
  readonly caller?: CallerPlaces;
}

const DOOR_PATHS: Record<string, readonly string[]> = {
  open: ["/usr/bin/open"],
  launchctl: ["/bin/launchctl"],
  osascript: ["/usr/bin/osascript"],
};

/** SBPL string literal. */
const q = (p: string) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** A path as an SBPL regex literal. */
const rx = (p: string) => p.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&").replace(/"/g, '\\"');

const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

/** The folders a rename would move a fenced item with: each one between a writable root and the item. */
function holders(denied: readonly string[], writable: readonly string[]): string[] {
  const out = new Set<string>();
  for (const d of denied) {
    for (let p = dirname(d); p !== dirname(p); p = dirname(p)) {
      if (writable.some((w) => inside(p, w))) out.add(p);
      else break;
    }
  }
  return [...out].sort();
}

export function macFenceProfile(input: MacProfileInput): string {
  const { policy } = input;
  const writable = policy.allowWrite;
  const naming = new Set<string>([input.cloverHome]);
  for (const d of policy.denyWrite) if (inside(d, input.cloverHome) && d !== input.cloverHome) naming.add(dirname(d));
  const doors = policy.closedDoors.flatMap((d) => (input.doorPaths ?? DOOR_PATHS)[d] ?? []);
  const mach = [
    "com.apple.system.notification_center",
    "com.apple.system.logger",
    "com.apple.CoreServices.coreservicesd",
    "com.apple.bsd.dirhelper",
  ];
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow ipc-posix-shm)",
    "(allow ipc-posix-sem)",
    `(allow mach-lookup ${mach.map((m) => `(global-name ${q(m)})`).join(" ")})`,
    "(allow file-read*)",
    `(allow file-write* ${writable.map((w) => `(subpath ${q(w)})`).join(" ")})`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
    "(allow file-ioctl (literal \"/dev/tty\"))",
  ];
  if (input.perUserTemp) lines.push(`(allow file-write* (regex #"^${rx(input.perUserTemp)}/[^/]+$"))`);
  // Not ASCII where Clover names things: every new name there is refused, then ASCII names are let back.
  for (const f of [...naming].sort()) {
    lines.push(`(deny file-write* (regex #"^${rx(f)}/[^/]"))`);
    lines.push(`(allow file-write* (regex #"^${rx(f)}/[ -.0-~]+(/|$)"))`);
  }
  // The fence's items, and the folders that hold them, after every allow: the last matching rule wins.
  for (const h of holders(policy.denyWrite, writable)) lines.push(`(deny file-write* (literal ${q(h)}))`);
  if (policy.denyWrite.length > 0) lines.push(`(deny file-write* ${policy.denyWrite.map((d) => `(subpath ${q(d)})`).join(" ")})`);
  if (policy.denyRead.length > 0) lines.push(`(deny file-read* ${policy.denyRead.map((d) => `(subpath ${q(d)})`).join(" ")})`);
  if (doors.length > 0) lines.push(`(deny process-exec ${doors.map((d) => `(literal ${q(d)})`).join(" ")})`);
  // The caller's rules (`per-caller.ts`), by pattern: every bot's memory denied both ways, every bot folder and the
  // memory folders themselves write-denied, then the owner's own memory opened inside (never the folder itself);
  // the bot driver's state hidden, its own state file readable.
  const c = input.caller;
  if (c) {
    const b = rx(c.bots);
    lines.push(`(deny file-read* file-write* (regex #"^${b}/[^/]+/memory(/|$)"))`);
    lines.push(`(deny file-write* (regex #"^${b}(/[^/]+)?/?$") (regex #"^${b}/[^/]+/"))`);
    if (c.ownMemory) lines.push(`(allow file-read* file-write* (regex #"^${rx(c.ownMemory)}/"))`, `(allow file-read* (literal ${q(c.ownMemory)}))`);
    lines.push(`(deny file-read* file-write* (subpath ${q(c.runtime)}))`);
    if (c.ownRuntime) lines.push(`(allow file-read* (literal ${q(c.ownRuntime)}))`);
  }
  // No network (the daemon's socket included); `filtered` comes with the escape floor's ports.
  lines.push("(deny network*)");
  return `${lines.join("\n")}\n`;
}
