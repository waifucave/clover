// FakeFence: the fenced set laid out under a Clover home, POSIX paths, prefix semantics. The layout is the fake's;
// lane C owns the real one, and a test can override any item.
import type { Caller, Os } from "@waifucave/clover-protocol";
import { Listeners, normalizePosix, type Unsubscribe } from "../common";
import {
  agentConfigPaths, autoRunPaths, CLOSED_DOORS, CLOUD_METADATA_ADDRESSES, CALLER_KINDS, fenceContextFor, gitHooksRoot, isBotCaller, BOT_READ_DENIED, ownFoldersOf, patternItemAt, isInsideFolded, judge, pluginLoadDenies, READ_DENIED_KINDS,
  writesPluginLoadDeny, type CallerFence, type FenceContext,
  type Fence, type FenceOp, type FencedKind, type FencedPath, type FenceVerdict, type SandboxPolicy,
} from "../fence";

/** Where the fake puts each item, under the Clover home. Development folders are wherever the user keeps them. */
export const FAKE_FENCE_LAYOUT: Record<Exclude<FencedKind, "dev-folders">, string | null> = {
  settings: "settings",
  levels: "levels",
  "saved-rules": "rules",
  "connector-permissions": "connectors",
  trust: "trust",
  "device-list": "devices",
  "user-layers": "user-layers",
  "credential-store": "credentials",
  "plugin-oks": "plugins-state/oks",
  "installed-plugins": "plugins-state/installed.json",
  "adult-confirmation": "plugins-state/adult.json",
  plugins: "plugins",
  "sessions-runtime": "sessions-runtime",
  /** One item per bot, `bots/<bot>/memory/` (`bots`). */
  "bot-memory": null,
  "plugin-data": "plugin-data",
  "run-folder": "run",
  transcripts: "sessions",
  usage: "usage",
  /** Under the app's userData folder, outside the Clover home (`userData`). */
  "browser-profiles": null,
  /** The OS's login item, outside the Clover home, plus macOS's parked copy in `<home>/login/`. */
  "login-start": null,
  /** Wherever the OK'd agents are installed (`agentInstalls`). */
  "agent-installs": null,
  "secrets-file": "secrets.enc",
  /** The key file, and the systemd-creds-sealed key on headless Linux (lane C's layout lists both). */
  "key-file": null,
};

export interface FakeFenceOptions {
  os?: Os;
  /** The user's home folder: commands may write in it (§9.1). */
  home: string;
  /** The Clover home (`~/.clover`, `~/.clover-dev`, or a test's temp home). */
  cloverHome: string;
  temp?: string;
  devFolders?: string[];
  /** The install folders of the coding agents the user has OK'd. */
  agentInstalls?: string[];
  /** The bots there are, by id (`pack/luna` for a child's), for their memory items. */
  bots?: string[];
  /** The app's userData folder (Electron's), which holds the browser's partitions; the OS's usual one by default. */
  userData?: string;
  /** Other folders plugin code loads from (the app's bundled plugins), for `pluginLoadDenies`. */
  pluginLoadFolders?: string[];
  /** Replaces the fake's layout for some items. */
  layout?: Partial<Record<FencedKind, string[]>>;
}

/** The app's userData folder on each OS, under the user's home. */
function defaultUserData(os: Os, home: string): string {
  if (os === "macos") return `${home}/Library/Application Support/Clover`;
  if (os === "windows") return `${home}/AppData/Roaming/Clover`;
  return `${home}/.config/Clover`;
}

/** The fake's own login-start places and the shared list as one: each once, and none inside another (a folder's
 *  subtree is its), as the real layout folds them. */
function loginStartUnion(paths: readonly string[]): string[] {
  const unique = [...new Set(paths.map(normalizePosix))];
  return unique.filter((p) => !unique.some((o) => o !== p && p.startsWith(`${o}/`)));
}

/** The shared lists in the fake's POSIX form (on Windows they're joined with backslashes). */
function posixOf(paths: readonly string[]): string[] {
  return paths.map((p) => p.replace(/\\/g, "/"));
}

/** The login item's files (lane C's `loginUnitPath`, `parkedPlistPath`); none on Windows. */
/** The login-start places: every folder and file a planted write could run later, outside the sandbox (spec item
 *  1116, the controller's ruling) — Clover's own login item first, then the shells and their logout scripts, SSH
 *  and git config, the folders that come ahead on PATH, editors, package managers, and the desktop's autostart,
 *  systemd, application and session-script folders. The gnupg entries are only its config files (gpg writes its
 *  trustdb and random seed in normal use), and `.git/config` stays writable (git writes it in normal use; setting
 *  risky keys through it is the reviewer's call) — only `.git/hooks` is fenced, as a pattern (any repo under the
 *  home). macOS also fences the loginwindow plist and `~/Library/Scripts`. Lane C's layout lists the same. */
function loginStartPaths(os: Os, home: string, cloverHome: string): string[] {
  const shell = [".zshrc", ".zprofile", ".zshenv", ".zlogin", ".bashrc", ".bash_profile", ".profile", ".bash_login",
    ".bash_logout", ".zlogout", ".logout"];
  const shells = [...shell.map((f) => `${home}/${f}`), `${home}/.config/fish`];
  const pathAhead = [`${home}/.local/bin`, `${home}/bin`];
  const sshGit = [`${home}/.ssh`, `${home}/.gitconfig`, `${home}/.config/git`];
  const editors = [`${home}/.vimrc`, `${home}/.vim`, `${home}/.config/nvim`, `${home}/.emacs`, `${home}/.emacs.d`];
  const packageManagers = [`${home}/.bunfig.toml`, `${home}/.bun/bin`, `${home}/.npmrc`, `${home}/.cargo/bin`,
    `${home}/.cargo/config.toml`, `${home}/.cargo/config`, `${home}/.config/pip`, `${home}/.pip`];
  if (os === "macos") {
    return [
      `${home}/Library/LaunchAgents/com.waifucave.clover.core.plist`, `${cloverHome}/login`,
      `${home}/Library/LaunchAgents`, `${home}/Library/LaunchDaemons`, `${home}/Library/StartupItems`,
      `${home}/Library/Application Support/com.apple.backgroundtaskmanagementagent`,
      `${home}/Library/Preferences/com.apple.loginwindow.plist`, `${home}/Library/Scripts`,
      ...shells, ...pathAhead, ...sshGit, ...editors, ...packageManagers,
      `${home}/Library/Python`,
      `${home}/.bash_aliases`, `${home}/.oh-my-zsh/custom`,
      `${home}/.gnupg/gpg.conf`, `${home}/.gnupg/gpg-agent.conf`, `${home}/.gnupg/dirmngr.conf`,
      `${home}/.config/environment.d`,
    ];
  }
  if (os === "linux") {
    return [
      `${home}/.config/systemd`, `${home}/.local/share/systemd/user`,
      `${home}/.config/autostart`, `${home}/.local/share/applications`, `${home}/.config/mimeapps.list`,
      `${home}/.config/environment.d`, `${home}/.pam_environment`, `${home}/.xprofile`, `${home}/.xsessionrc`, `${home}/.xinitrc`,
      `${home}/.config/autostart-scripts`, `${home}/.config/plasma-workspace/env`, `${home}/.config/plasma-workspace/shutdown`,
      ...shells, ...pathAhead, ...sshGit, ...editors, ...packageManagers,
      `${home}/.bash_aliases`, `${home}/.oh-my-zsh/custom`,
      `${home}/.gnupg/gpg.conf`, `${home}/.gnupg/gpg-agent.conf`, `${home}/.gnupg/dirmngr.conf`,
    ];
  }
  return [
    `${home}/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup`,
    `${home}/Documents/PowerShell`, `${home}/Documents/WindowsPowerShell`,
    `${home}/.bashrc`, `${home}/.bash_profile`, `${home}/.profile`, `${home}/.minttyrc`,
  ];
}

/** Lane M's self-update files under the Clover home (lane C's `layout.ts` lists the same): the `bin/` daemon
 *  binary, its `.new`/`.old` swap copies, the `update/` folder, and the install record. Never owned, read-only. */
function selfUpdatePaths(cloverHome: string): string[] {
  return [
    `${cloverHome}/bin/clover-core`,
    `${cloverHome}/bin/clover-core.new`,
    `${cloverHome}/bin/clover-core.old`,
    `${cloverHome}/bin/.new`,
    `${cloverHome}/bin/.old`,
    `${cloverHome}/update`,
    `${cloverHome}/install.json`,
  ];
}

export class FakeFence implements Fence {
  readonly os: Os;
  readonly #home: string;
  readonly #cloverHome: string;
  readonly #temp: string;
  readonly #userData: string;
  readonly #layout: Partial<Record<FencedKind, string[]>>;
  readonly #agentInstalls: string[];
  readonly #bots: string[];
  readonly #pluginLoadFolders: string[];
  #devFolders: string[];
  readonly #listeners = new Listeners<void>();

  constructor(opts: FakeFenceOptions) {
    this.os = opts.os ?? "macos";
    this.#home = normalizePosix(opts.home);
    this.#cloverHome = normalizePosix(opts.cloverHome);
    this.#temp = normalizePosix(opts.temp ?? "/tmp");
    this.#userData = normalizePosix(opts.userData ?? defaultUserData(this.os, this.#home));
    this.#devFolders = (opts.devFolders ?? []).map(normalizePosix);
    this.#agentInstalls = (opts.agentInstalls ?? []).map(normalizePosix);
    this.#bots = [...(opts.bots ?? [])];
    this.#layout = opts.layout ?? {};
    this.#pluginLoadFolders = (opts.pluginLoadFolders ?? []).map(normalizePosix);
  }

  /** `node_modules` above every folder plugin code loads from (`pluginLoadDenies`): the plugins folder, the
   *  development folders and the others the fake was given. */
  #pluginLoadDenies(): string[] {
    const plugins = this.#layout.plugins ?? [`${this.#cloverHome}/${FAKE_FENCE_LAYOUT.plugins}`];
    return pluginLoadDenies([...plugins, ...(this.#layout["dev-folders"] ?? this.#devFolders), ...this.#pluginLoadFolders]);
  }

  fencedSet(): readonly FencedPath[] {
    const out: FencedPath[] = [];
    const add = (kind: FencedKind, path: string) =>
      out.push({ kind, path: normalizePosix(path), deny: READ_DENIED_KINDS.includes(kind) ? "read-write" : CALLER_KINDS.includes(kind) ? "caller" : "write" });
    // Lane M's self-update files first (lane C's `layout.ts` pending `self-update`, pending until B names the
    // kind): never owned by any caller, read-only. First on purpose: they sit under login-start's `bin/` folder,
    // and the more specific kind names the attack.
    for (const p of (this.#layout as Record<string, string[] | undefined>)["self-update"] ?? selfUpdatePaths(this.#cloverHome)) {
      add("self-update" as FencedKind, p);
    }
    for (const [kind, rel] of Object.entries(FAKE_FENCE_LAYOUT) as [Exclude<FencedKind, "dev-folders">, string | null][]) {
      if ((kind === "secrets-file" || kind === "key-file") && this.os === "macos") continue; // the Keychain holds them there
      const override = this.#layout[kind];
      if (override) for (const p of override) add(kind, p);
      else if (rel !== null) add(kind, `${this.#cloverHome}/${rel}`);
      else if (kind === "key-file") for (const n of ["secrets.key", "secrets.key.cred"]) add(kind, `${this.#cloverHome}/${n}`);
      else if (kind === "browser-profiles") add(kind, `${this.#userData}/Partitions`);
      else if (kind === "login-start") for (const p of loginStartUnion([...loginStartPaths(this.os, this.#home, this.#cloverHome), ...posixOf(autoRunPaths(this.os, this.#home))])) add(kind, p);
      else if (kind === "agent-installs") for (const p of [...this.#agentInstalls, ...posixOf(agentConfigPaths(this.os, this.#home))]) add(kind, p);
      else if (kind === "bot-memory") for (const bot of this.#bots) out.push({ kind, path: `${this.#cloverHome}/bots/${bot.replace("/", "--")}/memory`, deny: "caller", bot });
    }
    for (const p of this.#layout["dev-folders"] ?? this.#devFolders) add("dev-folders", p);
    // Python's user site folders need the disk read (`pythonSiteDirNames`); the fake's fictional paths have none,
    // so its set lacks them — lane C's real fence and the sandboxes read them, and pin them on a real disk.
    return out;
  }

  check(op: FenceOp, ctx?: FenceContext): FenceVerdict {
    const writes = op.op === "write" || op.op === "delete" || op.op === "move";
    if (writes) {
      for (const p of op.op === "move" ? [op.path, op.to] : [op.path]) {
        const hooks = gitHooksRoot(p, this.#home, this.os);
        if (hooks !== null) return { allowed: false, reason: "login-start", path: hooks };
      }
    }
    const deny = ctx?.user ? undefined : writesPluginLoadDeny(op, this.#pluginLoadDenies(), this.os);
    if (deny !== undefined) return { allowed: false, reason: "plugins", path: deny };
    return judge(this.fencedSet(), op, { os: this.os, cloverHome: this.#cloverHome, ...(ctx ? { caller: ctx } : {}) });
  }

  touches(paths: readonly string[]): FencedPath | null {
    for (const path of paths) {
      const p = patternItemAt(path, this.#cloverHome, this.os);
      if (p?.kind === "bot-memory") return { kind: "bot-memory", path: p.root, deny: "caller", ...(p.folder ? { bot: p.folder.replace("--", "/") } : {}) };
      if (p?.kind === "sessions-runtime") return { kind: "sessions-runtime", path: p.root, deny: "read-write" };
      const hooks = gitHooksRoot(path, this.#home, this.os);
      if (hooks !== null) return { kind: "login-start", path: hooks, deny: "write" };
      for (const item of this.fencedSet()) {
        if (isInsideFolded(path, item.path, this.os) || isInsideFolded(item.path, path, this.os)) return item;
      }
    }
    return null;
  }

  checkAgentRoot(root: string): FenceVerdict {
    // Inside the Clover home, or holding it (#197's check 3): an unsandboxed agent rooted there could edit what's fenced.
    if (isInsideFolded(this.#cloverHome, root, this.os) || isInsideFolded(root, this.#cloverHome, this.os)) {
      return { allowed: false, reason: "clover-home", path: this.#cloverHome };
    }
    for (const item of this.fencedSet()) {
      if (item.kind === "dev-folders") continue;
      if (isInsideFolded(item.path, root, this.os) || isInsideFolded(root, item.path, this.os)) return { allowed: false, reason: item.kind, path: item.path };
    }
    for (const dev of this.#layout["dev-folders"] ?? this.#devFolders) {
      if (isInsideFolded(dev, root, this.os) || isInsideFolded(root, dev, this.os)) return { allowed: false, reason: "dev-folders", path: normalizePosix(dev) };
    }
    return { allowed: true };
  }

  policy(ctx?: FenceContext): SandboxPolicy {
    const set = this.fencedSet().filter((i) => i.deny !== "caller");
    const patterns = [`${this.#cloverHome}/bots/*/memory`, `${this.#cloverHome}/sessions-runtime`];
    return {
      allowWrite: [this.#home, this.#temp],
      // The whole Clover home, for every runner (the home default-deny), and the bots folder and the pattern items by
      // name (C's base); the runner's own folders come back below (`ownFoldersOf`, its own memory included).
      // A bot writes every bot's memory (the owner's amendment): no memory pattern in its write list either.
      denyWrite: [...set.map((i) => i.path), ...(isBotCaller(ctx) ? [] : [patterns[0]!]), `${this.#cloverHome}/bots`, this.#cloverHome, ...this.#pluginLoadDenies()],
      // A bot's open access (the owner's ruling of November 9): no memory pattern, what it can't read by name.
      denyRead: [...set.filter((i) => i.deny === "read-write").map((i) => i.path),
        ...(isBotCaller(ctx) ? BOT_READ_DENIED.map((rel) => [this.#cloverHome, ...rel].join("/")) : patterns), this.#cloverHome],
      closedDoors: [...CLOSED_DOORS[this.os]],
      blockedAddresses: [...CLOUD_METADATA_ADDRESSES],
      network: "none",
      ...ownFoldersOf(ctx, this.#cloverHome),
      ...(isBotCaller(ctx) ? { botAccess: { home: this.#cloverHome, scratch: `${this.#cloverHome}/scratch`, bots: `${this.#cloverHome}/bots` } } : {}),
    };
  }


  forCaller(caller: Caller): CallerFence {
    const context = fenceContextFor(caller);
    return {
      os: this.os,
      context,
      fencedSet: () => this.fencedSet(),
      touches: (paths) => this.touches(paths),
      checkAgentRoot: (root) => this.checkAgentRoot(root),
      check: (op) => this.check(op, context),
      policy: () => this.policy(context),
    };
  }

  watch(fn: () => void): Unsubscribe {
    return this.#listeners.add(fn);
  }

  /** The user added a development folder (after its sealed card, or in their own terminal). */
  addDevFolder(path: string): void {
    this.#devFolders = [...this.#devFolders, normalizePosix(path)];
    this.#listeners.emit();
  }

  removeDevFolder(path: string): void {
    const p = normalizePosix(path);
    this.#devFolders = this.#devFolders.filter((d) => d !== p);
    this.#listeners.emit();
  }
}
