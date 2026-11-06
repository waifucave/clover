// This desktop's answer key (decision 91, lane H's ask): made once and kept in the OS's protected store, registered
// with the core under the app's signature over lane H's statement, and never written down in the clear. The tests use
// a vault in memory and a stand-in for safeStorage: never the real Keychain, Credential Manager or Secret Service.
import { describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnswerKey, answerKeyStatement, holderFor, memoryVault, safeStorageVault, type SafeStorageLike } from "../src/main/answer-key";

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
    expect(holderFor("darwin")).toBe("app-keychain");
    expect(holderFor("win32")).toBe("none");
    expect(holderFor("linux")).toBe("none");
  });

  test("the user is never asked for their presence or identity to hold or to use the key (the owner's decision, E-M2)", () => {
    // The holder names: none of them is a prompt-gated one on this side; a Windows Hello key credential and a TPM or
    // Secure Enclave key with a user-presence ACL would ask. What the app holds is safeStorage's Keychain item / DPAPI
    // / Secret Service, which keep it at rest with no ACL, and the stores' names for the core stay honest above.
    const labels = [holderFor("darwin"), holderFor("win32"), holderFor("linux")];
    expect(labels).not.toContain("hello");
    expect(labels).not.toContain("tpm");
    // Loading, saving (over a made key) and signing stay free of anything the OS would ask about.
    const file = join(mkdtempSync(join(tmpdir(), "clover-answer-key-")), "answer-key");
    const vault = safeStorageVault(file, fakeStorage, "win32");
    const key = new AnswerKey(vault);
    expect(key.sign(new Uint8Array([1, 2, 3]))).toHaveLength(64);
    key.vault.save(new Uint8Array(key.sign(new Uint8Array([4]))));
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
