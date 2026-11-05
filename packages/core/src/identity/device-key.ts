// This device's own key (spec §8.1: "Every installation has its own Ed25519 key in the OS secret store"). It is the
// link key: iroh's endpoint id is its public key, so a link's peer is authenticated by it, and the device id is
// derived from it (`deviceIdFor`). The seed lives in the secret store as a device item, which never syncs; it leaves
// the core only wrapped in a `Secret`, for the link sidecar's stdin (never its arguments, environment or a file).
import { ContractError } from "../contracts/common";
import { deviceIdFor } from "../contracts/device-registry";
import type { Secret, SecretRef, SecretStore } from "../contracts/secret-store";
import { type Bytes, toBase64 } from "./bytes";
import { type Ed25519Key, ed25519FromSecret, generateEd25519 } from "./keys";

export const DEVICE_KEY_REF: SecretRef = { owner: { kind: "device" }, name: "device:link-key" };

export class DeviceKey {
  readonly id: string;
  readonly publicKey: Bytes;
  readonly #key: Ed25519Key;

  private constructor(id: string, key: Ed25519Key) {
    this.id = id;
    this.#key = key;
    this.publicKey = key.publicKey;
  }

  /** The key in the store, or a new one written there first. A store that is locked answers `locked`. */
  static async loadOrCreate(store: Pick<SecretStore, "get" | "set">, ref: SecretRef = DEVICE_KEY_REF): Promise<DeviceKey> {
    if (ref.owner.kind !== "device") throw new ContractError("invalid", "the device key is a device item");
    const stored = await store.get(ref);
    if (stored) return DeviceKey.fromKey(ed25519FromSecret(stored.value));
    const key = generateEd25519();
    await store.set(ref, key.seed(), { synced: false });
    return DeviceKey.fromKey(key);
  }

  static async fromKey(key: Ed25519Key): Promise<DeviceKey> {
    return new DeviceKey(await deviceIdFor(key.publicKey), key);
  }

  get publicKeyBase64(): string {
    return toBase64(this.publicKey);
  }

  sign(data: Uint8Array): Bytes {
    return this.#key.sign(data);
  }

  /** The seed, for the link sidecar's stdin only. */
  seed(): Secret {
    return this.#key.seed();
  }

  toJSON(): { id: string; publicKey: string } {
    return { id: this.id, publicKey: this.publicKeyBase64 };
  }
}
