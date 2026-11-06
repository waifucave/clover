import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSecretStoreConformance } from "../../src/contracts/conformance/secret-store";
import { encryptedFileStatus, Secret } from "../../src/contracts/secret-store";
import { CloverSecretStore, EncryptedFileValues, KeychainValues, keyFileKey, memoryVault, openCloverSecretStore, probeSystemdCreds, recordedKeySource, secretStoreWarning, systemdCredsKey, vaultKey, type CredsRunner, type Vault } from "../../src/secrets/clover-secret-store";

// C-M2: the real SecretStore, through B's conformance suite on both value backends (the OS stores as in-memory vaults,
// so no test touches the real Keychain, Credential Manager or keyring), then what the disk holds.

const MEMORY = { backend: "memory" as const, plaintext: false, state: "unlocked" as const };
const home = () => mkdtempSync(join(tmpdir(), "clover-secrets-"));

describe("macOS backend (one Keychain item per secret)", () => {
  runSecretStoreConformance((opts = {}) => new CloverSecretStore({
    home: home(), values: new KeychainValues(memoryVault()),
    status: opts.status ?? MEMORY, // the suite pins the fake's default status
    ...(opts.clock ? { clock: opts.clock } : {}), ...(opts.locked !== undefined ? { locked: opts.locked } : {}),
  }));
});

describe("Windows and Linux backend (one encrypted file, its key in the OS store)", () => {
  runSecretStoreConformance((opts = {}) => {
    const h = home();
    return new CloverSecretStore({
      home: h, values: new EncryptedFileValues(join(h, "secrets.enc"), vaultKey(memoryVault(), join(h, "secrets.enc")), "secret-service"),
      status: opts.status ?? MEMORY,
      ...(opts.clock ? { clock: opts.clock } : {}), ...(opts.locked !== undefined ? { locked: opts.locked } : {}),
    });
  });
});

const absent = (): Vault => ({ get: async () => null, set: async () => { throw new Error("org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.secrets was not provided by any .service files"); }, delete: async () => false });

describe("what the disk holds", () => {
  const VALUE = ["sk", "disk", Math.random().toString(36).slice(2)].join("-");

  test("the index and the secrets file never hold a value in the clear; the index is owner-only", async () => {
    const h = home();
    const keys = memoryVault();
    const store = new CloverSecretStore({ home: h, values: new EncryptedFileValues(join(h, "secrets.enc"), vaultKey(keys, join(h, "secrets.enc")), "secret-service"), status: encryptedFileStatus("secret-service") });
    await store.set({ owner: { kind: "device" }, name: "device-key" }, new Secret(VALUE));
    const index = readFileSync(join(h, "credentials", "index.json"), "utf8");
    expect(index).not.toContain(VALUE);
    expect(JSON.parse(index).items["device/device-key"]).toMatchObject({ generation: 1, synced: false });
    expect(readFileSync(join(h, "secrets.enc")).includes(Buffer.from(VALUE))).toBe(false);
    if (process.platform !== "win32") expect(require("node:fs").statSync(join(h, "credentials", "index.json")).mode & 0o777).toBe(0o600);
    // Another store over the same home and key reads it back; one with another key can't.
    const again = new CloverSecretStore({ home: h, values: new EncryptedFileValues(join(h, "secrets.enc"), vaultKey(keys, join(h, "secrets.enc")), "secret-service"), status: encryptedFileStatus("secret-service") });
    expect((await again.get({ owner: { kind: "device" }, name: "device-key" }))?.value.reveal()).toBe(VALUE);
    const otherKeys = memoryVault();
    otherKeys.items.set("secrets-file-key", Buffer.alloc(32, 7).toString("base64"));
    const stranger = new CloverSecretStore({ home: h, values: new EncryptedFileValues(join(h, "secrets.enc"), vaultKey(otherKeys, join(h, "secrets.enc")), "secret-service"), status: encryptedFileStatus("secret-service") });
    await expect(stranger.get({ owner: { kind: "device" }, name: "device-key" })).rejects.toThrow(/can't be opened/);
    // An empty keyring over an existing file mints nothing: the key is missing, and stays so.
    const empty = memoryVault();
    const lost = new CloverSecretStore({ home: h, values: new EncryptedFileValues(join(h, "secrets.enc"), vaultKey(empty, join(h, "secrets.enc")), "secret-service"), status: encryptedFileStatus("secret-service") });
    await expect(lost.get({ owner: { kind: "device" }, name: "device-key" })).rejects.toThrow(/missing/);
    expect(empty.items.size).toBe(0);
  });

  test("a headless computer's key file is the user's alone, and the store says plaintext", async () => {
    const h = home();
    const store = new CloverSecretStore({ home: h, values: new EncryptedFileValues(join(h, "secrets.enc"), keyFileKey(join(h, "secrets.key"), join(h, "secrets.enc")), "key-file"), status: encryptedFileStatus("key-file") });
    await store.set({ owner: { kind: "core" }, name: "anthropic:default" }, VALUE);
    expect(existsSync(join(h, "secrets.key"))).toBe(true);
    if (process.platform !== "win32") expect(require("node:fs").statSync(join(h, "secrets.key")).mode & 0o777).toBe(0o600);
    expect(store.status()).toMatchObject({ backend: "encrypted-file", keySource: "key-file", plaintext: true });
  });

  test("writes in a burst all land (one at a time)", async () => {
    const h = home();
    const store = new CloverSecretStore({ home: h, values: new EncryptedFileValues(join(h, "secrets.enc"), vaultKey(memoryVault(), join(h, "secrets.enc")), "credential-manager"), status: encryptedFileStatus("credential-manager") });
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.set({ owner: { kind: "core" }, name: `k${i}` }, `v${i}`)));
    expect((await store.list()).length).toBe(20);
    expect((await store.get({ owner: { kind: "core" }, name: "k7" }))?.value.reveal()).toBe("v7");
  });

  test("each OS gets its backend: the Keychain, Credential Manager, the Secret Service, or a plaintext key file headless", async () => {
    const vaults = new Map<string, ReturnType<typeof memoryVault>>();
    const vault = (svc: string) => { if (!vaults.has(svc)) vaults.set(svc, memoryVault()); return vaults.get(svc)!; };
    const mac = await openCloverSecretStore({ home: home(), service: "svc", os: "macos", vault });
    await mac.set({ owner: { kind: "core" }, name: "a" }, VALUE);
    expect(vaults.get("svc.items")!.items.get("core/a")).toBe(VALUE);
    expect(mac.status().backend).toBe("keychain");
    expect((await openCloverSecretStore({ home: home(), service: "svc", os: "windows", vault })).status()).toMatchObject({ keySource: "credential-manager" });
    expect((await openCloverSecretStore({ home: home(), service: "svc", os: "linux", vault })).status()).toMatchObject({ keySource: "secret-service", plaintext: false });
    // No Secret Service on the bus at all: systemd-creds, else the plaintext key file.
    const absent: Vault = { get: async () => null, set: async () => { throw new Error("org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.secrets was not provided by any .service files"); }, delete: async () => false };
    expect((await openCloverSecretStore({ home: home(), service: "svc", os: "linux", vault: () => absent, interactive: false, systemdCreds: null })).status()).toMatchObject({ keySource: "key-file", plaintext: true });
    expect((await openCloverSecretStore({ home: home(), service: "svc", os: "linux", vault: () => absent, interactive: false, systemdCreds: { args: ["--user"], tpm: true } })).status()).toMatchObject({ keySource: "systemd-creds", tpm: true, plaintext: false });
    // A keyring that is there but refuses (no login collection, as on the VM over SSH): never the plaintext file (#205 S3).
    const odd: Vault = { ...absent, set: async () => { throw new Error("Object does not exist at path /org/freedesktop/secrets/collection/login"); } };
    expect((await openCloverSecretStore({ home: home(), service: "svc", os: "linux", vault: () => odd, interactive: false, systemdCreds: null })).status()).toMatchObject({ keySource: "secret-service", state: "locked" });
    expect((await openCloverSecretStore({ home: home(), service: "svc", os: "linux", vault: () => odd, interactive: false, systemdCreds: { args: ["--user"], tpm: false } })).status()).toMatchObject({ keySource: "systemd-creds" });
    const locked: Vault = { ...absent, set: async () => { throw new Error("the collection is locked"); } };
    expect((await openCloverSecretStore({ home: home(), service: "svc", os: "linux", vault: () => locked, interactive: true })).status()).toMatchObject({ state: "locked" });
  });

  test("headless Linux seals the key with systemd-creds: --user from 256, the TPM on 250 to 255, else none", async () => {
    const runner = (version: number, tpm: boolean): CredsRunner => async (argv) => {
      if (argv[1] === "--version") return { ok: true, out: `systemd ${version} (${version}.1)\n+PAM` };
      if (argv[1] === "has-tpm2") return { ok: tpm, out: "" };
      return { ok: false, out: "" };
    };
    expect(await probeSystemdCreds(runner(257, false))).toEqual({ args: ["--user"], tpm: false });
    expect(await probeSystemdCreds(runner(252, true))).toEqual({ args: ["--with-key=tpm2"], tpm: true });
    expect(await probeSystemdCreds(runner(252, false))).toBeNull();
    expect(await probeSystemdCreds(runner(249, true))).toBeNull();
    expect(await probeSystemdCreds(async () => ({ ok: false, out: "" }))).toBeNull(); // no systemd-creds at all

    // The key is made once, sealed into the .cred file, and read back through decrypt.
    const sealed = new Map<string, string>();
    const calls: string[][] = [];
    const creds: CredsRunner = async (argv, stdin) => {
      calls.push([...argv]);
      if (argv.includes("encrypt")) { require("node:fs").writeFileSync(argv.at(-1)!, "sealed"); sealed.set("k", stdin!); return { ok: true, out: "" }; }
      if (argv.includes("decrypt")) return { ok: true, out: `${sealed.get("k")}\n` };
      return { ok: false, out: "" };
    };
    const h = home();
    const key = systemdCredsKey(join(h, "secrets.key.cred"), { args: ["--user"], tpm: false }, join(h, "secrets.enc"), creds);
    const store = new CloverSecretStore({ home: h, values: new EncryptedFileValues(join(h, "secrets.enc"), key, "systemd-creds"), status: encryptedFileStatus("systemd-creds") });
    await store.set({ owner: { kind: "core" }, name: "a" }, VALUE);
    expect(calls[0]).toEqual(["systemd-creds", "--user", "encrypt", "--name=clover-secrets-key", "-", expect.stringContaining("secrets.key.cred")]);
    expect(readFileSync(join(h, "secrets.key.cred"), "utf8")).toBe("sealed");
    const again = new CloverSecretStore({ home: h, values: new EncryptedFileValues(join(h, "secrets.enc"), systemdCredsKey(join(h, "secrets.key.cred"), { args: ["--user"], tpm: false }, join(h, "secrets.enc"), creds), "systemd-creds"), status: encryptedFileStatus("systemd-creds") });
    expect((await again.get({ owner: { kind: "core" }, name: "a" }))?.value.reveal()).toBe(VALUE);
  });

  test("#205 S3: the file records its key's source and keeps it; a source gone is locked; no new key while the file exists", async () => {
    const h = home();
    const keys = memoryVault();
    const first = await openCloverSecretStore({ home: h, service: "svc", os: "linux", vault: () => keys });
    await first.set({ owner: { kind: "core" }, name: "a" }, VALUE);
    expect(recordedKeySource(join(h, "secrets.enc"))).toBe("secret-service");
    // The keyring stops answering: locked, never the key file or a new key.
    const gone: Vault = { get: async () => { throw new Error("org.freedesktop.DBus.Error.ServiceUnknown: not provided"); }, set: async () => { throw new Error("org.freedesktop.DBus.Error.ServiceUnknown: was not provided by any .service files"); }, delete: async () => false };
    const later = await openCloverSecretStore({ home: h, service: "svc", os: "linux", vault: () => gone, interactive: false, systemdCreds: { args: ["--user"], tpm: false } });
    expect(later.status()).toMatchObject({ keySource: "secret-service", state: "locked" });
    expect(existsSync(join(h, "secrets.key"))).toBe(false);
    // The key itself lost from a keyring that answers: locked, and no new one is minted over the file.
    keys.items.clear();
    const lost = await openCloverSecretStore({ home: h, service: "svc", os: "linux", vault: () => keys });
    await expect(lost.get({ owner: { kind: "core" }, name: "a" })).rejects.toThrow(/missing/);
    expect(keys.items.size).toBe(0);
    // A file this store didn't write is locked, not overwritten.
    const h2 = home();
    require("node:fs").writeFileSync(join(h2, "secrets.enc"), "junk");
    const junk = await openCloverSecretStore({ home: h2, service: "svc", os: "linux", vault: () => memoryVault() });
    expect(junk.status().state).toBe("locked");
    expect(readFileSync(join(h2, "secrets.enc"), "utf8")).toBe("junk");
    // A file whose key is in a key file stays with the key file, even with a keyring answering now.
    const h3 = home();
    const plain = await openCloverSecretStore({ home: h3, service: "svc", os: "linux", vault: () => absent(), interactive: false, systemdCreds: null });
    await plain.set({ owner: { kind: "core" }, name: "b" }, VALUE);
    const reopened = await openCloverSecretStore({ home: h3, service: "svc", os: "linux", vault: () => memoryVault() });
    expect(reopened.status()).toMatchObject({ keySource: "key-file" });
    expect((await reopened.get({ owner: { kind: "core" }, name: "b" }))?.value.reveal()).toBe(VALUE);
  });

  test("a plaintext key is a warning, never silent; a sealed one isn't", () => {
    expect(secretStoreWarning(encryptedFileStatus("key-file"))).toMatch(/unsealed/);
    expect(secretStoreWarning(encryptedFileStatus("systemd-creds", true))).toBeNull();
    expect(secretStoreWarning({ backend: "keychain", plaintext: false, state: "unlocked" })).toBeNull();
    expect(secretStoreWarning({ backend: "encrypted-file", keySource: "secret-service", plaintext: false, state: "locked", reason: "unlock it" })).toMatch(/locked/);
  });
});
