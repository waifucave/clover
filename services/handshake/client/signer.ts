// Ed25519 signers for handshake members, on WebCrypto alone (browsers, Bun, Workers).

import { b64u, fromB64u, utf8 } from "../../shared/encoding";

export interface Signer {
  /** The public key, base64url (32 bytes). */
  readonly key: string;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

export async function signerFromKeyPair(pair: CryptoKeyPair): Promise<Signer> {
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return {
    key: b64u(raw),
    sign: async (data) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, data as Uint8Array<ArrayBuffer>)),
  };
}

/** A fresh key pair. Not extractable by default: a browser keeps it in IndexedDB as a CryptoKey that can't be read. */
export async function generateSigner(extractable = false): Promise<{ signer: Signer; pair: CryptoKeyPair }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, extractable, ["sign", "verify"])) as CryptoKeyPair;
  return { signer: await signerFromKeyPair(pair), pair };
}

/** PKCS #8 for an Ed25519 private key is a fixed 16-byte prefix and the 32-byte seed (RFC 8410). */
const PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

/** A signer from a 32-byte seed (an invite's key, derived from its secret). */
export async function signerFromSeed(seed: Uint8Array): Promise<Signer> {
  if (seed.length !== 32) throw new TypeError("an Ed25519 seed is 32 bytes");
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(PKCS8_PREFIX);
  pkcs8.set(seed, 16);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  // The public half, from the private key's JWK (x is the public key).
  const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
  pkcs8.fill(0);
  const publicKey = fromB64u(jwk.x ?? "");
  const signing = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x }, { name: "Ed25519" }, false, ["sign"]);
  return {
    key: b64u(publicKey),
    sign: async (data) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, signing, data as Uint8Array<ArrayBuffer>)),
  };
}

export async function signText(signer: Signer, text: string): Promise<string> {
  return b64u(await signer.sign(utf8(text)));
}

export async function verifyText(key: string, sig: string, text: string): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey("raw", fromB64u(key), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, publicKey, fromB64u(sig), utf8(text));
  } catch {
    return false;
  }
}
