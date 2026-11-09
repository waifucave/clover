// The plugin-process fence (B-M2's 2f; spec §5.2, §9.1): on macOS every process that runs a plugin's code (a plugin-host
// process, a supervised host, a hook's command, a plugin's stdio MCP server) runs under a Seatbelt profile that keeps it
// to its own plugin. The load guard (`plugin-run.ts`) holds which code a Bun process loads; this holds what any process
// a plugin starts can read, write and ask the system for.
//
// What a fenced process can't reach:
// * the Clover home (`<home>/**`): the run folder (the app's token, the socket, every run file but its own), the other
//   plugins' folders and data, the bots, the session transcripts, the settings, the secrets file, the logs;
// * the user's home, but the folders its kind of process is given (`tools` below);
// * the Keychain: its files (`~/Library/Keychains`) and the security daemon's services, so no item is read through
//   `security` or the Security framework (measured on macOS 26: with `com.apple.SecurityServer` denied, a keychain
//   item that a plain process reads is "not found");
// * launchd and the services that start programs for it (`LAUNCH_SERVICES_DENIES`, the same list the bot and dev
//   sandboxes deny, `sandbox.denyLaunchServices` in the agent runtime): `launchctl`, `open` and `osascript` don't run,
//   so a plugin can't have launchd start something outside the fence;
// * for a host process, any program but its Bun and its plugin's own files (`exec: "plugin"`).
//
// * any write but to its own data folder, its own temp folder (`<home>/run/plugin-tmp/<key>`, its TMPDIR) and
//   `/dev/null`, `/dev/tty` and `/dev/fd` (#345's review, the blocker: writes are denied by default, so the app's
//   install, `/Applications`, `/opt/homebrew`, `/Users/Shared`, `/Volumes` and the shared temp folders are out of
//   reach);
// * the per-user folders (`/var/folders/<…>/`: the temp `T`, the cache `C` and the per-user `0` folders), whose
//   other programs' files it has no business reading (S2, and #345's second review);
// * the clipboard and the window server (their services), and any signal but to itself and its children;
// * every Unix socket but the ones it's named (a supervised host's daemon socket) and the system's DNS resolver
//   (`mDNSResponder`): no ssh-agent, no other program's socket (S1);
// * in the `clover` process, which holds many plugins, any native code but Bun's and the system's (B3; since #345's
//   review, `file-map-executable` is denied everywhere else, not only in what it reads and writes).
//
// What it can: read its plugin's tree (and, for the `clover` process, the verified copy of the bundled plugins), read
// Clover's run files and shared packages that the guard loads, read and write its own data and temp folders, the
// network, and read everything else outside the homes and those folders that the system leaves readable.
//
// Hooks and MCP servers (`tools: true`): a server started with `npx`, `uvx` or `bunx` needs its package manager's
// installs, so those folders are readable, and any program may run (fenced the same way; measured: denying exec
// outside the plugin's folder breaks every server started through a package runner). Their caches are their own
// (S4): `toolFence`'s env points npm, pnpm, Bun, uv, pip, Yarn, Deno, Go and `XDG_CACHE_HOME` at a folder in their temp
// folder, and npm's user config at a file there, so no shared cache is written, and none of the user's is read but
// the package managers' installs. The credential files a package manager keeps (`CREDENTIAL_FILES`) are denied last,
// whatever else allows them.
//
// Linux and Windows: not fenced yet (Linux under bubblewrap comes next; Windows waits, the owner's priority).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { PluginRunFiles } from "./plugin-run";
import { agentConfigPaths, autoRunPaths, SHELL_FILES } from "../contracts/fence";
import { CloverFence } from "../fence/fence";
import { runLaterExtras } from "../fence/run-later";

/** What the agent runtime's `sandbox.denyLaunchServices` denies (`@waifucave/clover-agent-runtime`'s
 *  `LAUNCH_SERVICES_DENIES`, not exported; a test holds this equal to the installed runtime's). */
export const LAUNCH_SERVICES_DENIES = {
  exec: ["/bin/launchctl", "/usr/bin/open", "/usr/bin/osascript"],
  services: [
    "com.apple.coreservices.launchservicesd",
    "com.apple.lsd.mapdb",
    "com.apple.lsd.modifydb",
    "com.apple.xpc.smd",
    "com.apple.backgroundtaskmanagementagent",
    "com.apple.backgroundtaskmanagement.agent",
    "com.apple.coreservices.appleevents",
    "com.apple.coreservices.quarantine-resolver",
  ],
} as const;

/** The security daemon's services: the Keychain's way in, for `security` and the Security framework alike. */
export const KEYCHAIN_SERVICES: readonly string[] = ["com.apple.SecurityServer", "com.apple.securityd", "com.apple.securityd.xpc", "com.apple.security.agent", "com.apple.security.authhost"];

/** The user's folders a hook or MCP server may read: the package managers' installs (and npm's and Bun's own caches,
 *  read-only, which `npx` and `bunx` reuse). Relative to the user's home. None is written (#345's review, S4). */
export const TOOL_READ_DIRS: readonly string[] = [
  ".npm", ".nvm", ".volta", ".asdf", ".pyenv", ".rbenv", ".cargo", ".rustup", ".bun", ".deno", ".local/bin", ".local/share/uv",
  ".local/share/pnpm", "Library/pnpm", ".config/uv", ".gitconfig",
];

/** The credential files package managers and other tools keep in the user's home, denied to every fenced process
 *  whatever else allows them (S4). Relative to the user's home. */
export const CREDENTIAL_FILES: readonly string[] = [
  ".npmrc", ".yarnrc", ".yarnrc.yml", ".cargo/credentials", ".cargo/credentials.toml", ".netrc", ".docker/config.json", ".aws",
  ".config/gh", ".config/hub", ".git-credentials", ".config/git/credentials", ".pypirc", ".pip/pip.conf", ".config/pip/pip.conf",
  ".gem/credentials", ".ssh", ".gnupg", ".kube", ".config/gcloud", ".azure", ".terraform.d/credentials.tfrc.json",
  ".bun/install/credentials", ".config/uv/credentials", ".local/share/uv/credentials",
];

/** A project folder's entries denied WHOLE to a fenced process's writes, and the folder itself (so it can't be renamed
 *  away and back, #352's review): Git's folder (its hooks, config, attributes and every submodule's under `modules`),
 *  the editors' (VS Code's tasks run on folder open; JetBrains' `.idea` the same), and Clover's and Claude Code's own
 *  settings, MCP servers and hooks. */
export const PROJECT_WHOLE_DENIES: readonly string[] = [".git", ".vscode", ".idea", ".claude", ".clover"];

/** Inside a project folder, never written by a fenced process, besides `PROJECT_WHOLE_DENIES`: anything else that
 *  runs on its own without the user running their project (the controller's rulings on #352). A project's MCP servers
 *  (`.mcp.json`), direnv's `.envrc`, Git's `.gitconfig` and `.gitmodules`, and the shells' start files a dotfiles
 *  project holds; with the credential files (`CREDENTIAL_FILES`), which are neither read nor written. Relative to the
 *  project folder. Each folder between the project and one of these is write-denied too, so none can be renamed. */
export const PROJECT_DENIES: readonly string[] = [".mcp.json", ".envrc", ".gitconfig", ".gitmodules", ...SHELL_FILES, ...CREDENTIAL_FILES];

/** The folders in the user's home a project folder may never contain: where a write runs later, or a tool's settings
 *  and keys live (#352's review). With every persistence place (`persistencePlaces`) and credential file. */
export const NEVER_IN_A_PROJECT: readonly string[] = [
  "Library", ".config", ".local", "bin", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".cargo", ".rustup", ".npm",
  ".bun", ".deno", ".nvm", ".pyenv", ".rbenv", ".volta", ".asdf", ".claude", ".codex", ".cursor", ".gemini", "Applications",
];

/** Where a write runs later outside any sandbox, under the user's home (#308's `autoRunPaths` and `agentConfigPaths`),
 *  and every place the fence keeps from bots outside the Clover home (`CloverFence.fencedSet`): denied to every fenced
 *  process's writes, last in its profile, in their plain and real spellings (a dotfiles project holds the real file of
 *  `~/.zshrc`). The Clover home itself is denied whole already, but for the process's own data and temp folders. */
export function persistencePlaces(userHome: string, cloverHome: string, o: { fenced?: boolean } = {}): string[] {
  const out = new Set<string>();
  if (process.platform === "darwin" || process.platform === "linux") {
    const os = process.platform === "darwin" ? "macos" : "linux";
    for (const p of [...autoRunPaths(os, userHome, runLaterExtras(os, userHome)), ...agentConfigPaths(os, userHome)]) out.add(p);
    if (o.fenced === false) return [...out];
    let fenced: readonly { path: string }[] = [];
    try {
      fenced = new CloverFence({ home: userHome, cloverHome, os }).fencedSet();
    } catch {
      fenced = [];
    }
    const clover = realOrResolved(cloverHome);
    for (const f of fenced) {
      const p = f.path;
      if (p === cloverHome || p.startsWith(cloverHome + sep) || p === clover || p.startsWith(clover + sep)) continue;
      out.add(p);
    }
  }
  return [...out];
}

/** `core.hooksPath` as a Git config file sets it, or undefined (the last one in a `[core]` section wins, as in Git). */
function hooksPathIn(file: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let section = "";
  let found: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)[#;].*$/, "").trim();
    const head = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]$/.exec(line);
    if (head !== null) {
      section = head[1]!.toLowerCase();
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (section === "core" && kv !== null && kv[1]!.toLowerCase() === "hookspath") found = kv[2]!.replace(/^"(.*)"$/, "$1").trim();
  }
  return found === "" ? undefined : found;
}

/** A project's Git folders when its `.git` is a file (a linked worktree, a submodule): the folder its `gitdir:` names,
 *  and a worktree's common folder (`commondir`). Denied to writes whole, wherever they are. */
export function gitFoldersOf(project: string): string[] {
  const dotGit = join(project, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return [];
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (gitdir === undefined) return [];
    const dir = resolve(project, gitdir);
    const out = [dir];
    try {
      out.push(resolve(dir, readFileSync(join(dir, "commondir"), "utf8").trim()));
    } catch {
      /* a submodule's, or a plain gitdir */
    }
    return out;
  } catch {
    return [];
  }
}

/** The project's own Git config file: `.git/config`, or for a linked worktree (`.git` a file) its common folder's. */
function projectGitConfig(project: string): string | undefined {
  const dotGit = join(project, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return join(dotGit, "config");
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (gitdir === undefined) return undefined;
    const dir = resolve(project, gitdir);
    let common = dir;
    try {
      common = resolve(dir, readFileSync(join(dir, "commondir"), "utf8").trim());
    } catch {
      /* a plain gitdir */
    }
    return join(common, "config");
  } catch {
    return undefined;
  }
}

/** The folders Git runs hooks from for a project besides `.git/hooks`: its effective `core.hooksPath`, from the
 *  project's config or else the user's global config (read here, never written), resolved against the project
 *  (`~/` against the user's home). Husky's `.husky` and a `.githooks` setup are found this way. */
export function gitHooksPaths(project: string, userHome: string): string[] {
  const value = [projectGitConfig(project), join(userHome, ".gitconfig"), join(userHome, ".config", "git", "config")]
    .map((f) => (f === undefined ? undefined : hooksPathIn(f))).find((v) => v !== undefined);
  if (value === undefined) return [];
  const path = value.startsWith("~/") ? join(userHome, value.slice(2)) : resolve(project, value);
  return [path];
}

/** The session's working directories a hook or MCP server is given: absolute folders that are none of the homes, never
 *  a folder above one (`/`, `/Users`), never inside the Clover home. Real paths. */
export function projectFolders(dirs: readonly string[], o: { userHome: string; cloverHome: string }): string[] {
  const homes = [o.userHome, o.cloverHome].map(realOrResolved);
  const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
  // The places a project may never hold (#352's review): a working folder of ~/Library or ~/.config would put the
  // LaunchAgents or a tool's settings in reach. By where they are, never by where a link points: a dotfiles project
  // holding the real file of ~/.zshrc stays a project, and its profile write-denies that file (`persistencePlaces`).
  const never = [
    ...paths([...NEVER_IN_A_PROJECT.map((d) => join(o.userHome, d)), ...CREDENTIAL_FILES.map((f) => join(o.userHome, f))]),
    ...persistencePlaces(o.userHome, o.cloverHome, { fenced: false }).map((p) => resolve(p)),
  ];
  const out: string[] = [];
  for (const d of dirs) {
    if (typeof d !== "string" || !d.startsWith("/")) continue;
    const p = realOrResolved(d);
    if (homes.some((h) => inside(h, p))) continue; // a home, or a folder above one
    if (inside(p, homes[1]!)) continue; // inside the Clover home
    if (never.some((n) => inside(n, p))) continue; // holds a place where a write runs later, or a tool's settings
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** The system's DNS resolver socket: the one Unix socket every fenced process may reach (name lookups go through it). */
export const DNS_SOCKETS: readonly string[] = ["/private/var/run/mDNSResponder", "/var/run/mDNSResponder"];

/** The per-user folders under `/var/folders`, denied whole (S2, and #345's second review): the parent of
 *  `getconf DARWIN_USER_TEMP_DIR`, which holds the temp folder (`T`), the cache folder (`C`) and the per-user folder
 *  (`0`, `DARWIN_USER_DIR`: Biome, ScreenTime, SharedWebCredentials, AppSSOAgent, Find My, Spotlight). */
let userFolders: string[] | undefined;
export function darwinUserFolders(): string[] {
  if (userFolders !== undefined) return userFolders;
  const out: string[] = [];
  if (process.platform === "darwin") {
    const r = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" });
    const t = (r.stdout ?? "").trim().replace(/\/$/, "");
    if (r.status === 0 && (t.startsWith("/var/folders/") || t.startsWith("/private/var/folders/"))) out.push(dirname(t));
  }
  userFolders = out;
  return out;
}

/** The pasteboard's and the window server's services: no fenced process reads the clipboard or the screen (#345's
 *  second review; no capability grants them yet). */
export const SCREEN_AND_CLIPBOARD_SERVICES: readonly string[] = [
  "com.apple.pasteboard.1", "com.apple.pasteboard.2", "com.apple.windowserver", "com.apple.windowserver.active",
];

export interface PluginFenceInput {
  /** The Clover home: denied whole, but what `read` and `write` name. */
  cloverHome: string;
  /** The user's home: denied whole, but what `read`, `write` and `tools` give. */
  userHome: string;
  /** Folders and files it reads (its plugin's tree, the run files, the shared packages, its Bun). */
  read: readonly string[];
  /** Folders it reads and writes (its data folder, its temp folder). */
  write: readonly string[];
  /** `plugin`: it runs only `execs` (its Bun) and its plugin's own files (`read`'s first folder). `any`: any program,
   *  fenced the same. */
  exec: "plugin" | "any";
  /** The programs an `exec: "plugin"` process may run besides its plugin's files. */
  execs?: readonly string[];
  /** A hook or MCP server: the package managers' installs (`TOOL_READ_DIRS`), read-only. */
  tools?: boolean;
  /** False: it starts no process at all (a host process: its plugins' workers are threads, and it may run only its Bun),
   *  so nothing it starts can leave its process group (`setsid`), which Seatbelt has no rule for (#322's review, B1). */
  fork?: boolean;
  /** No native code but its Bun's (`execs`) and the system's (`file-map-executable` denied everywhere else): the
   *  clover process (B3, and #345's review). */
  noNativeCode?: boolean;
  /** The session's project folders (its working directories), for a hook or MCP server of that session: readable,
   *  and writable when `projectWrite` (its plugin holds `project.write`). `.git/hooks`, `.git/config` and the credential
   *  files inside each stay denied. `projectFolders` chooses them. */
  projects?: readonly string[];
  projectWrite?: boolean;
  /** The Unix sockets it may connect to (a supervised host's daemon socket) besides the DNS resolver; every other one
   *  is denied (S1). A file rule doesn't hold a socket's connect, only `network-outbound` does (measured). */
  sockets?: readonly string[];
}

/** A path as a literal inside an SBPL `#"…"` regex. */
const regexLiteral = (p: string): string => p.replace(/[\\^$.*+?()[\]{}|"]/g, (c) => `\\${c}`);
/** Escapes a path for an SBPL string. */
const sbpl = (p: string): string => p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
/** A path as the kernel sees it: its real path when it exists (`/var` is `/private/var`), else as given, resolved. */
export function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // Not there yet (a socket the daemon makes later): its folder's real path, and its name.
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return resolve(p);
    }
  }
}
const paths = (ps: readonly string[]): string[] => [...new Set(ps.flatMap((p) => {
  const real = realOrResolved(p);
  const plain = resolve(p);
  return real === plain ? [real] : [real, plain];
}))];
const subpaths = (ps: readonly string[]) => paths(ps).map((p) => `(subpath "${sbpl(p)}")`).join(" ");

/** The folders above each of `ps` that sit inside one of `roots` (each root included), real and as given. */
function ancestorsWithin(ps: readonly string[], roots: readonly string[]): string[] {
  const rs = paths(roots);
  const out = new Set<string>();
  for (const p of paths(ps)) {
    for (let d = dirname(p); d !== dirname(d); d = dirname(d)) {
      if (rs.some((r) => d === r || d.startsWith(r.endsWith(sep) ? r : r + sep))) out.add(d);
    }
  }
  return [...out];
}

/** The Seatbelt profile for one fenced process. Later rules win over earlier ones (measured): writes are denied
 *  everywhere and the homes and the per-user temp folders denied whole first, then what the process is given is
 *  allowed back, then what no process gets is denied last. */
export function pluginFenceProfile(i: PluginFenceInput): string {
  const user = i.userHome;
  const projects = i.projects ?? [];
  const read = [...i.read, ...(i.execs ?? []), ...(i.tools ? TOOL_READ_DIRS.map((d) => join(user, d)) : []), ...projects];
  const write = [...i.write, ...(i.projectWrite ? projects : [])];
  const closed = [user, i.cloverHome, ...darwinUserFolders()];
  const lines = [
    "(version 1)",
    "(allow default)",
    // No write but what it's given (#345's review, the blocker), and the devices every program writes to.
    "(deny file-write*)",
    `(allow file-write* ${DEVICE_WRITES})`,
    `(deny file-read* ${subpaths(closed)})`,
    // The folders above what it's given, by metadata only (a stat, never a listing or a file's contents): a path is
    // resolved component by component, so a real path through a denied folder fails without it (measured).
    ...ancestorsWithin([...read, ...write, ...(i.sockets ?? [])], closed).map((a) => `(allow file-read-metadata (literal "${sbpl(a)}"))`),
    // The sockets it's named, by metadata too: a client checks one is there before it connects. A path longer than a
    // socket address holds (104 bytes) is reached through its folder, which Bun opens (measured: EINVAL without it), so
    // that folder's names are readable too, for such a path only (a test's temp home; `<home>/run/core.sock` is short).
    ...((i.sockets ?? []).length > 0 ? [`(allow file-read-metadata ${paths(i.sockets!).map((p) => `(literal "${sbpl(p)}")`).join(" ")})`] : []),
    ...longSocketFolders(i.sockets ?? []).map((d) => `(allow file-read-data (literal "${sbpl(d)}"))`),
    `(allow file-read* ${subpaths(read)})`,
    `(allow file-read* file-write* ${subpaths(write)})`,
    // Never, whatever was allowed above: the Keychain's files, the tools' credential files and every way in to launchd.
    `(deny file-read* file-write* ${subpaths([join(user, "Library", "Keychains"), ...CREDENTIAL_FILES.map((f) => join(user, f))])})`,
    // In a project folder: what Git runs on its own, and the same credential files (the ruling on project writes).
    // In a project folder (the rulings on #352): what runs on its own, whole, and every folder that holds one, so none
    // can be renamed away and back; its credential files unread too.
    ...(projects.length > 0 ? projectDenyLines(projects, user) : []),
    `(deny mach-lookup ${[...KEYCHAIN_SERVICES, ...LAUNCH_SERVICES_DENIES.services, ...SCREEN_AND_CLIPBOARD_SERVICES].map((s) => `(global-name "${sbpl(s)}")`).join(" ")})`,
    // Signals only to itself and its own children: never the daemon, the app or another plugin (#345's second review).
    "(deny signal)",
    "(allow signal (target self) (target children))",
    // No Unix socket but the DNS resolver and the ones it's named (connect isn't a file read; S1).
    "(deny network-outbound (remote unix-socket))",
    `(allow network-outbound ${paths([...DNS_SOCKETS, ...(i.sockets ?? [])]).map((p) => `(remote unix-socket (path-literal "${sbpl(p)}"))`).join(" ")})`,
  ];
  // Last, for every fenced process: no write where a write runs later, nor anywhere the fence keeps from bots, in both
  // spellings, and in a project folder not the folders that hold one either (#352's review).
  const places = persistencePlaces(user, i.cloverHome);
  if (places.length > 0) {
    lines.push(`(deny file-write* ${subpaths(places)})`);
    const held = holdersWithin(places, projects);
    if (held.length > 0) lines.push(`(deny file-write* ${held.map((h) => `(literal "${sbpl(h)}")`).join(" ")})`);
  }
  if (i.exec === "plugin") {
    const own = i.read[0];
    lines.push("(deny process-exec*)");
    lines.push(`(allow process-exec ${[...paths(i.execs ?? []).map((p) => `(literal "${sbpl(p)}")`), ...(own !== undefined ? [subpaths([own])] : [])].join(" ")})`);
  }
  if (i.fork === false) lines.push("(deny process-fork)");
  if (i.noNativeCode) {
    lines.push("(deny file-map-executable)");
    lines.push(`(allow file-map-executable ${[...SYSTEM_CODE.map((p) => `(subpath "${p}")`), ...paths(i.execs ?? []).map((p) => `(literal "${sbpl(p)}")`)].join(" ")})`);
  }
  lines.push(`(deny process-exec ${LAUNCH_SERVICES_DENIES.exec.map((p) => `(literal "${sbpl(p)}")`).join(" ")})`);
  return `${lines.join("\n")}\n`;
}

/** The folders of the sockets whose path is too long for a socket address (`sun_path`, 104 bytes on macOS). */
function longSocketFolders(sockets: readonly string[]): string[] {
  return [...new Set(sockets.filter((p) => Buffer.byteLength(p) >= 104 || Buffer.byteLength(realOrResolved(p)) >= 104).flatMap((p) => paths([dirname(p)])))];
}

/** The folders between a project folder (itself included) and each of `denied` inside it, real and as given: write-
 *  denied as literals, so none can be renamed and the denied path planted under a new name (#321's holders, #352's
 *  review). A file inside them can still be written. */
function holdersWithin(denied: readonly string[], projects: readonly string[]): string[] {
  const out = new Set<string>();
  const roots = paths(projects);
  for (const d of paths(denied)) {
    for (const root of roots) {
      if (!(d === root || d.startsWith(root + sep))) continue;
      for (let h = dirname(d); h.length >= root.length; h = dirname(h)) {
        out.add(h);
        if (h === root) break;
      }
    }
  }
  return [...out];
}

/** A project folder's deny lines: `PROJECT_WHOLE_DENIES` whole, `PROJECT_DENIES`, Git's hooks folder and a `.git`
 *  file's folders written by no one, the folders holding any of them, and its credential files unread. */
function projectDenyLines(projects: readonly string[], userHome: string): string[] {
  const denied = projects.flatMap((p) => [
    ...PROJECT_WHOLE_DENIES.map((f) => join(p, f)), ...PROJECT_DENIES.map((f) => join(p, f)), ...gitHooksPaths(p, userHome), ...gitFoldersOf(p),
  ]);
  const holders = holdersWithin(denied, projects);
  return [
    `(deny file-write* ${subpaths(denied)})`,
    ...(holders.length > 0 ? [`(deny file-write* ${holders.map((h) => `(literal "${sbpl(h)}")`).join(" ")})`] : []),
    `(deny file-read* ${subpaths(projects.flatMap((p) => CREDENTIAL_FILES.map((f) => join(p, f))))})`,
  ];
}

/** The devices a fenced process may write to: the null device, its terminal and its own descriptors (`/dev/stdout`
 *  and `/dev/stderr` are links into `/dev/fd`). */
const DEVICE_WRITES = '(literal "/dev/null") (literal "/dev/tty") (subpath "/dev/fd")';
/** Where the system's own native code lives (the dyld shared cache is under `/System/Volumes/Preboot/Cryptexes`). */
const SYSTEM_CODE: readonly string[] = ["/System", "/usr/lib"];

/** Whether this computer fences plugin processes: macOS with `sandbox-exec`. */
export function pluginFenceAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
}

/** `cmd` under the fence where there is one; as it is elsewhere. */
export function fencedCommand(cmd: readonly string[], fence: PluginFenceInput | undefined, platform: NodeJS.Platform = process.platform): string[] {
  if (fence === undefined || !pluginFenceAvailable(platform)) return [...cmd];
  return ["/usr/bin/sandbox-exec", "-p", pluginFenceProfile(fence), ...cmd];
}

/** Where a plugin's data folder and a fenced process's temp folder are (`<home>/plugin-data/<top>`, made on first
 *  use; `<home>/run/plugin-tmp/<name>`). A plugin id that isn't one gets none. */
export function fenceFolders(cloverHome: string, pluginId: string | undefined, name: string): { data?: string; tmp: string } {
  const tmp = join(cloverHome, "run", "plugin-tmp", name.replace(/[^a-z0-9-]/gi, "_").slice(0, 120));
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const top = pluginId?.split("/")[0];
  if (top === undefined || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(top)) return { tmp };
  const data = join(cloverHome, "plugin-data", top);
  mkdirSync(data, { recursive: true, mode: 0o700 });
  return { data, tmp };
}

/** A session's project folders for a hook or MCP server of it: its working directories, and whether its plugin holds
 *  `project.write`. */
export interface ProjectAccess {
  dirs: readonly string[];
  write: boolean;
}

/** The env a hook or MCP server runs with besides its TMPDIR: every package manager's cache in a folder of its own
 *  temp folder, and npm's user config a file there (`~/.npmrc` is a credential file, denied; S4). */
export function toolCacheEnv(tmp: string): Record<string, string> {
  const cache = join(tmp, "cache");
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const c = (name: string) => join(cache, name);
  return {
    TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    XDG_CACHE_HOME: c("xdg"),
    npm_config_cache: c("npm"), npm_config_userconfig: c("npmrc"), npm_config_store_dir: c("pnpm-store"), npm_config_update_notifier: "false",
    BUN_INSTALL_CACHE_DIR: c("bun"),
    UV_CACHE_DIR: c("uv"), UV_TOOL_DIR: c("uv-tools"), PIP_CACHE_DIR: c("pip"),
    YARN_CACHE_FOLDER: c("yarn"), DENO_DIR: c("deno"), GOCACHE: c("go-build"), GOMODCACHE: c("go-mod"),
  };
}

/** The fence for a plugin's hook command or stdio MCP server: its plugin's tree, Clover's run files and shared
 *  packages and its Bun to read; its data and temp folders to write; the package managers' installs to read (`tools`);
 *  any program, fenced the same. Returns its temp folder and the env it runs with (`toolCacheEnv`). */
export function toolFence(o: { files: Pick<PluginRunFiles, "guard" | "bin" | "cloverHome">; shared?: readonly string[]; pluginRoot: string; pluginId?: string; userHome?: string; name: string; project?: ProjectAccess }): { fence: PluginFenceInput; tmp: string; env: Record<string, string> } {
  const { data, tmp } = fenceFolders(o.files.cloverHome, o.pluginId, o.name);
  const userHome = o.userHome ?? homedir();
  const projects = o.project !== undefined ? projectFolders(o.project.dirs, { userHome, cloverHome: o.files.cloverHome }) : [];
  return {
    tmp,
    env: toolCacheEnv(tmp),
    fence: {
      cloverHome: o.files.cloverHome, userHome,
      ...(projects.length > 0 ? { projects, projectWrite: o.project?.write === true } : {}),
      read: [o.pluginRoot, dirname(o.files.guard), ...(o.shared ?? []), realOrResolved(join(o.files.bin, process.platform === "win32" ? "bun.exe" : "bun"))],
      write: [...(data !== undefined ? [data] : []), tmp], exec: "any", tools: true,
    },
  };
}
