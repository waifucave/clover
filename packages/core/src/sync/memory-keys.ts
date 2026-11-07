// The content keys a bot's memory travels under (H-M3, item 4 of the brief): what one computer sends another, over a
// link or as mail a relay keeps, is sealed under a content key only the user's current computers hold.
//
// * **A key** is 32 random bytes, named `<epoch>.<creator>`, with the computers it was made for (`members`): every
//   computer of the user that ran the core, wasn't revoked and was known to its creator then. Its bytes live in the
//   secret store as a device item (never synced, never on disk in the clear); what's known about it is in
//   `<home>/sync/memory-keys.json`.
// * **Sealing** to a peer uses the newest key made for both computers whose members include no device this computer
//   knows as revoked, or one it doesn't know at all. With none, this computer makes one with the next epoch. So a
//   revoked device's keys are never used again (the brief: rotated on revoke), and a computer added later gets a key
//   made after it joined, never an older one; it gets older memory re-sealed under the new key.
// * **Signed by its creator** (#232's review, B1): the record (kid, epoch, members, creation time and a commitment to
//   the bytes) carries its creator's link-key signature, checked against this computer's own registry. The creator
//   must be a known computer of the user's, not revoked, among the members, and the kid's id part must be its own: no
//   computer can make a key in another's name or claim another's next kid.
// * **Sharing:** a key goes only to a member, over the link or sealed to it in mail, and is taken only from a member
//   that names this computer as one too, only for the kids a push's checked entries use. A key whose members include a
//   revoked device is dropped; an epoch may run at most `EPOCH_STEP` past the newest this computer knows; and each
//   creator keeps at most `PER_CREATOR` keys here (its oldest go first), so no one computer can fill the ring.
// * What a revoked device already holds can't be clawed back: the memory it had, and keys it had, stay with it. It gets
//   nothing new: its links are cut, no mail is addressed to it, and nothing is sealed under a key it holds.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { SecretRef, SecretStore } from "../contracts/secret-store";
import type { DeviceRecord } from "../contracts/device-registry";
import { type Bytes, concat, fromBase64, fromBase64Url, own, toBase64, toBase64Url, utf8 } from "../identity/bytes";
import { readJson, writeJsonAtomic } from "../sessions/atomic-file";

export interface ContentKeyInfo {
  kid: string;
  epoch: number;
  creator: string;
  members: string[];
  createdAt: number;
  /** SHA-256 over the key's bytes (with a label), hex: what the creator's signature binds them by. */
  commit: string;
  /** The creator's link-key signature over `keyStatement`, base64. */
  sig: string;
}

/** A key as it travels to a member: its record and its bytes, base64. */
export interface SharedContentKey extends ContentKeyInfo {
  key: string;
}

const KID_RE = /^([1-9][0-9]{0,9})\.([a-z0-9]{16,64})$/;
const DEVICE_RE = /^[a-z0-9]{16,64}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
export const MAX_MEMBERS = 64;
/** How far past the newest epoch this computer knows a key's epoch may be. */
export const EPOCH_STEP = 4_096;
export const MAX_EPOCH = 2 ** 31 - 1;
/** Keys kept per creator; past it, that creator's oldest go. */
export const PER_CREATOR = 32;
/** Keys one share carries at most. */
const MAX_SHARED = 16;

const refOf = (kid: string): SecretRef => ({ owner: { kind: "device" }, name: `memory-key:${kid}` });

export class ContentKeyRing {
  readonly #self: string;
  readonly #store: Pick<SecretStore, "get" | "set">;
  readonly #file: string;
  readonly #registry: ContentKeyRingOptions["registry"];
  readonly #sign: (data: Uint8Array) => Uint8Array;
  readonly #now: () => number;
  readonly #keys = new Map<string, ContentKeyInfo>();
  readonly #bytes = new Map<string, Bytes>();
  #making: Promise<ContentKeyInfo> | undefined;

  private constructor(o: ContentKeyRingOptions) {
    this.#self = o.self;
    this.#store = o.store;
    this.#file = join(o.home, "sync", "memory-keys.json");
    this.#registry = o.registry;
    this.#sign = o.sign;
    this.#now = o.now;
  }

  static async open(o: ContentKeyRingOptions): Promise<ContentKeyRing> {
    const ring = new ContentKeyRing(o);
    const saved = readJson(ring.#file) as { keys?: unknown } | undefined;
    for (const k of Array.isArray(saved?.keys) ? saved.keys : []) {
      const info = infoOf(k);
      if (!info) continue;
      const v = await o.store.get(refOf(info.kid));
      const raw = v ? fromBase64(v.value.reveal()) : null;
      if (!raw || raw.length !== 32 || commitOf(raw) !== info.commit) continue;
      ring.#keys.set(info.kid, info);
      ring.#bytes.set(info.kid, raw);
    }
    return ring;
  }

  list(): ContentKeyInfo[] {
    return [...this.#keys.values()].map((k) => ({ ...k, members: [...k.members] }));
  }

  has(kid: string): boolean {
    return this.#bytes.has(kid);
  }

  /** The key to seal to `peers` under, made if there is none fit for them. */
  async sealingKey(peers: readonly string[]): Promise<ContentKeyInfo> {
    if (this.#making) await this.#making.catch(() => undefined);
    const fit = this.#fit(peers);
    if (fit) return fit;
    return this.rotate();
  }

  /** Makes a new key for every current computer (on a revocation, or when no key fits). */
  async rotate(): Promise<ContentKeyInfo> {
    // One at a time: two at once would name the same epoch.
    const making = (this.#making ?? Promise.resolve()).catch(() => undefined).then(() => this.#make());
    this.#making = making;
    try {
      return await making;
    } finally {
      if (this.#making === making) this.#making = undefined;
    }
  }

  async #make(): Promise<ContentKeyInfo> {
    const epoch = Math.min(MAX_EPOCH, this.#highest() + 1);
    const members = [this.#self, ...this.#registry.list().filter((d) => d.runsCore && d.revokedAt === undefined && d.id !== this.#self).map((d) => d.id)].slice(0, MAX_MEMBERS);
    const bytes = own(randomBytes(32));
    const unsigned = { kid: `${epoch}.${this.#self}`, epoch, creator: this.#self, members, createdAt: this.#now(), commit: commitOf(bytes) };
    const info: ContentKeyInfo = { ...unsigned, sig: toBase64(this.#sign(keyStatement(unsigned))) };
    await this.#add(info, bytes);
    return info;
  }

  #highest(): number {
    return Math.max(0, ...[...this.#keys.values()].map((k) => k.epoch));
  }

  /** The keys `peer` is a member of, with their bytes, for sharing over a sealed path. */
  sharedWith(peer: string, kids?: readonly string[]): SharedContentKey[] {
    const out: SharedContentKey[] = [];
    for (const k of this.#keys.values()) {
      if (kids && !kids.includes(k.kid)) continue;
      if (!k.members.includes(peer) || this.#unsafe(peer)) continue;
      out.push({ ...k, members: [...k.members], key: toBase64(this.#bytes.get(k.kid)!) });
    }
    return out;
  }

  /** Takes keys a member shared, for `kids` only (the ones a push's checked entries use): each signed by its creator,
   *  a known computer of the user's, not revoked and among the members; naming this computer and the sender as members
   *  too, and no revoked device; its epoch within `EPOCH_STEP` of the newest known here. Returns how many were new. */
  async take(keys: unknown, from: string, kids: ReadonlySet<string>): Promise<number> {
    if (!Array.isArray(keys) || kids.size === 0) return 0;
    let n = 0;
    for (const raw of keys.slice(0, MAX_SHARED)) {
      const info = infoOf(raw);
      const bytes = typeof (raw as { key?: unknown }).key === "string" ? fromBase64((raw as { key: string }).key) : null;
      if (!info || !bytes || bytes.length !== 32 || !kids.has(info.kid) || this.#keys.has(info.kid)) continue;
      if (commitOf(bytes) !== info.commit) continue;
      if (!info.members.includes(this.#self) || !info.members.includes(from) || !info.members.includes(info.creator)) continue;
      if (info.members.some((m) => this.#registry.get(m)?.revokedAt !== undefined)) continue;
      if (info.epoch > this.#highest() + EPOCH_STEP) continue;
      const creator = this.#registry.get(info.creator);
      if (!creator || creator.revokedAt !== undefined || !creator.runsCore) continue;
      const sig = fromBase64(info.sig);
      if (!sig || !(await this.#registry.verify(info.creator, keyStatement(info), sig))) continue;
      await this.#add(info, bytes);
      n++;
    }
    return n;
  }

  /** `nonce (12) || AES-256-GCM(key, nonce, plaintext, aad)`, base64url. */
  seal(kid: string, aad: Uint8Array, plaintext: Uint8Array): string {
    const key = this.#bytes.get(kid);
    if (!key) throw new Error(`no content key ${kid}`);
    const nonce = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, nonce);
    c.setAAD(aad);
    return toBase64Url(concat(nonce, c.update(plaintext), c.final(), c.getAuthTag()));
  }

  /** Undefined for a key this computer doesn't hold or a box that doesn't open. */
  open(kid: string, aad: Uint8Array, box: string): Bytes | undefined {
    const key = this.#bytes.get(kid);
    const bytes = fromBase64Url(box);
    if (!key || !bytes || bytes.length < 12 + 16) return undefined;
    try {
      const d = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      d.setAAD(aad);
      d.setAuthTag(bytes.subarray(bytes.length - 16));
      return concat(d.update(bytes.subarray(12, bytes.length - 16)), d.final());
    } catch {
      return undefined;
    }
  }

  #fit(peers: readonly string[]): ContentKeyInfo | undefined {
    let best: ContentKeyInfo | undefined;
    for (const k of this.#keys.values()) {
      if (!k.members.includes(this.#self) || peers.some((p) => !k.members.includes(p))) continue;
      if (k.members.some((m) => m !== this.#self && this.#unsafe(m))) continue;
      if (!best || k.epoch > best.epoch || (k.epoch === best.epoch && k.creator > best.creator)) best = k;
    }
    return best;
  }

  /** A device no key may be sealed for: one revoked, or one this computer doesn't know. */
  #unsafe(id: string): boolean {
    const d = this.#registry.get(id);
    return d === undefined || d.revokedAt !== undefined;
  }

  async #add(info: ContentKeyInfo, bytes: Uint8Array): Promise<void> {
    await this.#store.set(refOf(info.kid), toBase64(bytes), { synced: false });
    this.#keys.set(info.kid, info);
    this.#bytes.set(info.kid, own(bytes));
    // One creator keeps `PER_CREATOR` keys here at most: its oldest go (their bytes stay in the store, unused).
    const mine = [...this.#keys.values()].filter((k) => k.creator === info.creator).sort((a, b) => a.epoch - b.epoch);
    for (const k of mine.slice(0, Math.max(0, mine.length - PER_CREATOR))) {
      this.#keys.delete(k.kid);
      this.#bytes.delete(k.kid);
    }
    writeJsonAtomic(this.#file, { v: 2, keys: [...this.#keys.values()] });
  }
}

export interface ContentKeyRingOptions {
  self: string;
  home: string;
  store: Pick<SecretStore, "get" | "set">;
  registry: { get(id: string): DeviceRecord | undefined; list(): DeviceRecord[]; verify(id: string, data: Uint8Array, signature: Uint8Array): Promise<boolean> };
  /** Signs this computer's key records with its link key. */
  sign(data: Uint8Array): Uint8Array;
  now: () => number;
}

function infoOf(raw: unknown): ContentKeyInfo | undefined {
  const k = raw as Partial<ContentKeyInfo> | undefined;
  if (!k || typeof k.kid !== "string" || typeof k.epoch !== "number" || typeof k.creator !== "string" || !Array.isArray(k.members)) return undefined;
  if (typeof k.commit !== "string" || !HEX64_RE.test(k.commit) || typeof k.sig !== "string" || typeof k.createdAt !== "number" || !Number.isSafeInteger(k.createdAt)) return undefined;
  const m = KID_RE.exec(k.kid);
  if (!m || Number(m[1]) !== k.epoch || k.epoch > MAX_EPOCH || m[2] !== k.creator) return undefined;
  const members = k.members.filter((x): x is string => typeof x === "string" && DEVICE_RE.test(x));
  if (members.length !== k.members.length || members.length === 0 || members.length > MAX_MEMBERS || new Set(members).size !== members.length) return undefined;
  return { kid: k.kid, epoch: k.epoch, creator: k.creator, members, createdAt: k.createdAt, commit: k.commit, sig: k.sig };
}

/** What a key's creator signs: its kid, epoch, members (in its order), creation time and the commitment to its bytes. */
export function keyStatement(k: Omit<ContentKeyInfo, "sig">): Bytes {
  return utf8(["clover-memory-v1 key", k.kid, String(k.epoch), k.members.join(","), String(k.createdAt), k.commit].join("\n"));
}

/** The commitment to a key's bytes a key record carries. */
export function keyCommit(bytes: Uint8Array): string {
  return commitOf(bytes);
}

function commitOf(bytes: Uint8Array): string {
  return createHash("sha256").update("clover-memory-v1 key commit\n").update(bytes).digest("hex");
}

/** The `aad` of a memory file's content box: it binds the box to its key, bot, file and content. */
export function contentAad(c: { kid: string; bot: string; key: string; hash: string }): Bytes {
  return utf8(["clover-memory-v1 content", c.kid, c.bot, c.key, c.hash].join("\n"));
}
