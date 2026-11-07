// A group's recovery code (PROTOCOL.md, "Group recovery"): 128 random bits the user keeps, shown as 26 Crockford
// base32 characters in groups of five. Its signing key comes from HKDF over the code's 16 bytes, so the service
// keeps only the public half and never sees the code. Lane H's client shows it and signs with it.

import { fromB64u } from "../../shared/encoding";
import { type Signer, signerFromSeed } from "./signer";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const INFO = "clover handshake v1 recovery";

/** A new code's 16 bytes. */
export function newRecoveryCode(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/** `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X`. */
export function formatRecoveryCode(code: Uint8Array): string {
  if (code.length !== 16) throw new TypeError("a recovery code is 16 bytes");
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of code) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  out += ALPHABET[(value << (5 - bits)) & 31];
  return out.match(/.{1,5}/g)!.join("-");
}

/** The code's 16 bytes from what the user typed: any case, dashes and spaces ignored, 0/O and 1/I/L alike. Null for
 *  anything else, a wrong length or nonzero padding bits among it. */
export function parseRecoveryCode(text: string): Uint8Array | null {
  const clean = text.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (clean.length !== 26) return null;
  const out = new Uint8Array(16);
  let bits = 0;
  let value = 0;
  let n = 0;
  for (const ch of clean) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) return null;
    value = ((value << 5) | digit) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      if (n < 16) out[n] = (value >>> (bits - 8)) & 0xff;
      n++;
      bits -= 8;
    }
  }
  // 26 characters carry 130 bits: the last 2 must be zero.
  if ((value & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

/** The code's signer for one group: seed = HKDF-SHA256(code, salt = the group id's 16 bytes, INFO). */
export async function recoverySigner(code: Uint8Array, group: string): Promise<Signer> {
  const ikm = await crypto.subtle.importKey("raw", code as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveBits"]);
  const seed = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: fromB64u(group), info: new TextEncoder().encode(INFO) }, ikm, 256),
  );
  try {
    return await signerFromSeed(seed);
  } finally {
    seed.fill(0);
  }
}
