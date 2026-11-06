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
import { Listeners, type Unsubscribe } from "../contracts/common";
import {
  CLOSED_DOORS, CLOUD_METADATA_ADDRESSES, judge, READ_DENIED_KINDS,
  type Fence, type FenceOp, type FencedKind, type FencedPath, type FenceVerdict, type SandboxPolicy,
} from "../contracts/fence";
import { canonicalPath } from "./canonical";
import { foldPath, nonAsciiAlias } from "./fold";
import { fenceLayout, type LaidOutKind } from "./layout";

export interface CloverFenceOptions {
  os?: Os;
  /** The user's home folder: commands may write in it (§9.1). */
  home: string;
  /** This computer's Clover home. */
  cloverHome: string;
  temp?: string;
  devFolders?: string[];
  /** Replaces the layout for some items (tests). */
  layout?: Partial<Record<FencedKind, string[]>>;
  /** The Clover Browser's SOCKS5 filter's loopback ports (lane L's `DaemonBrowser.filterPorts()`): unauthenticated, since
   *  Chromium sends no SOCKS credentials, so no fenced command may reach them. L's filter takes connections only from
   *  the browser's own network process; this is the second layer. */
  loopbackPorts?: () => readonly number[];
  /** How a path is resolved on this disk; the conformance suite's paths are fictional, so it passes its own. */
  canonical?: (path: string) => string;
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
  #devFolders: string[];

  constructor(opts: CloverFenceOptions) {
    this.os = opts.os ?? osOf();
    this.#canonical = opts.canonical ?? ((p) => canonicalPath(p));
    this.#home = this.#canonical(opts.home);
    this.#cloverHome = this.#canonical(opts.cloverHome);
    this.#temp = this.#canonical(opts.temp ?? (this.os === "windows" ? win32.join(opts.home, "AppData", "Local", "Temp") : "/tmp"));
    this.#devFolders = (opts.devFolders ?? []).map((p) => this.#canonical(p));
    this.#layout = opts.layout ?? {};
    this.#loopbackPorts = opts.loopbackPorts ?? (() => []);
  }

  fencedSet(): readonly FencedPath[] {
    const out: FencedPath[] = [];
    const add = (kind: FencedKind, path: string) =>
      out.push({ kind, path: this.#canonical(path), deny: READ_DENIED_KINDS.includes(kind) ? "read-write" : "write" });
    for (const [kind, paths] of Object.entries(fenceLayout(this.#cloverHome, this.os)) as [LaidOutKind, string[]][]) {
      for (const p of this.#layout[kind] ?? paths) add(kind, p);
    }
    for (const p of this.#layout["dev-folders"] ?? this.#devFolders) add("dev-folders", p);
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

  #fold(path: string): string {
    // `judge` and `isInside` are POSIX: a Windows path is compared as `c:/users/...`, which they take as relative.
    return foldPath(path, this.os);
  }

  check(op: FenceOp): FenceVerdict {
    const paths = op.op === "move" ? [op.path, op.to] : [op.path];
    const canonical = paths.map((p) => this.#canonical(p));
    // The folded item first, so a name that folds onto one (`ſettings`) is refused as that item; then a hard link to
    // one; then a name that isn't ASCII where Clover names things, whatever it folds to (B's contract, #179's F1).
    const { set, back } = this.#folded();
    const folded: FenceOp = op.op === "move"
      ? { op: "move", path: this.#fold(canonical[0]!), to: this.#fold(canonical[1]!) }
      : { op: op.op, path: this.#fold(canonical[0]!) } as FenceOp;
    const v = judge(set, folded);
    if (!v.allowed) {
      const item = back.get(v.path);
      return { allowed: false, reason: v.reason, path: item?.path ?? v.path };
    }
    if (op.op !== "read" && op.op !== "list" && op.op !== "stat") {
      const linked = this.#hardLinked(canonical[0]!);
      if (linked) return { allowed: false, reason: linked.kind, path: linked.path };
    }
    const fenced = this.fencedSet().map((i) => i.path);
    for (const p of canonical) {
      if (nonAsciiAlias(p, fenced, this.#cloverHome, this.os) !== null) return { allowed: false, reason: "clover-home", path: this.#cloverHome };
    }
    return { allowed: true };
  }

  /** The fenced item a file with more than one link shares its inode with; also every fenced item when the set
   *  holds more files than `HARD_LINK_SCAN_LIMIT` (it can't be told, so it's refused). */
  #hardLinked(path: string): FencedPath | null {
    let st: BigIntStats;
    try { st = lstatSync(path, { bigint: true }); } catch { return null; }
    if (!st.isFile() || st.nlink < 2n) return null;
    const key = `${st.dev}:${st.ino}`;
    let seen = 0;
    for (const item of this.fencedSet()) {
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
    for (const raw of paths) {
      const p = this.#fold(this.#canonical(raw));
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
    const r = this.#fold(this.#canonical(root));
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

  policy(): SandboxPolicy {
    const set = this.fencedSet();
    return {
      allowWrite: [this.#home, this.#temp],
      denyWrite: set.map((i) => i.path),
      denyRead: set.filter((i) => i.deny === "read-write").map((i) => i.path),
      closedDoors: [...CLOSED_DOORS[this.os]],
      // The cloud metadata address first, then the browser filter's ports on both loopbacks (`host:port`).
      blockedAddresses: [...CLOUD_METADATA_ADDRESSES, ...this.#loopbackPorts().flatMap((port) => [`127.0.0.1:${port}`, `[::1]:${port}`])],
      network: "none",
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
