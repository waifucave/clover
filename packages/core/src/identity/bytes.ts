// Small byte helpers lane H's identity, devices and links code shares: base64 in both alphabets, UTF-8, hashing and a
// constant-time comparison. Nothing here holds a secret; callers wrap secrets in `Secret` (contracts/secret-store).

export type Bytes = Uint8Array<ArrayBuffer>;

export const utf8 = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;
export const fromUtf8 = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

/** A copy backed by its own ArrayBuffer (WebCrypto wants one, and a view into a larger buffer would leak the rest). */
export function own(bytes: Uint8Array): Bytes {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out as Bytes;
}

export function concat(...parts: readonly Uint8Array[]): Bytes {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out as Bytes;
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** Strict standard base64 (with padding); null for anything else. */
export function fromBase64(text: string): Bytes | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return null;
  return own(Buffer.from(text, "base64"));
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

/** Strict unpadded base64url; null for anything else. */
export function fromBase64Url(text: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  return own(Buffer.from(text, "base64url"));
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
}

export function randomBytes(n: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(n)) as Bytes;
}

export async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", own(data))) as Bytes;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return toHex(await sha256(typeof data === "string" ? utf8(data) : data));
}

/** Equal length and equal bytes, in time that depends only on the length. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Big-endian unsigned 32-bit. */
export function u32(n: number): Bytes {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out as Bytes;
}
