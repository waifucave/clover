// Each bot's memory, kept alike on all of the user's computers (H-M3; the owner's decision: a bot's memory is
// `home/memory` in its tree, `<Clover home>/bots/<bot>/memory/` on every computer that runs the core; spec §6.5).
//
// The bot writes `MEMORY.md` and its other memory files with its ordinary tools on whichever computer runs it; lane
// J's holder tells this sync of each change once it is on disk (`changed`, the holder's `memoryChanged`), and a scan
// catches what reached the disk any other way (Bash). Only that bot's own sessions reach the folder (lane J's tree,
// lane B's `bot-memory` fence); this sync writes as the core.
//
// * **Versions:** each file has a version vector, one counter per computer that wrote it, signed by the computer
//   that made the version with its link key. A strictly newer version (its vector dominates) replaces the file. Two
//   concurrent versions are both kept: the winner, by the shared clock's `ts` (an edit always beats a deletion; the
//   writer's id breaks a tie), stays at the path; the other goes beside it as
//   `<name> (conflict <computer> <date>).<ext>`, a new file the bot merges on its next turn. Every computer decides
//   alike, so the copies they make are the same file.
// * **Writers come from the receiver's own state** (the H-M2 review's rule; never S1's pattern): a version counts
//   only when its signature checks against the writer's key in this computer's registry, and that writer is a
//   computer of the user's, not revoked, entitled to the bot's memory. What a sender says about who wrote it is never
//   taken on its word. A push is taken only from such a computer too, and mail only when its sender's signature checks.
//   An entry refused for its writer is skipped and the rest taken, so a revoked writer's earlier versions that another
//   computer passes on never hold up the others (they are dropped, as unsynced edits of a lost device are).
// * **Counters and times are bounded** (#232's review, B2 and its check 2's C1): in a version, every counter but its
//   signer's own runs at most `COUNTER_STEP` past the highest that counter's writer has itself signed (as this computer
//   has seen it); a revoked writer's counter isn't held to it, and every counter stays at most `MAX_COUNTER`. So no
//   member can raise another writer's counter past what that writer signed, and whatever gap a member leaves closes at
//   the writer's next version, or at the member's revoke. No time runs ahead of the shared clock by more than
//   `MAX_AHEAD_MS`.
// * **Live:** each change goes to every linked computer as `sync.push` on the stream `memory:<bot>`, and each computer
//   passes on what it takes, so a change crosses computers that aren't linked to each other directly. When a link
//   comes up, each side asks the other for its heads and pulls what it lacks (`sync.heads`, `sync.pull`).
// * **Sealed store-and-forward:** a change this computer made reaches a computer that is off now as mail a relay
//   keeps (mailbox.ts), sealed to that computer alone: HPKE to its X25519 box key (the account channel's box suite;
//   an account-less peer's box key comes over the link) and signed with this computer's link key.
// * **Content keys:** a file's content always travels sealed under a content key only current computers hold
//   (memory-keys.ts), rotated when a device is revoked.
// * **Caps, at the receiver:** entries per push, bytes per file, bytes and files per bot. A push over any of them is
//   refused whole, never cut short.
// * **Every paired computer of the user keeps every bot's memory** (the ruling on #232's S4: a bot is live on every
//   computer); never a phone, a browser or a device that doesn't run the core.
// * **Paths** are names in the bot's memory folder, folded (NFC, case) to compare; `..`, absolute paths and other
//   bots' paths are refused; nothing is written through a link (memory-files.ts).
import { isAnyPluginId, pluginIdFromSegment } from "@waifucave/clover-protocol";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { botPaths } from "../bots/paths";
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { DeviceRecord, DeviceChange } from "../contracts/device-registry";
import type { LinkTransport } from "../contracts/link-transport";
import type { SecretStore } from "../contracts/secret-store";
import { sealToBoxKey } from "../identity/box-key";
import { type Bytes, fromBase64, fromBase64Url, fromUtf8, toBase64, toBase64Url, utf8 } from "../identity/bytes";
import { readJson, writeJsonAtomic } from "../sessions/atomic-file";
import { botSegment } from "../sessions/ids";
import { MAIL_MAX_PIECE, type SyncMailbox } from "./mailbox";
import { listMemory, memoryPath, readMemoryFile, removeMemoryFile, sha256Hex, writeMemoryFile } from "./memory-files";
import { ContentKeyRing, contentAad, type SharedContentKey } from "./memory-keys";
import { mountSyncStreams } from "./streams";

const PREFIX = "memory:";
export const MAIL_INFO = "clover memory v1 mail";
const DEVICE_RE = /^[a-z0-9]{16,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
/** What one push or one pull page carries at most in content (the link's own frames are smaller; it splits them). */
const PAGE_BYTES = 4 * 1024 * 1024;
/** What one piece of mail seals to at most: the relay takes 1 MiB a piece (`MAIL_MAX_PIECE`), less some room. */
const MAIL_PIECE_BYTES = MAIL_MAX_PIECE - 4 * 1024;
const MAIL_TTL_MS = 30 * 24 * 3_600_000;
/** How far one writer's counter may run past the highest this computer has seen of it (#232's review, B2): far more
 *  than a lagging computer misses, far less than the counters' room, so no vector can be pushed to where nobody can
 *  write past it. */
export const COUNTER_STEP = 2 ** 20;
/** Counters stay well below the largest safe integer. */
export const MAX_COUNTER = 2 ** 48;
/** How far ahead of the shared clock a version's time may be. */
export const MAX_AHEAD_MS = 10 * 60_000;

export interface MemoryLimits {
  /** Entries in one `sync.push` (or one pull page, or one piece of mail). */
  pushEntries: number;
  /** Bytes in one memory file. */
  fileBytes: number;
  /** Bytes in one bot's memory, all files. */
  botBytes: number;
  /** Files in one bot's memory. */
  botFiles: number;
}

export const MEMORY_LIMITS: MemoryLimits = { pushEntries: 64, fileBytes: 512 * 1024, botBytes: 32 * 1024 * 1024, botFiles: 4_096 };

/** A version vector: each writer's count of its changes to one file. */
export type Vv = Record<string, number>;

/** One version of one file, as its writer signed it. `hash` is null for a deletion. */
export interface MemoryVersion {
  rel: string;
  vv: Vv;
  ts: number;
  by: string;
  hash: string | null;
  size: number;
  sig: string;
}

/** A version on the wire: with its content sealed under a content key (`kid`), unless it's a deletion. */
export interface MemoryEntry extends MemoryVersion {
  kid?: string;
  box?: string;
}

interface Tracked {
  cur: MemoryVersion;
  /** Every version this computer has seen of the file, merged: what it no longer needs. */
  ctx: Vv;
  /** The file's mtime when last read or written here, for the scan's quick look. */
  mtimeMs?: number;
}

type Applied = "old" | "new" | "newer" | "same" | "conflict";
type Refusal = "too_many" | "too_large" | "over_quota" | "bad_path" | "not_writer" | "need_key" | "refused";
/** Why one entry was skipped while the rest were taken: its writer (forged, unknown or revoked), counters past the
 *  bound, or a time ahead of the shared clock. */
export type SkipReason = "not_writer" | "counters" | "ahead";
export type PushResult = { ok: true; took: number; conflicts: number; skipped?: { rel: string; reason: SkipReason }[] } | { ok: false; reason: Refusal; detail?: string };

export interface MemorySyncOptions {
  /** The Clover home: memories are in `bots/<bot>/memory/` there, this sync's own state in `sync/`. */
  home: string;
  /** This computer's device id and its link key, which signs its versions and its mail. */
  self: string;
  key: { sign(data: Uint8Array): Uint8Array };
  /** This computer's X25519 box key, which opens its mail (identity/box-key.ts). */
  boxKey?: { open(box: string, aad: Uint8Array, info?: string): Uint8Array | undefined; readonly publicKeyBase64Url: string };
  /** Where the content keys' bytes live (device items, never synced). */
  store: Pick<SecretStore, "get" | "set">;
  transport: Pick<LinkTransport, "connect" | "handle" | "links" | "watch">;
  registry: {
    get(id: string): DeviceRecord | undefined;
    list(): DeviceRecord[];
    verify(id: string, data: Uint8Array, signature: Uint8Array): Promise<boolean>;
    boxKey?(id: string): string | undefined;
    watch?(fn: (change: DeviceChange) => void): Unsubscribe;
  };
  /** The shared clock (§6.4): a version's `ts`, which only breaks ties between concurrent versions. */
  now(): number;
  /** Where mail for a computer that is off now goes (a relay plugin's, `relayMailbox`); without it, only links. */
  mailbox?: SyncMailbox;
  /** How long changes wait to go out as mail, so a burst of writes is one piece (30 s by default). */
  mailDelayMs?: number;
  /** How long mail the relay didn't keep waits to go again (60 s by default). */
  mailRetryMs?: number;
  /** Whether a computer may hold a bot's memory: by default every paired computer that runs the core and isn't
   *  revoked, from this computer's registry. */
  entitled?(device: string, bot: string): boolean;
  limits?: Partial<MemoryLimits>;
  log?(line: string): void;
}

export class MemorySync {
  readonly #o: MemorySyncOptions;
  readonly #limits: MemoryLimits;
  readonly #ring: ContentKeyRing;
  readonly #offs: Unsubscribe[] = [];
  readonly #state = new Map<string, Map<string, Tracked>>();
  /** Per bot, the highest counter each writer has itself signed (`#signedCounters`). */
  readonly #signed = new Map<string, Vv>();
  /** Box keys account-less peers told this computer over their links. */
  readonly #peerBoxKeys: Record<string, string>;
  /** Files changed and not yet pushed, per bot: the key, and the computer the change came from (not pushed back). */
  readonly #dirty = new Map<string, Map<string, string | undefined>>();
  /** This computer's own changes not yet mailed, per offline computer and bot. */
  readonly #mail = new Map<string, Map<string, Set<string>>>();
  readonly #scanSoon = new Set<string>();
  readonly #up = new Set<string>();
  readonly #warned = new Set<string>();
  /** The ids of mail taken lately. */
  readonly #mailSeen = new Set<string>();
  #flushing = false;
  #mailTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  private constructor(o: MemorySyncOptions, ring: ContentKeyRing) {
    this.#o = o;
    this.#limits = { ...MEMORY_LIMITS, ...o.limits };
    this.#ring = ring;
    const peers = readJson(this.#peersFile()) as { boxKeys?: Record<string, string> } | undefined;
    this.#peerBoxKeys = { ...(peers?.boxKeys ?? {}) };
  }

  static async start(o: MemorySyncOptions): Promise<MemorySync> {
    const ring = await ContentKeyRing.open({ self: o.self, home: o.home, store: o.store, registry: o.registry, sign: (d) => o.key.sign(d), now: o.now });
    const s = new MemorySync(o, ring);
    s.#mount();
    return s;
  }

  /** Lane J's `memoryChanged(bot, rel)`: something in the bot's memory changed on disk here. The whole folder is
   *  looked at again (cheaply: unchanged files by size and mtime), so a change any tool made is caught alike. */
  changed(bot: string, _rel?: string): void {
    if (this.#closed || !isAnyPluginId(bot)) return;
    if (this.#scanSoon.size === 0) {
      queueMicrotask(() => {
        const bots = [...this.#scanSoon];
        this.#scanSoon.clear();
        for (const b of bots) this.#scanAndMark(b);
      });
    }
    this.#scanSoon.add(bot);
  }

  /** Looks at every bot's memory folder now, and sends what changed. */
  scanAll(): void {
    for (const bot of this.#bots()) this.#scanAndMark(bot);
  }

  /** Pulls what `peer` holds beyond this computer's copies, for every bot both keep. Returns the versions taken. */
  async catchUpFrom(peer: string): Promise<number> {
    const link = await this.#o.transport.connect(peer);
    await this.#hello(peer).catch(() => undefined);
    const { heads } = await link.request<{ heads: Record<string, { digest?: unknown }> }>("sync.heads", { prefixes: [PREFIX] });
    let taken = 0;
    for (const [stream, head] of Object.entries(heads)) {
      const bot = botOf(stream);
      if (!bot || !this.#entitled(peer, bot)) continue;
      this.#scanAndMark(bot);
      if (head?.digest === this.#digest(bot)) continue;
      let after = "";
      for (let pages = 0; pages < 10_000; pages++) {
        const page = await link.request<{ entries: MemoryEntry[]; more: boolean; next?: string; keys?: SharedContentKey[] }>("sync.pull", {
          stream, have: this.#have(bot), after, limit: this.#limits.pushEntries,
        });
        const r = await this.#take(bot, page.entries, peer, page.keys);
        if (!r.ok) {
          this.#log(`catching up ${bot}'s memory from ${peer}: refused (${r.reason}${r.detail ? `: ${r.detail}` : ""})`);
          break;
        }
        taken += r.took;
        if (!page.more || typeof page.next !== "string" || page.next <= after) break;
        after = page.next;
      }
    }
    return taken;
  }

  /** Reads this computer's mail and takes what's in it; returns the versions taken. */
  async takeMail(): Promise<number> {
    const box = this.#o.mailbox;
    if (!box || !this.#o.boxKey) return 0;
    let taken = 0;
    for (let rounds = 0; rounds < 64; rounds++) {
      const pieces = await box.take({ max: 16 });
      if (pieces.length === 0) break;
      for (const p of pieces) {
        // Bounded before it is parsed, and each piece once (S5).
        if (p.sealed.length > MAIL_MAX_PIECE || this.#mailSeen.has(p.id)) continue;
        this.#mailSeen.add(p.id);
        if (this.#mailSeen.size > 4_096) this.#mailSeen.delete(this.#mailSeen.values().next().value!);
        taken += await this.#openMail(p.sealed).catch((e: unknown) => {
          this.#log(`mail ${p.id} wasn't taken: ${errText(e)}`);
          return 0;
        });
      }
      await box.ack(pieces.map((p) => p.id));
    }
    return taken;
  }

  /** Sends mail waiting for its delay now. */
  async flushMail(): Promise<void> {
    if (this.#mailTimer) clearTimeout(this.#mailTimer);
    this.#mailTimer = undefined;
    await this.#sendMail();
  }

  /** What this computer knows of a bot's memory: each file's current version. For tests and `memory.list`. */
  versions(bot: string): Record<string, MemoryVersion> {
    const out: Record<string, MemoryVersion> = {};
    for (const [key, t] of this.#files(bot)) out[key] = { ...t.cur, vv: { ...t.cur.vv } };
    return out;
  }

  /** The content keys this computer holds (no bytes). */
  keys(): ReturnType<ContentKeyRing["list"]> {
    return this.#ring.list();
  }

  /** TEST-ONLY: opens a content box with this computer's keys. */
  openContent(bot: string, e: MemoryEntry): Bytes | undefined {
    const p = memoryPath(e.rel);
    if ("refused" in p || !e.kid || !e.box || !e.hash) return undefined;
    return this.#ring.open(e.kid, contentAad({ kid: e.kid, bot, key: p.key, hash: e.hash }), e.box);
  }

  close(): void {
    this.#closed = true;
    if (this.#mailTimer) clearTimeout(this.#mailTimer);
    for (const off of this.#offs.splice(0)) off();
  }

  // ---- the link ----

  #mount(): void {
    const t = this.#o.transport;
    this.#offs.push(mountSyncStreams(t, PREFIX, {
      heads: ({ streams }, from) => {
        this.#mustBeComputer(from);
        const heads: Record<string, { digest: string; files: number }> = {};
        for (const bot of this.#bots()) {
          const stream = `${PREFIX}${bot}`;
          if ((streams && !streams.has(stream)) || !this.#entitled(from, bot)) continue;
          this.#scanAndMark(bot);
          heads[stream] = { digest: this.#digest(bot), files: this.#files(bot).size };
        }
        return heads;
      },
      pull: async (raw, from) => {
        this.#mustBeComputer(from);
        const bot = botOf(raw.stream);
        if (!bot) throw new ContractError("invalid", "sync.pull: bad params");
        if (!this.#entitled(from, bot)) throw new ContractError("refused", "that computer doesn't keep this bot's memory");
        const after = typeof raw.after === "string" ? raw.after : "";
        const limit = Math.min(Math.max(1, Math.floor(typeof raw.limit === "number" ? raw.limit : this.#limits.pushEntries)), this.#limits.pushEntries);
        const have = (raw.have && typeof raw.have === "object" ? raw.have : {}) as Record<string, unknown>;
        this.#scanAndMark(bot);
        const want = [...this.#files(bot)].filter(([key, t]) => key > after && !(isVv(have[key]) && leq(t.cur.vv, have[key] as Vv))).sort(([a], [b]) => (a < b ? -1 : 1));
        const kid = (await this.#ring.sealingKey([from])).kid;
        const entries: MemoryEntry[] = [];
        let bytes = 0;
        let next = after;
        for (const [key] of want) {
          if (entries.length >= limit || bytes >= PAGE_BYTES) break;
          const e = this.#entry(bot, key, kid);
          next = key;
          if (!e) continue;
          entries.push(e);
          bytes += e.size;
        }
        const more = want.some(([key]) => key > next);
        return { entries, more, next, keys: this.#ring.sharedWith(from, [kid]) };
      },
      push: async (raw, from) => {
        this.#mustBeComputer(from);
        const bot = botOf(raw.stream);
        if (!bot || !Array.isArray(raw.entries)) throw new ContractError("invalid", "sync.push: bad params");
        if (!this.#entitled(from, bot)) return { ok: false, reason: "not_writer" } satisfies PushResult;
        return this.#take(bot, raw.entries as MemoryEntry[], from, raw.keys);
      },
    }));
    // A computer's box key, so this one can seal mail to it (an account's devices list theirs; account-less ones say).
    this.#offs.push(t.handle(MEMORY_HELLO, (raw, from) => {
      this.#mustBeComputer(from);
      this.#learnBoxKey(from, (raw as { boxKey?: unknown } | undefined)?.boxKey);
      return { boxKey: this.#o.boxKey?.publicKeyBase64Url ?? null };
    }));
    this.#offs.push(t.watch((v) => {
      if (v.up && !this.#up.has(v.peer)) {
        this.#up.add(v.peer);
        if (this.#isComputer(v.peer)) void this.catchUpFrom(v.peer).catch((e: unknown) => this.#log(`catching up from ${v.peer}: ${errText(e)}`));
      } else if (!v.up) this.#up.delete(v.peer);
    }));
    for (const l of t.links()) {
      if (!l.up || this.#up.has(l.peer)) continue;
      this.#up.add(l.peer);
      if (this.#isComputer(l.peer)) void this.catchUpFrom(l.peer).catch(() => undefined);
    }
    // A revoked device's keys are never used again: a new key at once (the brief, item 4).
    if (this.#o.registry.watch) {
      this.#offs.push(this.#o.registry.watch((c) => {
        if (c.type !== "revoked") return;
        // Its keys leave the ring (C2), and a new key goes out for the rest.
        this.#ring.forgetCreator(c.id);
        void this.#ring.rotate().catch((e: unknown) => this.#log(`rotating the content key: ${errText(e)}`));
      }));
    }
  }

  async #hello(peer: string): Promise<void> {
    const link = await this.#o.transport.connect(peer);
    const r = await link.request<{ boxKey?: unknown }>(MEMORY_HELLO, { boxKey: this.#o.boxKey?.publicKeyBase64Url ?? null });
    this.#learnBoxKey(peer, r?.boxKey);
  }

  #learnBoxKey(peer: string, key: unknown): void {
    if (typeof key !== "string" || fromBase64Url(key)?.length !== 32 || this.#peerBoxKeys[peer] === key) return;
    this.#peerBoxKeys[peer] = key;
    writeJsonAtomic(this.#peersFile(), { v: 1, boxKeys: this.#peerBoxKeys });
  }

  // ---- taking versions ----

  /** Takes versions `from` sent for `bot` (a push, a pull page or mail). The caps and the quota are all or none, and so
   *  is an entry the sender itself made wrong (a bad path, content that doesn't match, a key it didn't send); an entry
   *  refused for its writer (forged, unknown or revoked, #232's review B3: a revoked writer's earlier versions another
   *  computer passes on are skipped), for counters past the bound (B2) or a time ahead of the shared clock is skipped
   *  and logged, and the rest are taken. Keys come in only for the kids the checked entries use (B1). */
  async #take(bot: string, raw: unknown, from: string, keys?: unknown): Promise<PushResult> {
    if (!Array.isArray(raw)) return { ok: false, reason: "refused" };
    if (raw.length > this.#limits.pushEntries) return { ok: false, reason: "too_many", detail: `more than ${this.#limits.pushEntries} entries` };
    // Every entry is checked before any is taken: first what needs no key (its path, its writer and signature, its
    // counters and time), then the keys its kids name, then its content.
    const seen = this.#signedCounters(bot);
    const skipped: { rel: string; reason: SkipReason }[] = [];
    const signed: { key: string; names: string[]; v: MemoryVersion; e: MemoryEntry }[] = [];
    for (const e of raw as MemoryEntry[]) {
      const c = await this.#checkSigned(bot, e, seen);
      if ("skip" in c) {
        skipped.push({ rel: typeof e?.rel === "string" ? e.rel.slice(0, 200) : "?", reason: c.skip });
        continue;
      }
      if ("reason" in c) return { ok: false, ...c };
      signed.push(c);
    }
    const kids = new Set(signed.map((c) => c.e.kid).filter((k): k is string => typeof k === "string"));
    if (keys !== undefined) await this.#ring.take(keys, from, kids);
    const checked: { key: string; names: string[]; v: MemoryVersion; data?: Bytes }[] = [];
    for (const c of signed) {
      const opened = this.#openEntry(bot, c);
      if ("reason" in opened) return { ok: false, ...opened };
      checked.push(opened);
    }
    for (const s of skipped) this.#log(`${bot}'s ${s.rel} from ${from} skipped: ${s.reason}`);
    // From here on nothing waits, so no other push for this bot runs in between.
    if (checked.length === 0) return { ok: true, took: 0, conflicts: 0, skipped };
    this.#scanAndMark(bot);
    const files = this.#files(bot);
    let bytes = 0;
    let count = 0;
    for (const t of files.values()) {
      if (t.cur.hash === null) continue;
      bytes += t.cur.size;
      count++;
    }
    for (const c of checked) {
      const t = files.get(c.key);
      if (t && leq(c.v.vv, t.ctx)) continue;
      const replaces = t && t.cur.hash !== null && leq(t.cur.vv, c.v.vv);
      bytes += c.v.size - (replaces ? t!.cur.size : 0);
      if (c.v.hash !== null && !(t && t.cur.hash !== null)) count++;
    }
    if (bytes > this.#limits.botBytes) return { ok: false, reason: "over_quota", detail: `${bot}'s memory would pass ${this.#limits.botBytes} bytes` };
    if (count > this.#limits.botFiles) return { ok: false, reason: "over_quota", detail: `${bot}'s memory would pass ${this.#limits.botFiles} files` };
    let took = 0;
    let conflicts = 0;
    for (const c of checked) {
      let r: Applied;
      try {
        r = this.#apply(bot, c.key, c.names, c.v, c.data);
      } catch (e) {
        // A link or a file where a folder should be: nothing is written through it, and the version waits.
        this.#log(`${bot}'s ${c.v.rel} wasn't written: ${errText(e)}`);
        continue;
      }
      if (r === "old") continue;
      this.#noteSigned(bot, c.v);
      took++;
      if (r === "conflict") conflicts++;
      // What this computer now holds goes on to the others; back to the sender too when it isn't what the sender sent
      // (its version lost a conflict here), so the sender learns the winner without waiting for a catch-up.
      this.#mark(bot, c.key, files.get(c.key)?.cur === c.v ? from : undefined);
    }
    if (took > 0) this.#save(bot);
    return { ok: true, took, conflicts, skipped };
  }

  /** What needs no key: the path, the writer (by its signature, against this computer's registry), the counters and
   *  the time. A refusal for the entry's writer, its counters or its time skips it (`skip`); anything else the sender
   *  got wrong refuses the push (`reason`). */
  async #checkSigned(bot: string, e: MemoryEntry, seen: Vv): Promise<{ key: string; names: string[]; v: MemoryVersion; e: MemoryEntry } | { skip: SkipReason } | { reason: Refusal; detail?: string }> {
    if (!e || typeof e !== "object") return { reason: "refused" };
    const p = memoryPath(e.rel);
    if ("refused" in p) return { reason: "bad_path", detail: p.refused };
    if (p.rel !== e.rel) return { reason: "bad_path", detail: "not in NFC" };
    // Counters past the cap are a vector nobody could write past: skipped, as counters past the bound are (B2).
    if (e.vv && typeof e.vv === "object" && Object.values(e.vv).some((n) => typeof n === "number" && n > MAX_COUNTER)) return { skip: "counters" };
    if (!isVv(e.vv) || typeof e.ts !== "number" || !Number.isSafeInteger(e.ts) || typeof e.by !== "string" || !DEVICE_RE.test(e.by) || typeof e.sig !== "string") return { reason: "refused" };
    if (!Number.isSafeInteger(e.size) || e.size < 0) return { reason: "refused" };
    if (e.size > this.#limits.fileBytes) return { reason: "too_large", detail: `${e.rel} is over ${this.#limits.fileBytes} bytes` };
    if (e.hash !== null && (typeof e.hash !== "string" || !HASH_RE.test(e.hash))) return { reason: "refused" };
    if (e.hash === null && e.size !== 0) return { reason: "refused" };
    if (!(e.vv[e.by]! >= 1)) return { reason: "refused" };
    // The writer, from this computer's own registry: a computer of the user's that keeps this bot's memory, whose key
    // made the signature. A version another computer signed, or no computer did, or a revoked one, is skipped.
    if (!this.#entitled(e.by, bot)) return { skip: "not_writer" };
    const v: MemoryVersion = { rel: e.rel, vv: { ...e.vv }, ts: e.ts, by: e.by, hash: e.hash, size: e.size, sig: e.sig };
    const sig = fromBase64(e.sig);
    if (!sig || !(await this.#o.registry.verify(e.by, versionStatement(bot, v), sig))) return { skip: "not_writer" };
    // Counters within a step of what this computer has seen of each writer (B2), so no one can push a file's vector to
    // where nobody can write past it; and no time ahead of the shared clock, which would win every conflict (S5).
    for (const [w, n] of Object.entries(e.vv)) {
      if (w === e.by || this.#o.registry.get(w)?.revokedAt !== undefined) continue;
      if (n > (seen[w] ?? 0) + COUNTER_STEP) return { skip: "counters" };
    }
    if (e.ts > this.#o.now() + MAX_AHEAD_MS) return { skip: "ahead" };
    return { key: p.key, names: p.names, v, e };
  }

  /** The content: it opens under its key and hashes to what was signed. */
  #openEntry(bot: string, c: { key: string; names: string[]; v: MemoryVersion; e: MemoryEntry }): { key: string; names: string[]; v: MemoryVersion; data?: Bytes } | { reason: Refusal; detail?: string } {
    const { e, v } = c;
    if (v.hash === null) return { key: c.key, names: c.names, v };
    if (typeof e.kid !== "string" || typeof e.box !== "string") return { reason: "refused" };
    // A box's length follows from the size it says, before anything is decoded (S5).
    if (e.box.length > boxChars(v.size)) return { reason: "refused", detail: `${v.rel}'s box is longer than its size` };
    if (!this.#ring.has(e.kid)) return { reason: "need_key" };
    const data = this.#ring.open(e.kid, contentAad({ kid: e.kid, bot, key: c.key, hash: v.hash }), e.box);
    if (!data || data.length !== v.size || sha256Hex(data) !== v.hash) return { reason: "refused", detail: `${v.rel}'s content doesn't match its version` };
    return { key: c.key, names: c.names, v, data };
  }

  /** The highest counter each writer has itself signed in a bot's memory, as this computer has seen it: the counter
   *  named for the signer in each version it took or made (C1). */
  #signedCounters(bot: string): Vv {
    this.#files(bot);
    return this.#signed.get(bot)!;
  }

  #noteSigned(bot: string, v: MemoryVersion): void {
    const signed = this.#signedCounters(bot);
    const n = v.vv[v.by] ?? 0;
    if (n > (signed[v.by] ?? 0)) signed[v.by] = n;
  }


  /** Puts one checked version in place. */
  #apply(bot: string, key: string, names: string[], r: MemoryVersion, data: Bytes | undefined): Applied {
    const files = this.#files(bot);
    const t = files.get(key);
    if (t && leq(r.vv, t.ctx)) return "old";
    if (!t || leq(t.cur.vv, r.vv)) {
      const mtimeMs = this.#put(bot, names, r, data);
      files.set(key, { cur: r, ctx: t ? merge(t.ctx, r.vv) : { ...r.vv }, ...(mtimeMs !== undefined ? { mtimeMs } : {}) });
      return t ? "newer" : "new";
    }
    // Concurrent.
    const ctx = merge(t.ctx, r.vv);
    const winner = winnerOf(t.cur, r);
    if (r.hash === t.cur.hash) {
      files.set(key, { ...t, cur: winner, ctx });
      return "same";
    }
    const loser = winner === r ? t.cur : r;
    if (loser.hash !== null) {
      const lost = loser === r ? data : readMemoryFile(this.#o.home, this.#root(bot), t.cur.rel, this.#limits.fileBytes)?.data;
      if (lost && sha256Hex(lost) === loser.hash) this.#keepConflict(bot, loser, lost);
      else this.#log(`${bot}'s ${loser.rel}: the losing copy couldn't be kept`);
    }
    let mtimeMs = t.mtimeMs;
    if (winner === r) mtimeMs = this.#put(bot, names, r, data);
    files.set(key, { cur: winner, ctx, ...(mtimeMs !== undefined ? { mtimeMs } : {}) });
    return "conflict";
  }

  /** Writes (or removes) a version's file; its mtime after. */
  #put(bot: string, names: string[], v: MemoryVersion, data: Bytes | undefined): number | undefined {
    if (v.hash === null) {
      removeMemoryFile(this.#o.home, this.#root(bot), names);
      return undefined;
    }
    return writeMemoryFile(this.#o.home, this.#root(bot), names, data!).mtimeMs;
  }

  /** The losing side of a conflict, kept beside the file as a file of its own: `<name> (conflict <computer> <date>)`. */
  #keepConflict(bot: string, loser: MemoryVersion, data: Uint8Array): void {
    // The name is made from what the loser's writer signed alone, so every computer makes the same one (#232's
    // review, S3): its writer's id, the version's date and its content's hash.
    const p = conflictPath(loser.rel, `${loser.by.slice(0, 8)} ${new Date(loser.ts).toISOString().slice(0, 10)} ${loser.hash!.slice(0, 8)}`);
    if (!p) return;
    this.#placeCopy(bot, p, data);
  }

  /** Writes a copy at its own path and gives it a version of this computer's, unless it is there already. */
  #placeCopy(bot: string, p: { names: string[]; rel: string; key: string }, data: Uint8Array): void {
    const hash = sha256Hex(data);
    const t = this.#files(bot).get(p.key);
    if (t && t.cur.hash === hash) return;
    const w = writeMemoryFile(this.#o.home, this.#root(bot), p.names, data);
    this.#version(bot, p.key, p.rel, hash, data.length, w.mtimeMs);
    this.#mark(bot, p.key, undefined);
  }

  // ---- this computer's own changes ----

  /** Finds what changed on disk in a bot's memory and gives each change a version of this computer's. */
  #scan(bot: string): string[] {
    const root = this.#root(bot);
    const files = this.#files(bot);
    const { files: disk, over } = listMemory(this.#o.home, root, this.#limits.botFiles);
    if (over) this.#warn(`${bot}:files`, `${bot}'s memory has more than ${this.#limits.botFiles} files; the rest don't sync`);
    const seen = new Set<string>();
    const changed: string[] = [];
    // Two names that fold alike (`Notes.md` and `notes.md` on a case-sensitive disk) are one file to every other
    // computer (#232's review, S2): the one this computer already tracks keeps the path, and the other becomes a
    // conflict copy beside it, so neither silently undoes the other's edits.
    const byKey = new Map<string, typeof disk>();
    for (const f of disk) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f]);
    for (const [key, same] of byKey) {
      if (same.length < 2) continue;
      const keep = same.find((f) => f.rel === files.get(key)?.cur.rel) ?? same[0]!;
      for (const f of same) {
        if (f === keep) continue;
        const read = readMemoryFile(this.#o.home, root, f.rel, this.#limits.fileBytes, { exact: true });
        const p = read ? conflictPath(f.rel, `${this.#o.self.slice(0, 8)} ${new Date(this.#o.now()).toISOString().slice(0, 10)} ${sha256Hex(read.data).slice(0, 8)}`) : undefined;
        if (!read || !p) continue;
        this.#warn(`${bot}:fold:${f.rel}`, `${bot}'s ${f.rel} and ${keep.rel} are one name to other computers: ${f.rel} is kept as ${p.rel}`);
        this.#placeCopy(bot, p, read.data);
        removeMemoryFile(this.#o.home, root, f.rel.split("/"), { exact: true });
        changed.push(p.key);
      }
    }
    for (const f of disk) {
      if (seen.has(f.key) || (byKey.get(f.key)!.length > 1 && f.rel !== (byKey.get(f.key)!.find((x) => x.rel === files.get(f.key)?.cur.rel) ?? byKey.get(f.key)![0]!).rel)) continue;
      seen.add(f.key);
      const t = files.get(f.key);
      if (f.size > this.#limits.fileBytes) {
        this.#warn(`${bot}:${f.key}`, `${bot}'s ${f.rel} is over ${this.#limits.fileBytes} bytes and doesn't sync`);
        continue;
      }
      if (t && t.cur.hash !== null && t.cur.size === f.size && t.mtimeMs === f.mtimeMs) continue;
      const read = readMemoryFile(this.#o.home, root, f.rel, this.#limits.fileBytes);
      if (!read) continue;
      const hash = sha256Hex(read.data);
      if (t && t.cur.hash === hash) {
        t.mtimeMs = read.mtimeMs;
        continue;
      }
      this.#version(bot, f.key, f.rel, hash, read.data.length, read.mtimeMs);
      changed.push(f.key);
    }
    if (!over) {
      for (const [key, t] of files) {
        if (seen.has(key) || t.cur.hash === null) continue;
        this.#version(bot, key, t.cur.rel, null, 0, undefined);
        changed.push(key);
      }
    }
    if (changed.length > 0) this.#save(bot);
    return changed;
  }

  #scanAndMark(bot: string): void {
    try {
      for (const key of this.#scan(bot)) this.#mark(bot, key, undefined);
    } catch (e) {
      this.#log(`looking at ${bot}'s memory: ${errText(e)}`);
    }
  }

  /** A new version of this computer's: one past every version it has seen of the file, signed with its link key. */
  #version(bot: string, key: string, rel: string, hash: string | null, size: number, mtimeMs: number | undefined): void {
    const files = this.#files(bot);
    const t = files.get(key);
    const ctx = t?.ctx ?? {};
    const vv = { ...ctx, [this.#o.self]: (ctx[this.#o.self] ?? 0) + 1 };
    const unsigned = { rel, vv, ts: this.#o.now(), by: this.#o.self, hash, size };
    const v: MemoryVersion = { ...unsigned, sig: toBase64(this.#o.key.sign(versionStatement(bot, { ...unsigned, sig: "" }))) };
    files.set(key, { cur: v, ctx: vv, ...(mtimeMs !== undefined ? { mtimeMs } : {}) });
    this.#noteSigned(bot, v);
  }

  // ---- sending ----

  #mark(bot: string, key: string, from: string | undefined): void {
    const d = this.#dirty.get(bot) ?? new Map<string, string | undefined>();
    d.set(key, from);
    this.#dirty.set(bot, d);
    if (!this.#flushing) {
      this.#flushing = true;
      queueMicrotask(() => void this.#flush().catch((e: unknown) => this.#log(`sending memory: ${errText(e)}`)));
    }
  }

  async #flush(): Promise<void> {
    this.#flushing = false;
    if (this.#closed) return;
    const batches = [...this.#dirty];
    this.#dirty.clear();
    const up = this.#o.transport.links().filter((l) => l.up && this.#isComputer(l.peer)).map((l) => l.peer);
    for (const [bot, keys] of batches) {
      for (const peer of up) {
        if (!this.#entitled(peer, bot)) continue;
        const send = [...keys].filter(([, from]) => from !== peer).map(([key]) => key);
        if (send.length > 0) void this.#push(peer, bot, send);
      }
      // This computer's own versions go as mail to the computers that are off now.
      const own = [...keys.keys()].filter((key) => this.#files(bot).get(key)?.cur.by === this.#o.self);
      if (!this.#o.mailbox || own.length === 0) continue;
      for (const d of this.#o.registry.list()) {
        if (d.id === this.#o.self || !this.#isComputer(d.id) || up.includes(d.id) || !this.#entitled(d.id, bot)) continue;
        this.#queueMail(d.id, bot, own);
      }
    }
    if (this.#mail.size > 0 && !this.#mailTimer) {
      const delay = this.#o.mailDelayMs ?? 30_000;
      if (delay <= 0) await this.#sendMail();
      else {
        this.#mailTimer = setTimeout(() => {
          this.#mailTimer = undefined;
          void this.#sendMail().catch((e: unknown) => this.#log(`sending memory mail: ${errText(e)}`));
        }, delay);
        (this.#mailTimer as { unref?: () => void }).unref?.();
      }
    }
  }

  async #push(peer: string, bot: string, keys: string[]): Promise<void> {
    try {
      const kid = (await this.#ring.sealingKey([peer])).kid;
      const link = await this.#o.transport.connect(peer);
      for (const page of this.#pages(bot, keys, kid, PAGE_BYTES)) {
        const r = await link.request<PushResult>("sync.push", { stream: `${PREFIX}${bot}`, entries: page, keys: this.#ring.sharedWith(peer, [kid]) });
        if (!r.ok) this.#log(`${peer} refused ${bot}'s memory: ${r.reason}${r.detail ? ` (${r.detail})` : ""}`);
      }
    } catch {
      // An offline peer catches up when its link comes back.
    }
  }

  /** Entries for `keys`, in pages of at most `pushEntries` and about `bytes`. */
  *#pages(bot: string, keys: readonly string[], kid: string, bytes: number): Generator<MemoryEntry[]> {
    let page: MemoryEntry[] = [];
    let size = 0;
    for (const key of keys) {
      const e = this.#entry(bot, key, kid);
      if (!e) continue;
      if (page.length > 0 && (page.length >= this.#limits.pushEntries || size + e.size > bytes)) {
        yield page;
        page = [];
        size = 0;
      }
      page.push(e);
      size += e.size;
    }
    if (page.length > 0) yield page;
  }

  /** A file's current version with its content sealed under `kid`; undefined when the disk no longer holds it (a
   *  newer change, which the next scan finds). */
  #entry(bot: string, key: string, kid: string): MemoryEntry | undefined {
    const t = this.#files(bot).get(key);
    if (!t) return undefined;
    const v = { ...t.cur, vv: { ...t.cur.vv } };
    if (v.hash === null) return v;
    const read = readMemoryFile(this.#o.home, this.#root(bot), v.rel, this.#limits.fileBytes);
    if (!read || sha256Hex(read.data) !== v.hash) return undefined;
    return { ...v, kid, box: this.#ring.seal(kid, contentAad({ kid, bot, key, hash: v.hash }), read.data) };
  }

  async #sendMail(): Promise<void> {
    const box = this.#o.mailbox;
    if (!box) return;
    const all = [...this.#mail];
    this.#mail.clear();
    let retry = false;
    for (const [peer, bots] of all) {
      const to = this.#boxKeyOf(peer);
      if (!to) {
        this.#warn(`mail:${peer}`, `no box key for ${peer}: memory reaches it only over its link`);
        continue;
      }
      if (!this.#isComputer(peer)) continue;
      const kid = (await this.#ring.sealingKey([peer])).kid;
      const keys = this.#ring.sharedWith(peer, [kid]);
      for (const [bot, wanted] of bots) {
        // Pieces are cut by their sealed size, measured (#232's review, B4): what isn't kept stays queued and goes
        // again, so nothing is lost to a refused piece.
        for (const piece of this.#mailPieces(peer, to, bot, [...wanted], kid, keys)) {
          try {
            await box.put({ to: peer, id: piece.id, sealed: piece.sealed, expiresAt: Date.now() + MAIL_TTL_MS });
          } catch (e) {
            this.#log(`memory mail for ${peer} wasn't kept (it goes again): ${errText(e)}`);
            this.#queueMail(peer, bot, piece.keys);
            retry = true;
          }
        }
      }
    }
    if (retry && !this.#closed && !this.#mailTimer) {
      this.#mailTimer = setTimeout(() => {
        this.#mailTimer = undefined;
        void this.#sendMail().catch((e: unknown) => this.#log(`sending memory mail: ${errText(e)}`));
      }, this.#o.mailRetryMs ?? 60_000);
      (this.#mailTimer as { unref?: () => void }).unref?.();
    }
  }

  /** The pieces of mail for `wanted`, each sealed and at most the relay's piece size; a file whose piece alone would be
   *  bigger is logged and left out (none is under the default caps: a 512 KiB file seals to about 930 KiB). */
  *#mailPieces(peer: string, to: Bytes, bot: string, wanted: string[], kid: string, keys: SharedContentKey[]): Generator<{ id: string; sealed: Bytes; keys: string[] }> {
    const seal = (entries: MemoryEntry[]): { id: string; sealed: Bytes } => {
      const id = `mem-${toBase64Url(crypto.getRandomValues(new Uint8Array(12)))}`;
      const plain = { v: 1, from: this.#o.self, to: peer, id, at: this.#o.now(), bot, entries, keys };
      const sealedBox = sealToBoxKey(to, mailAad(this.#o.self, peer, id), utf8(JSON.stringify(plain)), MAIL_INFO);
      const sig = toBase64(this.#o.key.sign(mailStatement(this.#o.self, peer, id, sealedBox)));
      return { id, sealed: utf8(JSON.stringify({ v: 1, from: this.#o.self, id, box: sealedBox, sig })) };
    };
    // What a piece seals to, from its plaintext's length: HPKE adds 48 bytes, base64url a third, the outer fields a
    // few hundred. Measured again once sealed.
    const sealedSize = (plainLen: number) => Math.ceil(((plainLen + 48) * 4) / 3) + 512;
    const base = JSON.stringify({ v: 1, from: this.#o.self, to: peer, id: "x".repeat(20), at: this.#o.now(), bot, entries: [], keys }).length;
    let page: MemoryEntry[] = [];
    let pageKeys: string[] = [];
    let len = base;
    const out: { id: string; sealed: Bytes; keys: string[] }[] = [];
    const flush = () => {
      if (page.length === 0) return;
      const sealed = seal(page);
      if (sealed.sealed.length <= MAIL_PIECE_BYTES) out.push({ ...sealed, keys: pageKeys });
      else if (page.length === 1) this.#log(`${bot}'s ${page[0]!.rel} is too big for one piece of mail: it goes only over the link`);
      else {
        // Shouldn't happen (the size was measured ahead): halve and seal again.
        const [a, b] = [page.slice(0, page.length >> 1), page.slice(page.length >> 1)];
        const [ka, kb] = [pageKeys.slice(0, a.length), pageKeys.slice(a.length)];
        for (const [p, k] of [[a, ka], [b, kb]] as const) {
          const s2 = seal([...p]);
          if (s2.sealed.length <= MAIL_PIECE_BYTES) out.push({ ...s2, keys: [...k] });
          else this.#log(`a piece of ${bot}'s mail was too big and is left out`);
        }
      }
      page = [];
      pageKeys = [];
      len = base;
    };
    for (const key of wanted) {
      const e = this.#entry(bot, key, kid);
      if (!e) continue;
      const add = JSON.stringify(e).length + 1;
      if (page.length > 0 && (page.length >= this.#limits.pushEntries || sealedSize(len + add) > MAIL_PIECE_BYTES)) flush();
      page.push(e);
      pageKeys.push(key);
      len += add;
    }
    flush();
    yield* out;
  }

  #queueMail(peer: string, bot: string, keys: Iterable<string>): void {
    const forPeer = this.#mail.get(peer) ?? new Map<string, Set<string>>();
    const set = forPeer.get(bot) ?? new Set<string>();
    for (const k of keys) set.add(k);
    forPeer.set(bot, set);
    this.#mail.set(peer, forPeer);
  }

  /** One piece of mail: its sender's signature checked against this computer's registry, then opened. */
  async #openMail(sealed: Uint8Array): Promise<number> {
    const outer = JSON.parse(fromUtf8(sealed)) as { from?: unknown; id?: unknown; box?: unknown; sig?: unknown };
    const { from, id, box, sig } = outer;
    if (typeof from !== "string" || typeof id !== "string" || typeof box !== "string" || typeof sig !== "string") throw new Error("not memory mail");
    if (!this.#isComputer(from)) throw new Error("not from a computer of the user's");
    const sigBytes = fromBase64(sig);
    if (!sigBytes || !(await this.#o.registry.verify(from, mailStatement(from, this.#o.self, id, box), sigBytes))) throw new Error("its signature doesn't check");
    const plainBytes = this.#o.boxKey!.open(box, mailAad(from, this.#o.self, id), MAIL_INFO);
    if (!plainBytes) throw new Error("it doesn't open");
    const plain = JSON.parse(fromUtf8(plainBytes)) as { from?: unknown; to?: unknown; id?: unknown; bot?: unknown; entries?: unknown; keys?: unknown };
    if (plain.from !== from || plain.to !== this.#o.self || plain.id !== id || typeof plain.bot !== "string" || !isAnyPluginId(plain.bot)) throw new Error("not for this computer");
    if (!this.#entitled(from, plain.bot)) throw new Error("its sender doesn't keep this bot's memory");
    const r = await this.#take(plain.bot, plain.entries, from, plain.keys);
    if (!r.ok) throw new Error(`refused (${r.reason}${r.detail ? `: ${r.detail}` : ""})`);
    return r.took;
  }

  #boxKeyOf(peer: string): Bytes | undefined {
    const text = this.#o.registry.boxKey?.(peer) ?? this.#peerBoxKeys[peer];
    const k = text ? fromBase64Url(text) : null;
    return k && k.length === 32 ? k : undefined;
  }

  // ---- state ----

  #files(bot: string): Map<string, Tracked> {
    let m = this.#state.get(bot);
    if (m) return m;
    m = new Map();
    const saved = readJson(this.#stateFile(bot)) as { files?: unknown; signed?: unknown } | undefined;
    const signed: Vv = isVv(saved?.signed) ? { ...saved.signed } : {};
    if (saved && Array.isArray(saved.files)) {
      for (const f of saved.files as { key?: unknown; cur?: MemoryVersion; ctx?: unknown; mtimeMs?: unknown }[]) {
        if (typeof f.key !== "string" || !f.cur || !isVv(f.cur.vv) || !isVv(f.ctx)) continue;
        m.set(f.key, { cur: f.cur, ctx: f.ctx as Vv, ...(typeof f.mtimeMs === "number" ? { mtimeMs: f.mtimeMs } : {}) });
        const n = f.cur.vv[f.cur.by] ?? 0;
        if (n > (signed[f.cur.by] ?? 0)) signed[f.cur.by] = n;
      }
    }
    this.#state.set(bot, m);
    this.#signed.set(bot, signed);
    return m;
  }

  #save(bot: string): void {
    const files = [...this.#files(bot)].map(([key, t]) => ({ key, ...t }));
    writeJsonAtomic(this.#stateFile(bot), { v: 1, bot, files, signed: this.#signedCounters(bot) });
  }

  #stateFile(bot: string): string {
    return join(this.#o.home, "sync", "memory", `${botSegment(bot)}.json`);
  }

  #peersFile(): string {
    return join(this.#o.home, "sync", "memory-peers.json");
  }

  #root(bot: string): string {
    return botPaths(this.#o.home, bot).memory;
  }

  /** Every bot with a memory folder here, or versions this computer keeps. */
  #bots(): string[] {
    const out = new Set(this.#state.keys());
    try {
      for (const seg of readdirSync(join(this.#o.home, "bots"))) {
        const bot = pluginIdFromSegment(seg);
        if (isAnyPluginId(bot)) out.add(bot);
      }
    } catch {
      // no bots yet
    }
    try {
      for (const name of readdirSync(join(this.#o.home, "sync", "memory"))) {
        if (!name.endsWith(".json")) continue;
        const bot = pluginIdFromSegment(name.slice(0, -5));
        if (isAnyPluginId(bot)) out.add(bot);
      }
    } catch {
      // nothing synced yet
    }
    return [...out].sort();
  }

  #digest(bot: string): string {
    const lines = [...this.#files(bot)].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, t]) => `${key}\0${t.cur.hash ?? "-"}\0${vvText(t.cur.vv)}`);
    return sha256Hex(utf8(lines.join("\n")));
  }

  #have(bot: string): Record<string, Vv> {
    const out: Record<string, Vv> = {};
    for (const [key, t] of this.#files(bot)) out[key] = t.ctx;
    return out;
  }

  /** A computer of the user's that runs the core, not revoked: never a phone, a browser or a revoked device. Every
   *  such computer keeps every bot's memory, since a bot is live on every computer (the ruling on #232's S4). */
  #isComputer(id: string): boolean {
    if (id === this.#o.self) return false;
    const d = this.#o.registry.get(id);
    return d !== undefined && d.runsCore && d.revokedAt === undefined && d.kind !== "phone" && d.kind !== "browser";
  }

  #entitled(device: string, bot: string): boolean {
    if (device === this.#o.self) return true;
    if (!this.#isComputer(device)) return false;
    return this.#o.entitled ? this.#o.entitled(device, bot) : true;
  }

  #mustBeComputer(id: string): void {
    if (!this.#isComputer(id)) throw new ContractError("refused", "only a paired computer syncs");
  }

  #warn(key: string, line: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#log(line);
  }

  #log(line: string): void {
    this.#o.log?.(`[memory sync] ${line}`);
  }
}

/** The link's own request two computers trade their box keys with as their link comes up. */
export const MEMORY_HELLO = "link.memory.hello";

/** What a version's writer signs: the bot, the path, the vector, the time, the content's hash and size. */
export function versionStatement(bot: string, v: MemoryVersion): Bytes {
  return utf8(["clover-memory-v1 version", bot, v.rel, vvText(v.vv), String(v.ts), v.hash ?? "-", String(v.size)].join("\n"));
}

function mailAad(from: string, to: string, id: string): Bytes {
  return utf8(["clover-memory-v1 mail", from, to, id].join("\n"));
}

function mailStatement(from: string, to: string, id: string, box: string): Bytes {
  return utf8(["clover-memory-v1 mail", from, to, id, sha256Hex(utf8(box))].join("\n"));
}

function botOf(stream: unknown): string | undefined {
  if (typeof stream !== "string" || !stream.startsWith(PREFIX)) return undefined;
  const bot = stream.slice(PREFIX.length);
  return isAnyPluginId(bot) ? bot : undefined;
}

export function isVv(x: unknown): x is Vv {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const entries = Object.entries(x);
  return entries.length <= 256 && entries.every(([k, n]) => DEVICE_RE.test(k) && Number.isSafeInteger(n) && (n as number) > 0 && (n as number) <= MAX_COUNTER);
}

/** Whether every count in `a` is at most `b`'s: `b` has seen `a`. */
export function leq(a: Vv, b: Vv): boolean {
  return Object.entries(a).every(([k, n]) => n <= (b[k] ?? 0));
}

export function merge(a: Vv, b: Vv): Vv {
  const out = { ...a };
  for (const [k, n] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, n);
  return out;
}

export function vvText(v: Vv): string {
  return Object.keys(v).sort().map((k) => `${k}:${v[k]}`).join(",");
}

/** Of two concurrent versions, the one that stays at the path: an edit before a deletion, then the later by the shared
 *  clock, then the larger writer id. Every computer picks alike. */
export function winnerOf(a: MemoryVersion, b: MemoryVersion): MemoryVersion {
  if ((a.hash === null) !== (b.hash === null)) return a.hash === null ? b : a;
  if (a.ts !== b.ts) return a.ts > b.ts ? a : b;
  if (a.by !== b.by) return a.by > b.by ? a : b;
  return vvText(a.vv) >= vvText(b.vv) ? a : b;
}

/** The most characters a content box of `size` bytes takes: base64url of nonce, content and tag, and a little room. */
function boxChars(size: number): number {
  return Math.ceil(((size + 12 + 16) * 4) / 3) + 4;
}

/** `<stem> (conflict <tag>)<ext>` beside `rel`; undefined when that isn't a path. */
function conflictPath(rel: string, tag: string): { names: string[]; rel: string; key: string } | undefined {
  const names = rel.split("/");
  const last = names.pop()!;
  const dot = last.lastIndexOf(".");
  const stem = dot > 0 ? last.slice(0, dot) : last;
  const ext = dot > 0 ? last.slice(dot) : "";
  const p = memoryPath([...names, `${stem} (conflict ${tag})${ext}`].join("/"));
  return "refused" in p ? undefined : p;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
