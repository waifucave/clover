// Strict Ed25519 key parsing and verification (ed25519-strict.ts, used by identity/keys.ts and the device registry
// contract's verifier): a public key or a signature's R must be a canonical point outside the small-order subgroup, and
// S below the group order. Real keys and signatures still verify.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContractError } from "../../contracts/common";
import { verifyKeySignature as contractVerify } from "../../contracts/device-registry";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { answerKeyStatement, FileDeviceRegistry } from "../../devices/registry";
import { allowListsOf } from "../../links/sidecar-wire";
import { toBase64 } from "../bytes";
import { DeviceKey } from "../device-key";
import { ED25519_L, isStrictEd25519Point, isStrictEd25519Signature } from "../ed25519-strict";
import { answerKeyBytes, generateEd25519, publicKeyFromBase64, verifyEd25519, verifyKeySignature } from "../keys";
import * as service from "@waifucave/clover-service-shared/ed25519-strict";
import { deviceIdFor, type PairingProof } from "../../contracts/device-registry";
import { FakeDeviceRegistry, makeFakeDevice } from "../../contracts/fakes/device-registry";
import { fallbackDialTarget } from "../../links/node";
import { helloKeysStrict } from "../../links/pairing";

const hex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const le = (n: bigint) => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return out;
};
const P = (1n << 255n) - 19n;

/** The eight small-order points, as libsodium's blocklist names them (canonical encodings). */
const SMALL_ORDER = [
  "0100000000000000000000000000000000000000000000000000000000000000", // the identity
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // order 2
  "0000000000000000000000000000000000000000000000000000000000000000", // order 4
  "0000000000000000000000000000000000000000000000000000000000000080",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05", // order 8
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
];

describe("strict Ed25519 keys", () => {
  test("the all-zero key with the all-zero signature over a real answer-key statement is refused everywhere", async () => {
    const zero = new Uint8Array(32);
    const statement = answerKeyStatement("dev_0000", toBase64(zero), "none");
    const sig = new Uint8Array(64);
    expect(verifyEd25519(zero, statement, sig)).toBe(false);
    expect(verifyKeySignature("ed25519", zero, statement, sig)).toBe(false);
    expect(await contractVerify("ed25519", zero, statement, sig)).toBe(false);
  });

  test("each small-order point is refused as a key, and as a signature's R", () => {
    const k = generateEd25519();
    const data = new TextEncoder().encode("clover/card-answer/1\ncard_x");
    const good = k.sign(data);
    for (const h of SMALL_ORDER) {
      const pt = hex(h);
      expect(isStrictEd25519Point(pt), h).toBe(false);
      expect(publicKeyFromBase64(toBase64(pt)), h).toBeNull();
      expect(answerKeyBytes("ed25519", toBase64(pt)), h).toBeNull();
      expect(verifyEd25519(pt, data, new Uint8Array(64)), h).toBe(false);
      const withR = new Uint8Array(good);
      withR.set(pt, 0);
      expect(isStrictEd25519Signature(withR), h).toBe(false);
      expect(verifyEd25519(k.publicKey, data, withR), h).toBe(false);
    }
  });

  test("non-canonical encodings are refused: y at or above p, and x = 0 with the sign bit set", () => {
    expect(isStrictEd25519Point(le(P))).toBe(false); // y = p
    expect(isStrictEd25519Point(le(P + 1n))).toBe(false); // y = p + 1, an alias of y = 1
    expect(isStrictEd25519Point(le((1n << 255n) - 1n))).toBe(false); // y = 2^255 − 1
    const xZeroSigned = (y: bigint) => le(y | (1n << 255n));
    expect(isStrictEd25519Point(xZeroSigned(1n))).toBe(false); // (0, 1) with the sign bit
    expect(isStrictEd25519Point(xZeroSigned(P - 1n))).toBe(false); // (0, −1) with the sign bit
    expect(publicKeyFromBase64(toBase64(le(P + 1n)))).toBeNull();
  });

  test("a signature whose S is at or above the group order is refused", () => {
    const k = generateEd25519();
    const data = new TextEncoder().encode("hello");
    const sig = k.sign(data);
    let s = 0n;
    for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(sig[32 + i]!);
    for (const bad of [s + ED25519_L, ED25519_L]) {
      const forged = new Uint8Array(sig);
      forged.set(le(bad), 32);
      expect(isStrictEd25519Signature(forged)).toBe(false);
      expect(verifyEd25519(k.publicKey, data, forged)).toBe(false);
    }
  });

  test("real keys and signatures still verify, by both verifiers", async () => {
    for (let i = 0; i < 50; i++) {
      const k = generateEd25519();
      const data = new TextEncoder().encode(`message ${i}`);
      const sig = k.sign(data);
      expect(publicKeyFromBase64(toBase64(k.publicKey))).toEqual(k.publicKey);
      expect(verifyEd25519(k.publicKey, data, sig)).toBe(true);
      expect(verifyKeySignature("ed25519", k.publicKey, data, sig)).toBe(true);
      expect(await contractVerify("ed25519", k.publicKey, data, sig)).toBe(true);
      expect(verifyEd25519(k.publicKey, new TextEncoder().encode("other"), sig)).toBe(false);
    }
  });

  test("this desktop's answer key: a small-order key is refused by the registry, and a real one is taken", async () => {
    const key = await DeviceKey.loadOrCreate(new MemorySecretStore());
    const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-h-strict-")), key, clock: new FakeClock(), self: { name: "Studio", os: "macos" } });
    const zero = toBase64(new Uint8Array(32));
    const err = await registry.setOwnAnswerKey(zero, "none", new Uint8Array(64)).catch((e: unknown) => e);
    expect(isContractError(err, "invalid")).toBe(true);
    expect(registry.self().answerKey).toBeUndefined();
    const app = generateEd25519();
    const pub = toBase64(app.publicKey);
    await registry.setOwnAnswerKey(pub, "none", app.sign(answerKeyStatement(key.id, pub, "none")));
    expect(registry.self().answerKey?.publicKey).toBe(pub);
  });

  test("a peer's link key: a small-order one is never let into the sidecar's allow list", () => {
    const real = generateEd25519();
    const lists = allowListsOf({
      self: () => ({ id: "self" }),
      all: () => [{ id: "self", publicKey: "x" }, { id: "a", publicKey: toBase64(real.publicKey) }, { id: "b", publicKey: toBase64(new Uint8Array(32)) }],
    });
    expect(lists.keys).toEqual([real.publicKey]);
  });

  test("the Workers' copy (services/shared) agrees with this one, input for input", () => {
    const inputs: Uint8Array[] = [...SMALL_ORDER.map(hex), le(P), le(P + 1n), le((1n << 255n) - 1n), le(1n | (1n << 255n))];
    for (let i = 0; i < 200; i++) inputs.push(generateEd25519().publicKey, new Uint8Array(Buffer.from(crypto.getRandomValues(new Uint8Array(32)))));
    for (const x of inputs) expect(service.isStrictEd25519Point(x)).toBe(isStrictEd25519Point(x));
    expect(service.ED25519_L).toBe(ED25519_L);
    const k = generateEd25519();
    const sig = k.sign(new Uint8Array([1]));
    const bigS = new Uint8Array(sig);
    bigS.set(le(ED25519_L), 32);
    for (const x of [sig, bigS, new Uint8Array(64)]) expect(service.isStrictEd25519Signature(x)).toBe(isStrictEd25519Signature(x));
  });

  test("a pairing hello's pair and group keys must be strict (the pair key becomes the handshake's peer key)", () => {
    const pairKey = generateEd25519().publicKey;
    const groupKey = generateEd25519().publicKey;
    expect(helloKeysStrict({ pairKey, groupKey })).toBe(true);
    for (const h of SMALL_ORDER) {
      expect(helloKeysStrict({ pairKey: hex(h), groupKey }), h).toBe(false);
      expect(helloKeysStrict({ pairKey, groupKey: hex(h) }), h).toBe(false);
    }
    expect(helloKeysStrict({ pairKey: le(P + 1n), groupKey })).toBe(false);
    expect(helloKeysStrict({ pairKey: "x", groupKey })).toBe(false);
  });

  test("the fallback dial target is only a strict registry key", () => {
    const real = generateEd25519().publicKey;
    const records: Record<string, { publicKey: string; revokedAt?: number }> = { a: { publicKey: toBase64(real) }, b: { publicKey: toBase64(new Uint8Array(32)) }, c: { publicKey: toBase64(real), revokedAt: 1 } };
    const registry = { get: (id: string) => records[id] as never };
    expect(fallbackDialTarget(registry, "a")?.key).toEqual(real);
    expect(fallbackDialTarget(registry, "b")).toBeUndefined();
    expect(fallbackDialTarget(registry, "c")).toBeUndefined();
  });

  test("the fake device registry verifies through the contract's strict verifier", async () => {
    const { registry } = await FakeDeviceRegistry.create({ clock: new FakeClock() });
    const zero = new Uint8Array(32);
    const zeroId = await deviceIdFor(zero);
    await registry.add({ id: zeroId, publicKey: toBase64(zero), name: "Zero", kind: "desktop", runsCore: true }, { via: "code", card: "card_test" } as PairingProof);
    // A statement the all-zero signature passes under a plain verify: refused here.
    const statement = new TextEncoder().encode("clover/answer-key/1\nabc\nxyz\nnone");
    expect(await registry.verify(zeroId, statement, new Uint8Array(64))).toBe(false);
    const real = await makeFakeDevice();
    await registry.add({ id: real.id, publicKey: real.publicKey, name: "Real", kind: "desktop", runsCore: true }, { via: "code", card: "card_test" } as PairingProof);
    expect(await registry.verify(real.id, statement, await real.sign(statement))).toBe(true);
  });
});
