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
import type { SecretKeySource } from "@waifucave/clover-protocol";
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

const SOURCE_CODES: Record<SecretKeySource, number> = { "credential-manager": 1, "secret-service": 2, "systemd-creds": 3, "key-file": 4 };

/** The key source a secrets file records in its header (#205's S3): the store always uses it, never another. Null when
 *  there's no file; `unreadable` when it isn't one this store wrote. */
export function recordedKeySource(path: string): SecretKeySource | null | "unreadable" {
  if (!existsSync(path)) return null;
  let head: Buffer;
  try { head = readFileSync(path).subarray(0, 2); } catch { return "unreadable"; }
  if (head[0] !== 2) return "unreadable";
  const code = head[1];
  const found = (Object.entries(SOURCE_CODES) as [SecretKeySource, number][]).find(([, c]) => c === code);
  return found ? found[0] : "unreadable";
}

/** Windows and Linux: every value in one AES-256-GCM file, its 32-byte key from `key()`. The header is the format
 *  (2), the key's source, then the nonce and the tag; the key's source is authenticated with the body. */
export class EncryptedFileValues implements ValueBackend {
  constructor(private readonly path: string, private readonly key: () => Promise<Buffer>, private readonly source: SecretKeySource) {}

  async #read(): Promise<Record<string, string>> {
    if (!existsSync(this.path)) return {};
    const blob = readFileSync(this.path);
    if (blob.length < 2 + 12 + 16 || blob[0] !== 2) throw new ContractError("invalid", "the secrets file is not one this store wrote");
    if (blob[1] !== SOURCE_CODES[this.source]) throw new ContractError("locked", "the secrets file's key is kept elsewhere than this store looks");
    const iv = blob.subarray(2, 14), tag = blob.subarray(14, 30), body = blob.subarray(30);
    const d = createDecipheriv("aes-256-gcm", await this.key(), iv);
    d.setAAD(blob.subarray(0, 2));
    d.setAuthTag(tag);
    try { return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString("utf8")) as Record<string, string>; }
    catch { throw new ContractError("invalid", "the secrets file can't be opened with this key"); }
  }

  async #write(all: Record<string, string>): Promise<void> {
    const iv = randomBytes(12);
    const head = Buffer.from([2, SOURCE_CODES[this.source]]);
    const c = createCipheriv("aes-256-gcm", await this.key(), iv);
    c.setAAD(head);
    const body = Buffer.concat([c.update(JSON.stringify(all), "utf8"), c.final()]);
    writeOwnerOnly(this.path, Buffer.concat([head, iv, c.getAuthTag(), body]));
  }

  async get(key: string) { return (await this.#read())[key] ?? null; }
  async set(key: string, value: string) { const all = await this.#read(); all[key] = value; await this.#write(all); }
  async delete(key: string) { const all = await this.#read(); if (key in all) { delete all[key]; await this.#write(all); } }
}

/** A key may be made only while there's no secrets file: one that exists was sealed with a key that must be found,
 *  never replaced (#205's S3). */
const missingKey = (where: string) => new ContractError("locked", `the secrets file's key is missing from ${where}: saved logins stay locked until it's back`);

/** The secrets file's key, kept in `vault` under `name`, made on first use (only while `secretsFile` doesn't exist). */
export function vaultKey(vault: Vault, secretsFile: string, name = "secrets-file-key", where = "the OS keyring"): () => Promise<Buffer> {
  let cached: Buffer | undefined;
  return async () => {
    if (cached) return cached;
    let text: string | null;
    try { text = await vault.get(name); } catch { throw new ContractError("locked", `${where} didn't answer`); }
    if (text === null) {
      if (existsSync(secretsFile)) throw missingKey(where);
      text = randomBytes(32).toString("base64");
      await vault.set(name, text);
    }
    const k = Buffer.from(text, "base64");
    if (k.length !== 32) throw new ContractError("invalid", "the secrets file's key is damaged");
    return (cached = k);
  };
}

/** How `systemd-creds` seals the key here: `--user` (systemd 256 or later, the user's own credential key, with the TPM
 *  where there is one), or `--with-key=tpm2` on systemd 250 to 255 when the user can reach the TPM; null for neither. */
export interface SystemdCreds { readonly args: readonly string[]; readonly tpm: boolean }

export type CredsRunner = (argv: readonly string[], stdin?: string) => Promise<{ ok: boolean; out: string }>;

const bunCredsRunner: CredsRunner = async (argv, stdin) => {
  try {
    const p = Bun.spawn([...argv], { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "ignore" });
    if (stdin !== undefined && p.stdin) { p.stdin.write(stdin); await p.stdin.end(); }
    const out = await new Response(p.stdout).text();
    return { ok: (await p.exited) === 0, out };
  } catch { return { ok: false, out: "" }; }
};

/** What `systemd-creds` offers on this Linux computer. */
export async function probeSystemdCreds(run: CredsRunner = bunCredsRunner): Promise<SystemdCreds | null> {
  const v = await run(["systemd-creds", "--version"]);
  const version = Number(/systemd\s+(\d+)/.exec(v.out)?.[1] ?? 0);
  if (!v.ok || version < 250) return null;
  const tpm = (await run(["systemd-creds", "has-tpm2", "--quiet"])).ok;
  if (version >= 256) return { args: ["--user"], tpm };
  return tpm ? { args: ["--with-key=tpm2"], tpm } : null;
}

/** The secrets file's key sealed by `systemd-creds` in `path` (`secrets.key.cred`), made on first use. */
export function systemdCredsKey(path: string, creds: SystemdCreds, secretsFile: string, run: CredsRunner = bunCredsRunner): () => Promise<Buffer> {
  let cached: Buffer | undefined;
  const name = "--name=clover-secrets-key";
  return async () => {
    if (cached) return cached;
    if (!existsSync(path)) {
      if (existsSync(secretsFile)) throw missingKey("its sealed credential (secrets.key.cred)");
      const fresh = randomBytes(32).toString("base64");
      const tmp = `${path}.${process.pid}.tmp`;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const r = await run(["systemd-creds", ...creds.args, "encrypt", name, "-", tmp], fresh);
      if (!r.ok) { rmSync(tmp, { force: true }); throw new ContractError("locked", "systemd-creds could not seal the secrets file's key"); }
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    }
    const r = await run(["systemd-creds", ...creds.args, "decrypt", name, path, "-"]);
    const k = Buffer.from(r.out.trim(), "base64");
    if (!r.ok || k.length !== 32) throw new ContractError("locked", "systemd-creds could not open the secrets file's key");
    return (cached = k);
  };
}

/** What `clover doctor` and the daemon's log say about a store's status: a warning when the key sits unsealed, so a
 *  plaintext key is never a silent default (the controller's condition); null when there's nothing to warn of. */
export function secretStoreWarning(status: SecretStoreStatus): string | null {
  if (status.state === "locked") return `saved logins are locked: ${status.reason ?? "unlock the keyring"}`;
  if (status.plaintext) return "saved logins are encrypted with a key kept unsealed in a file (no keyring, no systemd-creds here): anyone who can read your files can read them";
  return null;
}

/** A headless computer's last resort: the key in a file only the user can read (status `plaintext`). */
export function keyFileKey(path: string, secretsFile: string): () => Promise<Buffer> {
  return async () => {
    if (!existsSync(path)) {
      if (existsSync(secretsFile)) throw missingKey("its key file (secrets.key)");
      writeOwnerOnly(path, randomBytes(32));
    }
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
 *  sealed by `systemd-creds` where it is here, and only as a last resort a key file labelled `plaintext`, which
 *  `secretStoreWarning` turns into a warning. `vault` stands in for `Bun.secrets` (tests). */
export async function openCloverSecretStore(o: {
  home: string;
  /** The daemon's Keychain service (`keychainService(profile, home)`); the store keeps its items under `<service>.items`
   *  and the file's key under `<service>.key`, apart from the inherited items. */
  service: string;
  os?: "macos" | "windows" | "linux";
  vault?: (service: string) => Vault;
  clock?: Pick<Clock, "now">;
  interactive?: boolean;
  /** Linux: what `systemd-creds` offers (`probeSystemdCreds`); probed when not given. */
  systemdCreds?: SystemdCreds | null;
  credsRunner?: CredsRunner;
}): Promise<CloverSecretStore> {
  const os = o.os ?? (process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux");
  const vault = o.vault ?? bunVault;
  const clock = o.clock ? { clock: o.clock } : {};
  if (os === "macos") return new CloverSecretStore({ home: o.home, values: new KeychainValues(vault(`${o.service}.items`)), status: { backend: "keychain", plaintext: false, state: "unlocked" }, ...clock });
  const file = join(o.home, "secrets.enc");
  const keys = vault(`${o.service}.key`);
  const store = (source: SecretKeySource, key: () => Promise<Buffer>, extra: { tpm?: boolean; locked?: string } = {}) => new CloverSecretStore({
    home: o.home, values: new EncryptedFileValues(file, key, source),
    status: { backend: "encrypted-file", keySource: source, ...(source === "systemd-creds" ? { tpm: extra.tpm ?? false } : {}), plaintext: source === "key-file", state: "unlocked" },
    ...(extra.locked !== undefined ? { locked: extra.locked } : {}), ...clock,
  });
  const recorded = recordedKeySource(file);
  if (recorded === "unreadable") return store(os === "windows" ? "credential-manager" : "key-file", async () => { throw new ContractError("invalid", "the secrets file is not one this store wrote"); }, { locked: "the secrets file isn't one this store wrote" });

  if (os === "windows") {
    if (recorded !== null && recorded !== "credential-manager") return store(recorded, keyFileKey(join(o.home, "secrets.key"), file), { locked: `the secrets file's key is kept in ${recorded}, which Windows doesn't have` });
    const answers = await vaultAnswers(keys);
    return store("credential-manager", vaultKey(keys, file, undefined, "Credential Manager"), answers === "yes" ? {} : { locked: "Credential Manager didn't answer" });
  }

  // Linux. A file already made keeps its key's source, and is locked while that source can't be reached (#205's S3).
  const service = await probeSecretService(keys);
  // A file that claims a weaker key than this computer keeps (a planted secrets.enc saying `key-file`, with a planted
  // secrets.key) is taken as replaced: locked, never opened or written under the weaker key (#205's check 2).
  if (recorded !== null) {
    const rank: Record<SecretKeySource, number> = { "key-file": 0, "systemd-creds": 1, "secret-service": 2, "credential-manager": 2 };
    let vaultHasKey = false;
    try { vaultHasKey = (await keys.get("secrets-file-key")) !== null; } catch { /* unreachable: no evidence either way */ }
    const strongest = vaultHasKey ? 2 : existsSync(join(o.home, "secrets.key.cred")) ? 1 : 0;
    if (rank[recorded] < strongest) {
      return store(recorded, async () => { throw new ContractError("locked", "the secrets file may have been replaced"); }, { locked: "the secrets file claims a weaker key than this computer keeps: it may have been replaced, so saved logins stay locked" });
    }
  }
  const interactive = o.interactive ?? Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const credsOf = async () => (o.systemdCreds !== undefined ? o.systemdCreds : await probeSystemdCreds(o.credsRunner));
  const sealed = (creds: SystemdCreds) => store("systemd-creds", systemdCredsKey(join(o.home, "secrets.key.cred"), creds, file, o.credsRunner), { tpm: creds.tpm });
  if (recorded === "secret-service") return store("secret-service", vaultKey(keys, file), service === "unlocked" ? {} : { locked: service === "absent" ? "the keyring that holds the key isn't running" : "the keyring is locked: unlock it to use saved logins" });
  if (recorded === "systemd-creds") {
    const creds = await credsOf();
    return creds ? sealed(creds) : store("systemd-creds", async () => { throw missingKey("systemd-creds"); }, { locked: "systemd-creds, which holds the key, isn't available here" });
  }
  if (recorded === "key-file") return store("key-file", keyFileKey(join(o.home, "secrets.key"), file));
  if (recorded === "credential-manager") return store("credential-manager", vaultKey(keys, file), { locked: "the secrets file's key is kept in Credential Manager, which Linux doesn't have" });

  // A new store: the Secret Service when it answers; a keyring that is there but locked (or that answered strangely)
  // is never passed over for the unsealed key file (#205's S3): it's waited for, or systemd-creds seals the key.
  if (service === "unlocked") return store("secret-service", vaultKey(keys, file));
  if (service !== "absent" && interactive) return store("secret-service", vaultKey(keys, file), { locked: "the keyring is locked: unlock it to use saved logins" });
  const creds = await credsOf();
  if (creds) return sealed(creds);
  if (service !== "absent") return store("secret-service", vaultKey(keys, file), { locked: "the keyring is locked, and there's no systemd-creds to seal the key with instead" });
  return store("key-file", keyFileKey(join(o.home, "secrets.key"), file));
}

/** Whether an OS vault answers at all (a read). */
async function vaultAnswers(v: Vault): Promise<"yes" | "no"> {
  try { await v.get("probe"); return "yes"; } catch { return "no"; }
}

/** The Secret Service, probed by a write (a service with no login collection answers reads and refuses writes, measured
 *  on the Ubuntu 26.04 VM). `absent` only when the session bus says no such service is there (or there's no bus);
 *  any other refusal is `locked`, never taken for "no keyring" (#205's S3). */
export async function probeSecretService(keys: Vault): Promise<"unlocked" | "locked" | "absent"> {
  try { await keys.set("probe", "1"); await keys.delete("probe"); return "unlocked"; }
  catch (e) {
    const m = String(e);
    return /ServiceUnknown|was not provided by any|NoServer|Cannot autolaunch|DBUS_SESSION_BUS_ADDRESS|Failed to connect to socket|No such file or directory|not supported on this platform/i.test(m) ? "absent" : "locked";
  }
}
