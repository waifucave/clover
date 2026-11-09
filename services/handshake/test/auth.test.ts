// The Worker's signature check (src/auth.ts) is strict, as the core's: a small-order or non-canonical key or R, or an S
// at or above the group order, is refused before WebCrypto's verify; a real key and signature still verify.
import { describe, expect, test } from "vitest";

import { b64u, utf8 } from "../../shared/encoding";
import { generateSigner } from "../client/signer";
import { verifySignature } from "../src/auth";

const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const le = (n: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));

async function realKey() {
  const { signer } = await generateSigner();
  return { key: signer.key, sign: (text: string) => signer.sign(utf8(text)) };
}

describe("verifySignature", () => {
  test("the all-zero key with the all-zero signature is refused, for any statement", async () => {
    for (const text of ["clover-pair-v1 register\nx", "clover/answer-key/1\ndev\nkey\nnone", "anything"]) {
      expect(await verifySignature(b64u(new Uint8Array(32)), b64u(new Uint8Array(64)), text)).toBe(false);
    }
  });

  test("a real signature verifies; with a small-order R, or S at or above L, it doesn't", async () => {
    const k = await realKey();
    const text = "clover-group-v1 admit\ng\nk\n1";
    const sig = await k.sign(text);
    expect(await verifySignature(k.key, b64u(sig), text)).toBe(true);
    const smallR = new Uint8Array(sig);
    smallR.set(new Uint8Array(32), 0);
    expect(await verifySignature(k.key, b64u(smallR), text)).toBe(false);
    let s = 0n;
    for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(sig[32 + i]!);
    const bigS = new Uint8Array(sig);
    bigS.set(le(s + L), 32);
    expect(await verifySignature(k.key, b64u(bigS), text)).toBe(false);
  });

  test("a non-canonical key (y at or above p) is refused", async () => {
    const p = (1n << 255n) - 19n;
    expect(await verifySignature(b64u(le(p + 1n)), b64u(new Uint8Array(64)), "x")).toBe(false);
  });
});
