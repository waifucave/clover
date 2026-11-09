// The Workers' copy of the strict Ed25519 checks (../ed25519-strict.ts), under Bun: libsodium's small-order points and
// the non-canonical encodings refused, S below L, and real keys and signatures accepted. The core checks this copy
// agrees with its own, input for input (packages/core/src/identity/tests/ed25519-strict.test.ts).
import { describe, expect, test } from "bun:test";
import { ED25519_L, isStrictEd25519Point, isStrictEd25519Signature } from "../ed25519-strict";

const hex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const le = (n: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const P = (1n << 255n) - 19n;

describe("the Workers' strict Ed25519", () => {
  test("the eight small-order points and the non-canonical encodings are refused", () => {
    for (const h of [
      "0100000000000000000000000000000000000000000000000000000000000000", "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "0000000000000000000000000000000000000000000000000000000000000000", "0000000000000000000000000000000000000000000000000000000000000080",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05", "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a", "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    ]) expect(isStrictEd25519Point(hex(h)), h).toBe(false);
    for (const y of [P, P + 1n, (1n << 255n) - 1n]) expect(isStrictEd25519Point(le(y))).toBe(false);
    expect(isStrictEd25519Point(le(1n | (1n << 255n)))).toBe(false);
  });

  test("real keys and signatures pass; S at or above L doesn't", async () => {
    for (let i = 0; i < 20; i++) {
      const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new Uint8Array([i])));
      expect(isStrictEd25519Point(raw)).toBe(true);
      expect(isStrictEd25519Signature(sig)).toBe(true);
      const big = new Uint8Array(sig);
      big.set(le(ED25519_L), 32);
      expect(isStrictEd25519Signature(big)).toBe(false);
    }
  });
});
