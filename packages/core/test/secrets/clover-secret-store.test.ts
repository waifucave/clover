import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSecretStoreConformance } from "../../src/contracts/conformance/secret-store";
import { encryptedFileStatus, Secret } from "../../src/contracts/secret-store";
import { CloverSecretStore, EncryptedFileValues, KeychainValues, keyFileKey, memoryVault, openCloverSecretStore, vaultKey, type Vault } from "../../src/secrets/clover-secret-store";

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
      home: h, values: new EncryptedFileValues(join(h, "secrets.enc"), vaultKey(memoryVault())),
      status: opts.status ?? MEMORY,
      ...(opts.clock ? { clock: opts.clock } : {}), ...(opts.locked !== undefined ? { locked: opts.locked } : {}),
    });
  });
});

describe("what the disk holds", () => {
  const VALUE = ["sk", "disk", Math.random().toString(36).slice(2)].join("-");

  test("the index and the secrets file never hold a value in the clear; the index is owner-only", async () => {
    const h = home();
    const keys = memoryVault();
    const store = new CloverSecretStore({ home: h, values: new EncryptedFileValues(join(h, "secrets.enc"), vaultKey(keys)), status: encryptedFileStatus("secret-service") });
    await store.set({ owner: { kind: "device" }, name: "device-key" }, new Secret(VALUE));
    const index = readFileSync(join(h, "credentials", "index.json"), "utf8");
    expect(index).not.toContain(VALUE);
    expect(JSON.parse(index).items["device/device-key"]).toMatchObject({ generation: 1, synced: false });
    expect(readFileSync(join(h, "secrets.enc")).includes(Buffer.from(VALUE))).toBe(false);
    if (process.platform !== "win32") expect(require("node:fs").statSync(join(h, "credentials", "index.json")).mode & 0o777).toBe(0o600);
    // Another store over the same home and key reads it back; one with another key can't.
    const again = new CloverSecretStore({ home: h, values: new EncryptedFileValues(join(h, "secrets.enc"), vaultKey(keys)), status: encryptedFileStatus("secret-service") });
    expect((await again.get({ owner: { kind: "device" }, name: "device-key" }))?.value.reveal()).toBe(VALUE);
    const stranger = new CloverSecretStore({ home: h, values: new EncryptedFileValues(join(h, "secrets.enc"), vaultKey(memoryVault())), status: encryptedFileStatus("secret-service") });
    await expect(stranger.get({ owner: { kind: "device" }, name: "device-key" })).rejects.toThrow(/can't be opened/);
  });

  test("a headless computer's key file is the user's alone, and the store says plaintext", async () => {
    const h = home();
    const store = new CloverSecretStore({ home: h, values: new EncryptedFileValues(join(h, "secrets.enc"), keyFileKey(join(h, "secrets.key"))), status: encryptedFileStatus("key-file") });
    await store.set({ owner: { kind: "core" }, name: "anthropic:default" }, VALUE);
    expect(existsSync(join(h, "secrets.key"))).toBe(true);
    if (process.platform !== "win32") expect(require("node:fs").statSync(join(h, "secrets.key")).mode & 0o777).toBe(0o600);
    expect(store.status()).toMatchObject({ backend: "encrypted-file", keySource: "key-file", plaintext: true });
  });

  test("writes in a burst all land (one at a time)", async () => {
    const h = home();
    const store = new CloverSecretStore({ home: h, values: new EncryptedFileValues(join(h, "secrets.enc"), vaultKey(memoryVault())), status: encryptedFileStatus("credential-manager") });
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
    const absent: Vault = { get: async () => { throw new Error("no Secret Service on the bus"); }, set: async () => {}, delete: async () => false };
    expect((await openCloverSecretStore({ home: home(), service: "svc", os: "linux", vault: () => absent, interactive: false })).status()).toMatchObject({ keySource: "key-file", plaintext: true });
    const locked: Vault = { ...absent, get: async () => { throw new Error("the collection is locked"); } };
    expect((await openCloverSecretStore({ home: home(), service: "svc", os: "linux", vault: () => locked, interactive: true })).status()).toMatchObject({ state: "locked" });
  });
});
