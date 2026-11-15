// The plugin index client (spec §5.1 "Indexes and npm"; the owner's ruling, 2026-11-13): the indexes a user installs
// from, each a plain JSON file (`IndexSchema`, format 1) the user added by its https URL. There is no official index and
// nothing is signed: what a plugin may do is decided on its OK card, and a download must match the tree hash its index
// lists (`install.ts`).
//
// * Offline: a fetch that fails keeps the last good copy, however old (an offline user keeps his plugins), cached in
//   the fenced `plugins-state/index-cache/`.
// * 18+ (§5.7, the controller's ruling F): an entry marked adult is hidden from search until the user has confirmed
//   they are 18 or older; after that it shows, marked.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compareVersions, IndexSchema, parseVersion, type IndexFile } from "@waifucave/clover-plugin-sdk";
import { ContractError } from "../../contracts/common";
import { pinnedFetch, type PlatformFetch } from "../../plugin-host/pinned-fetch";
import { emptyIndexesState, type IndexesStateFile, type LeftByRecord, type RegistryStore } from "../state";

/** The largest index file read. */
export const INDEX_MAX_BYTES = 32 * 1024 * 1024;
/** How long one fetch may take, the whole body included. */
export const INDEX_FETCH_TIMEOUT_MS = 30_000;
/** The most indexes a user may add. */
export const MAX_ADDED_INDEXES = 64;

/** Fetches one URL's bytes, at most `maxBytes`, or throws. */
export type IndexFetch = (url: string, maxBytes: number, signal?: AbortSignal, headers?: Readonly<Record<string, string>>) => Promise<Uint8Array>;

/** Semver order of two version strings (the schema checked each). */
export const byVersion = (a: string, b: string): number => compareVersions(parseVersion(a)!, parseVersion(b)!);
const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

/** An https URL, or why not: an index and its downloads come over TLS only. */
export function httpsUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ContractError("invalid", `${JSON.stringify(raw.slice(0, 200))} isn't a URL`);
  }
  if (u.protocol !== "https:") throw new ContractError("invalid", "an index's address is an https URL");
  if (u.username !== "" || u.password !== "") throw new ContractError("invalid", "an index's address carries no user name or password");
  u.hash = "";
  return u.href;
}

/** The most redirects one fetch follows. */
export const MAX_HOPS = 5;

/** The default fetch (index files and npm metadata: 30 s each phase and in all): through the pinned fetch (#428: each name resolved once and connected to by the address checked,
 *  public addresses only, never an environment proxy), following redirects by hand so every hop is checked the same
 *  way and stays on https. A URL inside an index (a download) or a redirect can't point the daemon at this computer or the
 *  LAN. The body is read up to `maxBytes`, within the time. Tests pass their own
 *  `platform` (the pinned fetch's seam); production never does. */
export function httpsFetch(limits: number | FetchLimits = INDEX_FETCH_TIMEOUT_MS, platform: PlatformFetch = pinnedFetch()): IndexFetch {
  const l: Required<FetchLimits> = typeof limits === "number"
    ? { headersMs: limits, stallMs: limits, totalMs: limits }
    : { headersMs: limits.headersMs ?? INDEX_FETCH_TIMEOUT_MS, stallMs: limits.stallMs ?? INDEX_FETCH_TIMEOUT_MS, totalMs: limits.totalMs ?? INDEX_FETCH_TIMEOUT_MS };
  return async (url, maxBytes, signal, headers) => {
    // One controller for the whole fetch: the overall cap, the caller's signal, and the phase limits below abort it.
    const ctl = new AbortController();
    const fail = (why: string) => ctl.abort(new Error(why));
    const total = setTimeout(() => fail(`it took longer than ${Math.round(l.totalMs / 1000)} s`), l.totalMs);
    const onAbort = () => fail("it was cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    let phase: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number, why: string) => {
      if (phase !== undefined) clearTimeout(phase);
      phase = setTimeout(() => fail(why), ms);
    };
    const reason = (err: unknown): Error => (ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : err instanceof Error ? err : new Error(String(err)));
    try {
      let at = httpsUrl(url);
      let res: Response | undefined;
      for (let hop = 0; ; hop++) {
        // Up to its headers, each hop within `headersMs`.
        arm(l.headersMs, `it sent no answer within ${Math.round(l.headersMs / 1000)} s`);
        res = await platform(at, { redirect: "manual", signal: ctl.signal, ...(headers !== undefined ? { headers: { ...headers } } : {}) });
        if (res.status < 300 || res.status >= 400) break;
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (location === null) throw new Error(`it answered ${res.status} with nowhere to go`);
        if (hop + 1 > MAX_HOPS) throw new Error(`it redirected more than ${MAX_HOPS} times`);
        let next: URL;
        try {
          next = new URL(location, at);
        } catch {
          throw new Error("it redirected to something that isn't a URL");
        }
        if (next.protocol !== "https:") throw new Error("it redirected off https");
        at = httpsUrl(next.href);
      }
      if (!res.ok) throw new Error(`it answered ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? "NaN");
      if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`it is larger than ${maxBytes} bytes`);
      const reader = res.body?.getReader();
      if (reader === undefined) return new Uint8Array();
      // The body: no gap longer than `stallMs` between chunks, within the overall cap and the byte cap.
      const stalled = new Promise<never>((_, reject) => ctl.signal.addEventListener("abort", () => reject(reason(undefined)), { once: true }));
      stalled.catch(() => undefined);
      const parts: Uint8Array[] = [];
      let got = 0;
      try {
        for (;;) {
          arm(l.stallMs, `it sent nothing for ${Math.round(l.stallMs / 1000)} s`);
          const { done, value } = await Promise.race([reader.read(), stalled]);
          if (done) break;
          got += value.byteLength;
          if (got > maxBytes) throw new Error(`it is larger than ${maxBytes} bytes`);
          parts.push(value);
        }
      } catch (err) {
        await reader.cancel().catch(() => undefined);
        throw err;
      }
      const out = new Uint8Array(got);
      let off = 0;
      for (const p of parts) {
        out.set(p, off);
        off += p.byteLength;
      }
      return out;
    } catch (err) {
      throw reason(err);
    } finally {
      clearTimeout(total);
      if (phase !== undefined) clearTimeout(phase);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

/** A fetch's limits: to the response headers (each hop), the longest gap between body chunks, and the whole. */
export interface FetchLimits {
  headersMs?: number;
  stallMs?: number;
  totalMs?: number;
}

/** A plugin download's limits (the review of step 3): its headers within 30 s, then no gap over 30 s, and the whole
 *  within 30 minutes, sized for the 256 MiB cap on a slow line (about 150 KB/s). */
export const DOWNLOAD_LIMITS: Required<FetchLimits> = { headersMs: 30_000, stallMs: 30_000, totalMs: 30 * 60_000 };

/** One index as the client holds it. */
interface Held {
  url: string;
  file?: IndexFile;
  /** The last fetch's failure, kept until one succeeds. */
  error?: string;
}

export interface IndexClientOptions {
  store: Pick<RegistryStore, "loadIndexes" | "saveIndexes">;
  /** Where the last good copies are kept (`plugins-state/index-cache/`). */
  cacheDir: string;
  fetch?: IndexFetch;
  /** The fetch for plugin downloads; default the pinned https fetch with `DOWNLOAD_LIMITS` (or `fetch` when a test
   *  gives one). */
  download?: IndexFetch;
  now?: () => number;
  log?: (line: string) => void;
}

/** What the plugin index browser lists for one plugin. */
export interface IndexEntry {
  id: string;
  index: string;
  name?: IndexFile["plugins"][number]["name"];
  description?: IndexFile["plugins"][number]["description"];
  versions: { version: string; hash: string; url: string }[];
  adult?: boolean;
}

export class IndexClient {
  readonly #o: IndexClientOptions;
  readonly #fetch: IndexFetch;
  readonly #download: IndexFetch;
  readonly #now: () => number;
  #state: IndexesStateFile;
  readonly #held = new Map<string, Held>();
  /** Each index's fetches run one at a time. */
  readonly #chain = new Map<string, Promise<unknown>>();

  constructor(o: IndexClientOptions) {
    this.#o = o;
    this.#fetch = o.fetch ?? httpsFetch();
    this.#download = o.download ?? o.fetch ?? httpsFetch(DOWNLOAD_LIMITS);
    this.#now = o.now ?? Date.now;
    this.#state = o.store.loadIndexes?.() ?? emptyIndexesState();
    for (const a of this.#state.added) this.#held.set(a.url, { url: a.url });
  }

  /** The indexes the user added, in the order added. */
  urls(): string[] {
    return this.#state.added.map((a) => a.url);
  }

  /** The index at `url`, as last read. */
  index(url: string): IndexFile | undefined {
    return this.#held.get(url)?.file;
  }

  #cachePath(url: string): string {
    return join(this.#o.cacheDir, `${sha256(`index:${url}`)}.json`);
  }

  /** Reads an index's bytes: JSON, then its schema. Throws why not. */
  static parse(bytes: Uint8Array): IndexFile {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error("it isn't JSON");
    }
    const r = IndexSchema.safeParse(parsed);
    if (!r.success) throw new Error(`it isn't a plugin index Clover reads (${r.error.issues[0]?.message ?? "invalid"})`);
    return r.data;
  }

  /** Fetches one index and keeps it as the last good copy. Throws why not; the last good copy stays. */
  async #fetchIndex(url: string, signal?: AbortSignal): Promise<IndexFile> {
    const run = (this.#chain.get(url) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const bytes = await this.#fetch(url, INDEX_MAX_BYTES, signal);
      const file = IndexClient.parse(bytes);
      const path = this.#cachePath(url);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, bytes, { mode: 0o600 });
      renameSync(tmp, path);
      this.#state = { ...this.#state, checked: { ...(this.#state.checked ?? {}), [url]: this.#now() } };
      this.#o.store.saveIndexes?.(this.#state);
      return file;
    });
    this.#chain.set(url, run);
    return run;
  }

  /** Fetches one file (https, the pinned fetch, the index limits): npm's package metadata. */
  fetchBytes(url: string, maxBytes: number, signal?: AbortSignal, headers?: Readonly<Record<string, string>>): Promise<Uint8Array> {
    return this.#fetch(httpsUrl(url), maxBytes, signal, headers);
  }

  /** Downloads a plugin version (https, at most `maxBytes`), through the same fetch as the indexes. */
  download(url: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.#download(httpsUrl(url), maxBytes, signal);
  }

  /** Reads every index's last good copy (at start). */
  loadCached(): void {
    for (const [url, h] of this.#held) {
      try {
        h.file = IndexClient.parse(readFileSync(this.#cachePath(url)));
      } catch {
        // None kept yet, or it no longer reads: the next fetch brings one.
      }
    }
  }

  /** Fetches one index, or all; a failure is kept on it, with its last good copy. Never throws. */
  async refresh(url?: string, signal?: AbortSignal): Promise<void> {
    const targets = url === undefined ? [...this.#held.values()] : [this.#held.get(url)].filter((h): h is Held => h !== undefined);
    await Promise.all(targets.map(async (h) => {
      try {
        h.file = await this.#fetchIndex(h.url, signal);
        delete h.error;
      } catch (err) {
        h.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        this.#o.log?.(`plugin index ${h.url}: ${h.error}`);
      }
    }));
  }

  /** The indexes for Settings, in the order added. */
  list(): { url: string; name?: string; lastCheckedAt?: number; error?: string }[] {
    return this.urls().map((url) => {
      const h = this.#held.get(url);
      const at = this.#state.checked?.[url];
      return {
        url,
        ...(h?.file !== undefined ? { name: h.file.name } : {}),
        ...(at !== undefined ? { lastCheckedAt: at } : {}),
        ...(h?.error !== undefined ? { error: h.error } : {}),
      };
    });
  }

  /** Adds an index by its https URL; gives back the URL as kept. Throws `invalid`, `conflict` or `refused`. */
  add(rawUrl: string): string {
    const url = httpsUrl(rawUrl);
    if (this.#state.added.some((a) => a.url === url)) throw new ContractError("conflict", `${url} is added already`);
    if (this.#state.added.length >= MAX_ADDED_INDEXES) throw new ContractError("refused", `at most ${MAX_ADDED_INDEXES} indexes can be added`);
    this.#state = { ...this.#state, added: [...this.#state.added, { url, addedAt: this.#now() }] };
    this.#o.store.saveIndexes?.(this.#state);
    this.#held.set(url, { url });
    return url;
  }

  /** Whether the user pinned this plugin to its version here (`plugin.pin`): it isn't offered updates. */
  isPinned(id: string): boolean {
    return (this.#state.pinned ?? []).includes(id);
  }

  /** Pins a plugin to its version on this computer, or lets it be offered updates again. */
  setPinned(id: string, pinned: boolean): void {
    if (this.isPinned(id) === pinned) return;
    const now = new Set(this.#state.pinned ?? []);
    if (pinned) now.add(id);
    else now.delete(id);
    this.#state = { ...this.#state, pinned: [...now].sort() };
    this.#o.store.saveIndexes?.(this.#state);
  }

  /** What a plugin whose folder went without `plugin.remove` was (`leftovers.ts`). */
  leftBy(id: string): LeftByRecord | undefined {
    return this.#state.leftBy?.[id];
  }

  setLeftBy(id: string, rec: LeftByRecord | undefined): void {
    const leftBy = { ...(this.#state.leftBy ?? {}) };
    if (rec === undefined) delete leftBy[id];
    else leftBy[id] = rec;
    this.#state = { ...this.#state, leftBy };
    this.#o.store.saveIndexes?.(this.#state);
  }

  /** The updates coming up (`indexes/update.ts`), as kept in the MAC'd state. */
  updating(): Readonly<NonNullable<IndexesStateFile["updating"]>> {
    return this.#state.updating ?? {};
  }

  setUpdating(id: string, kept: NonNullable<IndexesStateFile["updating"]>[string] | undefined): void {
    const updating = { ...(this.#state.updating ?? {}) };
    if (kept === undefined) delete updating[id];
    else updating[id] = kept;
    this.#state = { ...this.#state, updating };
    this.#o.store.saveIndexes?.(this.#state);
  }

  /** Removes an index the user added. */
  remove(rawUrl: string): void {
    const url = httpsUrl(rawUrl);
    if (!this.#state.added.some((a) => a.url === url)) throw new ContractError("not_found", `${url} isn't one of your indexes`);
    const checked = { ...(this.#state.checked ?? {}) };
    delete checked[url];
    this.#state = { ...this.#state, added: this.#state.added.filter((a) => a.url !== url), checked };
    this.#o.store.saveIndexes?.(this.#state);
    this.#held.delete(url);
  }

  /** Every index's entries matching `query` (the id, name or description, any case), in the order the indexes were
   *  added; an adult entry only once the user has confirmed 18+, marked. */
  search(o: { query?: string; limit?: number; adultConfirmed: boolean }): IndexEntry[] {
    const q = (o.query ?? "").trim().toLowerCase();
    const text = (t: unknown): string => (typeof t === "string" ? t : t !== null && typeof t === "object" ? Object.values(t as Record<string, string>).join(" ") : "");
    const out: IndexEntry[] = [];
    for (const url of this.urls()) {
      const file = this.#held.get(url)?.file;
      if (file === undefined) continue;
      for (const p of file.plugins) {
        if (p.adult === true && !o.adultConfirmed) continue;
        if (q !== "" && ![p.id, text(p.name), text(p.description)].some((s) => s.toLowerCase().includes(q))) continue;
        out.push({
          id: p.id, index: url,
          ...(p.name !== undefined ? { name: p.name } : {}),
          ...(p.description !== undefined ? { description: p.description } : {}),
          versions: [...p.versions].sort((a, b) => byVersion(b.version, a.version)),
          ...(p.adult === true ? { adult: true } : {}),
        });
        if (out.length >= (o.limit ?? 50)) return out;
      }
    }
    return out;
  }

  /** The version to install of `id`: from `index` when named (else the first index that lists it, in the order added),
   *  `version` when named (else its newest). Adult entries need the user's 18+ confirmation, as in search. */
  find(id: string, o: { version?: string; index?: string; adultConfirmed: boolean }): { index: string; version: string; hash: string; url: string; adult: boolean } | undefined {
    const indexes = o.index !== undefined ? this.urls().filter((u) => u === httpsUrl(o.index!)) : this.urls();
    for (const url of indexes) {
      const p = this.#held.get(url)?.file?.plugins.find((e) => e.id === id);
      if (p === undefined) continue;
      if (p.adult === true && !o.adultConfirmed) return undefined;
      const versions = [...p.versions].sort((a, b) => byVersion(b.version, a.version));
      const v = o.version !== undefined ? versions.find((x) => x.version === o.version) : versions[0];
      if (v !== undefined) return { index: url, version: v.version, hash: v.hash, url: v.url, adult: p.adult === true };
    }
    return undefined;
  }
}

export { IndexSchema, type IndexFile };
