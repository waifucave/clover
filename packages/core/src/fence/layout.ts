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
// Waiting on kinds in B's contract (asked of B-M1; `agent-installs` asked after K-M2's review), so not yet in
// `fencedSet()`: `pendingFenced` below.
import { posix, win32 } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import type { FencedKind } from "../contracts/fence";
import { userLayersDir } from "../bots/paths";
import { transcriptsDir } from "../sessions/ids";

export type LaidOutKind = Exclude<FencedKind, "dev-folders">;

const pathFor = (os: Os) => (os === "windows" ? win32 : posix);

/** Each kind's paths under `cloverHome` on `os`. */
export function fenceLayout(cloverHome: string, os: Os): Record<LaidOutKind, string[]> {
  const p = pathFor(os);
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
  const p = pathFor(o.os);
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
  };
}
