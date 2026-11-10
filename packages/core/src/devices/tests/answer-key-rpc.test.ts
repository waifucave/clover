// `device.answerKey.set` (devices/rpc.ts): this desktop's app registers the key it answers cards with, on every
// connection. The registry takes it only with the app's signature; the first key and the same key again apply; another
// key in place of a held one is refused (no card subject or hand-over for it yet); a small-order key never is taken;
// only the app's user may set it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOVER_ERR, ERR, type Caller } from "@waifucave/clover-protocol";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { DeviceKey } from "../../identity/device-key";
import { toBase64 } from "../../identity/bytes";
import { generateEd25519 } from "../../identity/keys";
import { answerKeyStatement, FileDeviceRegistry } from "../registry";
import { devicesMethods, type DevicesMethodsDeps } from "../rpc";

const app: Caller = { kind: "user", client: "app" };

async function make() {
  const key = await DeviceKey.loadOrCreate(new MemorySecretStore());
  const clock = new FakeClock();
  const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-h-ak-")), key, clock, self: { name: "Studio", os: "macos" } });
  const m = devicesMethods({ registry, clock } as unknown as DevicesMethodsDeps);
  const set = (k: ReturnType<typeof generateEd25519>, caller: Caller = app, signer = k) => {
    const publicKey = toBase64(k.publicKey);
    return m["device.answerKey.set"]!({ publicKey, held: "app-keychain", signature: toBase64(signer.sign(answerKeyStatement(key.id, publicKey, "app-keychain"))) }, { caller });
  };
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e as { code?: number }).code);
  return { registry, set, code, m };
}

describe("device.answerKey.set", () => {
  test("the first key applies, and the same key again (every connection) applies", async () => {
    const { registry, set } = await make();
    const k = generateEd25519();
    expect(await set(k)).toEqual({ applied: true });
    expect(registry.self().answerKey).toEqual({ publicKey: toBase64(k.publicKey), held: "app-keychain" });
    expect(await set(k)).toEqual({ applied: true });
  });

  test("a key the app didn't sign is refused, and nothing is taken", async () => {
    const { registry, set, code } = await make();
    expect(await code(set(generateEd25519(), app, generateEd25519()))).not.toBe("ok");
    expect(registry.self().answerKey).toBeUndefined();
  });

  test("another key in place of a held one is refused, never applied", async () => {
    const { registry, set, code } = await make();
    const first = generateEd25519();
    await set(first);
    expect(await code(set(generateEd25519()))).toBe(ERR.INVALID_REQUEST);
    expect(registry.self().answerKey?.publicKey).toBe(toBase64(first.publicKey));
  });

  test("a small-order key (the all-zero one among them) is refused, signature or not, and nothing is taken", async () => {
    const { registry, m, code } = await make();
    for (const hex of ["0000000000000000000000000000000000000000000000000000000000000000", "0100000000000000000000000000000000000000000000000000000000000000", "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"]) {
      const publicKey = Buffer.from(hex, "hex").toString("base64");
      expect(await code(m["device.answerKey.set"]!({ publicKey, held: "app-keychain", signature: toBase64(new Uint8Array(64)) }, { caller: app }))).not.toBe("ok");
    }
    expect(registry.self().answerKey).toBeUndefined();
  });

  test("only the app's user sets it: not the terminal, not a session", async () => {
    const { registry, set, code } = await make();
    expect(await code(set(generateEd25519(), { kind: "user", client: "cli" }))).toBe(CLOVER_ERR.NOT_THE_USER);
    expect(await code(set(generateEd25519(), { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "alpha" }))).toBe(CLOVER_ERR.NOT_THE_USER);
    expect(registry.self().answerKey).toBeUndefined();
  });

  test("a signature that isn't base64 is refused as invalid params", async () => {
    const { m, code } = await make();
    expect(await code(m["device.answerKey.set"]!({ publicKey: toBase64(generateEd25519().publicKey), held: "app-keychain", signature: "abc" }, { caller: app }))).not.toBe("ok");
  });
});
