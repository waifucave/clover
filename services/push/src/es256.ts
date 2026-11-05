// ES256 (ECDSA P-256, SHA-256) JWTs and P-256 key import: what APNs provider tokens and VAPID both use.

import { b64u, fromB64, fromB64u, utf8 } from "../../shared/encoding";

/** Imports a P-256 private key given as PKCS #8: PEM (an APNs .p8 file) or bare base64 DER. */
export async function importPkcs8(text: string): Promise<CryptoKey> {
  const body = text.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "");
  return crypto.subtle.importKey("pkcs8", fromB64(body), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** Imports a VAPID key pair from its raw parts: the 65-byte uncompressed public key and the 32-byte scalar. */
export async function importRawP256(publicKey: Uint8Array, d: Uint8Array, usage: "sign" | "deriveBits"): Promise<CryptoKey> {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04 || d.length !== 32) throw new TypeError("not a P-256 key pair");
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: b64u(publicKey.subarray(1, 33)),
    y: b64u(publicKey.subarray(33, 65)),
    d: b64u(d),
  };
  return usage === "sign"
    ? crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
    : crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

export function decodeRawPublicKey(text: string): Uint8Array<ArrayBuffer> {
  const raw = fromB64u(text);
  if (raw.length !== 65 || raw[0] !== 0x04) throw new TypeError("not an uncompressed P-256 public key");
  return raw;
}

/** A compact JWS signed with ES256 (the signature as JOSE wants it, r || s). */
export async function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: CryptoKey): Promise<string> {
  const input = `${b64u(utf8(JSON.stringify(header)))}.${b64u(utf8(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(input));
  return `${input}.${b64u(new Uint8Array(signature))}`;
}
