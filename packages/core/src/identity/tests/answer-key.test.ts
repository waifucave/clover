// The app-held answer key (item 91): how it is held per OS, and that the core takes it only with the app's proof and
// then verifies answers with it, not with the link key.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import type { Secret } from "../../contracts/secret-store";
import { FileDeviceRegistry } from "../../devices/registry";
import { cardAnswerSigningInput } from "@waifucave/clover-protocol";
import { fromBase64, utf8 } from "../bytes";
import { AnswerKey, answerKeyHolder } from "../answer-key";
import { DeviceKey } from "../device-key";

describe("answer key", () => {
  test("held by the Keychain on macOS, Hello or the TPM on Windows, and marked none elsewhere", () => {
    expect(answerKeyHolder("macos", { appKeychain: true })).toBe("app-keychain");
    expect(answerKeyHolder("macos", {})).toBe("none");
    // Never Windows Hello, which prompts: the TPM, or nothing.
    expect(answerKeyHolder("windows", { tpm: true })).toBe("tpm");
    expect(answerKeyHolder("windows", { hello: true, tpm: false } as never)).toBe("none");
    expect(answerKeyHolder("windows", { tpm: true })).toBe("tpm");
    expect(answerKeyHolder("windows", {})).toBe("none");
    expect(answerKeyHolder("linux", { tpm: true })).toBe("none");
  });

  test("the app's key reaches the registry with its proof; answers verify with it and never with the link key", async () => {
    let saved: Secret | null = null;
    const storage = { load: async () => saved, save: async (s: Secret) => void (saved = s) };
    const appKey = await AnswerKey.loadOrCreate(storage, "app-keychain");
    expect((await AnswerKey.loadOrCreate(storage, "app-keychain")).publicKey).toBe(appKey.publicKey);
    expect(JSON.stringify(appKey)).toBe('"[answer key]"');

    const store = new MemorySecretStore();
    const key = await DeviceKey.loadOrCreate(store);
    const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-h-answer-")), key, clock: { now: () => Date.now() }, self: { name: "Studio", os: "macos" } });
    const reg = appKey.registration(key.id);
    await registry.setOwnAnswerKey(reg.publicKey, reg.held, fromBase64(reg.signature)!);
    const answer = { id: "card_abcdef", hash: "00".repeat(32), option: "approve", at: Date.now() };
    const data = utf8(cardAnswerSigningInput(answer));
    expect(await registry.verifyAnswer(key.id, data, fromBase64(appKey.signAnswer(answer))!)).toBe(true);
    expect(await registry.verifyAnswer(key.id, data, key.sign(data))).toBe(false);
  });

  test("the app moves to a new key by having the old one sign the hand-over", async () => {
    const mem = () => {
      let saved: Secret | null = null;
      return { load: async () => saved, save: async (s: Secret) => void (saved = s) };
    };
    const old = await AnswerKey.loadOrCreate(mem(), "none");
    const next = await AnswerKey.loadOrCreate(mem(), "app-keychain");
    const key = await DeviceKey.loadOrCreate(new MemorySecretStore());
    const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-h-answer-")), key, clock: { now: () => Date.now() }, self: { name: "Studio", os: "macos" } });
    const r1 = old.registration(key.id);
    await registry.setOwnAnswerKey(r1.publicKey, r1.held, fromBase64(r1.signature)!);
    const r2 = next.registration(key.id);
    const h = old.handOverTo(next, key.id, Date.now());
    await registry.setOwnAnswerKey(r2.publicKey, r2.held, fromBase64(r2.signature)!, { from: h.from, at: h.at, signature: fromBase64(h.signature)! });
    expect(registry.self().answerKey).toEqual({ publicKey: next.publicKey, held: "app-keychain" });
  });
});
