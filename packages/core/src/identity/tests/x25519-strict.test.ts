// Strict X25519 box keys: the low-order points (libsodium's blocklist), non-canonical encodings and the high bit are
// refused wherever a box key enters — the registry, a seal, an open, the account fake, the account sync — and the
// Workers' copy of the check agrees with the core's.
import { afterEach, describe, expect, test } from "bun:test";
import { diffieHellman, generateKeyPairSync, createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStrictX25519PublicKey as sharedCheck } from "@waifucave/clover-service-shared/x25519-strict";
import { startSignInStub } from "@waifucave/clover-test-harness/signin-stub";
import { isContractError } from "../../contracts/common";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { Secret } from "../../contracts/secret-store";
import { syncAccountDevices } from "../../devices/account-devices";
import { FileDeviceRegistry } from "../../devices/registry";
import { AccountClient, type AccountDevice } from "../account";
import { startFakeAccountService } from "../account-fake";
import { BoxKey, sealToBoxKey } from "../box-key";
import { concat, toBase64Url, utf8 } from "../bytes";
import { DeviceKey } from "../device-key";
import { isStrictX25519PublicKey } from "../x25519-strict";

const hex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const withHighBit = (b: Uint8Array) => b.map((x, i) => (i === 31 ? x | 0x80 : x));

// libsodium's blocklist (crypto_scalarmult/curve25519/ref10/x25519_ref10.c): the curve's and the twist's points of
// order 1, 2, 4 and 8, and the encodings of 0 and 1 at or above p.
const LOW_ORDER = [
  "0000000000000000000000000000000000000000000000000000000000000000", // 0
  "0100000000000000000000000000000000000000000000000000000000000000", // 1
  "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800", // order 8
  "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157", // order 8
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // p − 1
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // p
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // p + 1
].map(hex);

function realKey(): Uint8Array {
  const { publicKey } = generateKeyPairSync("x25519");
  return new Uint8Array((publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12));
}

let stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.reverse()) s();
  stops = [];
});

describe("isStrictX25519PublicKey", () => {
  test("refuses every low-order point, with and without the high bit", () => {
    for (const k of LOW_ORDER) {
      expect(isStrictX25519PublicKey(k)).toBe(false);
      expect(isStrictX25519PublicKey(withHighBit(k))).toBe(false);
    }
  });

  test("refuses non-canonical encodings: u at or above p, and the high bit on a good key", () => {
    // p + 9 is the base point's u, reduced; X25519 itself would take it.
    expect(isStrictX25519PublicKey(hex("0900000000000000000000000000000000000000000000000000000000000000"))).toBe(true);
    expect(isStrictX25519PublicKey(hex("f6ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"))).toBe(false);
    const k = realKey();
    expect(isStrictX25519PublicKey(withHighBit(k))).toBe(false);
    expect(isStrictX25519PublicKey(k.subarray(0, 31))).toBe(false);
  });

  test("takes real keys", () => {
    for (let i = 0; i < 200; i++) expect(isStrictX25519PublicKey(realKey())).toBe(true);
  });

  test("the low-order points are exactly the ones whose shared secret is all zero", () => {
    // Why they're refused: whatever the private key, the agreement with one of them is all zero (or OpenSSL refuses it).
    const { privateKey } = generateKeyPairSync("x25519");
    const spki = Buffer.from("302a300506032b656e032100", "hex");
    for (const k of LOW_ORDER.slice(0, 4)) {
      let zero: boolean;
      try {
        const dh = diffieHellman({ privateKey, publicKey: createPublicKey({ key: Buffer.concat([spki, Buffer.from(k)]), format: "der", type: "spki" }) });
        zero = dh.every((b) => b === 0);
      } catch {
        zero = true;
      }
      expect(zero).toBe(true);
    }
  });

  test("the Workers' copy agrees with the core's", () => {
    const core = readFileSync(join(import.meta.dir, "../x25519-strict.ts"), "utf8");
    const copy = readFileSync(join(import.meta.dir, "../../../../../services/shared/x25519-strict.ts"), "utf8");
    expect(copy.endsWith(core)).toBe(true);
    for (const k of [...LOW_ORDER, ...LOW_ORDER.map(withHighBit), realKey(), realKey()]) expect(sharedCheck(k)).toBe(isStrictX25519PublicKey(k));
  });
});

describe("where a box key enters", () => {
  test("sealToBoxKey refuses a low-order recipient; BoxKey.open refuses a low-order enc", () => {
    for (const k of LOW_ORDER) {
      try {
        sealToBoxKey(k, utf8("aad"), utf8("hello"));
        throw new Error("sealed to a low-order key");
      } catch (err) {
        expect(isContractError(err) && err.code === "invalid").toBe(true);
      }
    }
    const mine = BoxKey.generate();
    for (const k of LOW_ORDER) expect(mine.open(toBase64Url(concat(k, new Uint8Array(48))), utf8("aad"))).toBeUndefined();
    // A good box still opens.
    expect(new TextDecoder().decode(mine.open(sealToBoxKey(mine.publicKey, utf8("aad"), utf8("hi")), utf8("aad"))!)).toBe("hi");
  });

  test("the registry's setBoxKey refuses a key that isn't usable and keeps a good one", async () => {
    const store = new MemorySecretStore();
    const key = await DeviceKey.loadOrCreate(store);
    const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-k-x25519-")), key, clock: { now: () => Date.now() }, self: { name: "Studio", os: "macos" } });
    const id = registry.self().id;
    for (const k of [...LOW_ORDER, withHighBit(realKey())]) {
      try {
        registry.setBoxKey(id, toBase64Url(k));
        throw new Error("took an unusable box key");
      } catch (err) {
        expect(isContractError(err) && err.code === "invalid").toBe(true);
      }
    }
    expect(registry.boxKey(id)).toBeUndefined();
    const good = toBase64Url(realKey());
    registry.setBoxKey(id, good);
    expect(registry.boxKey(id)).toBe(good);
  });

  test("the account fake refuses to register one, and the account sync leaves out a listed one", async () => {
    const auth = startSignInStub();
    stops.push(() => auth.stop());
    const service = startFakeAccountService({ authUrl: auth.url, anonKey: auth.anonKey });
    stops.push(() => service.stop());
    auth.addUser({ email: "someone@example.invalid", password: "correct horse" });
    const store = new MemorySecretStore();
    const key = await DeviceKey.loadOrCreate(store);
    const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-k-x25519-")), key, clock: { now: () => Date.now() }, self: { name: "Studio", os: "macos" } });
    const account = new AccountClient({ config: { authUrl: auth.url, anonKey: auth.anonKey, serviceUrl: service.url }, store, device: key, clock: { now: () => Date.now() } });
    stops.push(() => account.close());
    await account.signInWithPassword("someone@example.invalid", new Secret("correct horse"));
    for (const k of [LOW_ORDER[2]!, withHighBit(realKey())]) await expect(account.registerDevice({ name: "Studio", kind: "desktop", os: "macos", boxKey: toBase64Url(k) })).rejects.toThrow();
    expect((await account.registerDevice({ name: "Studio", kind: "desktop", os: "macos", boxKey: toBase64Url(realKey()) })).id).toBe(key.id);

    // A listing (from a service that didn't check) with a low-order box key: the device is added, its box key isn't.
    const other = await DeviceKey.loadOrCreate(new MemorySecretStore());
    const listed: AccountDevice = { id: other.id, publicKey: other.publicKeyBase64, boxKey: toBase64Url(LOW_ORDER[3]!), name: "Laptop", kind: "desktop", os: "macos", addedAt: Date.now() };
    const unchecked = {
      accountId: async () => "someone",
      registerDevice: async () => listed,
      listDevices: async () => [listed],
    } as unknown as AccountClient;
    const { added } = await syncAccountDevices({ registry, account: unchecked, device: key, boxKey: BoxKey.generate() });
    expect(added).toEqual([other.id]);
    expect(registry.boxKey(other.id)).toBeUndefined();
  });
});
