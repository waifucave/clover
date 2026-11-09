// This desktop's answer key (decision 91, lane H's ask): made once and kept in the OS's protected store, registered
// with the core under the app's signature over lane H's statement, and never written down in the clear. The tests use
// a vault in memory and a stand-in for safeStorage: never the real Keychain, Credential Manager or Secret Service.
import { describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnswerKey, AnswerKeyRegistration, answerKeyStatement, memoryVault, safeStorageVault, type SafeStorageLike } from "../src/main/answer-key";

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

describe("the answer key's registration, retried", () => {
  function setup(locked: () => boolean) {
    const calls: string[] = [];
    const client = {
      request: async <T,>(method: string): Promise<T> => {
        calls.push(method);
        if (locked()) throw new Error("no device.answerKey.set");
        return { ok: true } as T;
      },
    };
    const queue: { ms: number; fn: () => void }[] = [];
    // One-shot like setTimeout: firing removes the entry, so the queue holds only pending waits.
    const schedule = (ms: number, fn: () => void) => {
      const e = { ms, fn: () => { queue.splice(queue.indexOf(e), 1); fn(); } };
      queue.push(e);
      return { cancel: () => void queue.splice(queue.indexOf(e), 1) };
    };
    const key = new AnswerKey(memoryVault("none"));
    const reg = new AnswerKeyRegistration(key, () => {}, schedule);
    return { client, calls, queue, reg };
  }

  test("connected while the store is locked, unlocked later: registered with no reconnect, backing off", async () => {
    let locked = true;
    const { client, calls, queue, reg } = setup(() => locked);
    await reg.onConnected(client, "dev_temp");
    expect(calls).toEqual(["device.answerKey.set"]);
    // One retry waits, backing off.
    expect(queue.map((q) => q.ms)).toEqual([2000]);
    locked = false;
    await queue[0]!.fn();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(["device.answerKey.set", "device.answerKey.set"]);
    expect(queue).toHaveLength(0);
  });

  test("the backoff grows while the store stays locked", async () => {
    const { client, calls, queue, reg } = setup(() => true);
    await reg.onConnected(client, "dev_temp");
    expect(queue.map((q) => q.ms)).toEqual([2000]);
    await queue[0]!.fn();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(["device.answerKey.set", "device.answerKey.set"]);
    expect(queue.map((q) => q.ms)).toEqual([4000]);
    await queue[0]!.fn();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(["device.answerKey.set", "device.answerKey.set", "device.answerKey.set"]);
    expect(queue.map((q) => q.ms)).toEqual([8000]);
  });

  test("its own device id changing registers again; anyone else's is none of ours", async () => {
    const { client, calls, queue, reg } = setup(() => false);
    await reg.onConnected(client, "dev_standin");
    expect(calls).toEqual(["device.answerKey.set"]);
    await reg.onDeviceChanged(client, { id: "dev_other", isThis: false });
    expect(calls).toEqual(["device.answerKey.set"]);
    // Its own record changed (the stand-in id became the unlocked one): registers again, and an echo after the
    // acceptance registers nothing more.
    await reg.onDeviceChanged(client, { id: "dev_real", isThis: true });
    expect(calls).toEqual(["device.answerKey.set", "device.answerKey.set"]);
    expect(queue).toHaveLength(0);
    await reg.onDeviceChanged(client, { id: "dev_real", isThis: true });
    expect(calls).toEqual(["device.answerKey.set", "device.answerKey.set"]);
  });

  test("a reconnect registers again: a restarted daemon kept nothing", async () => {
    const { client, calls, reg } = setup(() => false);
    await reg.onConnected(client, "dev_real");
    await reg.onConnected(client, "dev_real");
    expect(calls).toEqual(["device.answerKey.set", "device.answerKey.set"]);
  });

  test("a reconnect restarts the backoff: the next failure waits 2 s again", async () => {
    const { client, calls, queue, reg } = setup(() => true);
    await reg.onConnected(client, "dev_real");
    await queue[0]!.fn();
    await new Promise((r) => setTimeout(r, 20));
    expect(queue.map((q) => q.ms)).toEqual([4000]);
    await reg.onConnected(client, "dev_real");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(["device.answerKey.set", "device.answerKey.set", "device.answerKey.set"]);
    expect(queue.map((q) => q.ms)).toEqual([2000]);
  });
});
