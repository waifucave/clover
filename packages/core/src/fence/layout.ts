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
//   plugins                plugins/ (a bot's plugin comes in only through `plugin.install`'s OK card)
//   transcripts            sessions/ (sessions' records) and transcripts/ (every session's event log)
//   usage                  usage/ (the usage ledger)
//   sessions-runtime       sessions-runtime/ (the bot driver's state per session)
//   run-folder             run/ (read-denied)
//   secrets-file, key-file secrets.enc, secrets.key and (headless Linux's systemd-creds-sealed key)
//                          secrets.key.cred, on Windows and Linux only (read-denied); macOS's Keychain holds them
//   dev-folders            wherever the user keeps them
//
// The login-start places (under the user's home), the browser profiles (under userData), the OK'd agent installs and
// the bot-memory items (per bot) are laid out in fence.ts, which holds the home, userData and options. The login-start
// list names every folder and file a planted write could run later, outside the sandbox (spec item 1116, the
// controller's ruling): Clover's own login item first, then the shells and their logout scripts, SSH and git config,
// the folders that come ahead on PATH, and the desktop's autostart, systemd and session-script folders.
// Kinds the fence enforces ahead of B's contract naming them live in `pendingFenced` below.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, posix, win32 } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import type { FencedKind } from "../contracts/fence";
import { linkedRouterSupportsRunHome } from "../runtime-sdk/run-home-support";
import { parseGitConfigWatched } from "./git-config";

export type LaidOutKind = Exclude<FencedKind, "dev-folders" | "bot-memory" | "login-start" | "browser-profiles" | "agent-installs">;

/** Windows joins with backslashes, except under a home written POSIX-style (`/Users/me/.clover`, as B's conformance
 *  suite writes every OS's paths), so the items come back in the form the home was given. */
const pathFor = (os: Os, home?: string) => (os === "windows" && !(home?.startsWith("/") && !home.includes("\\")) ? win32 : posix);

/** Each kind's paths under `cloverHome` on `os`. `login-start`, `browser-profiles`, `agent-installs`
 *  and `bot-memory` are not here: they need the home, userData, options and bot list, so
 *  `CloverFence.fencedSet` lays them out. */
export function fenceLayout(cloverHome: string, os: Os): Record<LaidOutKind, string[]> {
  const p = pathFor(os, cloverHome);
  const h = (...parts: string[]) => p.join(cloverHome, ...parts);
  const offMac = (...paths: string[]) => (os === "macos" ? [] : paths);
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
    plugins: [h("plugins")],
    transcripts: [h("sessions"), h("transcripts")],
    usage: [h("usage")],
    "sessions-runtime": [h("sessions-runtime")],
    "run-folder": [h("run")],
    "secrets-file": offMac(h("secrets.enc")),
    "key-file": offMac(h("secrets.key"), h("secrets.key.cred")),
  };
}

/** The items of the fenced set whose kinds B's contract doesn't have yet (spec §9.1), by the kind asked for. */
export function pendingFenced(o: {
  home: string; cloverHome: string; os: Os;
}): Record<string, string[]> {
  // `session-transcripts`: the runtime's transcript store (`storeProjectsDir`: `<home>/projects`, and
  // `<home>/sdk/projects` on a build whose router applies run homes). A bot's prompt carries its `MEMORY.md`, so its
  // transcript holds the memory: read- and write-denied to every tool runner, bots' own sessions included. The home
  // default-deny covers the store too; this names it for its refusal.
  // Windows: the per-user Git for Windows, whose bash runs hooks: a fenced caller can't plant one there.
  const p = pathFor(o.os, o.cloverHome);
  const u = (...parts: string[]) => p.join(o.home, ...parts);
  return {
    // The store's two spellings: `<home>/sdk/projects` is the store on a run-home build, and on a migrated home
    // `<home>/projects` is its compatibility link; on router 0.0.11 `<home>/projects` is the store itself.
    "session-transcripts": [p.join(o.cloverHome, "projects"), ...(linkedRouterSupportsRunHome() ? [p.join(o.cloverHome, "sdk", "projects")] : [])],
    // Windows: the per-user Git for Windows, whose bash runs hooks (#205's S4): a fenced caller can't plant one there.
    "hook-shell": o.os === "windows" ? [u("AppData", "Local", "Programs", "Git")] : [],
    // Lane M's self-update files: lane M's `<home>` is the Clover home, not the user's. Writing any of them
    // would let a runner swap in an unsandboxed daemon (#198 review B1). Never owned by any caller, read-only.
    // `selfUpdateDirs`/`selfUpdateFiles` name the folders and files; `~/bin` stays in login-start as before.
    "self-update": [...selfUpdateDirs(o.cloverHome, o.os), ...selfUpdateFiles(o.cloverHome, o.os)],
  };
}

/** The login-start places (B's contract `login-start`): every folder and file a planted write could run later,
 *  outside the sandbox (spec item 1116, the controller's ruling) — Clover's own login item first, then the shells
 *  and their logout scripts, SSH and git config, the folders that come ahead on PATH, editors, package managers,
 *  and the desktop's autostart, systemd, application and session-script folders. The gnupg entries are only its
 *  config files (gpg writes its trustdb and random seed in normal use), and `.git/config` stays writable (git
 *  writes it in normal use; setting risky keys through it is the reviewer's call) — only `.git/hooks` is fenced,
 *  as a pattern (any repo under the home), enforced by the fence, the macOS regex and the Linux cwd-repo bind.
 *  macOS also fences the loginwindow plist and `~/Library/Scripts`. */
export function loginStartPaths(home: string, cloverHome: string, os: Os): string[] {
  const p = pathFor(os, home);
  const u = (...parts: string[]) => p.join(home, ...parts);
  const shell = [".zshrc", ".zprofile", ".zshenv", ".zlogin", ".bashrc", ".bash_profile", ".profile", ".bash_login",
    ".bash_logout", ".zlogout", ".logout"];
  // Places a planted file runs later, outside the sandbox (spec item 1116, the controller's ruling): shells and
  // their logout scripts, SSH and git config, the folders that come ahead on PATH, editors and package managers.
  // The gnupg entries are only its config files: gpg writes its trustdb and random seed in normal use.
  const shells = [...shell.map((f) => u(f)), u(".config", "fish")];
  const pathAhead = [u(".local", "bin"), u("bin")];
  const sshGit = [u(".ssh"), u(".gitconfig"), u(".config", "git")];
  const editors = [u(".vimrc"), u(".vim"), u(".config", "nvim"), u(".emacs"), u(".emacs.d")];
  const packageManagers = [u(".bunfig.toml"), u(".bun", "bin"), u(".npmrc"), u(".cargo", "bin"),
    u(".cargo", "config.toml"), u(".cargo", "config"), u(".config", "pip"), u(".pip")];
  if (os === "macos") {
    return [
      u("Library", "LaunchAgents", "com.waifucave.clover.core.plist"), p.join(cloverHome, "login"),
      u("Library", "LaunchAgents"), u("Library", "LaunchDaemons"), u("Library", "StartupItems"),
      u("Library", "Application Support", "com.apple.backgroundtaskmanagementagent"),
      u("Library", "Preferences", "com.apple.loginwindow.plist"), u("Library", "Scripts"),
      ...shells, ...pathAhead, ...sshGit, ...editors, ...packageManagers,
      u("Library", "Python"),
      u(".bash_aliases"), u(".oh-my-zsh", "custom"),
      u(".gnupg", "gpg.conf"), u(".gnupg", "gpg-agent.conf"), u(".gnupg", "dirmngr.conf"),
      u(".config", "environment.d"),
    ];
  }
  if (os === "linux") {
    return [
      u(".config", "systemd"), u(".local", "share", "systemd", "user"),
      u(".config", "autostart"), u(".local", "share", "applications"), u(".config", "mimeapps.list"),
      u(".config", "environment.d"), u(".pam_environment"), u(".xprofile"), u(".xsessionrc"), u(".xinitrc"),
      u(".config", "autostart-scripts"), u(".config", "plasma-workspace", "env"), u(".config", "plasma-workspace", "shutdown"),
      ...shells, ...pathAhead, ...sshGit, ...editors, ...packageManagers,
      u("Library", "Python"),
      u(".bash_aliases"), u(".oh-my-zsh", "custom"),
      u(".gnupg", "gpg.conf"), u(".gnupg", "gpg-agent.conf"), u(".gnupg", "dirmngr.conf"),
    ];
  }
  return [
    u("AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
    u("Documents", "PowerShell"), u("Documents", "WindowsPowerShell"),
    u(".bashrc"), u(".bash_profile"), u(".profile"), u(".minttyrc"),
  ];
}

/** The fenced login-start FOLDERS, made empty and read-only at sandbox setup (ruling 1). Derived, not listed:
 *  every login-start path that is neither a safe nor an unsafe file and not one of Clover's own files. */
export function loginStartDirs(home: string, cloverHome: string, os: Os): string[] {
  if (os === "windows") return [];
  const all = new Set(loginStartPaths(home, cloverHome, os));
  for (const f of [...loginStartSafeFiles(home, os), ...loginStartUnsafeFiles(home, os)]) all.delete(f);
  // Clover's own files are created and owned by the core.
  const p = pathFor(os, home);
  all.delete(p.join(home, "Library", "LaunchAgents", "com.waifucave.clover.core.plist"));
  all.delete(pathFor(os, cloverHome).join(cloverHome, "login"));
  return [...all];
}

/** The fenced login-start FILES that are safe to create empty (0600) at sandbox setup: sourcing an empty shell
 *  file, logout script or X session script is a no-op, and an empty config means the program's defaults (npm, git,
 *  bun, cargo, gnupg, pip's ini style, mimeapps). `.gitconfig` and the shells belong here; their hooks and the
 *  folders around them stay fenced. */
export function loginStartSafeFiles(home: string, os: Os): string[] {
  const u = (...parts: string[]) => pathFor(os, home).join(home, ...parts);
  const shells = [".zshrc", ".zprofile", ".zshenv", ".zlogin", ".bashrc", ".profile", ".bash_aliases", ".zlogout", ".logout"];
  const configs = [".npmrc", ".gitconfig", ".bunfig.toml", ".cargo/config.toml", ".cargo/config",
    ".gnupg/gpg.conf", ".gnupg/gpg-agent.conf", ".gnupg/dirmngr.conf"];
  if (os === "macos") return [...shells, ...configs].map((f) => u(f));
  if (os === "linux") return [...shells, ".pam_environment", ".xprofile", ".xsessionrc", ...configs, ".config/mimeapps.list"].map((f) => u(f));
  return [];
}

/** The fenced login-start FILES that are never created empty: an empty one still changes behavior — `.bash_profile`
 *  and `.bash_login` shadow the user's `.profile`, an empty `.xinitrc` replaces the default X startup, an empty
 *  `.vimrc`/`.emacs` replaces the editor's defaults, and an empty loginwindow plist is not a plist the login
 *  window wrote. The Linux supervisor refuses them (spec item 1116); macOS refuses them by static deny. */
export function loginStartUnsafeFiles(home: string, os: Os): string[] {
  const u = (...parts: string[]) => pathFor(os, home).join(home, ...parts);
  if (os === "macos") return [".bash_profile", ".bash_login", ".vimrc", ".emacs", "Library/Preferences/com.apple.loginwindow.plist"].map((f) => u(...f.split("/")));
  if (os === "linux") return [".bash_profile", ".bash_login", ".xinitrc", ".vimrc", ".emacs"].map((f) => u(...f.split("/")));
  return [];
}

/** Lane M's self-update folders under the Clover home (`update/`, holding `boot.json`, `rolled-back.json` and
 *  whatever the updater stages): never owned by any caller, read-only. The Clover home's default-deny already
 *  covers them, so they never hold anything; inside the default-deny view nothing is created for them. */
export function selfUpdateDirs(cloverHome: string, os: Os): string[] {
  if (os === "windows") return [];
  return [pathFor(os, cloverHome).join(cloverHome, "update")];
}

/** Lane M's self-update files under the Clover home: the `bin/` daemon binary, its `.new`/`.old` swap copies,
 *  and the install record. Never owned by any caller, read-only. None is ever created by the sandbox (an install
 *  record is the installer's to write); the Linux supervisor refuses plants, with the post-command belt behind
 *  it. */
export function selfUpdateFiles(cloverHome: string, os: Os): string[] {
  if (os === "windows") return [];
  const p = pathFor(os, cloverHome);
  return [
    p.join(cloverHome, "bin", "clover-core"),
    p.join(cloverHome, "bin", "clover-core.new"),
    p.join(cloverHome, "bin", "clover-core.old"),
    p.join(cloverHome, "bin", ".new"),
    p.join(cloverHome, "bin", ".old"),
    p.join(cloverHome, "install.json"),
  ];
}

/** The folder names under `<home>/bots/` on this computer, read each time a command's policy is built. */
export function botFolders(cloverHome: string): string[] {
  try { return readdirSync(join(cloverHome, "bots"), { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name); }
  catch { return []; }
}

/** Clover's empty git template for the sandboxed Bash (`GIT_TEMPLATE_DIR`): read-only to the runner, created by the
 *  core when a sandboxed command starts, outside every runner-writable place (directly under the Clover home, which
 *  the home default-deny keeps from runners). `git init` and `git clone` install no hooks from it. A user's own
 *  `init.templateDir` in their git config is overridden by the env var inside the sandbox only. */
export function gitTemplateDir(cloverHome: string): string {
  const p = cloverHome.startsWith("/") && !cloverHome.includes("\\") ? posix : win32;
  return p.join(cloverHome, "git-template");
}

/** The user's configured global `core.hooksPath` folders (spec item 1116, ruling 5): read from the global git
 *  configs without following links. A hook planted in one runs later, outside the sandbox, so each is fenced
 *  with the login-start set. Relative values resolve against the home; `~` expands. `/dev/null` (hooks off)
 *  and empty values are skipped. */
export function globalHooksPathDirs(home: string): string[] {
  const readNoFollow = (p: string): string | null => {
    try {
      const st = lstatSync(p);
      if (!st.isFile() || st.isSymbolicLink()) return null;
      return readFileSync(p, "utf8");
    } catch { return null; }
  };
  const out = new Set<string>();
  for (const cfg of [join(home, ".gitconfig"), join(home, ".config", "git", "config")]) {
    const text = readNoFollow(cfg);
    if (text === null) continue;
    for (const k of parseGitConfigWatched(text)) {
      if (k.dotted.toLowerCase() !== "core.hookspath") continue;
      const v = k.value.trim();
      if (v === "" || v === "/dev/null") continue;
      const expanded = v.startsWith("~/") ? join(home, v.slice(2)) : v;
      out.add(isAbsolute(expanded) ? expanded : join(home, expanded));
    }
  }
  return [...out];
}
