// The device registry (spec §8.1; contracts/device-registry.ts): every paired device, phones and browsers included,
// kept in `<home>/devices/registry.json` (public keys, names and dates; no secret is ever in it). This device's own
// key lives in the secret store (`DeviceKey`); the registry holds its public half like any other device's.
//
// Beyond the contract it keeps what lane H's pairing and handshake need:
// * the answer key a desktop's app holds apart from the link key (item 91): the app proves it holds the key by
//   signing a statement, and only then does the registry take it;
// * the pairs of devices paired without an account (item 81), each with this device's own signing key for the pair
//   (the controller's ruling: a signing key per device per pair, never one key both hold);
// * the group those devices form (the controller's ruling on item 85: one group record per user's account-less
//   devices, which H-M2's lease uses);
// * the guided rotation a revocation starts: the synced keys the revoked device held, to be rotated (§8.1).
import { join } from "node:path";
import type { DeviceKind, Os } from "@waifucave/clover-protocol";
import { AnswerKeyHolder, COMPUTER_NAME_RE } from "@waifucave/clover-protocol";
import type { Clock } from "../contracts/clock";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import {
  answerKeyOf, deviceIdFor, type DeviceChange, type DeviceRecord, type DeviceRegistry, type PairingProof,
} from "../contracts/device-registry";
import type { SecretMeta } from "../contracts/secret-store";
import { fromBase64, fromBase64Url, utf8 } from "../identity/bytes";
import type { DeviceKey } from "../identity/device-key";
import { publicKeyFromBase64, verifyEd25519 } from "../identity/keys";
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
  /** The members this device knows, by device id, with their group keys. */
  members: Record<string, { key: string; since: number }>;
  /** A founding or a join the service hasn't taken yet (it was unreachable), signed, to send again. */
  pendingCreate?: { group: string; key: string; t: number; sig: string };
  pendingJoin?: { key: string; t: number; sig: string; by: string; bysig: string };
}

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
}

const NAME_RE = /^[^\u0000-\u001f\u007f]{1,63}$/u;
const KINDS: readonly DeviceKind[] = ["desktop", "server", "cloud", "phone", "browser"];

/** What a desktop's app signs to show the core it holds an answer key. */
export function answerKeyStatement(deviceId: string, publicKey: string, held: string): Uint8Array {
  return utf8(`clover/answer-key/1\n${deviceId}\n${publicKey}\n${held}`);
}

export interface FileDeviceRegistryOptions {
  /** The Clover home; the registry is `devices/registry.json` in it. */
  home: string;
  key: DeviceKey;
  self: { name: string; kind?: DeviceKind; os?: Os; computer?: string; hasDisplay?: boolean };
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
      return new FileDeviceRegistry(path, { ...existing, pairs: existing.pairs ?? [], rotations: existing.rotations ?? [], updates: existing.updates ?? {}, boxKeys: existing.boxKeys ?? {} }, opts);
    }
    if (!NAME_RE.test(opts.self.name)) throw new ContractError("invalid", "a device name is 1–63 characters");
    const self: DeviceRecord = {
      id: opts.key.id, name: opts.self.name, kind, runsCore, publicKey: opts.key.publicKeyBase64,
      addedAt: opts.clock.now(), addedBy: "self",
      ...(opts.self.os === undefined ? {} : { os: opts.self.os }),
      ...(runsCore ? { computer: opts.self.computer ?? (computerNameFor(opts.self.name) || "Computer") } : {}),
      ...(opts.self.hasDisplay === undefined ? {} : { hasDisplay: opts.self.hasDisplay }),
    };
    const state: FileShape = { v: 1, self: self.id, devices: [self], pairs: [], rotations: [], updates: {}, boxKeys: {} };
    writeJsonFile(path, state);
    return new FileDeviceRegistry(path, state, opts);
  }

  self(): DeviceRecord {
    return { ...this.#find(this.#state.self)! };
  }

  list(): DeviceRecord[] {
    return this.#state.devices.filter((d) => d.revokedAt === undefined).map((d) => ({ ...d }));
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
    if (device.answerKey !== undefined) this.#checkAnswerKey(device.answerKey);
    // Every computer has its tree name (§9.1; lane J's ask): a device that runs clover-core and names none takes its own.
    const computer = device.runsCore ? { computer: device.computer ?? (computerNameFor(device.name) || "Computer") } : {};
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
    if (d.runsCore) {
      const tree = computerNameFor(name);
      if (tree) d.computer = tree;
    }
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
    const keyText = d === undefined ? undefined : answerKeyOf(d);
    if (keyText === undefined) return false;
    const key = fromBase64(keyText);
    return key !== null && verifyEd25519(key, data, signature);
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

  /** Takes this device's app's answer key, after checking the app signed `answerKeyStatement` with it. */
  async setOwnAnswerKey(publicKey: string, held: AnswerKeyHolder, signature: Uint8Array): Promise<DeviceRecord> {
    this.#checkAnswerKey({ publicKey, held });
    const self = this.#find(this.#state.self)!;
    if (self.kind !== "desktop") throw new ContractError("refused", "only a desktop's app holds an answer key apart from the core's");
    const key = publicKeyFromBase64(publicKey)!;
    if (!verifyEd25519(key, answerKeyStatement(self.id, publicKey, held), signature)) throw new ContractError("refused", "the app didn't sign the answer key's statement");
    self.answerKey = { publicKey, held };
    this.#save();
    this.#listeners.emit({ type: "changed", device: { ...self } });
    return { ...self };
  }

  /** Takes a peer's new answer key or name from what it sent, signed with its link key (`peerUpdateStatement`). */
  async applyPeerUpdate(id: string, update: PeerUpdate, signature: Uint8Array): Promise<boolean> {
    const d = this.#find(id);
    if (!d || d.revokedAt !== undefined || id === this.#state.self) return false;
    if (!(await this.verify(id, peerUpdateStatement(id, update), signature))) return false;
    if (update.at <= (this.#state.updates[id] ?? 0)) return false;
    if (update.name !== undefined) {
      if (!NAME_RE.test(update.name)) return false;
      d.name = update.name;
    }
    if (update.computer !== undefined && d.runsCore) {
      if (!COMPUTER_NAME_RE.test(update.computer) || update.computer.length > 63) return false;
      d.computer = update.computer;
    }
    if (update.answerKey === null) delete d.answerKey;
    else if (update.answerKey !== undefined) {
      try {
        this.#checkAnswerKey(update.answerKey);
      } catch {
        return false;
      }
      d.answerKey = { ...update.answerKey };
    }
    this.#state.updates[id] = update.at;
    this.#save();
    this.#listeners.emit({ type: "changed", device: { ...d } });
    return true;
  }

  #checkAnswerKey(k: { publicKey: string; held: string }): void {
    if (!publicKeyFromBase64(k.publicKey)) throw new ContractError("invalid", "an answer key is a 32-byte Ed25519 public key");
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

  addGroupMember(device: string, key: string): void {
    const g = this.#state.group;
    if (!g) throw new ContractError("not_found", "no group");
    g.members[device] = { key, since: this.#clock.now() };
    this.#save();
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

  #save(): void {
    writeJsonFile(this.#path, this.#state);
  }
}

/** What a device signs to tell its peers about a new name or answer key. */
export interface PeerUpdate {
  name?: string;
  /** A computer's tree name. */
  computer?: string;
  answerKey?: { publicKey: string; held: AnswerKeyHolder } | null;
  at: number;
}

export function peerUpdateStatement(id: string, update: { name?: string; computer?: string; answerKey?: { publicKey: string; held: string } | null; at: number }): Uint8Array {
  const ak = update.answerKey === undefined ? "-" : update.answerKey === null ? "none" : `${update.answerKey.publicKey}:${update.answerKey.held}`;
  return utf8(`clover/device-update/2\n${id}\n${update.at}\n${update.name ?? "-"}\n${update.computer ?? "-"}\n${ak}`);
}

/** A computer's tree name from its display name: letters and digits, the rest as single hyphens (`Studio 2` →
 *  `Studio-2`); empty when nothing usable is left. */
export function computerNameFor(name: string): string {
  return name.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, "");
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
