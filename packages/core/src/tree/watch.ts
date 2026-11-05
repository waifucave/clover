// Change events for a folder of the tree: what a code session's Files panel shows fresh (the owner's item 88: the
// Files panel exists only in code sessions, rooted at the session's folder; its data comes from the holder).
//
// The holder watches the folder on its own disk and says which tree paths changed, coalesced; the panel drops what it
// cached for them and lists again. A watch that fails (an inotify limit, the folder replaced) says `resync` and is
// armed again with backoff, since changes made while it was down were never reported (S6 review S3). Each computer
// that watches here has its own budget of folders, and this computer watches a bounded number in all; a code session's
// folder is one, never a whole home or a bot's whole folder (the holder refuses those; J-M1 review minor 2).
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { sep } from "node:path";
import type { Unsubscribe } from "../contracts/common";
import { ContractError } from "../contracts/common";

export type TreeWatchEvent = { type: "changed"; paths: string[] } | { type: "resync" };

/** The most watches one watcher (this computer's own app, or one other computer) holds here at once. */
export const WATCH_BUDGET = 64;
/** The most folders this computer watches at once, for everyone. */
export const WATCH_TOTAL = 256;
/** Changes inside this window are reported together. */
const COALESCE_MS = 50;
/** The most paths one event names; more says `resync`. */
const EVENT_PATHS_MAX = 512;

interface Watched {
  real: string;
  watcher: FSWatcher | null;
  subscribers: Set<{ treeRoot: string; visible: (realChild: string) => boolean; fn: (e: TreeWatchEvent) => void }>;
  pending: Set<string>;
  flush: ReturnType<typeof setTimeout> | null;
  retry: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
}

/** One computer's watches, shared by everyone who watches the same real folder. */
export class FolderWatches {
  readonly #watched = new Map<string, Watched>();
  /** Watches held, by watcher. */
  readonly #held = new Map<string, number>();
  readonly #budget: number;
  readonly #total: number;
  readonly #watchFn: typeof fsWatch;

  constructor(opts: { budget?: number; total?: number; watch?: typeof fsWatch } = {}) {
    this.#budget = opts.budget ?? WATCH_BUDGET;
    this.#total = opts.total ?? WATCH_TOTAL;
    this.#watchFn = opts.watch ?? fsWatch;
  }

  /** Watches `real` (a folder's real path) for a subscriber who sees it as `treeRoot`. `visible` hides what the
   *  subscriber's fence keeps from it. */
  subscribe(real: string, treeRoot: string, visible: (realChild: string) => boolean, fn: (e: TreeWatchEvent) => void, watcher = "local"): Unsubscribe {
    const held = this.#held.get(watcher) ?? 0;
    if (held >= this.#budget) throw new ContractError("refused", `you already watch ${this.#budget} folders on this computer`);
    let w = this.#watched.get(real);
    if (!w) {
      if (this.#watched.size >= this.#total) throw new ContractError("refused", `this computer already watches ${this.#total} folders`);
      w = { real, watcher: null, subscribers: new Set(), pending: new Set(), flush: null, retry: null, backoffMs: 500 };
      this.#watched.set(real, w);
      this.#arm(w);
    }
    const sub = { treeRoot: treeRoot.replace(/\/+$/, ""), visible, fn };
    w.subscribers.add(sub);
    this.#held.set(watcher, held + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.#held.get(watcher) ?? 1) - 1;
      if (n <= 0) this.#held.delete(watcher);
      else this.#held.set(watcher, n);
      w!.subscribers.delete(sub);
      if (w!.subscribers.size === 0) this.#drop(w!);
    };
  }

  get size(): number {
    return this.#watched.size;
  }

  close(): void {
    for (const w of [...this.#watched.values()]) this.#drop(w);
  }

  #arm(w: Watched): void {
    try {
      w.watcher = this.#watchFn(w.real, { recursive: true }, (_event, filename) => {
        if (filename == null) {
          this.#queue(w, null);
          return;
        }
        this.#queue(w, String(filename));
      });
      w.watcher.on("error", () => this.#rearm(w));
      w.backoffMs = 500;
    } catch {
      this.#rearm(w);
    }
  }

  /** The watch failed: every subscriber hears `resync`, and it is armed again later. */
  #rearm(w: Watched): void {
    try {
      w.watcher?.close();
    } catch {
      // already closed
    }
    w.watcher = null;
    for (const s of [...w.subscribers]) s.fn({ type: "resync" });
    if (w.retry || !this.#watched.has(w.real)) return;
    w.retry = setTimeout(() => {
      w.retry = null;
      if (!this.#watched.has(w.real)) return;
      this.#arm(w);
      if (w.watcher) for (const s of [...w.subscribers]) s.fn({ type: "resync" });
    }, w.backoffMs);
    w.retry.unref?.();
    w.backoffMs = Math.min(w.backoffMs * 2, 30_000);
  }

  #queue(w: Watched, rel: string | null): void {
    if (rel === null || w.pending.size >= EVENT_PATHS_MAX) w.pending.add("\0resync");
    else w.pending.add(rel);
    if (w.flush) return;
    w.flush = setTimeout(() => {
      w.flush = null;
      const rels = [...w.pending];
      w.pending.clear();
      const resync = rels.includes("\0resync");
      for (const s of [...w.subscribers]) {
        if (resync) {
          s.fn({ type: "resync" });
          continue;
        }
        const paths: string[] = [];
        for (const rel of rels) {
          const real = `${w.real}${sep}${rel}`;
          if (!s.visible(real)) continue;
          paths.push(`${s.treeRoot}/${rel.split(sep).join("/")}`);
        }
        if (paths.length > 0) s.fn({ type: "changed", paths: paths.sort() });
      }
    }, COALESCE_MS);
    w.flush.unref?.();
  }

  #drop(w: Watched): void {
    this.#watched.delete(w.real);
    if (w.flush) clearTimeout(w.flush);
    if (w.retry) clearTimeout(w.retry);
    try {
      w.watcher?.close();
    } catch {
      // already closed
    }
    w.watcher = null;
  }
}
