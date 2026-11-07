// The real Fence (B's contract `contracts/fence.ts`, owner lane C; spec §9.1 "The fence, precisely"). One per
// computer, over its own Clover home: the fenced set laid out by layout.ts, every path resolved on this disk
// (canonical.ts) and compared folded (fold.ts), so a link, a `..` after a link, a fenced name in another case or
// Unicode form, or a Windows short name, trailing dot or stream suffix never leads past it, whether or not the item
// exists yet. A name that isn't ASCII where Clover names things (the home's top level, a folder holding a fenced
// item) is refused outright. A hard link is
// another name for the same file: a write, delete or move of a file with more than one link is judged as the
// fenced file it shares an inode with (J-M1's review), and refused outright when the fenced set holds too many
// files to tell (fail closed).
//
// The verdict itself is B's shared `judge`, so the real fence and the fake agree, caller by caller: the Clover home
// is default-deny for every tool runner, with only the caller's own `outputs/<session>`, `scratch/<bot>`,
// `routines/<bot>`, `bots/<x>` (read) and `memory` (read and write), and a plugin's own `plugin-data/<id>` letting
// it back in. The sandbox profiles (macOS, Linux) apply the same order through `policy`.
import { lstatSync, readdirSync, type BigIntStats } from "node:fs";
import { join, posix, win32 } from "node:path";
import type { Caller, Os } from "@waifucave/clover-protocol";
import { Listeners, type Unsubscribe } from "../contracts/common";
import {
  CLOSED_DOORS, CLOUD_METADATA_ADDRESSES, fenceContextFor, judge, ownFoldersOf, patternItemAt, READ_DENIED_KINDS,
  type CallerFence, type Fence, type FenceContext, type FencedKind, type FencedPath, type FenceOp, type FenceVerdict,
  type SandboxPolicy,
} from "../contracts/fence";
import { canonicalPath } from "./canonical";
import { foldPath, nonAsciiAlias } from "./fold";
import { botFolders, fenceLayout, loginStartPaths, pendingFenced, type LaidOutKind } from "./layout";

/** Pending kinds this fence enforces before B's contract has them. */
export const ENFORCED_AHEAD = ["hook-shell", "session-transcripts"] as const;

export interface CloverFenceOptions {
  os?: Os;
  /** The user's home folder: commands may write in it (§9.1). */
  home: string;
  /** This computer's Clover home. */
  cloverHome: string;
  temp?: string;
  devFolders?: string[];
  /** The bots there are, by id (`pack/luna` for a child's), for their memory items (pattern rules the rest). */
  bots?: string[];
  /** The install folders of the coding agents the user has OK'd to run unsandboxed (lane K). */
  agentInstalls?: readonly string[];
  /** The app's userData folder (E's), which holds the Clover Browser's partitions; the OS's usual one by default. */
  userData?: string;
  /** A headless run's session data folder (lane E passes `app.getPath("sessionData")` here; TODO(lane E): wire it).
   *  Its `Partitions` folder is fenced like the app's. */
  sessionData?: string;
  /** Replaces the layout for some items (tests). */
  layout?: Partial<Record<FencedKind, string[]>>;
  /** The Clover Browser's SOCKS5 filter's loopback ports (lane L's `DaemonBrowser.filterPorts()`): unauthenticated, since
   *  Chromium sends no SOCKS credentials, so no fenced command may reach them. L's filter takes connections only from
   *  the browser's own network process; this is the second layer. */
  loopbackPorts?: () => readonly number[];
  /** How a path is resolved on this disk; the conformance suite's paths are fictional, so it passes its own. */
  canonical?: (path: string) => string;
  /** Enforce `ENFORCED_AHEAD` (default true). Off for B's contract suite until its next version names those kinds. */
  enforceAhead?: boolean;
}

/** How many entries of the fenced set a hard-link walk refuses instead of scanning. */
export const HARD_LINK_SCAN_LIMIT = 20_000;

const osOf = (): Os => (process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux");

/** The app's userData folder on each OS, under the user's home. */
function defaultUserData(os: Os, home: string): string {
  const p = os === "windows" && !home.startsWith("/") ? win32 : posix;
  if (os === "macos") return p.join(home, "Library", "Application Support", "Clover");
  if (os === "windows") return p.join(home, "AppData", "Roaming", "Clover");
  return p.join(home, ".config", "Clover");
}

export class CloverFence implements Fence {
  readonly os: Os;
  readonly #home: string;
  readonly #cloverHome: string;
  readonly #temp: string;
  readonly #userData: string;
  readonly #sessionData: string | undefined;
  readonly #layout: Partial<Record<FencedKind, string[]>>;
  readonly #canonical: (path: string) => string;
  readonly #listeners = new Listeners<void>();
  readonly #loopbackPorts: () => readonly number[];
  readonly #agentInstalls: string[];
  readonly #bots: string[];
  #devFolders: string[];

  constructor(opts: CloverFenceOptions) {
    this.os = opts.os ?? osOf();
    this.#canonical = opts.canonical ?? ((p) => canonicalPath(p));
    this.#home = this.#canonical(opts.home);
    this.#cloverHome = this.#canonical(opts.cloverHome);
    this.#temp = this.#canonical(opts.temp ?? (this.os === "windows" ? win32.join(opts.home, "AppData", "Local", "Temp") : "/tmp"));
    this.#userData = this.#canonical(opts.userData ?? defaultUserData(this.os, opts.home));
    this.#sessionData = opts.sessionData === undefined ? undefined : this.#canonical(opts.sessionData);
    this.#devFolders = (opts.devFolders ?? []).map((p) => this.#canonical(p));
    this.#agentInstalls = [...(opts.agentInstalls ?? [])].map((p) => this.#canonical(p));
    this.#bots = [...(opts.bots ?? [])];
    this.#layout = opts.layout ?? {};
    this.#loopbackPorts = opts.loopbackPorts ?? (() => []);
    this.#enforceAhead = opts.enforceAhead ?? true;
  }

  readonly #enforceAhead: boolean;

  fencedSet(): readonly FencedPath[] {
    const out: FencedPath[] = [];
    const add = (kind: FencedKind, path: string) =>
      out.push({ kind, path: this.#canonical(path), deny: READ_DENIED_KINDS.includes(kind) ? "read-write" : kind === "bot-memory" ? "caller" : "write" });
    for (const [kind, paths] of Object.entries(fenceLayout(this.#cloverHome, this.os)) as [LaidOutKind, string[]][]) {
      for (const p of this.#layout[kind] ?? paths) add(kind, p);
    }
    for (const p of this.#layout["dev-folders"] ?? this.#devFolders) add("dev-folders", p);
    // The kinds that need more than the Clover home: the login places (under the user's home), the browser's
    // partitions (always both shipped and dev profiles from the OS app-data folder, so neither app build can read
    // the other's sign-ins, plus an explicitly passed userData and a headless sessionData when given), and the
    // OK'd agent installs.
    for (const p of this.#layout["login-start"] ?? loginStartPaths(this.#home, this.#cloverHome, this.os)) add("login-start", p);
    const appData = this.os === "macos"
      ? joinHome(this.#home, this.os, "Library", "Application Support")
      : this.os === "windows"
        ? joinHome(this.#home, this.os, "AppData", "Roaming")
        : joinHome(this.#home, this.os, ".config");
    const browserProfiles = this.#layout["browser-profiles"] ?? [
      joinHome(appData, this.os, "Clover", "Partitions"),
      joinHome(appData, this.os, "Clover Dev", "Partitions"),
      joinHome(this.#userData, this.os, "Partitions"),
      ...(this.#sessionData === undefined ? [] : [joinHome(this.#sessionData, this.os, "Partitions")]),
    ];
    for (const p of [...new Set(browserProfiles)]) add("browser-profiles", p);
    for (const p of this.#layout["agent-installs"] ?? this.#agentInstalls) add("agent-installs", p);
    // Each bot's memory, `<home>/bots/<bot>/memory/` (deny `caller`: `judge` binds it by pattern to the bot whose id
    // folds equal). The known bots by id, plus the folders on the disk, so an unlisted leftover is still named.
    const seg = (bot: string) => bot.replace(/\//g, "--");
    const known = new Map<string, string>();
    for (const bot of this.#bots) known.set(seg(bot), bot);
    try { for (const folder of botFolders(this.#cloverHome)) if (!known.has(folder)) known.set(folder, folder); }
    catch { /* the disk is unreadable: the pattern still rules */ }
    const p = this.os === "windows" && !this.#cloverHome.startsWith("/") ? win32 : posix;
    for (const [folder, bot] of known) {
      out.push({ kind: "bot-memory", path: this.#canonical(p.join(this.#cloverHome, "bots", folder, "memory")), deny: "caller", ...(this.#bots.includes(bot) ? { bot } : {}) });
    }
    // Enforced ahead of B's contract naming them: the per-user Git whose bash runs Windows hooks (write-denied),
    // and the runtime's transcript store (write-denied: runners never write a transcript; the home default-deny
    // already keeps their reads out, while the core and the user's own surfaces still reach it).
    const pending = pendingFenced({ home: this.#home, cloverHome: this.#cloverHome, os: this.os });
    const aheadDeny: Record<string, "write" | "read-write"> = { "hook-shell": "write", "session-transcripts": "write" };
    for (const kind of this.#enforceAhead ? ENFORCED_AHEAD : []) {
      for (const path of (this.#layout as Record<string, string[] | undefined>)[kind] ?? pending[kind] ?? []) {
        out.push({ kind: kind as FencedKind, path: this.#canonical(path), deny: aheadDeny[kind]! });
      }
    }
    return out;
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
      // A drive-relative path (`C:name`) resolves against that drive's own current folder, which this process
      // doesn't track the way the opener does (#205's check 3): refused.
      if (/^[A-Za-z]:(?![\\/])/.test(local)) return null;
      // A share on this computer (localhost, a loopback address, its own names) reaches its disk past every drive
      // path the fence names, and an admin share (`C$`) anywhere does too (the controller's ruling): refused.
      if (isRefusedShare(local)) return null;
      path = local;
    }
    try {
      const linksFirst = this.#canonical(path);
      const textual = this.#canonical((this.os === "windows" ? win32 : posix).normalize(path));
      const forms = linksFirst === textual ? [linksFirst] : [linksFirst, textual];
      // On a real Windows disk every form judged is a drive path or a \\server\share path (#205's check 2).
      if (this.os === "windows" && isWindowsDiskForm(this.#cloverHome) && !forms.every(isWindowsDiskForm)) return null;
      if (this.os === "windows" && forms.some((f) => isRefusedShare(f))) return null;
      return forms;
    } catch { return null; } // more links than the walk follows (`TooManyLinks`): refused
  }

  check(op: FenceOp, ctx?: FenceContext): FenceVerdict {
    const write = op.op === "write" || op.op === "delete" || op.op === "move";
    const all: string[] = [];
    for (const raw of op.op === "move" ? [op.path, op.to] : [op.path]) {
      const forms = this.#forms(raw);
      if (forms === null) return { allowed: false, reason: "clover-home", path: this.#cloverHome };
      all.push(...forms);
    }
    // B's shared `judge`: the fenced kinds, then the home default-deny, folded on every OS. Each folded item maps
    // back to its own; the pattern roots (`bots/<x>/memory`, `sessions-runtime`) come back in the home's own form.
    const set = this.fencedSet();
    for (const p of all) {
      const v = judge(set, { op: write ? "write" : "read", path: p }, { os: this.os, cloverHome: this.#cloverHome, ...(ctx ? { caller: ctx } : {}) });
      if (v.allowed) continue;
      // A pattern verdict's root comes back in the home's own form (backslashes on Windows, unless the home is
      // POSIX-style, as the conformance suite writes every OS's paths).
      if (v.reason === "bot-memory" || v.reason === "sessions-runtime") {
        const at = patternItemAt(p, this.#cloverHome, this.os);
        if (at?.kind === "bot-memory") {
          const root = at.inside ? joinHome(this.#cloverHome, this.os, "bots", at.folder, "memory") : joinHome(this.#cloverHome, this.os, "bots", at.folder);
          return { allowed: false, reason: v.reason, path: root };
        }
        if (at?.kind === "sessions-runtime") return { allowed: false, reason: v.reason, path: joinHome(this.#cloverHome, this.os, "sessions-runtime") };
      }
      return v;
    }
    for (const p of all) {
      const linked = this.#hardLinked(p, !write);
      if (linked) return { allowed: false, reason: linked.kind, path: linked.path };
    }
    const fenced = set.map((i) => i.path);
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
    for (const raw of paths) for (const form of this.#forms(raw) ?? [this.#cloverHome]) {
      // The pattern items first, by where the path is, whatever list of bots or sessions is known.
      const at = patternItemAt(form, this.#cloverHome, this.os);
      if (at?.kind === "bot-memory") {
        const root = at.inside ? joinHome(this.#cloverHome, this.os, "bots", at.folder, "memory") : joinHome(this.#cloverHome, this.os, "bots", at.folder);
        return { kind: "bot-memory", path: root, deny: "caller" };
      }
      if (at?.kind === "sessions-runtime") return { kind: "sessions-runtime", path: joinHome(this.#cloverHome, this.os, "sessions-runtime"), deny: "read-write" };
      for (const item of this.fencedSet()) {
        if (item.deny === "caller") continue; // judged by its pattern above
        if (inside(form, item.path, this.os) || inside(item.path, form, this.os)) return item;
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
    if (inside(home, r, this.os) || inside(r, home, this.os)) return { allowed: false, reason: "clover-home", path: this.#cloverHome };
    for (const dev of this.#layout["dev-folders"] ?? this.#devFolders) {
      const d = this.#fold(this.#canonical(dev));
      if (inside(d, r, this.os) || inside(r, d, this.os)) return { allowed: false, reason: "dev-folders", path: this.#canonical(dev) };
    }
    for (const item of this.fencedSet()) {
      if (item.kind === "dev-folders") continue;
      const f = this.#fold(item.path);
      if (inside(f, r, this.os) || inside(r, f, this.os)) return { allowed: false, reason: item.kind, path: item.path };
    }
    return { allowed: true };
  }

  policy(ctx?: FenceContext): SandboxPolicy {
    // The whole Clover home, for every runner (the home default-deny); its `own…` folders are the ways back in.
    // The `caller` items (`bot-memory`) stay out of the deny lists: the pattern, and the `own…` allows, rule them.
    const set = this.fencedSet().filter((i) => i.deny !== "caller");
    return {
      allowWrite: [this.#home, this.#temp],
      denyWrite: [...set.map((i) => i.path), this.#cloverHome],
      denyRead: [...set.filter((i) => i.deny === "read-write").map((i) => i.path), this.#cloverHome],
      ...ownFoldersOf(ctx, this.#cloverHome),
      closedDoors: [...CLOSED_DOORS[this.os]],
      // The cloud metadata address first, then the browser filter's ports on both loopbacks (`host:port`).
      blockedAddresses: [...CLOUD_METADATA_ADDRESSES, ...this.#loopbackPorts().flatMap((port) => [`127.0.0.1:${port}`, `[::1]:${port}`])],
      network: "none",
    };
  }

  /** The fence as one caller meets it (B's `Fence.forCaller`): the caller's context, then the same rules. */
  forCaller(caller: Caller): CallerFence {
    const context = fenceContextFor(caller);
    const base = this;
    return {
      os: base.os,
      context,
      fencedSet: () => base.fencedSet(),
      touches: (paths: readonly string[]) => base.touches(paths),
      checkAgentRoot: (root: string) => base.checkAgentRoot(root),
      check: (op: FenceOp) => base.check(op, context),
      policy: () => base.policy(context),
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

/** Join under the Clover home in the home's own form (backslashes on Windows, unless the home is POSIX-style). */
function joinHome(cloverHome: string, os: Os, ...parts: string[]): string {
  const p = os === "windows" && !cloverHome.startsWith("/") ? win32 : posix;
  return p.join(cloverHome, ...parts);
}

/** `isInside` over folded, `/`-separated paths (a Windows drive path has no leading `/`; `..` stays to `judge`). */
function inside(path: string, root: string, os: Os): boolean {
  const p = foldPath(path, os), r = foldPath(root, os);
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

/** The names this computer answers to on a share path: localhost, loopback addresses, its NetBIOS and DNS names. */
function thisComputersNames(): Set<string> {
  const os = require("node:os") as typeof import("node:os");
  const names = new Set(["localhost", ".", "::1", "0:0:0:0:0:0:0:1", "[::1]"]);
  const host = os.hostname().toLowerCase();
  names.add(host);
  names.add(host.split(".")[0]!);
  const cn = process.env.COMPUTERNAME?.toLowerCase();
  if (cn) names.add(cn);
  const dns = process.env.USERDNSDOMAIN?.toLowerCase();
  if (cn && dns) names.add(`${cn}.${dns}`);
  for (const addrs of Object.values(os.networkInterfaces())) for (const a of addrs ?? []) names.add(a.address.toLowerCase());
  return names;
}

/** A `\\server\share` path to an admin share (`X$`, anywhere), or to any share on this computer (#205's check 3). */
export function isRefusedShare(p: string, names: () => Set<string> = thisComputersNames): boolean {
  const m = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(p);
  if (!m) return false;
  const server = unmapIpv4(m[1]!.toLowerCase().replace(/^\[|\]$/g, "")), share = m[2]!;
  if (share.endsWith("$")) return true;
  if (/^127\./.test(server) || server.endsWith(".ipv6-literal.net") || server === "localhost" || server.startsWith("localhost.")) return true;
  return names().has(server);
}

/** An IPv4-mapped IPv6 address (`::ffff:192.168.1.5`, `::ffff:c0a8:105`, `0:0:0:0:0:ffff:…`) as the IPv4 address it
 *  maps, so a mapped form of one of this computer's addresses is known by the same name (#205's check 4 note). */
export function unmapIpv4(server: string): string {
  const m = /^(?:0{0,4}:){1,6}ffff:(.+)$/.exec(server);
  if (!m) return server;
  const tail = m[1]!;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (!hex) return server;
  const a = parseInt(hex[1]!, 16), b = parseInt(hex[2]!, 16);
  return [a >> 8, a & 255, b >> 8, b & 255].join(".");
}
