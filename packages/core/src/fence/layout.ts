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
import { userLayersDir } from "../bots/paths";
import { botSegment, transcriptsDir } from "../sessions/ids";
import { foldName } from "./fold";

export type LaidOutKind = Exclude<FencedKind, "dev-folders">;

/** Windows joins with backslashes, except under a home written POSIX-style (`/Users/me/.clover`, as B's conformance
 *  suite writes every OS's paths), so the items come back in the form the home was given. */
const pathFor = (os: Os, home?: string) => (os === "windows" && !(home?.startsWith("/") && !home.includes("\\")) ? win32 : posix);

/** Each kind's paths under `cloverHome` on `os`. */
export function fenceLayout(cloverHome: string, os: Os): Record<LaidOutKind, string[]> {
  const p = pathFor(os, cloverHome);
  const h = (...parts: string[]) => p.join(cloverHome, ...parts);
  const offMac = (path: string) => (os === "macos" ? [] : [path]);
  return {
    settings: [h("settings.json"), h("settings"), h("sdk", "settings.json")],
    levels: [h("levels")],
    "saved-rules": [h("rules")],
    "connector-permissions": [h("connectors")],
    trust: [h("trust"), h("trust.json")],
    "device-list": [h("devices")],
    "user-layers": [os === "windows" ? h("user-layers") : userLayersDir(cloverHome)],
    "credential-store": [h("credentials")],
    "plugin-oks": [h("plugins-state", "oks")],
    "installed-plugins": [h("plugins-state", "installed.json")],
    "adult-confirmation": [h("plugins-state", "adult.json")],
    "plugin-data": [h("plugin-data")],
    "run-folder": [h("run")],
    "secrets-file": offMac(h("secrets.enc")),
    "key-file": offMac(h("secrets.key")),
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
    transcripts: [o.os === "windows" ? p.join(o.cloverHome, "transcripts") : transcriptsDir(o.cloverHome)],
    usage: [p.join(o.cloverHome, "usage")],
    "browser-profiles": o.userData ? [p.join(o.userData, "Partitions")] : [],
    "login-start": loginStart[o.os],
    "agent-installs": [...(o.agentInstalls ?? [])],
    plugins: [p.join(o.cloverHome, "plugins")],
    "sessions-runtime": [p.join(o.cloverHome, "sessions-runtime")],
  };
}

/** Who is asking, for bots' memory (the owner's decision): a bot's own sessions (its main conversation and side
 *  threads), or anyone else (other bots' sessions, coding sessions the user drives, ACP or delegated agents, that
 *  bot's own agents included). */
export type MemoryCaller = { readonly kind: "bot-session"; readonly bot: string } | { readonly kind: "other" };

/** The `bot-memory` items for one caller, for B's per-caller view (`Fence.forCaller`). A bot writes its memory with
 *  ordinary Write and Edit in `<home>/bots/<bot>/memory/` (the tree's `home/memory`, synced): its own sessions read and
 *  write it; everyone else is denied both. The rest of each `<home>/bots/<bot>/` (its agents' transcripts, which the
 *  core writes) stays write-denied to all, reads allowed. `folders` are the folder names under `<home>/bots/` now
 *  (`botFolders`); `entries` the names in one of them (default: read from the disk). */
export function botMemoryFenced(o: {
  cloverHome: string; os: Os; caller: MemoryCaller; folders: readonly string[];
  entries?: (folder: string) => readonly string[];
}): { kind: "bot-memory"; path: string; deny: "write" | "read-write" }[] {
  const p = pathFor(o.os, o.cloverHome);
  const own = o.caller.kind === "bot-session" ? botSegment(o.caller.bot) : null;
  const entries = o.entries ?? ((f: string) => { try { return readdirSync(join(o.cloverHome, "bots", f)); } catch { return []; } });
  const out: { kind: "bot-memory"; path: string; deny: "write" | "read-write" }[] = [];
  for (const f of o.folders) {
    const root = p.join(o.cloverHome, "bots", f);
    if (f === own) {
      for (const e of entries(f)) if (foldName(e) !== "memory") out.push({ kind: "bot-memory", path: p.join(root, e), deny: "write" });
    } else {
      out.push({ kind: "bot-memory", path: p.join(root, "memory"), deny: "read-write" });
      out.push({ kind: "bot-memory", path: root, deny: "write" });
    }
  }
  return out;
}

/** The folder names under `<home>/bots/` on this computer, read each time a command's policy is built. */
export function botFolders(cloverHome: string): string[] {
  try { return readdirSync(join(cloverHome, "bots"), { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name); }
  catch { return []; }
}
