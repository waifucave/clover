// The real SecretStore (B's contract `contracts/secret-store.ts`, owner lane C; spec §8.5, §9.1 "The secret store").
//   - What the store knows about each item (its owner, name, generation, time and whether it syncs) sits in an index,
//     `<home>/credentials/index.json`, inside the fenced set and owner-only. It never holds a value, so `list` and
//     `watch` work while the values are locked.
//   - The values:
//       macOS            one Keychain item per secret (`KeychainValues`), whose ACL trusts the daemon's binary
//       Windows, Linux   one encrypted file, `<home>/secrets.enc` (AES-256-GCM, a fresh nonce per write), whose key
//                        is in the OS store (Credential Manager, the Secret Service) or, on a headless computer with
//                        neither, a key file only the user can read, labelled `plaintext` (`secretKeySourceFor`)
//   - The OS stores are injected (`Vault`), so tests never touch the real Keychain, Credential Manager or keyring.
// A value leaves only through `get`, wrapped in a `Secret`; nothing written to the index, a log or an error holds one.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Clock } from "../contracts/clock";
import { ContractError, Listeners } from "../contracts/common";
import {
  SECRET_NAME_RE, Secret, secretOwnerKey, secretRefKey,
  type SecretChange, type SecretMeta, type SecretOwner, type SecretRef, type SecretStore, type SecretStoreStatus, type SecretValue,
} from "../contracts/secret-store";

/** An OS store of named strings (`Bun.secrets` with one service): the Keychain, Credential Manager, the Secret Service. */
export interface Vault {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

/** `Bun.secrets` under one service. */
export function bunVault(service: string): Vault {
  return {
    get: async (name) => (await Bun.secrets.get({ service, name })) ?? null,
    set: async (name, value) => { await Bun.secrets.set({ service, name, value }); },
    delete: async (name) => Bun.secrets.delete({ service, name }),
  };
}

/** A vault in memory (tests). */
export function memoryVault(): Vault & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    get: async (n) => items.get(n) ?? null,
    set: async (n, v) => { items.set(n, v); },
    delete: async (n) => items.delete(n),
  };
}

/** Where the values are kept. */
export interface ValueBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** macOS: one vault item per secret. */
export class KeychainValues implements ValueBackend {
  constructor(private readonly vault: Vault) {}
  get(key: string) { return this.vault.get(key); }
  async set(key: string, value: string) { await this.vault.set(key, value); }
  async delete(key: string) { await this.vault.delete(key); }
}

/** Windows and Linux: every value in one AES-256-GCM file, its 32-byte key from `key()`. */
export class EncryptedFileValues implements ValueBackend {
  constructor(private readonly path: string, private readonly key: () => Promise<Buffer>) {}

  async #read(): Promise<Record<string, string>> {
    if (!existsSync(this.path)) return {};
    const blob = readFileSync(this.path);
    if (blob.length < 1 + 12 + 16 || blob[0] !== 1) throw new ContractError("invalid", "the secrets file is not one this store wrote");
    const iv = blob.subarray(1, 13), tag = blob.subarray(13, 29), body = blob.subarray(29);
    const d = createDecipheriv("aes-256-gcm", await this.key(), iv);
    d.setAuthTag(tag);
    try { return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString("utf8")) as Record<string, string>; }
    catch { throw new ContractError("invalid", "the secrets file can't be opened with this key"); }
  }

  async #write(all: Record<string, string>): Promise<void> {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", await this.key(), iv);
    const body = Buffer.concat([c.update(JSON.stringify(all), "utf8"), c.final()]);
    writeOwnerOnly(this.path, Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]));
  }

  async get(key: string) { return (await this.#read())[key] ?? null; }
  async set(key: string, value: string) { const all = await this.#read(); all[key] = value; await this.#write(all); }
  async delete(key: string) { const all = await this.#read(); if (key in all) { delete all[key]; await this.#write(all); } }
}

/** The secrets file's key, kept in `vault` under `name`, made on first use. */
export function vaultKey(vault: Vault, name = "secrets-file-key"): () => Promise<Buffer> {
  let cached: Buffer | undefined;
  return async () => {
    if (cached) return cached;
    let text = await vault.get(name);
    if (text === null) { text = randomBytes(32).toString("base64"); await vault.set(name, text); }
    const k = Buffer.from(text, "base64");
    if (k.length !== 32) throw new ContractError("invalid", "the secrets file's key is damaged");
    return (cached = k);
  };
}

/** A headless computer's last resort: the key in a file only the user can read (status `plaintext`). */
export function keyFileKey(path: string): () => Promise<Buffer> {
  return async () => {
    if (!existsSync(path)) writeOwnerOnly(path, randomBytes(32));
    const k = readFileSync(path);
    if (k.length !== 32) throw new ContractError("invalid", "the key file is damaged");
    return k;
  };
}

function writeOwnerOnly(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, "", { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") chmodSync(tmp, 0o600);
  writeFileSync(tmp, data, { flag: "r+" });
  renameSync(tmp, path);
}

export interface CloverSecretStoreOptions {
  /** The Clover home: the index is `credentials/index.json` there. */
  home: string;
  values: ValueBackend;
  status: SecretStoreStatus;
  clock?: Pick<Clock, "now">;
  /** Starts locked with this reason (a keyring still locked at the login screen). */
  locked?: string;
}

interface Index { version: 1; items: Record<string, SecretMeta> }

export class CloverSecretStore implements SecretStore {
  readonly #o: CloverSecretStoreOptions;
  readonly #listeners = new Listeners<SecretChange>();
  readonly #indexPath: string;
  readonly #unlockedStatus: SecretStoreStatus;
  #status: SecretStoreStatus;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(o: CloverSecretStoreOptions) {
    this.#o = o;
    this.#indexPath = join(o.home, "credentials", "index.json");
    this.#unlockedStatus = { ...o.status };
    this.#status = o.locked === undefined ? { ...o.status } : { ...o.status, state: "locked", reason: o.locked };
  }

  status(): SecretStoreStatus { return { ...this.#status }; }

  /** The store's key became unreachable (the keyring locked). */
  lock(reason = "the keyring is locked"): void {
    this.#status = { ...this.#unlockedStatus, state: "locked", reason };
    this.#listeners.emit({ status: this.status() });
  }

  unlock(): void {
    this.#status = { ...this.#unlockedStatus };
    this.#listeners.emit({ status: this.status() });
  }

  #index(): Index {
    try {
      const i = JSON.parse(readFileSync(this.#indexPath, "utf8")) as Index;
      return i.version === 1 && typeof i.items === "object" ? i : { version: 1, items: {} };
    } catch { return { version: 1, items: {} }; }
  }

  #save(i: Index): void { writeOwnerOnly(this.#indexPath, JSON.stringify(i)); }

  #unlocked(): void {
    if (this.#status.state === "locked") throw new ContractError("locked", `the secret store is locked${this.#status.reason ? `: ${this.#status.reason}` : ""}`);
  }

  /** One write at a time: the index and the encrypted file are read and rewritten whole. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async get(ref: SecretRef): Promise<SecretValue | null> {
    this.#unlocked();
    const key = secretRefKey(ref);
    const meta = this.#index().items[key];
    if (!meta) return null;
    const value = await this.#o.values.get(key);
    return value === null ? null : { value: new Secret(value), generation: meta.generation };
  }

  set(ref: SecretRef, value: string | Secret, opts: { synced?: boolean } = {}): Promise<SecretMeta> {
    return this.#serial(async () => {
      this.#unlocked();
      if (!SECRET_NAME_RE.test(ref.name)) throw new ContractError("invalid", "a secret's name is 1–128 of A-Z a-z 0-9 . _ : -");
      const key = secretRefKey(ref);
      const index = this.#index();
      const meta: SecretMeta = {
        ref: { owner: { ...ref.owner }, name: ref.name },
        generation: (index.items[key]?.generation ?? 0) + 1,
        updatedAt: this.#o.clock?.now() ?? Date.now(),
        synced: ref.owner.kind === "device" ? false : (opts.synced ?? true),
      };
      await this.#o.values.set(key, value instanceof Secret ? value.reveal() : value);
      index.items[key] = meta;
      this.#save(index);
      this.#listeners.emit({ meta: { ...meta }, deleted: false });
      return { ...meta };
    });
  }

  delete(ref: SecretRef): Promise<boolean> {
    return this.#serial(async () => {
      this.#unlocked();
      const key = secretRefKey(ref);
      const index = this.#index();
      const meta = index.items[key];
      if (!meta) return false;
      await this.#o.values.delete(key);
      delete index.items[key];
      this.#save(index);
      this.#listeners.emit({ meta: { ...meta }, deleted: true });
      return true;
    });
  }

  async list(owner?: SecretOwner): Promise<SecretMeta[]> {
    const want = owner ? secretOwnerKey(owner) : undefined;
    return Object.values(this.#index().items)
      .filter((m) => want === undefined || secretOwnerKey(m.ref.owner) === want)
      .map((m) => ({ ...m, ref: { owner: { ...m.ref.owner }, name: m.ref.name } }))
      .sort((a, b) => secretRefKey(a.ref).localeCompare(secretRefKey(b.ref)));
  }

  watch(fn: (change: SecretChange) => void): () => void { return this.#listeners.add(fn); }

  /** Removes the index (tests' and an uninstaller's clean-up; the values go with their backend). */
  dropIndex(): void { rmSync(this.#indexPath, { force: true }); }
}

/** This computer's store (spec §8.5): the Keychain on macOS; on Windows and Linux the encrypted file, its key in
 *  Credential Manager or the Secret Service, or on a headless Linux computer a key file labelled `plaintext`
 *  (`systemd-creds` sealing is still to come, so it is not offered yet). `vault` stands in for `Bun.secrets` (tests). */
export async function openCloverSecretStore(o: {
  home: string;
  /** The daemon's Keychain service (`keychainService(profile, home)`); the store keeps its items under `<service>.items`
   *  and the file's key under `<service>.key`, apart from the inherited items. */
  service: string;
  os?: "macos" | "windows" | "linux";
  vault?: (service: string) => Vault;
  clock?: Pick<Clock, "now">;
  interactive?: boolean;
}): Promise<CloverSecretStore> {
  const os = o.os ?? (process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux");
  const vault = o.vault ?? bunVault;
  const clock = o.clock ? { clock: o.clock } : {};
  if (os === "macos") return new CloverSecretStore({ home: o.home, values: new KeychainValues(vault(`${o.service}.items`)), status: { backend: "keychain", plaintext: false, state: "unlocked" }, ...clock });
  const file = join(o.home, "secrets.enc");
  const keys = vault(`${o.service}.key`);
  if (os === "windows") return new CloverSecretStore({ home: o.home, values: new EncryptedFileValues(file, vaultKey(keys)), status: { backend: "encrypted-file", keySource: "credential-manager", plaintext: false, state: "unlocked" }, ...clock });
  // Linux: the Secret Service if it answers; a locked keyring someone can unlock waits; else the key file.
  let service: "unlocked" | "locked" | "absent" = "absent";
  try { await keys.get("probe"); service = "unlocked"; } catch (e) { service = /lock/i.test(String(e)) ? "locked" : "absent"; }
  const interactive = o.interactive ?? Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  if (service === "unlocked") return new CloverSecretStore({ home: o.home, values: new EncryptedFileValues(file, vaultKey(keys)), status: { backend: "encrypted-file", keySource: "secret-service", plaintext: false, state: "unlocked" }, ...clock });
  if (service === "locked" && interactive) {
    return new CloverSecretStore({ home: o.home, values: new EncryptedFileValues(file, vaultKey(keys)), status: { backend: "encrypted-file", keySource: "secret-service", plaintext: false, state: "unlocked" }, locked: "the keyring is locked: unlock it to use saved logins", ...clock });
  }
  return new CloverSecretStore({ home: o.home, values: new EncryptedFileValues(file, keyFileKey(join(o.home, "secrets.key"))), status: { backend: "encrypted-file", keySource: "key-file", plaintext: true, state: "unlocked" }, ...clock });
}
