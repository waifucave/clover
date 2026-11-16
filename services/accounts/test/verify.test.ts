// The accounts Worker's signature check (src/verify.ts) is strict, as the core's: the all-zero key with the all-zero
// signature (which WebCrypto's Ed25519 verify passes for some statements) is refused, so is a small-order R or an S at
// or above L; a real key and signature still verify.
import { describe, expect, test } from "vitest";

import { utf8 } from "../../shared/encoding";
import { verifyEd25519 } from "../src/verify";

const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const le = (n: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));

describe("verifyEd25519", () => {
  test("the all-zero key and signature are refused, for any statement", async () => {
    for (const text of ["clover/answer-key/1\nabc\nxyz\nnone", "clover-account-v2 register", "x"]) {
      expect(await verifyEd25519(new Uint8Array(32), new Uint8Array(64), utf8(text))).toBe(false);
    }
  });

  test("a real signature verifies; with a small-order R, or S at or above L, it doesn't", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const key = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
    const data = utf8("clover-account-v2 mint");
    const sig = new Uint8Array((await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, data)) as ArrayBuffer);
    expect(await verifyEd25519(key, sig, data)).toBe(true);
    const smallR = new Uint8Array(sig);
    smallR.set(new Uint8Array(32), 0);
    expect(await verifyEd25519(key, smallR, data)).toBe(false);
    let s = 0n;
    for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(sig[32 + i]!);
    const bigS = new Uint8Array(sig);
    bigS.set(le(s + L), 32);
    expect(await verifyEd25519(key, bigS, data)).toBe(false);
  });
});
