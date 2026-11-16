// Pair-scope boxes (PROTOCOL.md, "Boxes"): what one member seals for the other. The service never opens one.
//
//   K   = HKDF-SHA256(ikm = the pair secret, salt = the pair id's 16 bytes, info = "clover handshake v1 box"), 32 bytes
//   box = base64url( nonce (12 random bytes) || AES-256-GCM(K, nonce, plaintext, aad) )
//   aad = "clover-handshake-v1 box" \n <pair> \n <from key> \n <to key> \n <kind> [\n <gen>]

import { b64u, concatBytes, fromB64u, utf8 } from "../../shared/encoding";
import { BOX_INFO, boxAad, type Kind } from "./wire";

/** The pair's box key, from the 32-byte pair secret. Not extractable. */
export async function pairBoxKey(pairSecret: Uint8Array, pair: string): Promise<CryptoKey> {
  if (pairSecret.length !== 32) throw new TypeError("a pair secret is 32 bytes");
  const ikm = await crypto.subtle.importKey("raw", pairSecret as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: fromB64u(pair), info: utf8(BOX_INFO) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface BoxAddress {
  pair: string;
  from: string;
  to: string;
  kind: Kind;
  /** A record's generation; absent for a message. */
  gen?: number;
}

export async function sealBox(key: CryptoKey, address: BoxAddress, plaintext: Uint8Array): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = utf8(boxAad(address.pair, address.from, address.to, address.kind, address.gen));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, plaintext as Uint8Array<ArrayBuffer>));
  return b64u(concatBytes(nonce, sealed));
}

/** Opens a box, or throws when it was sealed for another pair, direction, kind or generation, or was changed. */
export async function openBox(key: CryptoKey, address: BoxAddress, box: string): Promise<Uint8Array> {
  const bytes = fromB64u(box);
  if (bytes.length < 12 + 16) throw new Error("box too short");
  const aad = utf8(boxAad(address.pair, address.from, address.to, address.kind, address.gen));
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: aad }, key, bytes.subarray(12)));
}

export async function sealJson(key: CryptoKey, address: BoxAddress, value: unknown): Promise<string> {
  return sealBox(key, address, utf8(JSON.stringify(value)));
}

export async function openJson<T = Record<string, unknown>>(key: CryptoKey, address: BoxAddress, box: string): Promise<T> {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await openBox(key, address, box))) as T;
}
