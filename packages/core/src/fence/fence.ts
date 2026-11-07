// The real Fence (B's contract `contracts/fence.ts`, owner lane C; spec §9.1 "The fence, precisely"). One per
// computer, over its own Clover home: the fenced set laid out by layout.ts, every path resolved on this disk
// (canonical.ts) and compared folded (fold.ts), so a link, a `..` after a link, a fenced name in another case or
// Unicode form, or a Windows short name, trailing dot or stream suffix never leads past it, whether or not the item
// exists yet. A name that isn't ASCII where Clover names things (the home's top level, a folder holding a fenced
// item) is refused outright. A hard link is
// another name for the same file: a write, delete or move of a file with more than one link is judged as the
// fenced file it shares an inode with (J-M1's review), and refused outright when the fenced set holds too many
// files to tell (fail closed).
import { lstatSync, readdirSync, type BigIntStats } from "node:fs";
import { join, posix, win32 } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import type { Caller } from "@waifucave/clover-protocol";
import { Listeners, type Unsubscribe } from "../contracts/common";
import {
  CLOSED_DOORS, CLOUD_METADATA_ADDRESSES, judge, READ_DENIED_KINDS, fenceContextFor, patternItemAt, windowsAlias,
  type CallerFence, type Fence, type FenceContext, type FenceOp, type FencedKind, type FencedPath, type FenceVerdict, type SandboxPolicy,
} from "../contracts/fence";
import { canonicalPath } from "./canonical";
import { foldPath, nonAsciiAlias } from "./fold";
import { fenceLayout, pendingFenced, type LaidOutKind } from "./layout";

/** Pending kinds this fence enforces before B's contract has them. */
export const ENFORCED_AHEAD = ["plugins", "login-start", "hook-shell"] as const;

export interface CloverFenceOptions {
  os?: Os;
  /** The user's home folder: commands may write in it (§9.1). */
  home: string;
  /** This computer's Clover home. */
  cloverHome: string;
  temp?: string;
  devFolders?: string[];
  /** The bots whose memory is fenced (`bots/<bot>/memory`, deny `caller` each). */
  bots?: string[];
  /** The install folders of the coding agents the user has OK'd (`agent-installs`). */
  agentInstalls?: string[];
  /** The app's userData folder (E's); per-OS default under `home` when absent. */
  userData?: string;
  /** Replaces the layout for some items (tests). */
  layout?: Partial<Record<FencedKind, string[]>>;
  /** The Clover Browser's SOCKS5 filter's loopback ports (lane L's `DaemonBrowser.filterPorts()`): unauthenticated, since
   *  Chromium sends no SOCKS credentials, so no fenced command may reach them. L's filter takes connections only from
   *  the browser's own network process; this is the second layer. */
  loopbackPorts?: () => readonly number[];
  /** How a path is resolved on this disk; the conformance suite's paths are fictional, so it passes its own. */
  canonical?: (path: string) => string;
  /** Enforce `ENFORCED_AHEAD` (default true). Off only for B's contract suite until its next version names those kinds
   *  (B's #197), since today's suite still says the plugins folder isn't fenced. */
  enforceAhead?: boolean;
}

/** How many entries of the fenced set a hard-link check walks before it refuses instead. */
export const HARD_LINK_SCAN_LIMIT = 20_000;

const osOf = (): Os => (process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux");

export class CloverFence implements Fence {
  readonly os: Os;
  readonly #home: string;
  readonly #cloverHome: string;
  readonly #temp: string;
  readonly #layout: Partial<Record<FencedKind, string[]>>;
  readonly #canonical: (path: string) => string;
  readonly #listeners = new Listeners<void>();
  readonly #loopbackPorts: () => readonly number[];
  readonly #bots: string[];
  readonly #agentInstalls: string[];
  readonly #userData: string | undefined;
  #devFolders: string[];

  constructor(opts: CloverFenceOptions) {
    this.os = opts.os ?? osOf();
    this.#canonical = opts.canonical ?? ((p) => canonicalPath(p));
    this.#home = this.#canonical(opts.home);
    this.#cloverHome = this.#canonical(opts.cloverHome);
    this.#temp = this.#canonical(opts.temp ?? (this.os === "windows" ? win32.join(opts.home, "AppData", "Local", "Temp") : "/tmp"));
    this.#devFolders = (opts.devFolders ?? []).map((p) => this.#canonical(p));
    this.#bots = [...(opts.bots ?? [])];
    this.#agentInstalls = [...(opts.agentInstalls ?? [])];
    this.#userData = opts.userData;
    this.#layout = opts.layout ?? {};
    this.#loopbackPorts = opts.loopbackPorts ?? (() => []);
    this.#enforceAhead = opts.enforceAhead ?? true;
  }

  readonly #enforceAhead: boolean;

  fencedSet(): readonly FencedPath[] {
    const out: FencedPath[] = [];
    const add = (kind: FencedKind, path: string) =>
      out.push({ kind, path: this.#canonical(path), deny: READ_DENIED_KINDS.includes(kind) ? "read-write" : "write" });
    for (const [kind, paths] of Object.entries(fenceLayout(this.#cloverHome, this.os, {
      home: this.#home, userData: this.#userData, agentInstalls: this.#agentInstalls,
    })) as [LaidOutKind, string[]][]) {
      for (const p of this.#layout[kind] ?? paths) add(kind, p);
    }
    // Bots' memory is per-bot and caller-gated (`deny: "caller"`, judged by pattern in `judge`).
    for (const bot of this.#bots) {
      out.push({ kind: "bot-memory", path: this.#canonical(`${this.#cloverHome}/bots/${bot.replace("/", "--")}/memory`), deny: "caller", bot });
    }
    for (const p of this.#layout["dev-folders"] ?? this.#devFolders) add("dev-folders", p);
    // Enforced ahead of B's contract naming them (#205's S5: before bots' Bash runs under the fence and before hooks
    // run): the plugins folder, the places that start programs at login (shell start files included), and the
    // per-user Git whose bash runs Windows hooks. Write-denied.
    const pending = pendingFenced({ home: this.#home, cloverHome: this.#cloverHome, os: this.os });
    for (const kind of this.#enforceAhead ? ENFORCED_AHEAD : []) {
      for (const p of (this.#layout as Record<string, string[] | undefined>)[kind] ?? pending[kind] ?? []) add(kind as FencedKind, p);
    }
    return out;
  }

  /** The set and an operation's paths, folded, for B's shared `judge`; each folded item maps back to its own. */
  #folded(): { set: FencedPath[]; back: Map<string, FencedPath> } {
    const back = new Map<string, FencedPath>();
    const set = this.fencedSet().map((item) => {
      const f = { ...item, path: this.#fold(item.path) };
      back.set(f.path, item);
      return f;
    });
    return { set, back };
  }

  /** The Clover home, canonical: a command's sandbox names where Clover names things from it. */
  get cloverHome(): string { return this.#cloverHome; }

  #fold(path: string): string {
    // `judge` and `isInside` are POSIX: a Windows path is compared as `c:/users/...`, which they take as relative.
    return foldPath(path, this.os);
  }

  /** The forms a path is judged in (#205's B1): as the disk resolves it, links first (`canonicalPath`: a `..` after a
   *  link climbs from its target, as POSIX kernels do), and with its `..` taken textually first (as Win32 and most
   *  path code do). A path is refused when either form is. Null, refused outright: a Windows device path that isn't a
   *  drive or a share once its prefix is taken off (`windowsLocalForm`), a `\\?\` path with a `.` or `..` component
   *  (Windows passes it through unresolved), or one past the walk's link limit. */
  #forms(raw: string): string[] | null {
    let path = raw;
    if (this.os === "windows") {
      const local = windowsLocalForm(raw);
      if (local === null) return null;
      path = local;
    }
    try {
      const linksFirst = this.#canonical(path);
      const textual = this.#canonical((this.os === "windows" ? win32 : posix).normalize(path));
      const forms = linksFirst === textual ? [linksFirst] : [linksFirst, textual];
      // On a real Windows disk every form judged is a drive path or a \\server\share path (#205's check 2).
      if (this.os === "windows" && isWindowsDiskForm(this.#cloverHome) && !forms.every(isWindowsDiskForm)) return null;
      return forms;
    } catch { return null; } // more links than the walk follows (`TooManyLinks`): refused
  }

  check(op: FenceOp, ctx?: FenceContext): FenceVerdict {
    const write = op.op === "write" || op.op === "delete" || op.op === "move";
    const all: string[] = [];
    for (const raw of op.op === "move" ? [op.path, op.to] : [op.path]) {
      const forms = this.#forms(raw);
      if (forms === null) return { allowed: false, reason: "clover-home", path: this.#cloverHome };
      // A stream suffix or 8.3 short name is refused wherever it is. This runs on the device
      // form (so `\??\C:\…` still names the drive path it names, #205's check 2) but before
      // folding (which would resolve the alias to the name it names).
      if (this.os === "windows") {
        for (const form of forms) {
          if (windowsAlias(form) !== undefined) return { allowed: false, reason: "alias", path: raw };
        }
      }
      all.push(...forms);
    }
    // The folded item first, so a name that folds onto one (`ſettings`) is refused as that item; then a hard link to
    // one (for a read, to a read-denied one: #205's B2); then a name that isn't ASCII where Clover names things,
    // whatever it folds to (B's contract, #179's F1).
    const { set, back } = this.#folded();
    const judgeOpts = { os: this.os, cloverHome: this.#cloverHome, ...(ctx === undefined ? {} : { caller: ctx }) };
    for (const p of all) {
      const v = judge(set, { op: write ? "write" : "read", path: this.#fold(p) }, judgeOpts);
      if (!v.allowed) return { allowed: false, reason: v.reason, path: back.get(v.path)?.path ?? v.path };
    }
    for (const p of all) {
      const linked = this.#hardLinked(p, !write);
      if (linked) return { allowed: false, reason: linked.kind, path: linked.path };
    }
    const fenced = this.fencedSet().map((i) => i.path);
    for (const p of all) {
      if (nonAsciiAlias(p, fenced, this.#cloverHome, this.os) !== null) return { allowed: false, reason: "clover-home", path: this.#cloverHome };
    }
    return { allowed: true };
  }

  /** The fenced item a file with more than one link shares its inode with (for a read, only the read-denied items);
   *  also every such item when the set holds more files than `HARD_LINK_SCAN_LIMIT` (it can't be told, so it's
   *  refused). */
  #hardLinked(path: string, readsOnly = false): FencedPath | null {
    let st: BigIntStats;
    try { st = lstatSync(path, { bigint: true }); } catch { return null; }
    if (!st.isFile() || st.nlink < 2n) return null;
    const key = `${st.dev}:${st.ino}`;
    let seen = 0;
    for (const item of this.fencedSet()) {
      if (readsOnly && item.deny !== "read-write") continue;
      const stack = [item.path];
      while (stack.length > 0) {
        const at = stack.pop()!;
        if (++seen > HARD_LINK_SCAN_LIMIT) return item;
        let s: BigIntStats;
        try { s = lstatSync(at, { bigint: true }); } catch { continue; }
        if (s.isFile() && `${s.dev}:${s.ino}` === key) return item;
        if (s.isDirectory()) { try { for (const name of readdirSync(at)) stack.push(join(at, name)); } catch { /* unreadable */ } }
      }
    }
    return null;
  }

  touches(paths: readonly string[]): FencedPath | null {
    const { set, back } = this.#folded();
    for (const raw of paths) for (const form of this.#forms(raw) ?? [this.#cloverHome]) {
      const pattern = patternItemAt(form, this.#cloverHome, this.os);
      if (pattern?.kind === "bot-memory") {
        return { kind: "bot-memory", path: pattern.root, deny: "caller", ...(pattern.folder ? { bot: pattern.folder.replace("--", "/") } : {}) };
      }
      if (pattern?.kind === "sessions-runtime") return { kind: "sessions-runtime", path: pattern.root, deny: "read-write" };
      const p = this.#fold(form);
      for (const item of set) {
        if (inside(p, item.path) || inside(item.path, p)) return back.get(item.path) ?? null;
      }
    }
    return null;
  }

  /** A coding agent runs unsandboxed (§9.3), so its root may neither hold nor sit inside the Clover home (an OK'd
   *  plugin's folder, the settings, plugin data), a development folder, or any other fenced item (#197's check 3).
   *  Compared folded, so a different case or a decomposed name is the same folder. */
  checkAgentRoot(root: string): FenceVerdict {
    const forms = this.#forms(root);
    if (forms === null) return { allowed: false, reason: "clover-home", path: this.#cloverHome };
    for (const f of forms) {
      const v = this.#agentRoot(f);
      if (!v.allowed) return v;
    }
    return { allowed: true };
  }

  #agentRoot(form: string): FenceVerdict {
    const r = this.#fold(form);
    const home = this.#fold(this.#cloverHome);
    if (inside(home, r) || inside(r, home)) return { allowed: false, reason: "clover-home", path: this.#cloverHome };
    for (const dev of this.#layout["dev-folders"] ?? this.#devFolders) {
      const d = this.#fold(this.#canonical(dev));
      if (inside(d, r) || inside(r, d)) return { allowed: false, reason: "dev-folders", path: this.#canonical(dev) };
    }
    for (const item of this.fencedSet()) {
      const f = this.#fold(item.path);
      if (inside(f, r) || inside(r, f)) return { allowed: false, reason: item.kind, path: item.path };
    }
    return { allowed: true };
  }

  policy(ctx?: FenceContext): SandboxPolicy {
    const set = this.fencedSet().filter((i) => i.deny !== "caller");
    const patterns = [`${this.#cloverHome}/bots/*/memory`, `${this.#cloverHome}/sessions-runtime`];
    return {
      allowWrite: [this.#home, this.#temp],
      denyWrite: [...set.map((i) => i.path), patterns[0]!],
      denyRead: [...set.filter((i) => i.deny === "read-write").map((i) => i.path), ...patterns],
      closedDoors: [...CLOSED_DOORS[this.os]],
      // The cloud metadata address first, then the browser filter's ports on both loopbacks (`host:port`).
      blockedAddresses: [...CLOUD_METADATA_ADDRESSES, ...this.#loopbackPorts().flatMap((port) => [`127.0.0.1:${port}`, `[::1]:${port}`])],
      network: "none",
      ...(ctx?.memoryOf !== undefined ? { ownMemory: `${this.#cloverHome}/bots/${ctx.memoryOf.replace("/", "--")}/memory` } : {}),
    };
  }

  /** The fence as one caller meets it: the caller's reach for `caller` items, everything else as for any caller. */
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

  /** Follows the plugin registry's development folders (B's `PluginFolders.devFolderPaths()` and
   *  `onDevFoldersChanged()`, #197): the set is replaced on each change, and watchers are told. Returns the stop. */
  followDevFolders(source: { devFolderPaths(): readonly string[]; onDevFoldersChanged(fn: () => void): () => void }): () => void {
    const sync = () => {
      const next = [...new Set(source.devFolderPaths().map((p) => this.#canonical(p)))];
      if (next.length === this.#devFolders.length && next.every((p, i) => p === this.#devFolders[i])) return;
      this.#devFolders = next;
      this.#listeners.emit();
    };
    sync();
    return source.onDevFoldersChanged(sync);
  }

  /** A development folder was turned on (§5.6). */
  addDevFolder(path: string): void {
    const p = this.#canonical(path);
    if (this.#devFolders.includes(p)) return;
    this.#devFolders = [...this.#devFolders, p];
    this.#listeners.emit();
  }

  removeDevFolder(path: string): void {
    const p = this.#canonical(path);
    const next = this.#devFolders.filter((d) => d !== p);
    if (next.length === this.#devFolders.length) return;
    this.#devFolders = next;
    this.#listeners.emit();
  }
}

/** `isInside` over folded, `/`-separated paths (a Windows drive path has no leading `/`). */
function inside(path: string, root: string): boolean {
  const p = posix.normalize(path), r = posix.normalize(root);
  return p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`);
}

/** A Windows path with its device prefix (`\\?\`, `\\.\`, and the NT `\??\` that Bun also opens) taken off:
 *  `C:\…` for a drive, `\\server\share\…` for `UNC\`. Null for anything else behind a prefix (`GLOBALROOT`, a
 *  volume GUID, a pipe or a device), and for a prefixed path with a `.` or `..` component, which Windows passes
 *  through unresolved (#205's B1 and check 2). A path without a prefix is returned as it is. */
export function windowsLocalForm(raw: string): string | null {
  const m = /^(?:[\\/]{2}[?.]|\\\?\?)[\\/](.*)$/s.exec(raw);
  if (!m) return raw;
  const rest = m[1]!;
  if (rest.split(/[\\/]/).some((c) => c === "." || c === "..")) return null;
  if (/^[A-Za-z]:([\\/]|$)/.test(rest)) return rest;
  const unc = /^UNC[\\/](.+)$/i.exec(rest);
  if (unc) return `\\\\${unc[1]}`;
  return null;
}

/** A drive path (`C:\…`) or a share path (`\\server\share\…`), nothing else. */
export function isWindowsDiskForm(p: string): boolean {
  return /^[A-Za-z]:([\\/]|$)/.test(p) || /^[\\/]{2}(?![?.][\\/])[^\\/]+[\\/][^\\/]+/.test(p);
}
