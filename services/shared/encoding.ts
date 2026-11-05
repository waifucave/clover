// Small encoding helpers for the waifucave services (forwarder, push). This folder is plain source shared by
// relative import; it becomes a workspace package once the repo's workspace globs cover services/.

export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();

export function utf8(text: string): Bytes {
  return encoder.encode(text) as Bytes;
}

export function concatBytes(...parts: readonly Uint8Array[]): Bytes {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function b64u(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict, canonical base64url without padding; throws otherwise. */
export function fromB64u(text: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new TypeError("not base64url");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  if (b64u(out) !== text) throw new TypeError("not canonical base64url");
  return out;
}

/** Standard base64 (with padding), as PEM bodies and some secrets use. Whitespace is ignored. */
export function fromB64(text: string): Bytes {
  const binary = atob(text.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function sha256(data: Uint8Array): Promise<Bytes> {
  const copy = new Uint8Array(data.length);
  copy.set(data);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
}

const hmacKeys = new Map<string, Promise<CryptoKey>>();

/** HMAC-SHA256 with a base64url secret from the environment; imported keys are cached per isolate. */
export async function hmacSha256(secretB64u: string, data: Uint8Array): Promise<Bytes> {
  let key = hmacKeys.get(secretB64u);
  if (!key) {
    const raw = fromB64u(secretB64u);
    if (raw.length < 32) throw new Error("hmac secret must be at least 32 bytes");
    key = crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    hmacKeys.set(secretB64u, key);
  }
  const copy = new Uint8Array(data.length);
  copy.set(data);
  return new Uint8Array(await crypto.subtle.sign("HMAC", await key, copy));
}
