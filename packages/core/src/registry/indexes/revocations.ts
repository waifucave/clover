// Revocation (spec §5.1 "Indexes and npm"; the controller's rulings B and D): each index may have a revocation list,
// signed with its keys (`RevocationsSchema`, format 1, with `issued` and `seq`), checked at start and every 6 hours.
//
// * Whose list applies: the OFFICIAL list is the safety net. An entry listing tree hashes blocks a plugin with one of
//   those hashes from any source (another index, npm, a folder, a wrap); its entries by id apply to plugins installed
//   from the official index. An added index's list applies only to ids installed from that index (`provenance.index`).
// * What blocked means: the plugin stops on this computer (every computer checks for itself) and stays on disk with
//   its data and secrets; Settings shows `blocked` and the reason. Nothing is deleted.
// * Override (the owner's answer C, 2026-11-11: on): the user may run a revoked plugin anyway on this computer, after
//   one sealed warning card in Clover's own words (who revoked it, the reason the list gives, that Clover will run it
//   anyway here), from the app and the terminal alike. Only the user's yes on that card records the override: for the
//   record actually revoked (a child revoked by its own hash is overridden by its own), and its exact tree hash, so a
//   changed tree is blocked again. The same rule for the official list and an added index's.
// * Offline and replay as the index client: a failed fetch keeps the last good list, however old; a lower `seq` is
//   refused; a list signed more than 7 days ago is shown stale.
import { isRevoked, REVOCATION_CHECK_INTERVAL_MS, RevocationsSchema, type RevocationsFile } from "@waifucave/clover-plugin-sdk";
import type { PluginProvenance } from "@waifucave/clover-protocol";
import { REVOCATIONS_MAX_BYTES, type IndexClient } from "./client";

/** Whether the user may run a revoked tree anyway, after the warning card: the owner's answer C (2026-11-11), yes. */
export const REVOKED_OVERRIDE: boolean | undefined = true;

/** Who revoked a tree and why, as the warning card and Settings say it. */
export interface Revoked {
  /** "Clover's plugin index", or the added index's name. */
  by: string;
  reason: string;
}

/** What the check needs of a plugin: its id, its tree as it is now, its version, and where it came from. */
export interface RevocationSubject {
  id: string;
  treeHash: string | undefined;
  version: string | undefined;
  provenance: PluginProvenance | undefined;
}

interface HeldList {
  /** The index the list belongs to. */
  index: string;
  official: boolean;
  url: string;
  keys: readonly string[];
  file?: RevocationsFile;
  error?: string;
}

export interface RevocationsOptions {
  client: IndexClient;
  /** The official index's own list URL, when the index file doesn't name one (`OFFICIAL_INDEX.revocations`). */
  officialList?: string;
  /** The owner's switch (`REVOKED_OVERRIDE`); tests set it. */
  override?: boolean;
  /** The lists changed: every plugin is checked again (the registry reads its folders). */
  onChange?: () => void | Promise<void>;
  /** After each check, the lists applied: the plugin updates (`indexes/update.ts`). Its failure is logged. */
  afterCheck?: () => Promise<void>;
  log?: (line: string) => void;
}

export class Revocations {
  readonly #o: RevocationsOptions;
  readonly #held = new Map<string, HeldList>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(o: RevocationsOptions) {
    this.#o = o;
  }

  /** Whether the user may run a revoked tree anyway. */
  get overrideAllowed(): boolean {
    return ("override" in this.#o ? this.#o.override : REVOKED_OVERRIDE) === true;
  }

  /** Each index's list, as its (signed) index file names it, or the official one's from the app. */
  #sources(): HeldList[] {
    const out: HeldList[] = [];
    for (const t of this.#o.client.trusts()) {
      const named = this.#o.client.index(t.url)?.revocations ?? (t.official ? this.#o.officialList ?? t.revocations : undefined);
      if (named === undefined) continue;
      const kept = this.#held.get(t.url);
      out.push({ index: t.url, official: t.official, url: named, keys: t.keys, ...(kept?.url === named && kept.file !== undefined ? { file: kept.file } : {}) });
    }
    return out;
  }

  /** Reads every list's last good copy (at start, before the first scan, so a revoked plugin never starts offline). */
  loadCached(): void {
    for (const s of this.#sources()) {
      const file = this.#o.client.cached("revocations", s.url, s.keys, RevocationsSchema);
      this.#held.set(s.index, { ...s, ...(file !== undefined ? { file } : {}) });
    }
  }

  /** Fetches the indexes and every list now; if a list changed, every plugin is checked again. Never throws. */
  async check(signal?: AbortSignal): Promise<void> {
    await this.#o.client.refresh(undefined, signal);
    let changed = false;
    const seen = new Set<string>();
    for (const s of this.#sources()) {
      seen.add(s.index);
      const before = this.#held.get(s.index);
      try {
        const file = await this.#o.client.fetchSigned("revocations", s.url, s.keys, RevocationsSchema, REVOCATIONS_MAX_BYTES, signal);
        if (before?.file?.seq !== file.seq || before.url !== s.url) changed = true;
        this.#held.set(s.index, { ...s, file });
      } catch (err) {
        const error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        this.#o.log?.(`revocation list ${s.url}: ${error}`);
        // The last good copy stays (a fetch that fails keeps it, however old).
        this.#held.set(s.index, { ...s, ...(before?.file !== undefined && before.url === s.url ? { file: before.file } : {}), error });
      }
    }
    // An index removed: its list goes with it.
    for (const index of [...this.#held.keys()]) {
      if (!seen.has(index)) {
        this.#held.delete(index);
        changed = true;
      }
    }
    if (changed) await this.#o.onChange?.();
    try {
      await this.#o.afterCheck?.();
    } catch (err) {
      this.#o.log?.(`plugin updates: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
    }
  }

  /** Checks now, then every 6 hours. */
  start(): void {
    if (this.#timer !== undefined) return;
    void this.check();
    this.#timer = setInterval(() => void this.check(), REVOCATION_CHECK_INTERVAL_MS);
    (this.#timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Why a plugin is blocked, or undefined: the official list's hashes from any source, its ids for official
   *  installs, and an added index's list for its own installs. An override the user made (with the switch on, after
   *  the warning card) holds for that record's exact tree. */
  blockedOf(p: RevocationSubject): string | undefined {
    const v = this.verdict(p);
    if (v === undefined) return undefined;
    if (this.overrideAllowed && p.treeHash !== undefined && this.#o.client.overrides()[p.id] === p.treeHash) return undefined;
    return `revoked by ${v.by}: ${v.reason}`;
  }

  /** Who revoked this record's tree and why, overrides aside, or undefined. */
  verdict(p: RevocationSubject): Revoked | undefined {
    const from = p.provenance?.index?.url;
    for (const l of this.#held.values()) {
      if (l.file === undefined) continue;
      const by = l.official ? "Clover's plugin index" : (this.#o.client.index(l.index)?.name ?? l.index);
      if (l.official && p.treeHash !== undefined) {
        const e = l.file.entries.find((x) => x.hashes?.includes(p.treeHash!));
        if (e !== undefined) return { by, reason: e.reason };
      }
      if (from === l.index) {
        const r = isRevoked(l.file, p.id, p.version ?? "", p.treeHash ?? "");
        if (r.revoked) return { by, reason: r.reason };
      }
    }
    return undefined;
  }

  /** Each list's state, for Settings (by its index's URL). */
  status(index: string): { url: string; lastCheckedAt?: number; issued?: string; stale?: boolean; error?: string; entries?: number } | undefined {
    const l = this.#held.get(index) ?? this.#sources().find((s) => s.index === index);
    if (l === undefined) return undefined;
    const a = this.#o.client.acceptedOf("revocations", l.url);
    return {
      url: l.url,
      ...(a !== undefined ? { lastCheckedAt: a.checkedAt, issued: a.issued, stale: a.stale } : {}),
      ...(l.error !== undefined ? { error: l.error } : {}),
      ...(l.file !== undefined ? { entries: l.file.entries.length } : {}),
    };
  }
}
