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
//   * names that aren't ASCII where Clover names things outside its home (the login places, an agent's install) are
//     refused by a deny on every new name there followed by an allow for ASCII names, which the sandbox also takes
//     for the names that fold to ASCII (`ſ`, `ß`, the Kelvin sign) as the disk does. Inside the home the home deny
//     refuses every new name outright, with no allow after it.
import { dirname } from "node:path";
import type { SandboxPolicy } from "../contracts/fence";
import type { CallerPlaces } from "./per-caller";

export interface MacProfileInput {
  readonly policy: SandboxPolicy;
  /** The Clover home: its top level is where Clover names things. */
  readonly cloverHome: string;
  /** The user's home folder: a hook planted in any repo under it runs later, outside the sandbox. */
  readonly home: string;
  /** macOS's per-user temp folder (`getconf DARWIN_USER_TEMP_DIR`): `mktemp` writes there whatever TMPDIR says. */
  readonly perUserTemp?: string | null;
  /** Programs' real paths for `closedDoors` (default: where macOS keeps them). */
  readonly doorPaths?: Readonly<Record<string, readonly string[]>>;
  /** The runner's caller (`callerPlaces`): its own folders, opened after the denies. */
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
  // Naming folders: folders holding a fenced item outside the Clover home (the login places, an agent's install), up
  // to their writable root. A name that isn't ASCII there is refused outright, as the fence's second wall is, and an
  // ASCII name stays allowed. Inside the Clover home there is no naming handling: the home deny above already refuses
  // every new name there, and a later allow must never open one (a bot's own folders come last, for their runner).
  // A naming folder that contains the home is skipped for the same reason: its allow must never reach inside the deny.
  const naming = new Set<string>();
  for (const d of policy.denyWrite) {
    if (!inside(d, input.cloverHome) && d !== input.cloverHome) {
      const parent = dirname(d);
      if (!inside(parent, input.cloverHome) && !inside(input.cloverHome, parent) && !writable.some((w) => w === parent)) naming.add(parent);
    }
  }
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
  // 1. Clover home default-deny: subpath deny on the Clover home itself (broad deny for everything under it).
  const cloverHomeDenyWrite = policy.denyWrite.filter((d) => d === input.cloverHome);
  const cloverHomeDenyRead = policy.denyRead.filter((d) => d === input.cloverHome);
  if (cloverHomeDenyWrite.length > 0) lines.push(`(deny file-write* ${cloverHomeDenyWrite.map((d) => `(subpath ${q(d)})`).join(" ")})`);
  if (cloverHomeDenyRead.length > 0) lines.push(`(deny file-read* ${cloverHomeDenyRead.map((d) => `(subpath ${q(d)})`).join(" ")})`);
  // 2. Holder folders: specific folder denies (between writable root and fenced item).
  for (const h of holders(policy.denyWrite, writable)) lines.push(`(deny file-write* (literal ${q(h)}))`);
  // 3. Naming folders outside the home (where Clover names things beyond it): deny non-ASCII names, then allow
  // ASCII names. Inside the home the home deny rules alone: no allow ever reopens a new name there.
  for (const f of [...naming].sort()) {
    lines.push(`(deny file-write* (regex #"^${rx(f)}/[^/]"))`);
    lines.push(`(allow file-write* (regex #"^${rx(f)}/[ -.0-~]+(/|$)"))`);
  }
  // 4. Specific fenced item denies: the rest of denyWrite/denyRead (excluding the Clover home).
  // These come AFTER naming folder allows so they can't be overridden by them.
  const specificDenyWrite = policy.denyWrite.filter((d) => d !== input.cloverHome);
  const specificDenyRead = policy.denyRead.filter((d) => d !== input.cloverHome);
  if (specificDenyWrite.length > 0) lines.push(`(deny file-write* ${specificDenyWrite.map((d) => `(subpath ${q(d)})`).join(" ")})`);
  if (specificDenyRead.length > 0) lines.push(`(deny file-read* ${specificDenyRead.map((d) => `(subpath ${q(d)})`).join(" ")})`);
  if (doors.length > 0) lines.push(`(deny process-exec ${doors.map((d) => `(literal ${q(d)})`).join(" ")})`);
  // 5. The caller's rules (B's contract, `policyAllows`'s order): the home deny above refuses everything under
  // the Clover home; the caller's own folders below open its own ways back in, and nothing else. Each read-and-write
  // folder reads on itself, reads and writes strictly inside it, and never writes over itself (deleting or moving
  // it stays denied, while moves inside it stay allowed); the bot's own folder reads only.
  const c = input.caller;
  if (c) {
    for (const p of [c.ownOutputs, c.ownScratch, c.ownRoutines, c.ownPluginData, c.ownMemory]) {
      if (p === null) continue;
      lines.push(`(allow file-read* (literal ${q(p)}))`);
      lines.push(`(allow file-read* file-write* (regex #"^${rx(p)}/"))`);
      lines.push(`(deny file-write* (literal ${q(p)}))`);
    }
    if (c.ownBot !== null) lines.push(`(allow file-read* (regex #"^${rx(c.ownBot)}(/|$)"))`);
  }
  // A hook planted in any repo under the home runs later, outside the sandbox (spec item 1116): refused everywhere
  // under it, after the caller's own allows (a runner's own folders may hold a repo too).
  lines.push(`(deny file-write* (regex #"^${rx(input.home)}/.*/\\.git/hooks(/|$)"))`);
  // No network (the daemon's socket included); `filtered` comes with the escape floor's ports.
  lines.push("(deny network*)");
  return `${lines.join("\n")}\n`;
}
