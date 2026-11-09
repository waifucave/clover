// FakeDeviceRegistry: devices with real Ed25519 keys made in memory (WebCrypto), so a test can sign a card answer as a
// paired phone and have it checked as the real registry would. No key ever touches the disk or the OS store.
import type { DeviceKind, Os } from "@waifucave/clover-protocol";
import type { Clock } from "../clock";
import { ContractError, Listeners, type Unsubscribe } from "../common";
import {
  answerKeyAlgOf, answerKeyOf, deviceIdFor, holderFitsAlg, verifyKeySignature,
  type DeviceChange, type DeviceRecord, type DeviceRegistry, type PairingProof,
} from "../device-registry";

/** A device a test made: its record, and a way to sign as it. */
export interface FakeDevice {
  id: string;
  publicKey: string;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Makes a device identity: an Ed25519 key pair in memory, and the id it gives. */
export async function makeFakeDevice(): Promise<FakeDevice> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    id: await deviceIdFor(raw),
    publicKey: b64(raw),
    sign: async (data) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, data as Uint8Array<ArrayBuffer>)),
  };
}

/** A phone as it pairs (no fallback, lane H's ask): its link key (`id`, `publicKey`, `link`) and an answer key apart
 *  from it (`answerKey`, for its record), which `sign` signs with, since a phone answers only with its answer key. */
export interface FakePhone extends FakeDevice {
  answerKey: { publicKey: string; held: "keychain" };
  link: FakeDevice;
}

/** Makes a phone: a link key, and an answer key in memory. Pair it with `answerKey: phone.answerKey`. */
export async function makeFakePhone(): Promise<FakePhone> {
  const link = await makeFakeDevice();
  const answers = await makeFakeDevice();
  return { id: link.id, publicKey: link.publicKey, sign: answers.sign, answerKey: { publicKey: answers.publicKey, held: "keychain" }, link };
}

export class FakeDeviceRegistry implements DeviceRegistry {
  readonly #clock: Pick<Clock, "now">;
  readonly #devices = new Map<string, DeviceRecord>();
  readonly #listeners = new Listeners<DeviceChange>();
  readonly #selfId: string;

  private constructor(clock: Pick<Clock, "now">, self: DeviceRecord) {
    this.#clock = clock;
    this.#selfId = self.id;
    this.#devices.set(self.id, self);
  }

  /** A registry for this device, with its own key made in memory. */
  static async create(opts: { clock: Pick<Clock, "now">; name?: string; kind?: DeviceKind; os?: Os; computer?: string }): Promise<{ registry: FakeDeviceRegistry; device: FakeDevice }> {
    const device = await makeFakeDevice();
    const kind = opts.kind ?? "desktop";
    const runsCore = kind === "desktop" || kind === "server" || kind === "cloud";
    const record: DeviceRecord = {
      id: device.id, name: opts.name ?? "Studio", kind, runsCore, publicKey: device.publicKey,
      addedAt: opts.clock.now(), addedBy: "self",
      ...(opts.os === undefined ? {} : { os: opts.os }),
      ...(runsCore ? { computer: opts.computer ?? opts.name ?? "Studio" } : {}),
    };
    return { registry: new FakeDeviceRegistry(opts.clock, record), device };
  }

  self(): DeviceRecord {
    return { ...this.#devices.get(this.#selfId)! };
  }

  list(): DeviceRecord[] {
    return [...this.#devices.values()].filter((d) => d.revokedAt === undefined).map((d) => ({ ...d }));
  }

  get(id: string): DeviceRecord | undefined {
    const d = this.#devices.get(id);
    return d ? { ...d } : undefined;
  }

  async add(device: Omit<DeviceRecord, "addedAt" | "addedBy" | "revokedAt">, proof: PairingProof): Promise<DeviceRecord> {
    const existing = this.#devices.get(device.id);
    if (existing && existing.revokedAt === undefined) throw new ContractError("conflict", `${device.id} is already paired`);
    if (existing?.revokedAt !== undefined) throw new ContractError("refused", `${device.id} was revoked; pair it again with a new key`);
    if (proof.via === "self") throw new ContractError("invalid", "only this device is added as itself");
    if ((await deviceIdFor(unb64(device.publicKey))) !== device.id) throw new ContractError("invalid", "the id doesn't match the key");
    if (device.answerKey !== undefined && !holderFitsAlg(device.answerKey.held, device.answerKey.alg)) throw new ContractError("invalid", `${device.answerKey.held} holds only P-256 keys`);
    const record: DeviceRecord = { ...device, addedAt: this.#clock.now(), addedBy: proof.via };
    this.#devices.set(device.id, record);
    this.#listeners.emit({ type: "added", device: { ...record } });
    return { ...record };
  }

  async revoke(id: string, reason?: string): Promise<void> {
    if (id === this.#selfId) throw new ContractError("refused", "this device can't revoke itself");
    const d = this.#devices.get(id);
    if (!d) throw new ContractError("not_found", `no device ${id}`);
    if (d.revokedAt !== undefined) return;
    d.revokedAt = this.#clock.now();
    this.#listeners.emit({ type: "revoked", id, ...(reason === undefined ? {} : { reason }) });
  }

  async rename(id: string, name: string): Promise<void> {
    const d = this.#devices.get(id);
    if (!d || d.revokedAt !== undefined) throw new ContractError("not_found", `no device ${id}`);
    if (!/^.{1,63}$/u.test(name)) throw new ContractError("invalid", "a device name is 1–63 characters");
    d.name = name;
    this.#listeners.emit({ type: "changed", device: { ...d } });
  }

  async verifyAnswer(id: string, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    const d = this.#devices.get(id);
    const key = d === undefined ? undefined : answerKeyOf(d);
    if (key === undefined) return false;
    return verifyKeySignature(answerKeyAlgOf(d!), unb64(key), data, signature);
  }

  async verify(id: string, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    const d = this.#devices.get(id);
    if (!d || d.revokedAt !== undefined) return false;
    // Through the contract's own verifier, strict as the real registry's (identity/ed25519-strict.ts).
    return verifyKeySignature("ed25519", unb64(d.publicKey), data, signature);
  }

  watch(fn: (change: DeviceChange) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }

  /** Records that a device was seen over its link. */
  seen(id: string): void {
    const d = this.#devices.get(id);
    if (d) d.lastSeenAt = this.#clock.now();
  }
}

export { b64 as toBase64, unb64 as fromBase64 };
