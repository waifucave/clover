// MemorySecretStore: the throwaway store tests use. It never touches the OS store or the disk, and a test can lock
// it to see how a caller copes.
import type { Clock } from "../clock";
import { ContractError, Listeners } from "../common";
import {
  SECRET_NAME_RE, Secret, secretOwnerKey, secretRefKey,
  type SecretChange, type SecretMeta, type SecretOwner, type SecretRef, type SecretStore, type SecretStoreStatus, type SecretValue,
} from "../secret-store";

interface Item {
  meta: SecretMeta;
  value: Secret;
}

export class MemorySecretStore implements SecretStore {
  readonly #items = new Map<string, Item>();
  readonly #listeners = new Listeners<SecretChange>();
  #status: SecretStoreStatus;
  readonly #clock: Pick<Clock, "now"> | undefined;

  readonly #unlockedStatus: SecretStoreStatus;

  /** `status`: the backend it stands for (`encryptedFileStatus("key-file")` for a headless computer's); memory by
   *  default. */
  constructor(opts: { clock?: Pick<Clock, "now">; locked?: string; status?: SecretStoreStatus } = {}) {
    this.#clock = opts.clock;
    this.#unlockedStatus = opts.status ?? { backend: "memory", plaintext: false, state: "unlocked" };
    this.#status = opts.locked === undefined ? { ...this.#unlockedStatus } : { ...this.#unlockedStatus, state: "locked", reason: opts.locked };
  }

  status(): SecretStoreStatus {
    return { ...this.#status };
  }

  lock(reason = "locked by the test"): void {
    this.#status = { ...this.#unlockedStatus, state: "locked", reason };
    this.#listeners.emit({ status: this.status() });
  }

  unlock(): void {
    this.#status = { ...this.#unlockedStatus };
    this.#listeners.emit({ status: this.status() });
  }

  async get(ref: SecretRef): Promise<SecretValue | null> {
    this.#unlocked();
    const item = this.#items.get(secretRefKey(ref));
    return item ? { value: item.value, generation: item.meta.generation } : null;
  }

  async set(ref: SecretRef, value: string | Secret, opts: { synced?: boolean } = {}): Promise<SecretMeta> {
    this.#unlocked();
    if (!SECRET_NAME_RE.test(ref.name)) throw new ContractError("invalid", "a secret's name is 1–128 of A-Z a-z 0-9 . _ : -");
    const key = secretRefKey(ref);
    const previous = this.#items.get(key);
    const meta: SecretMeta = {
      ref: { owner: { ...ref.owner }, name: ref.name },
      generation: (previous?.meta.generation ?? 0) + 1,
      updatedAt: this.#clock?.now() ?? Date.now(),
      synced: ref.owner.kind === "device" ? false : (opts.synced ?? true),
    };
    this.#items.set(key, { meta, value: value instanceof Secret ? value : new Secret(value) });
    this.#listeners.emit({ meta: { ...meta }, deleted: false });
    return { ...meta };
  }

  async delete(ref: SecretRef): Promise<boolean> {
    this.#unlocked();
    const key = secretRefKey(ref);
    const item = this.#items.get(key);
    if (!item) return false;
    this.#items.delete(key);
    this.#listeners.emit({ meta: { ...item.meta }, deleted: true });
    return true;
  }

  async list(owner?: SecretOwner): Promise<SecretMeta[]> {
    const want = owner ? secretOwnerKey(owner) : undefined;
    return [...this.#items.values()]
      .filter((i) => want === undefined || secretOwnerKey(i.meta.ref.owner) === want)
      .map((i) => ({ ...i.meta }))
      .sort((a, b) => secretRefKey(a.ref).localeCompare(secretRefKey(b.ref)));
  }

  watch(fn: (change: SecretChange) => void): () => void {
    return this.#listeners.add(fn);
  }

  #unlocked(): void {
    if (this.#status.state === "locked") throw new ContractError("locked", `the secret store is locked${this.#status.reason ? `: ${this.#status.reason}` : ""}`);
  }
}
