// The device registry (spec §8.1; contracts/device-registry.ts): every paired device, phones and browsers included,
// kept in `<home>/devices/registry.json` (public keys, names and dates; no secret is ever in it). This device's own
// key lives in the secret store (`DeviceKey`); the registry holds its public half like any other device's.
//
// Beyond the contract it keeps what lane H's pairing and handshake need:
// * the answer key a desktop's app holds apart from the link key (item 91): the app proves it holds the key by
//   signing a statement, and only then does the registry take it. A change of key is taken only with the current
//   key's signature over the new one (`answerKeyRotateStatement`), here and at every peer, so code that can sign
//   with the link key can remove an answer key (which only takes rights away) but never put its own in. A device
//   whose key was removed or lost gets a new one only by pairing again (or, later, a card answered on another
//   device);
// * the pairs of devices paired without an account (item 81), each with this device's own signing key for the pair
//   (the controller's ruling: a signing key per device per pair, never one key both hold);
// * the group those devices form (the controller's ruling on item 85: one group record per user's account-less
//   devices, which H-M2's lease uses);
// * the guided rotation a revocation starts: the synced keys the revoked device held, to be rotated (§8.1).
import { join } from "node:path";
import type { DeviceKind, DeviceOs } from "@waifucave/clover-protocol";
import { AnswerKeyHolder, COMPUTER_NAME_RE } from "@waifucave/clover-protocol";
import type { Clock } from "../contracts/clock";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import {
  answerKeyOf, deviceIdFor, type DeviceChange, type DeviceRecord, type DeviceRegistry, type PairingProof,
} from "../contracts/device-registry";
import type { SecretMeta } from "../contracts/secret-store";
import { fromBase64, fromBase64Url, toBase64, utf8 } from "../identity/bytes";
import { encode } from "../links/codec";
import type { DeviceKey } from "../identity/device-key";
import { type AnswerKeyAlg, answerKeyBytes, publicKeyFromBase64, verifyEd25519, verifyKeySignature } from "../identity/keys";
import { readJsonFile, writeJsonFile } from "./json-file";

/** A pair of devices paired without an account (item 81). The pair's signing keys stay in the secret store. */
export interface PairRecord {
  /** Shared by both devices: chosen at pairing. */
  pairId: string;
  peer: string;
  createdAt: number;
  /** This device's signing key for this pair, public half, base64. */
  ownKey: string;
  /** The peer's signing key for this pair, public half, base64. */
  peerKey: string;
  /** The registration both devices signed (public: keys and signatures), kept until the service takes it. */
  registration?: { t: number; keys: [string, string]; sigs: [string, string] };
  /** When the handshake service took the pair's registration. */
  registeredAt?: number;
  endedAt?: number;
}

/** The user's account-less devices as one group (H-M2's lease record lives at the service under it). */
export interface GroupRecord {
  id: string;
  joinedAt: number;
  /** This device's signing key for the group, public half, base64; its seed is in the secret store. */
  ownKey: string;
  /** The members this device knows, by device id, with their group keys and when they vote (the service's last read;
   *  null: not yet known to vote). */
  members: Record<string, { key: string; since: number; votesFrom?: number | null }>;
  /** When this device votes in the group, as the service's last read said. */
  votesFrom?: number | null;
  /** How many members the service names, as of its last read (a merge's survivor rule compares these). */
  size?: number;
  /** How many of those members this device can't name (no device it knows holds the key), as of the last read: any
   *  turns off the main's exception to fencing (H-M2's check 4, L4). */
  unknownMembers?: number;
  /** The group this one replaced after this device was removed from it (group recovery's two-voter case). */
  recoveredFrom?: string;
  /** Every key ever bound to each device in this group, so a revoke removes them all (H-M2's check 2). */
  keysEver?: Record<string, string[]>;
  /** A founding or a join the service hasn't taken yet (it was unreachable), signed, to send again. */
  pendingCreate?: { group: string; key: string; t: number; sig: string };
  /** `via`: the device whose admit it is, to ask for a fresh one when this one goes stale. */
  pendingJoin?: { key: string; t: number; sig: string; by: string; bysig: string; from?: string; via?: string };
}

/** How this device left a group: moved with a merge or an invite, removed by another member, or left on its own
 *  (its revoke couldn't reach a quorum, so it started a new group). */
export type GroupLeaving = "moved" | "removed" | "left";

/** The synced keys a revoked device held, to be rotated by the user (§8.1: revoking starts a guided rotation). */
export interface RotationRecord {
  device: string;
  startedAt: number;
  items: { owner: string; name: string; rotatedAt?: number }[];
}

interface FileShape {
  v: 1;
  self: string;
  devices: DeviceRecord[];
  pairs: PairRecord[];
  group?: GroupRecord;
  rotations: RotationRecord[];
  /** The `at` of the last signed update each peer sent, so an old one can't be replayed. */
  updates: Record<string, number>;
  /** Each device's X25519 key for the handshake's account-scope boxes, base64url (lane I's need; the contract's
   *  `DeviceRecord` has no field for it yet). */
  boxKeys: Record<string, string>;
  /** This device's answer key's proofs, which its peers check before they take it (B1 of H-M1's review). */
  answerKeyProof?: AnswerKeyProof;
  /** Devices (this one too) whose answer key was removed: a new first key isn't taken for them. */
  answerKeyGone: Record<string, number>;
  /** A revocation's steps at the services that haven't been confirmed yet, to send again (S5). */
  pendingRevokes: PendingRevoke[];
  /** Groups this device left: moved out of in a merge, or was removed from by another member. It never goes back to one
   *  on its own. */
  groupsLeft: Record<string, { at: number; how: GroupLeaving }>;
}

/** What a revocation still has to tell the services, kept until each confirms (devices/account-devices.ts). */
export interface PendingRevoke {
  device: string;
  at: number;
  steps: string[];
  /** The account-less pair to end, whose keys are kept until the service has ended it. */
  pair?: string;
  /** The group and the revoked member's key in it, to remove at the service, with every other key ever bound to it. */
  group?: { id: string; member: string; others?: string[] };
}

/** What makes a peer take a device's answer key: the app's own registration of the key (signed by it), and the chain
 *  of rotations from each earlier key, each signed by the key it replaces. */
export interface AnswerKeyProof {
  /** The new key's signature over `answerKeyStatement`, base64. */
  registration: string;
  /** Oldest first; each `signature` is by `from` over `answerKeyRotateStatement`. At most `MAX_ROTATIONS` kept. */
  rotations: AnswerKeyRotation[];
}

export interface AnswerKeyRotation {
  from: string;
  to: string;
  at: number;
  signature: string;
  /** The algorithms of `from` and `to` (ed25519 when absent; B's #187). */
  fromAlg?: AnswerKeyAlg;
  toAlg?: AnswerKeyAlg;
}

/** An answer key as the registry keeps it: B's #187 adds `alg` to the contract's record; until it lands, here. */
export type AnswerKeyRecord = NonNullable<DeviceRecord["answerKey"]> & { alg?: AnswerKeyAlg };
const algOf = (k: object | undefined): AnswerKeyAlg => (k as { alg?: AnswerKeyAlg } | undefined)?.alg ?? "ed25519";

/** Long enough that a peer away for years of rotations still follows the chain (H-M1's review); a peer that can't
 *  re-anchors by pairing again. */
const MAX_ROTATIONS = 256;

const NAME_RE = /^[^\u0000-\u001f\u007f]{1,63}$/u;
const KINDS: readonly DeviceKind[] = ["desktop", "server", "cloud", "phone", "browser"];

/** What a device's app signs to show it holds an answer key. The statement covers the key's algorithm (B's #187): a
 *  P-256 key's is `clover/answer-key/2` with `alg` last; an Ed25519 key's stays `clover/answer-key/1`. */
export function answerKeyStatement(deviceId: string, publicKey: string, held: string, alg: AnswerKeyAlg = "ed25519"): Uint8Array {
  return alg === "ed25519"
    ? utf8(`clover/answer-key/1\n${deviceId}\n${publicKey}\n${held}`)
    : utf8(`clover/answer-key/2\n${deviceId}\n${publicKey}\n${held}\n${alg}`);
}

/** What the current answer key signs to hand over to the next one. */
export function answerKeyRotateStatement(deviceId: string, from: string, to: string, at: number): Uint8Array {
  return utf8(`clover/answer-key-rotate/1\n${deviceId}\n${from}\n${to}\n${at}`);
}

/** Whether `proof` carries a device's answer key from `from` (undefined: the device had none) to `to`. */
function provesAnswerKey(id: string, from: { publicKey: string; alg?: AnswerKeyAlg } | undefined, to: { publicKey: string; held: string; alg?: AnswerKeyAlg }, proof: AnswerKeyProof | undefined): boolean {
  if (!proof || typeof proof.registration !== "string" || !Array.isArray(proof.rotations)) return false;
  const next = answerKeyBytes(algOf(to), to.publicKey);
  const reg = fromBase64(proof.registration);
  if (!next || !reg || !verifyKeySignature(algOf(to), next, answerKeyStatement(id, to.publicKey, to.held, algOf(to)), reg)) return false;
  if (from === undefined || from.publicKey === to.publicKey) return true;
  // Walk the chain from the key this device knows to the new one, each step signed by the key it replaces, with that
  // key's own algorithm.
  let current = from.publicKey;
  let alg = algOf(from);
  for (const r of proof.rotations.slice(-MAX_ROTATIONS)) {
    if (!r || r.from !== current || typeof r.to !== "string" || typeof r.at !== "number" || typeof r.signature !== "string") continue;
    const k = answerKeyBytes(alg, r.from);
    const sig = fromBase64(r.signature);
    if (!k || !sig || !verifyKeySignature(alg, k, answerKeyRotateStatement(id, r.from, r.to, r.at), sig)) return false;
    current = r.to;
    alg = r.toAlg ?? "ed25519";
    if (current === to.publicKey) return true;
  }
  return false;
}

export interface FileDeviceRegistryOptions {
  /** The Clover home; the registry is `devices/registry.json` in it. */
  home: string;
  key: DeviceKey;
  self: { name: string; kind?: DeviceKind; os?: DeviceOs; computer?: string; hasDisplay?: boolean };
  clock: Pick<Clock, "now">;
  /** For a revocation's rotation list: the synced items in the secret store (names only, never values). */
  syncedSecrets?: () => Promise<SecretMeta[]>;
}

export class FileDeviceRegistry implements DeviceRegistry {
  readonly #path: string;
  readonly #clock: Pick<Clock, "now">;
  readonly #listeners = new Listeners<DeviceChange>();
  readonly #syncedSecrets: FileDeviceRegistryOptions["syncedSecrets"];
  #state: FileShape;

  private constructor(path: string, state: FileShape, opts: FileDeviceRegistryOptions) {
    this.#path = path;
    this.#state = state;
    this.#clock = opts.clock;
    this.#syncedSecrets = opts.syncedSecrets;
  }

  /** Opens the registry, writing it with this device as its first entry if it isn't there yet. A registry written
   *  for another device key is refused: the key is the device. */
  static async open(opts: FileDeviceRegistryOptions): Promise<FileDeviceRegistry> {
    const path = join(opts.home, "devices", "registry.json");
    const existing = readJsonFile<FileShape>(path);
    const kind = opts.self.kind ?? "desktop";
    const runsCore = kind === "desktop" || kind === "server" || kind === "cloud";
    if (existing) {
      if (existing.v !== 1 || existing.self !== opts.key.id) throw new ContractError("conflict", "the device registry belongs to another device key");
      return new FileDeviceRegistry(path, {
        ...existing, pairs: existing.pairs ?? [], rotations: existing.rotations ?? [], updates: existing.updates ?? {}, boxKeys: existing.boxKeys ?? {},
        answerKeyGone: existing.answerKeyGone ?? {}, pendingRevokes: existing.pendingRevokes ?? [], groupsLeft: existing.groupsLeft ?? {},
      }, opts);
    }
    if (!NAME_RE.test(opts.self.name)) throw new ContractError("invalid", "a device name is 1–63 characters");
    const self: DeviceRecord = {
      id: opts.key.id, name: opts.self.name, kind, runsCore, publicKey: opts.key.publicKeyBase64,
      addedAt: opts.clock.now(), addedBy: "self",
      ...(opts.self.os === undefined ? {} : { os: opts.self.os }),
      ...(runsCore ? { computer: ((c) => (computerNameProblem(c) === null ? c : computerNameFor(c) || "Computer"))(opts.self.computer ?? opts.self.name) } : {}),
      ...(opts.self.hasDisplay === undefined ? {} : { hasDisplay: opts.self.hasDisplay }),
    };
    const state: FileShape = { v: 1, self: self.id, devices: [self], pairs: [], rotations: [], updates: {}, boxKeys: {}, answerKeyGone: {}, pendingRevokes: [], groupsLeft: {} };
    writeJsonFile(path, state);
    return new FileDeviceRegistry(path, state, opts);
  }

  self(): DeviceRecord {
    return { ...this.#find(this.#state.self)! };
  }

  list(): DeviceRecord[] {
    return this.#state.devices.filter((d) => d.revokedAt === undefined).map((d) => ({ ...d }));
  }

  /** Every device, revoked ones too (the sidecar closes their links as revoked). */
  all(): DeviceRecord[] {
    return this.#state.devices.map((d) => ({ ...d }));
  }

  get(id: string): DeviceRecord | undefined {
    const d = this.#find(id);
    return d ? { ...d } : undefined;
  }

  async add(device: Omit<DeviceRecord, "addedAt" | "addedBy" | "revokedAt">, proof: PairingProof): Promise<DeviceRecord> {
    const existing = this.#find(device.id);
    if (existing && existing.revokedAt === undefined) throw new ContractError("conflict", `${device.id} is already paired`);
    if (existing?.revokedAt !== undefined) throw new ContractError("refused", `${device.id} was revoked; pair it again with a new key`);
    if (proof.via === "self") throw new ContractError("invalid", "only this device is added as itself");
    const key = publicKeyFromBase64(device.publicKey);
    if (!key || (await deviceIdFor(key)) !== device.id) throw new ContractError("invalid", "the id doesn't match the key");
    if (!NAME_RE.test(device.name)) throw new ContractError("invalid", "a device name is 1–63 characters");
    if (!KINDS.includes(device.kind)) throw new ContractError("invalid", `unknown device kind ${String(device.kind)}`);
    // A record's answer key as its pairing or the account gave it: its holder and algorithm must be known ones; a key
    // that doesn't fit its algorithm (a P-256 point labelled Ed25519) is kept, and simply never verifies an answer
    // (B's DeviceRegistry conformance, `answer-alg`).
    if (device.answerKey !== undefined) this.#checkAnswerKeyLabel(device.answerKey);
    // Every computer has its tree name (§9.1; lane J's ask): the one it names, if it passes lane J's rules, else one made
    // from its name; unique here ignoring case, with a `-2` on a collision (S4 of H-M1's review).
    const computer = device.runsCore ? { computer: this.#treeName(device.computer ?? device.name, device.id) } : {};
    const record: DeviceRecord = { ...stripUndefined(device), ...computer, addedAt: this.#clock.now(), addedBy: proof.via };
    this.#state.devices.push(record);
    this.#save();
    this.#listeners.emit({ type: "added", device: { ...record } });
    return { ...record };
  }

  async revoke(id: string, reason?: string): Promise<void> {
    if (id === this.#state.self) throw new ContractError("refused", "this device can't revoke itself");
    const d = this.#find(id);
    if (!d) throw new ContractError("not_found", `no device ${id}`);
    if (d.revokedAt !== undefined) return;
    d.revokedAt = this.#clock.now();
    for (const p of this.#state.pairs) if (p.peer === id && p.endedAt === undefined) p.endedAt = d.revokedAt;
    if (this.#state.group) delete this.#state.group.members[id];
    const synced = this.#syncedSecrets ? await this.#syncedSecrets().catch(() => []) : [];
    if (synced.length > 0) {
      this.#state.rotations.push({
        device: id, startedAt: d.revokedAt,
        items: synced.filter((m) => m.synced).map((m) => ({ owner: m.ref.owner.kind === "plugin" ? `plugin:${m.ref.owner.pluginId}` : m.ref.owner.kind, name: m.ref.name })),
      });
    }
    this.#save();
    this.#listeners.emit({ type: "revoked", id, ...(reason === undefined ? {} : { reason }) });
  }

  async rename(id: string, name: string): Promise<void> {
    const d = this.#find(id);
    if (!d || d.revokedAt !== undefined) throw new ContractError("not_found", `no device ${id}`);
    if (!NAME_RE.test(name)) throw new ContractError("invalid", "a device name is 1–63 characters");
    d.name = name;
    // A computer's tree name follows its name (§9.1; lane J keeps the old one as an alias). This device's own change
    // reaches every peer's device list over the link (`shareDeviceUpdates`), since a hello no longer renames.
    if (d.runsCore) d.computer = this.#treeName(name, id);
    this.#save();
    this.#listeners.emit({ type: "changed", device: { ...d } });
  }

  async verify(id: string, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    const d = this.#find(id);
    if (!d || d.revokedAt !== undefined) return false;
    const key = fromBase64(d.publicKey);
    return key !== null && verifyEd25519(key, data, signature);
  }

  async verifyAnswer(id: string, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    const d = this.#find(id);
    // Never a phone's link key (the controller's ruling, item 91): only the answer key its record names. On main,
    // `answerKeyOf` still falls back to a phone's link key; lane B's #234 drops that fallback, and with it on main the
    // phone check here is redundant and goes.
    const keyText = d === undefined || (d.kind === "phone" && d.answerKey === undefined) ? undefined : answerKeyOf(d);
    if (keyText === undefined) return false;
    // With the key's own algorithm: a phone's Secure Enclave key is P-256 (B's #187).
    const alg = algOf(d!.answerKey as AnswerKeyRecord | undefined);
    const key = answerKeyBytes(alg, keyText);
    return key !== null && verifyKeySignature(alg, key, data, signature);
  }

  watch(fn: (change: DeviceChange) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }

  /** Records that a device was seen over its link. */
  seen(id: string): void {
    const d = this.#find(id);
    if (!d || d.revokedAt !== undefined) return;
    d.lastSeenAt = this.#clock.now();
    this.#save();
  }

  // ---- the answer key (item 91) ----

  /** Takes this device's app's answer key, after checking the app signed `answerKeyStatement` with it. A different key
   *  from the one held needs the held key's signature handing over to it (`rotation`, `answerKeyRotateStatement`); a
   *  first key after one was removed isn't taken (pair again). */
  async setOwnAnswerKey(
    publicKey: string, held: AnswerKeyHolder, signature: Uint8Array, rotation?: { from: string; at: number; signature: Uint8Array }, alg: AnswerKeyAlg = "ed25519",
  ): Promise<DeviceRecord> {
    this.#checkAnswerKey({ publicKey, held, alg });
    const self = this.#find(this.#state.self)!;
    if (self.kind !== "desktop" && self.kind !== "phone") throw new ContractError("refused", "only a desktop's or a phone's app holds an answer key apart from the link key");
    const key = answerKeyBytes(alg, publicKey)!;
    if (!verifyKeySignature(alg, key, answerKeyStatement(self.id, publicKey, held, alg), signature)) throw new ContractError("refused", "the app didn't sign the answer key's statement");
    const held0 = self.answerKey as AnswerKeyRecord | undefined;
    const current = held0?.publicKey;
    const rotations = [...(this.#state.answerKeyProof?.rotations ?? [])];
    if (current !== undefined && current !== publicKey) {
      if (!rotation || rotation.from !== current) throw new ContractError("refused", "a new answer key needs the current one's signature handing over to it");
      if (!verifyKeySignature(algOf(held0), answerKeyBytes(algOf(held0), current)!, answerKeyRotateStatement(self.id, current, publicKey, rotation.at), rotation.signature)) {
        throw new ContractError("refused", "the current answer key didn't sign the hand-over");
      }
      rotations.push({
        from: current, to: publicKey, at: rotation.at, signature: toBase64(rotation.signature),
        ...(algOf(held0) === "ed25519" ? {} : { fromAlg: algOf(held0) }), ...(alg === "ed25519" ? {} : { toAlg: alg }),
      });
    } else if (current === undefined && this.#state.answerKeyGone[self.id] !== undefined) {
      throw new ContractError("refused", "this device's answer key was removed: pair it again to answer cards");
    }
    self.answerKey = { publicKey, held, ...(alg === "ed25519" ? {} : { alg }) } as AnswerKeyRecord;
    this.#state.answerKeyProof = { registration: toBase64(signature), rotations: rotations.slice(-MAX_ROTATIONS) };
    this.#save();
    this.#listeners.emit({ type: "changed", device: { ...self } });
    return { ...self };
  }

  /** Removes this device's answer key (the app lost it, or the user turned answering off). Peers drop it too, and a
   *  new one takes pairing again. */
  clearOwnAnswerKey(): void {
    const self = this.#find(this.#state.self)!;
    if (!self.answerKey) return;
    delete self.answerKey;
    delete this.#state.answerKeyProof;
    this.#state.answerKeyGone[self.id] = this.#clock.now();
    this.#save();
    this.#listeners.emit({ type: "changed", device: { ...self } });
  }

  /** This device's answer key's proofs, for its peers (`shareDeviceUpdates`). */
  ownAnswerKeyProof(): AnswerKeyProof | undefined {
    const p = this.#state.answerKeyProof;
    return p ? { registration: p.registration, rotations: p.rotations.map((r) => ({ ...r })) } : undefined;
  }

  /** Takes a peer's new answer key or name from what it sent, signed with its link key (`peerUpdateStatement`). A new
   *  answer key also needs `proof`: the key's own registration and, when the peer had one before, the chain of
   *  hand-overs from it (B1). Removing it needs only the link key. */
  async applyPeerUpdate(id: string, update: PeerUpdate, signature: Uint8Array, proof?: AnswerKeyProof): Promise<boolean> {
    const d = this.#find(id);
    if (!d || d.revokedAt !== undefined || id === this.#state.self) return false;
    if (!(await this.verify(id, peerUpdateStatement(id, update), signature))) return false;
    if (update.at <= (this.#state.updates[id] ?? 0)) return false;
    if (update.answerKey) {
      try {
        this.#checkAnswerKey(update.answerKey);
      } catch {
        return false;
      }
      const current = d.answerKey as AnswerKeyRecord | undefined;
      const same = current !== undefined && current.publicKey === update.answerKey.publicKey && current.held === update.answerKey.held && algOf(current) === algOf(update.answerKey);
      if (!same) {
        if (current === undefined && this.#state.answerKeyGone[id] !== undefined) return false;
        if (!provesAnswerKey(id, current, update.answerKey, proof)) return false;
      }
    }
    if (update.name !== undefined) {
      if (!NAME_RE.test(update.name)) return false;
      d.name = update.name;
    }
    if (update.computer !== undefined && d.runsCore) {
      if (computerNameProblem(update.computer) !== null) return false;
      d.computer = this.#treeName(update.computer, id);
    }
    if (update.answerKey === null) {
      if (d.answerKey) this.#state.answerKeyGone[id] = this.#clock.now();
      delete d.answerKey;
    } else if (update.answerKey !== undefined) d.answerKey = { ...update.answerKey };
    this.#state.updates[id] = update.at;
    this.#save();
    this.#listeners.emit({ type: "changed", device: { ...d } });
    return true;
  }

  #checkAnswerKeyLabel(k: { publicKey: string; held: string; alg?: unknown }): void {
    if (k.alg !== undefined && k.alg !== "ed25519" && k.alg !== "p256") throw new ContractError("invalid", `unknown answer key algorithm ${String(k.alg)}`);
    if (typeof k.publicKey !== "string" || fromBase64(k.publicKey) === null) throw new ContractError("invalid", "an answer key is base64");
    if (!AnswerKeyHolder.safeParse(k.held).success) throw new ContractError("invalid", `unknown answer key holder ${k.held}`);
  }

  #checkAnswerKey(k: { publicKey: string; held: string; alg?: unknown }): void {
    if (k.alg !== undefined && k.alg !== "ed25519" && k.alg !== "p256") throw new ContractError("invalid", `unknown answer key algorithm ${String(k.alg)}`);
    if (!answerKeyBytes(algOf(k as { alg?: AnswerKeyAlg }), k.publicKey)) throw new ContractError("invalid", "an answer key is a 32-byte Ed25519 key, or a P-256 key's 65-byte point");
    if (!AnswerKeyHolder.safeParse(k.held).success) throw new ContractError("invalid", `unknown answer key holder ${k.held}`);
  }

  // ---- pairs and the group (items 81 and 85) ----

  pairs(): PairRecord[] {
    return this.#state.pairs.map((p) => ({ ...p }));
  }

  pairWith(peer: string): PairRecord | undefined {
    const p = this.#state.pairs.find((x) => x.peer === peer && x.endedAt === undefined);
    return p ? { ...p } : undefined;
  }

  addPair(p: Omit<PairRecord, "createdAt">): PairRecord {
    if (this.#state.pairs.some((x) => x.pairId === p.pairId)) throw new ContractError("conflict", `pair ${p.pairId} exists`);
    const d = this.#find(p.peer);
    if (!d || d.revokedAt !== undefined) throw new ContractError("not_found", `no device ${p.peer}`);
    const record: PairRecord = { ...p, createdAt: this.#clock.now() };
    this.#state.pairs.push(record);
    this.#save();
    return { ...record };
  }

  /** A pair registration signed again (its statements' `t` had passed the service's window). */
  setPairRegistration(pairId: string, registration: NonNullable<PairRecord["registration"]>): void {
    const p = this.#state.pairs.find((x) => x.pairId === pairId);
    if (!p) throw new ContractError("not_found", `no pair ${pairId}`);
    p.registration = { t: registration.t, keys: [...registration.keys], sigs: [...registration.sigs] };
    this.#save();
  }

  markPairRegistered(pairId: string): void {
    const p = this.#state.pairs.find((x) => x.pairId === pairId);
    if (!p) throw new ContractError("not_found", `no pair ${pairId}`);
    p.registeredAt = this.#clock.now();
    this.#save();
  }

  group(): GroupRecord | undefined {
    return this.#state.group ? { ...this.#state.group, members: { ...this.#state.group.members } } : undefined;
  }

  setGroup(group: GroupRecord): void {
    this.#state.group = { ...group, members: { ...group.members } };
    this.#save();
  }

  /** Binds a device's member key: from a confirmed pairing, an invited move, or a key the device proved it holds and
   *  the service lists. A bound key is never overwritten, and a key bound to one device is never bound to another
   *  (H-M2's check 2). False when it isn't bound. */
  addGroupMember(device: string, key: string): boolean {
    const g = this.#state.group;
    if (!g) throw new ContractError("not_found", "no group");
    const bound = g.members[device];
    if (bound) return bound.key === key;
    if (key === g.ownKey || Object.values(g.members).some((m) => m.key === key)) return false;
    g.members[device] = { key, since: this.#clock.now() };
    const ever = (g.keysEver ??= {});
    ever[device] = [...new Set([...(ever[device] ?? []), key])];
    this.#save();
    return true;
  }

  /** Every key this group record ever bound to `device` (its current one among them). */
  groupKeysOf(device: string): string[] {
    const g = this.#state.group;
    if (!g) return [];
    return [...new Set([...(g.keysEver?.[device] ?? []), ...(g.members[device] ? [g.members[device].key] : [])])];
  }

  /** What the service's read of the group says: who votes from when, and how many members it has. A member the read
   *  doesn't name is kept (a read can cross a join in flight); a revoke drops it. */
  groupRead(group: string, read: { size: number; self?: number | null; members: Record<string, number | null | undefined>; unknown?: number }): void {
    const g = this.#state.group;
    if (!g || g.id !== group) return;
    g.size = read.size;
    if (read.unknown !== undefined) g.unknownMembers = read.unknown;
    if (read.self !== undefined) g.votesFrom = read.self;
    for (const [device, m] of Object.entries(g.members)) if (device in read.members) m.votesFrom = read.members[device] ?? null;
    this.#save();
  }

  /** Leaves the group record behind (merged into another, or removed from it); the next `setGroup` names the new one. */
  leaveGroup(how: GroupLeaving): void {
    const g = this.#state.group;
    if (!g) return;
    this.#state.groupsLeft[g.id] = { at: this.#clock.now(), how };
    delete this.#state.group;
    this.#save();
  }

  groupLeft(id: string): { at: number; how: GroupLeaving } | undefined {
    const l = this.#state.groupsLeft[id];
    return l ? { ...l } : undefined;
  }

  // ---- box keys (the handshake's account scope) ----

  /** A device's X25519 key, base64url: this device's own, or one the account's device list gave. */
  boxKey(id: string): string | undefined {
    const d = this.#find(id);
    return d && d.revokedAt === undefined ? this.#state.boxKeys[id] : undefined;
  }

  setBoxKey(id: string, key: string): void {
    const raw = fromBase64Url(key);
    if (!raw || raw.length !== 32) throw new ContractError("invalid", "an X25519 key is 32 bytes");
    if (!this.#find(id)) throw new ContractError("not_found", `no device ${id}`);
    if (this.#state.boxKeys[id] === key) return;
    this.#state.boxKeys[id] = key;
    this.#save();
  }

  // ---- a revocation's steps at the services (S5) ----

  pendingRevokes(): PendingRevoke[] {
    return this.#state.pendingRevokes.map((r) => ({ ...r, steps: [...r.steps], ...(r.group ? { group: { ...r.group, ...(r.group.others ? { others: [...r.group.others] } : {}) } } : {}) }));
  }

  addPendingRevoke(r: Omit<PendingRevoke, "at">): void {
    if (r.steps.length === 0) return;
    this.#state.pendingRevokes = [...this.#state.pendingRevokes.filter((x) => x.device !== r.device), { ...r, at: this.#clock.now() }];
    this.#save();
  }

  /** A step the service confirmed. */
  doneRevokeStep(device: string, step: string): void {
    const r = this.#state.pendingRevokes.find((x) => x.device === device);
    if (!r) return;
    r.steps = r.steps.filter((s) => s !== step);
    if (r.steps.length === 0) this.#state.pendingRevokes = this.#state.pendingRevokes.filter((x) => x !== r);
    this.#save();
  }

  // ---- rotation (§8.1) ----

  rotations(): RotationRecord[] {
    return this.#state.rotations.map((r) => ({ ...r, items: r.items.map((i) => ({ ...i })) }));
  }

  markRotated(device: string, owner: string, name: string): void {
    for (const r of this.#state.rotations) {
      if (r.device !== device) continue;
      for (const i of r.items) if (i.owner === owner && i.name === name && i.rotatedAt === undefined) i.rotatedAt = this.#clock.now();
    }
    this.#save();
  }

  #find(id: string): DeviceRecord | undefined {
    return this.#state.devices.find((d) => d.id === id);
  }

  /** A tree name for device `id` from `want`: `want` if it passes lane J's rules, else one made from it; then unique
   *  among this registry's other computers ignoring case (`Studio`, `Studio-2`, `Studio-3`…). */
  #treeName(want: string, id: string): string {
    let base = computerNameProblem(want) === null ? want : computerNameFor(want);
    if (computerNameProblem(base) !== null) base = "Computer";
    const taken = new Set(this.#state.devices.filter((d) => d.id !== id && d.revokedAt === undefined && d.computer).map((d) => d.computer!.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
      const suffix = `-${n}`;
      const name = `${base.slice(0, 63 - suffix.length).replace(/-+$/, "")}${suffix}`;
      if (!taken.has(name.toLowerCase()) && computerNameProblem(name) === null) return name;
    }
  }

  #save(): void {
    writeJsonFile(this.#path, this.#state);
  }
}

/** What a device signs to tell its peers about a new name or answer key. */
export interface PeerUpdate {
  name?: string;
  /** A computer's tree name. */
  computer?: string;
  answerKey?: { publicKey: string; held: AnswerKeyHolder; alg?: AnswerKeyAlg } | null;
  at: number;
}

/** The update as signed: canonical CBOR, so no field's value can read as another's or as "no change". */
export function peerUpdateStatement(id: string, update: { name?: string; computer?: string; answerKey?: { publicKey: string; held: string; alg?: AnswerKeyAlg } | null; at: number }): Uint8Array {
  // A P-256 key's algorithm is signed too (B's #187); an Ed25519 key's update reads as before.
  const ak = update.answerKey === undefined ? ["keep"] : update.answerKey === null ? ["none"]
    : algOf(update.answerKey) === "ed25519" ? ["key", update.answerKey.publicKey, update.answerKey.held] : ["key", update.answerKey.publicKey, update.answerKey.held, algOf(update.answerKey)];
  return encode(["clover/device-update/3", id, update.at, update.name === undefined ? ["keep"] : ["set", update.name], update.computer === undefined ? ["keep"] : ["set", update.computer], ak]);
}

/** Names Windows keeps for devices, which lane J's tree refuses as a computer's name. */
const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Why `name` can't be a computer's tree name, by lane J's rules (letters, digits and single hyphens, at most 63, and
 *  no name Windows keeps for a device); null when it can. */
export function computerNameProblem(name: string): string | null {
  if (name.length === 0 || name.length > 63 || !COMPUTER_NAME_RE.test(name)) return "a computer's name is letters, digits and hyphens";
  if (WINDOWS_DEVICE_NAMES.test(name)) return `${name} is a name Windows keeps for a device`;
  return null;
}

/** A computer's tree name from its display name: letters and digits, the rest as single hyphens (`Studio 2` →
 *  `Studio-2`); empty when nothing usable is left. */
export function computerNameFor(name: string): string {
  return name.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, "");
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
