// Where each fenced item lives under a Clover home (spec §9.1 "The fence, precisely"; B's `FENCED_KINDS`). Lane C
// owns the layout; the lanes that write these items take their paths from here, or the fence names theirs
// (D's `userLayersDir`). Every item is a folder except the files named with an extension, and the node (lane J)
// makes the folders at start, so a folder swapped for a link is found as one.
//
//   settings               settings.json, settings/, sdk/settings.json (the saved allow rules' inherited home too)
//   levels                 levels/ (levels/computer.json, J)
//   saved-rules            rules/
//   connector-permissions  connectors/
//   trust                  trust/ (trust/agent-oks.json, K), trust.json (the inherited directory trust)
//   device-list            devices/
//   user-layers            user-layers/ (D)
//   credential-store       credentials/
//   plugin-oks             plugins-state/oks/; installed-plugins plugins-state/installed.json;
//                          adult-confirmation plugins-state/adult.json (B's registry records)
//   plugin-data            plugin-data/
//   run-folder             run/ (read-denied)
//   secrets-file, key-file secrets.enc, secrets.key, on Windows and Linux only (read-denied); macOS's Keychain
//                          holds them
//   dev-folders            wherever the user keeps them
//
// Waiting on kinds in B's contract (asked of B-M1; `agent-installs` asked after K-M2's review; `plugins` by the
// controller's ruling on B's registry review; `sessions-runtime` from A-M3's review), so not yet in
// `fencedSet()`: `pendingFenced` below.
import { readdirSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import type { FencedKind } from "../contracts/fence";

export type LaidOutKind = Exclude<FencedKind, "dev-folders">;

/** Windows joins with backslashes, except under a home written POSIX-style (`/Users/me/.clover`, as B's conformance
 *  suite writes every OS's paths), so the items come back in the form the home was given. */
const pathFor = (os: Os, home?: string) => (os === "windows" && !(home?.startsWith("/") && !home.includes("\\")) ? win32 : posix);

/** The app's userData folder on each OS, under the user's home (main's `defaultUserData`). */
export function defaultUserData(os: Os, home: string): string {
  if (os === "macos") return pathFor(os, home).join(home, "Library", "Application Support", "Clover");
  if (os === "windows") return pathFor(os, home).join(home, "AppData", "Roaming", "Clover");
  return pathFor(os, home).join(home, ".config", "Clover");
}

/** The login items that start the daemon at login (main's `loginStartPaths`): macOS's LaunchAgents
 *  plist, Linux's systemd user unit; Windows keeps its start in Task Scheduler, a closed door. */
export function loginStartPaths(os: Os, home: string | undefined, cloverHome: string): string[] {
  if (home === undefined) return [];
  const p = pathFor(os, home);
  const u = (...parts: string[]) => p.join(home, ...parts);
  if (os === "macos") return [u("Library", "LaunchAgents", "com.waifucave.clover.core.plist"), pathFor(os, cloverHome).join(cloverHome, "login")];
  if (os === "linux") return [u(".config", "systemd", "user", "clover-core.service")];
  return [];
}

/** Each kind's paths under `cloverHome` on `os`. `home` locates the login items and the default
 *  userData; `userData` overrides it; `agentInstalls` are the OK'd agents' folders. */
export function fenceLayout(cloverHome: string, os: Os, o?: {
  home?: string; userData?: string; agentInstalls?: readonly string[];
}): Record<LaidOutKind, string[]> {
  const p = pathFor(os, cloverHome);
  const h = (...parts: string[]) => p.join(cloverHome, ...parts);
  const offMac = (path: string) => (os === "macos" ? [] : [path]);
  const userData = o?.userData ?? (o?.home !== undefined ? defaultUserData(os, o.home) : undefined);
  return {
    settings: [h("settings.json"), h("settings"), h("sdk", "settings.json")],
    levels: [h("levels")],
    "saved-rules": [h("rules")],
    "connector-permissions": [h("connectors")],
    trust: [h("trust"), h("trust.json")],
    "device-list": [h("devices")],
    "user-layers": [h("user-layers")], // `userLayersDir(home)`, joined in this OS's form
    "credential-store": [h("credentials")],
    "plugin-oks": [h("plugins-state", "oks")],
    "installed-plugins": [h("plugins-state", "installed.json")],
    "adult-confirmation": [h("plugins-state", "adult.json")],
    "plugin-data": [h("plugin-data")],
    "run-folder": [h("run")],
    "secrets-file": offMac(h("secrets.enc")),
    "key-file": offMac(h("secrets.key")),
    plugins: [h("plugins")],
    "sessions-runtime": [h("sessions-runtime")],
    // No static path: enforced by pattern, per bot (`bots/<x>/memory`), in `fencedSet`.
    "bot-memory": [],
    transcripts: [h("sessions")],
    usage: [h("usage")],
    "browser-profiles": userData === undefined ? [] : [p.join(userData, "Partitions")],
    "login-start": loginStartPaths(os, o?.home, cloverHome),
    "agent-installs": [...(o?.agentInstalls ?? [])],
  };
}

/** The items of the fenced set whose kinds B's contract doesn't have yet (spec §9.1; D-M2, L-M1, S2), by the kind
 *  asked for. `userData` is the app's own folder (E's), where the Clover Browser keeps its partitions. */
export function pendingFenced(o: {
  home: string; cloverHome: string; os: Os; userData?: string;
  /** The install folders of the coding agents the user has OK'd to run unsandboxed (lane K, keyed to each program's
   *  real path and hash): the resolved program's folder, and npm's global package folder for its package. Write-denied
   *  to sessions and agents, so none can swap in a new copy of itself or of another agent. */
  agentInstalls?: readonly string[];
}): Record<string, string[]> {
  // `plugins`: the installed plugins folder (spec §2), write-denied to sessions, agents and plugin code, reads
  // allowed. A bot's plugin comes in only through `plugin.install`'s OK card, and is made in a dev folder, which the
  // fence follows by its real path (`followDevFolders`).
  // `sessions-runtime`: the bot driver's state per session (A-M3), which a turn resumes from.
  const p = pathFor(o.os, o.cloverHome);
  const u = (...parts: string[]) => p.join(o.home, ...parts);
  const loginStart: Record<Os, string[]> = {
    macos: [u("Library", "LaunchAgents"), u("Library", "Application Support", "com.apple.backgroundtaskmanagementagent"),
      u(".zshrc"), u(".zprofile"), u(".zshenv"), u(".zlogin"), u(".bashrc"), u(".bash_profile"), u(".profile")],
    linux: [u(".config", "systemd", "user"), u(".config", "autostart"), u(".bashrc"), u(".bash_profile"), u(".profile"),
      u(".zshrc"), u(".zprofile"), u(".zshenv"), u(".config", "environment.d")],
    windows: [u("AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
      u("Documents", "PowerShell"), u("Documents", "WindowsPowerShell"), u(".bashrc"), u(".bash_profile"), u(".profile"), u(".minttyrc")],
  };
  return {
    transcripts: [p.join(o.cloverHome, "transcripts")], // `transcriptsDir(home)`, joined in this OS's form
    usage: [p.join(o.cloverHome, "usage")],
    "browser-profiles": o.userData ? [p.join(o.userData, "Partitions")] : [],
    "login-start": loginStart[o.os],
    "agent-installs": [...(o.agentInstalls ?? [])],
    plugins: [p.join(o.cloverHome, "plugins")],
    // Windows: the per-user Git for Windows, whose bash runs hooks (#205's S4): a fenced caller can't plant one there.
    "hook-shell": o.os === "windows" ? [u("AppData", "Local", "Programs", "Git")] : [],
    "sessions-runtime": [p.join(o.cloverHome, "sessions-runtime")],
  };
}

/** The folder names under `<home>/bots/` on this computer, read each time a command's policy is built. */
export function botFolders(cloverHome: string): string[] {
  try { return readdirSync(join(cloverHome, "bots"), { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name); }
  catch { return []; }
}
