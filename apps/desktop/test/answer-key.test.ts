// This desktop's answer key (decision 91, lane H's ask): made once and kept in the OS's protected store, registered
// with the core under the app's signature over lane H's statement, and never written down in the clear. The tests use
// a vault in memory and a stand-in for safeStorage: never the real Keychain, Credential Manager or Secret Service.
import { describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnswerKey, answerKeyRotateStatement, answerKeyStatement, memoryVault, safeStorageVault, type SafeStorageLike } from "../src/main/answer-key";
import { CloverApprovalBroker } from "../../../packages/core/src/approvals/broker";
import { FakeClock } from "../../../packages/core/src/contracts/fakes/clock";
import { MemorySecretStore } from "../../../packages/core/src/contracts/fakes/secret-store";
import { answerKeyRotateStatement as coreRotateStatement, FileDeviceRegistry } from "../../../packages/core/src/devices/registry";
import { devicesMethods, type DevicesMethodsDeps } from "../../../packages/core/src/devices/rpc";
import { DeviceKey } from "../../../packages/core/src/identity/device-key";

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const verifier = (publicKey: string) => createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKey, "base64")]), format: "der", type: "spki" });

/** A stand-in for safeStorage: what it writes isn't the plain text. */
const fakeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from([...Buffer.from(plain)].map((b) => b ^ 0x5a)),
  decryptString: (enc) => Buffer.from([...enc].map((b) => b ^ 0x5a)).toString(),
};

describe("the answer key", () => {
  test("registered with the core under the app's signature over lane H's statement", async () => {
    const key = new AnswerKey(memoryVault("app-keychain"));
    const calls: { method: string; params: { publicKey: string; held: string; signature: string } }[] = [];
    const client = { request: async <T,>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params: params as never });
      return { ok: true } as T;
    } };
    const ok = await key.register(client, "dev_laptop");
    expect(ok).toBe(true);
    const p = calls[0]!.params;
    expect(calls[0]!.method).toBe("device.answerKey.set");
    expect(p.held).toBe("app-keychain");
    expect(Buffer.from(p.publicKey, "base64")).toHaveLength(32);
    expect(verify(null, Buffer.from(answerKeyStatement("dev_laptop", p.publicKey, "app-keychain")), verifier(p.publicKey), Buffer.from(p.signature, "base64"))).toBe(true);
    // The statement is lane H's, byte for byte.
    expect(new TextDecoder().decode(answerKeyStatement("dev_laptop", "AAAA", "none"))).toBe("clover/answer-key/1\ndev_laptop\nAAAA\nnone");
  });

  test("made once and kept: the same key across starts; the file holds only what the OS's key encrypted", () => {
    const file = join(mkdtempSync(join(tmpdir(), "clover-answer-key-")), "answer-key");
    const first = new AnswerKey(safeStorageVault(file, fakeStorage, "darwin")).publicKey();
    const again = new AnswerKey(safeStorageVault(file, fakeStorage, "darwin")).publicKey();
    expect(again).toBe(first);
    const raw = readFileSync(file);
    // Not the key's base64, nor its DER.
    expect(raw.toString()).not.toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(raw.includes(Buffer.from("302e020100300506032b6570", "hex"))).toBe(false);
  });

  test("only macOS's Keychain keeps it from plugin code; elsewhere the core hears so", () => {
    expect(safeStorageVault("/x", fakeStorage, "darwin").held).toBe("app-keychain");
    expect(safeStorageVault("/x", fakeStorage, "win32").held).toBe("none");
    expect(safeStorageVault("/x", fakeStorage, "linux").held).toBe("none");
  });

  test("the user is never asked for their presence or identity to hold or to use the key (the owner's decision, E-M2)", () => {
    // The holder names: none of them is a prompt-gated one on this side; a Windows Hello key credential and a TPM or
    // Secure Enclave key with a user-presence ACL would ask. What the app holds is safeStorage's Keychain item / DPAPI
    // / Secret Service, which keep it at rest with no ACL, and the stores' names for the core stay honest above.
    const labels = (["darwin", "win32", "linux"] as const).map((p) => safeStorageVault("/x", fakeStorage, p).held);
    expect(labels).not.toContain("hello");
    expect(labels).not.toContain("tpm");
    // Loading, saving (over a made key) and signing stay free of anything the OS would ask about.
    const file = join(mkdtempSync(join(tmpdir(), "clover-answer-key-")), "answer-key");
    const vault = safeStorageVault(file, fakeStorage, "win32");
    const key = new AnswerKey(vault);
    expect(key.sign(new Uint8Array([1, 2, 3]))).toHaveLength(64);
    vault.save(new Uint8Array(key.sign(new Uint8Array([4]))));
    expect(key.publicKey()).toHaveLength(44);
    expect(vault.held).toBe("none");
  });

  test("a core that refuses (an older one, a device that isn't a desktop) is said and not fatal; nothing secret in the line", async () => {
    const lines: string[] = [];
    const key = new AnswerKey(memoryVault(), (l) => lines.push(l));
    expect(await key.register({ request: async () => { throw new Error("no device.answerKey.set"); } }, "dev_x")).toBe(false);
    expect(lines).toEqual(["answer key: not registered (no device.answerKey.set)"]);
    expect(lines.join("\n")).not.toContain(key.publicKey().slice(0, 12));
  });
});

describe("replacing the answer key, against the core's own handler", () => {
  async function core() {
    const clock = new FakeClock();
    const device = await DeviceKey.loadOrCreate(new MemorySecretStore());
    const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-e-akr-")), key: device, clock, self: { name: "Studio", os: "macos" } });
    const broker = new CloverApprovalBroker({ clock });
    const m = devicesMethods({ registry, clock, answerKeyRotation: () => ({ broker, computer: "Studio" }) } as unknown as DevicesMethodsDeps);
    const client = { request: async <T,>(method: string, params?: unknown): Promise<T> => (await m[method]!(params, { caller: { kind: "user", client: "app" } })) as T };
    const answer = (card: string, optionId: "approve" | "deny") => {
      const c = broker.get(card)!.card;
      return broker.answer(card, { optionId, hash: c.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card)!, input: "click", at: clock.now() } }, { role: "app" });
    };
    return { clock, id: device.id, registry, broker, client, answer };
  }

  test("the hand-over statement is lane H's, byte for byte", () => {
    expect(Buffer.from(answerKeyRotateStatement("dev", "AAAA", "BBBB", 7))).toEqual(Buffer.from(coreRotateStatement("dev", "AAAA", "BBBB", 7)));
  });

  test("the card's yes swaps the key: the app signs with the new one, which the core holds and keeps", async () => {
    const c = await core();
    const vault = memoryVault("app-keychain");
    const key = new AnswerKey(vault);
    expect(await key.register(c.client, c.id)).toBe(true);
    const first = key.publicKey();
    const started = await key.rotate(c.client, c.id, c.clock.now());
    expect(started).toEqual({ card: expect.any(String) });
    const card = (started as { card: string }).card;
    expect(key.pendingCard).toBe(card);
    // Until the yes, the current key signs and stays registered.
    expect(key.publicKey()).toBe(first);
    expect(c.registry.self().answerKey?.publicKey).toBe(first);
    expect(await c.answer(card, "approve")).toBe("accepted");
    expect(await key.resolved(c.client, c.id, card, "approved")).toBe(true);
    const next = key.publicKey();
    expect(next).not.toBe(first);
    expect(c.registry.self().answerKey?.publicKey).toBe(next);
    expect(key.pendingCard).toBeUndefined();
    // Kept: a new start reads the new key from the vault, and it registers at once.
    const again = new AnswerKey(vault);
    expect(again.publicKey()).toBe(next);
    expect(await again.register(c.client, c.id)).toBe(true);
  });

  test("a no, or another card's outcome, keeps the current key", async () => {
    const c = await core();
    const key = new AnswerKey(memoryVault("app-keychain"));
    await key.register(c.client, c.id);
    const first = key.publicKey();
    const { card } = (await key.rotate(c.client, c.id, c.clock.now())) as { card: string };
    expect(await key.resolved(c.client, c.id, "card_someotherone", "approved")).toBe(false);
    expect(key.pendingCard).toBe(card);
    expect(await c.answer(card, "deny")).toBe("accepted");
    expect(await key.resolved(c.client, c.id, card, "denied")).toBe(false);
    expect(key.publicKey()).toBe(first);
    expect(c.registry.self().answerKey?.publicKey).toBe(first);
  });

  test("a hand-over the core refuses (a stale one) is said, and nothing changes", async () => {
    const c = await core();
    const key = new AnswerKey(memoryVault("app-keychain"));
    await key.register(c.client, c.id);
    const first = key.publicKey();
    const r = await key.rotate(c.client, c.id, c.clock.now() - 60 * 60 * 1000);
    expect(r).toEqual({ refused: expect.stringContaining("too old") });
    expect(key.pendingCard).toBeUndefined();
    expect(key.publicKey()).toBe(first);
    expect(c.broker.cards()).toEqual([]);
  });
});
