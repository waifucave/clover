// The plugin index client (spec §5.1 "Indexes and npm", §14.2 item 25): the indexes a user installs from, each a signed
// JSON file (`IndexSchema`, format 1) with its Ed25519 signature in `<url>.sig`.
//
// * Trust: the official index (`OFFICIAL_INDEX`, empty until the owner names one) and the ones the user added, each
//   with a LIST of trusted keys, any one of which verifies (a key is rotated by shipping the new one beside the old).
//   A signature is checked strictly (`verifyEd25519`: canonical points, S below the group order) over the file's
//   exact bytes, and only then is the file parsed.
// * Replay (the controller's ruling): each file carries `seq`, which its signer only raises. The highest `seq`
//   accepted per file, with the SHA-256 of the bytes accepted at it, is kept in the registry's MAC'd records
//   (`indexes.json`); a lower `seq`, or the same `seq` with other bytes, is refused. Removing an index keeps its
//   high-water mark, so adding it again can't take an older copy either.
// * Offline: a fetch that fails keeps the last good copy, however old (an offline user keeps his plugins), cached in
//   the fenced `plugins-state/index-cache/` and checked again (signature, hash, `seq`) each time it's read. A copy
//   signed more than 7 days ago is marked stale for Settings. There is no hard expiry.
// * 18+ (§5.7, the controller's ruling F): an entry marked adult is hidden from search until the user has confirmed
//   they are 18 or older; after that it shows, marked.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { z } from "zod";
import { compareVersions, IndexSchema, parseVersion, parseSignatureFile, RevocationsSchema, type IndexFile, type RevocationsFile } from "@waifucave/clover-plugin-sdk";
import { ContractError } from "../../contracts/common";
import { isStrictEd25519Point } from "../../identity/ed25519-strict";
import { verifyEd25519 } from "../../identity/keys";
import { emptyIndexesState, type AcceptedFile, type IndexesStateFile, type RegistryStore } from "../state";
import { OFFICIAL_INDEX, type IndexTrust } from "./official";

/** The largest index file read; a revocation list; a `.sig` file. */
export const INDEX_MAX_BYTES = 32 * 1024 * 1024;
export const REVOCATIONS_MAX_BYTES = 16 * 1024 * 1024;
export const SIGNATURE_MAX_BYTES = 1024;
/** How long one fetch may take, the whole body included. */
export const INDEX_FETCH_TIMEOUT_MS = 30_000;
/** A copy signed longer ago than this is shown as stale (the controller's ruling D). */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** The most indexes a user may add. */
export const MAX_ADDED_INDEXES = 64;

/** Fetches one URL's bytes, at most `maxBytes`, or throws. */
export type SignedFetch = (url: string, maxBytes: number, signal?: AbortSignal) => Promise<Uint8Array>;

const HEX64 = /^[0-9a-f]{64}$/;
/** Semver order of two version strings (the schema checked each). */
export const byVersion = (a: string, b: string): number => compareVersions(parseVersion(a)!, parseVersion(b)!);
const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

/** The `.sig` file beside a signed file: the same URL with `.sig` added to its path. */
export function signatureUrl(url: string): string {
  const u = new URL(url);
  u.pathname = `${u.pathname}.sig`;
  return u.href;
}

/** An https URL, or why not: an index and its lists come over TLS only (their signature holds their bytes; TLS keeps
 *  what the user browses private). */
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

/** The default fetch: https only (a redirect elsewhere is refused), the body read up to `maxBytes`, within the time. */
export function httpsFetch(timeoutMs = INDEX_FETCH_TIMEOUT_MS): SignedFetch {
  return async (url, maxBytes, signal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(httpsUrl(url), { redirect: "follow", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.url.startsWith("https:")) throw new Error("it redirected off https");
    if (!res.ok) throw new Error(`it answered ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`it is larger than ${maxBytes} bytes`);
    const reader = res.body?.getReader();
    if (reader === undefined) return new Uint8Array();
    const parts: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      if (got > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`it is larger than ${maxBytes} bytes`);
      }
      parts.push(value);
    }
    const out = new Uint8Array(got);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return out;
  };
}

/** Whether `sigText` (a `.sig` file) is a signature over `bytes` by one of `keys` (hex). */
export function verifySigned(bytes: Uint8Array, sigText: string, keys: readonly string[]): boolean {
  const sig = parseSignatureFile(sigText);
  if (sig === null) return false;
  return keys.some((k) => HEX64.test(k) && verifyEd25519(Buffer.from(k, "hex"), bytes, sig));
}

export type SignedKind = "index" | "revocations";

/** One index as the client holds it. */
interface Held {
  trust: IndexTrust & { official: boolean };
  file?: IndexFile;
  /** The last fetch's failure, kept until one succeeds. */
  error?: string;
}

export interface IndexClientOptions {
  store: Pick<RegistryStore, "loadIndexes" | "saveIndexes">;
  /** Where the last good copies are kept (`plugins-state/index-cache/`). */
  cacheDir: string;
  fetch?: SignedFetch;
  /** The official index; default `OFFICIAL_INDEX` (none until the owner names one). */
  official?: IndexTrust;
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
  readonly #fetch: SignedFetch;
  readonly #now: () => number;
  readonly #official: IndexTrust | undefined;
  #state: IndexesStateFile;
  readonly #held = new Map<string, Held>();
  /** Each file's fetches run one at a time. */
  readonly #chain = new Map<string, Promise<unknown>>();

  constructor(o: IndexClientOptions) {
    this.#o = o;
    this.#fetch = o.fetch ?? httpsFetch();
    this.#now = o.now ?? Date.now;
    this.#official = "official" in o ? o.official : OFFICIAL_INDEX;
    this.#state = o.store.loadIndexes?.() ?? emptyIndexesState();
    for (const t of this.trusts()) this.#held.set(t.url, { trust: t });
  }

  /** The official index first, then the user's, in the order added. */
  trusts(): (IndexTrust & { official: boolean })[] {
    const out: (IndexTrust & { official: boolean })[] = [];
    if (this.#official !== undefined) out.push({ ...this.#official, url: httpsUrl(this.#official.url), official: true });
    for (const a of this.#state.added) if (!out.some((t) => t.url === a.url)) out.push({ url: a.url, keys: a.keys, official: false });
    return out;
  }

  isOfficial(url: string): boolean {
    return this.#official !== undefined && httpsUrl(this.#official.url) === url;
  }

  /** The index at `url`, as last accepted. */
  index(url: string): IndexFile | undefined {
    return this.#held.get(url)?.file;
  }

  // ---- the signed files ----

  #cachePath(kind: SignedKind, url: string): string {
    return join(this.#o.cacheDir, sha256(`${kind}:${url}`));
  }

  /** Accepts one signed file's bytes: signature first, then its schema, then the replay check; kept as the last good
   *  copy, its `seq` raised. Throws why not. */
  accept<T extends { seq: number; issued: string }>(kind: SignedKind, url: string, bytes: Uint8Array, sigText: string, keys: readonly string[], schema: z.ZodType<T>): T {
    if (!verifySigned(bytes, sigText, keys)) throw new Error("its signature isn't by a key it's trusted under");
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error("it isn't JSON");
    }
    const r = schema.safeParse(parsed);
    if (!r.success) throw new Error(`it isn't a ${kind === "index" ? "plugin index" : "revocation list"} Clover reads (${r.error.issues[0]?.message ?? "invalid"})`);
    const file = r.data;
    const hash = sha256(bytes);
    const key = `${kind}:${url}`;
    const seen = this.#state.accepted[key];
    if (seen !== undefined) {
      if (file.seq < seen.seq) throw new Error(`it is older than the copy already taken (seq ${file.seq} < ${seen.seq}), so it isn't taken`);
      if (file.seq === seen.seq && hash !== seen.sha256) throw new Error(`it has the same seq as the copy already taken (${file.seq}) but other contents`);
    }
    const base = this.#cachePath(kind, url);
    mkdirSync(dirname(base), { recursive: true, mode: 0o700 });
    for (const [ext, data] of [[".json", bytes], [".sig", sigText]] as const) {
      const tmp = `${base}${ext}.tmp-${process.pid}`;
      writeFileSync(tmp, data, { mode: 0o600 });
      renameSync(tmp, `${base}${ext}`);
    }
    const accepted: AcceptedFile = { seq: file.seq, sha256: hash, issued: file.issued, checkedAt: this.#now() };
    this.#state = { ...this.#state, accepted: { ...this.#state.accepted, [key]: accepted } };
    this.#o.store.saveIndexes?.(this.#state);
    return file;
  }

  /** The last good copy of a signed file, checked again: the bytes accepted (by hash), still signed by a key it's
   *  trusted under now. Undefined when there is none, or it no longer checks. */
  cached<T>(kind: SignedKind, url: string, keys: readonly string[], schema: z.ZodType<T>): T | undefined {
    const seen = this.#state.accepted[`${kind}:${url}`];
    if (seen === undefined) return undefined;
    const base = this.#cachePath(kind, url);
    let bytes: Buffer;
    let sig: string;
    try {
      bytes = readFileSync(`${base}.json`);
      sig = readFileSync(`${base}.sig`, "utf8");
    } catch {
      return undefined;
    }
    if (sha256(bytes) !== seen.sha256 || !verifySigned(bytes, sig, keys)) {
      this.#o.log?.(`plugin index: the kept copy of ${url} doesn't check, so it isn't used`);
      return undefined;
    }
    try {
      const r = schema.safeParse(JSON.parse(bytes.toString("utf8")));
      return r.success ? r.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Fetches a signed file and its `.sig`, and accepts it. Throws why not; the last good copy stays. */
  async fetchSigned<T extends { seq: number; issued: string }>(kind: SignedKind, url: string, keys: readonly string[], schema: z.ZodType<T>, maxBytes: number, signal?: AbortSignal): Promise<T> {
    const key = `${kind}:${url}`;
    const run = (this.#chain.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const [bytes, sig] = await Promise.all([this.#fetch(url, maxBytes, signal), this.#fetch(signatureUrl(url), SIGNATURE_MAX_BYTES, signal)]);
      return this.accept(kind, url, bytes, new TextDecoder().decode(sig), keys, schema);
    });
    this.#chain.set(key, run);
    return run;
  }

  /** Downloads a plugin version (https, at most `maxBytes`), through the same fetch as the indexes. */
  download(url: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.#fetch(httpsUrl(url), maxBytes, signal);
  }

  /** When a file was last accepted, and whether its copy is stale. */
  acceptedOf(kind: SignedKind, url: string): (AcceptedFile & { stale: boolean }) | undefined {
    const a = this.#state.accepted[`${kind}:${url}`];
    if (a === undefined) return undefined;
    const issued = Date.parse(a.issued);
    return { ...a, stale: Number.isFinite(issued) && this.#now() - issued > STALE_AFTER_MS };
  }

  // ---- indexes ----

  /** Reads every index's last good copy (at start). */
  loadCached(): void {
    for (const [url, h] of this.#held) {
      const file = this.cached("index", url, h.trust.keys, IndexSchema);
      if (file !== undefined) h.file = file;
    }
  }

  /** Fetches one index, or all; a failure is kept on it, with its last good copy. Never throws. */
  async refresh(url?: string, signal?: AbortSignal): Promise<void> {
    const targets = url === undefined ? [...this.#held.values()] : [this.#held.get(url)].filter((h): h is Held => h !== undefined);
    await Promise.all(targets.map(async (h) => {
      try {
        h.file = await this.fetchSigned("index", h.trust.url, h.trust.keys, IndexSchema, INDEX_MAX_BYTES, signal);
        delete h.error;
      } catch (err) {
        h.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        this.#o.log?.(`plugin index ${h.trust.url}: ${h.error}`);
      }
    }));
  }

  /** The indexes for Settings: the official one first. */
  list(): { url: string; name?: string; keys: string[]; official: boolean; lastCheckedAt?: number; issued?: string; stale?: boolean; error?: string }[] {
    return this.trusts().map((t) => {
      const h = this.#held.get(t.url);
      const a = this.acceptedOf("index", t.url);
      return {
        url: t.url, keys: [...t.keys], official: t.official,
        ...(h?.file !== undefined ? { name: h.file.name } : {}),
        ...(a !== undefined ? { lastCheckedAt: a.checkedAt, issued: a.issued, stale: a.stale } : {}),
        ...(h?.error !== undefined ? { error: h.error } : {}),
      };
    });
  }

  /** Adds an index (after the user's warning: the caller's). Throws `invalid` or `conflict`. */
  add(rawUrl: string, keys: readonly string[]): string {
    const url = httpsUrl(rawUrl);
    const clean = [...new Set(keys.map((k) => k.toLowerCase()))];
    if (clean.length === 0 || clean.length > 8 || !clean.every(verifyKeyShape)) throw new ContractError("invalid", "an index's keys are 1 to 8 Ed25519 public keys, 64 hex characters each");
    if (this.isOfficial(url)) throw new ContractError("conflict", "that is the official index, which is always there");
    if (this.#state.added.some((a) => a.url === url)) throw new ContractError("conflict", `${url} is added already; remove it first to change its keys`);
    if (this.#state.added.length >= MAX_ADDED_INDEXES) throw new ContractError("refused", `at most ${MAX_ADDED_INDEXES} indexes can be added`);
    this.#state = { ...this.#state, added: [...this.#state.added, { url, keys: clean, addedAt: this.#now() }] };
    this.#o.store.saveIndexes?.(this.#state);
    this.#held.set(url, { trust: { url, keys: clean, official: false } });
    return url;
  }

  /** The overrides the user made for revoked trees (read only when `REVOKED_OVERRIDE` is on). */
  overrides(): Readonly<Record<string, string>> {
    return this.#state.overrides ?? {};
  }

  /** Records the user's choice to run a revoked tree anyway (`REVOKED_OVERRIDE` on), or takes it back. */
  setOverride(id: string, treeHash: string | undefined): void {
    const overrides = { ...(this.#state.overrides ?? {}) };
    if (treeHash === undefined) delete overrides[id];
    else overrides[id] = treeHash;
    this.#state = { ...this.#state, overrides };
    this.#o.store.saveIndexes?.(this.#state);
  }

  /** Removes an index the user added; its high-water marks stay (adding it again takes no older copy). */
  remove(rawUrl: string): void {
    const url = httpsUrl(rawUrl);
    if (this.isOfficial(url)) throw new ContractError("refused", "the official index can't be removed");
    if (!this.#state.added.some((a) => a.url === url)) throw new ContractError("not_found", `${url} isn't one of your indexes`);
    this.#state = { ...this.#state, added: this.#state.added.filter((a) => a.url !== url) };
    this.#o.store.saveIndexes?.(this.#state);
    this.#held.delete(url);
  }

  /** Every index's entries matching `query` (the id, name or description, any case), official first; an adult entry
   *  only once the user has confirmed 18+, marked. */
  search(o: { query?: string; limit?: number; adultConfirmed: boolean }): IndexEntry[] {
    const q = (o.query ?? "").trim().toLowerCase();
    const text = (t: unknown): string => (typeof t === "string" ? t : t !== null && typeof t === "object" ? Object.values(t as Record<string, string>).join(" ") : "");
    const out: IndexEntry[] = [];
    for (const t of this.trusts()) {
      const file = this.#held.get(t.url)?.file;
      if (file === undefined) continue;
      for (const p of file.plugins) {
        if (p.adult === true && !o.adultConfirmed) continue;
        if (q !== "" && ![p.id, text(p.name), text(p.description)].some((s) => s.toLowerCase().includes(q))) continue;
        out.push({
          id: p.id, index: t.url,
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

  /** The version to install of `id`: from `index` when named (else the first index that lists it, official first),
   *  `version` when named (else its newest). Adult entries need the user's 18+ confirmation, as in search. */
  find(id: string, o: { version?: string; index?: string; adultConfirmed: boolean }): { index: string; version: string; hash: string; url: string; adult: boolean } | undefined {
    const indexes = o.index !== undefined ? this.trusts().filter((t) => t.url === httpsUrl(o.index!)) : this.trusts();
    for (const t of indexes) {
      const p = this.#held.get(t.url)?.file?.plugins.find((e) => e.id === id);
      if (p === undefined) continue;
      if (p.adult === true && !o.adultConfirmed) return undefined;
      const versions = [...p.versions].sort((a, b) => byVersion(b.version, a.version));
      const v = o.version !== undefined ? versions.find((x) => x.version === o.version) : versions[0];
      if (v !== undefined) return { index: t.url, version: v.version, hash: v.hash, url: v.url, adult: p.adult === true };
    }
    return undefined;
  }
}

/** A key that names a canonical Ed25519 point outside the small-order subgroup (checked again at each verify). */
function verifyKeyShape(hex: string): boolean {
  return HEX64.test(hex) && isStrictEd25519Point(Buffer.from(hex, "hex"));
}

export { IndexSchema, RevocationsSchema, type IndexFile, type RevocationsFile };
