// FakeFence: the fenced set laid out under a Clover home, POSIX paths, prefix semantics. The layout is the fake's;
// lane C owns the real one, and a test can override any item.
import type { Caller, Os } from "@waifucave/clover-protocol";
import { Listeners, normalizePosix, type Unsubscribe } from "../common";
import {
  CLOSED_DOORS, CLOUD_METADATA_ADDRESSES, BASH_WRITE_KINDS, fenceContextFor, isInsideFolded, judge, otherBotFolder, READ_DENIED_KINDS, type CallerFence, type FenceContext,
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
  "bot-memory": "bots",
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
  "key-file": "secrets.key",
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
  /** The app's userData folder (Electron's), which holds the browser's partitions; the OS's usual one by default. */
  userData?: string;
  /** Replaces the fake's layout for some items. */
  layout?: Partial<Record<FencedKind, string[]>>;
}

/** The app's userData folder on each OS, under the user's home. */
function defaultUserData(os: Os, home: string): string {
  if (os === "macos") return `${home}/Library/Application Support/Clover`;
  if (os === "windows") return `${home}/AppData/Roaming/Clover`;
  return `${home}/.config/Clover`;
}

/** The login item's files (lane C's `loginUnitPath`, `parkedPlistPath`); none on Windows. */
function loginStartPaths(os: Os, home: string, cloverHome: string): string[] {
  if (os === "macos") return [`${home}/Library/LaunchAgents/com.waifucave.clover.core.plist`, `${cloverHome}/login`];
  if (os === "linux") return [`${home}/.config/systemd/user/clover-core.service`];
  return [];
}

export class FakeFence implements Fence {
  readonly os: Os;
  readonly #home: string;
  readonly #cloverHome: string;
  readonly #temp: string;
  readonly #userData: string;
  readonly #layout: Partial<Record<FencedKind, string[]>>;
  readonly #agentInstalls: string[];
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
    this.#layout = opts.layout ?? {};
  }

  fencedSet(): readonly FencedPath[] {
    const out: FencedPath[] = [];
    const add = (kind: FencedKind, path: string) =>
      out.push({ kind, path: normalizePosix(path), deny: READ_DENIED_KINDS.includes(kind) ? "read-write" : BASH_WRITE_KINDS.includes(kind) ? "bash-write" : "write" });
    for (const [kind, rel] of Object.entries(FAKE_FENCE_LAYOUT) as [Exclude<FencedKind, "dev-folders">, string | null][]) {
      if ((kind === "secrets-file" || kind === "key-file") && this.os === "macos") continue; // the Keychain holds them there
      const override = this.#layout[kind];
      if (override) for (const p of override) add(kind, p);
      else if (rel !== null) add(kind, `${this.#cloverHome}/${rel}`);
      else if (kind === "browser-profiles") add(kind, `${this.#userData}/Partitions`);
      else if (kind === "login-start") for (const p of loginStartPaths(this.os, this.#home, this.#cloverHome)) add(kind, p);
      else if (kind === "agent-installs") for (const p of this.#agentInstalls) add(kind, p);
    }
    for (const p of this.#layout["dev-folders"] ?? this.#devFolders) add("dev-folders", p);
    return out;
  }

  check(op: FenceOp, ctx?: FenceContext): FenceVerdict {
    const v = judge(this.fencedSet(), op, { os: this.os, cloverHome: this.#cloverHome });
    if (!v.allowed) return v;
    // A bot's session reads only its own bot's folder (`bot-memory`).
    for (const path of op.op === "move" ? [op.path, op.to] : [op.path]) {
      const other = otherBotFolder(path, ctx, { os: this.os, cloverHome: this.#cloverHome });
      if (other !== undefined) return { allowed: false, reason: "bot-memory", path: other };
    }
    return v;
  }

  touches(paths: readonly string[]): FencedPath | null {
    for (const path of paths) {
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

  policy(ctx?: FenceContext & { bots?: readonly string[] }): SandboxPolicy {
    const set = this.fencedSet();
    const others = ctx?.bot === undefined && !ctx?.noBots ? [] : (ctx.bots ?? []).filter((b) => b !== ctx.bot).map((b) => `${this.#cloverHome}/bots/${b}`);
    return {
      allowWrite: [this.#home, this.#temp],
      denyWrite: set.map((i) => i.path),
      denyRead: [...set.filter((i) => i.deny === "read-write").map((i) => i.path), ...others],
      closedDoors: [...CLOSED_DOORS[this.os]],
      blockedAddresses: [...CLOUD_METADATA_ADDRESSES],
      network: "none",
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
      policy: (opts = {}) => this.policy({ ...context, ...(opts.bots ? { bots: opts.bots } : {}) }),
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
