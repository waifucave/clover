// Byte helpers shared by the forwarder plugin and the forwarder service (services/forwarder imports this
// folder by relative path). Web-standard APIs only, so the same code runs in Bun, workerd and Node.

/** A byte array backed by a plain ArrayBuffer, which is what WebCrypto accepts. */
export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function utf8(text: string): Bytes {
  return encoder.encode(text) as Bytes;
}

/** Decodes UTF-8, throwing on invalid sequences. */
export function fromUtf8(data: Uint8Array): string {
  return decoder.decode(data);
}

export function concat(...parts: readonly Uint8Array[]): Bytes {
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

/** A copy of `data` that owns a plain ArrayBuffer. */
export function own(data: Uint8Array): Bytes {
  const out = new Uint8Array(data.length);
  out.set(data);
  return out;
}

export function randomBytes(length: number): Bytes {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/** Big-endian unsigned integer of `length` bytes (RFC 9180's I2OSP), for values up to 2^53. */
export function i2osp(value: number, length: number): Bytes {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("i2osp: not a safe unsigned integer");
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  if (rest !== 0) throw new RangeError("i2osp: value too large");
  return out;
}

/** Reads a big-endian unsigned integer of `length` bytes (at most 7, so the result stays safe). */
export function os2ip(data: Uint8Array, offset: number, length: number): number {
  if (length > 7) throw new RangeError("os2ip: at most 7 bytes");
  if (offset + length > data.length) throw new RangeError("os2ip: out of range");
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + data[offset + i]!;
  return value;
}

/** Writes a timestamp or sequence number as 8 big-endian bytes. */
export function u64(value: number): Bytes {
  return i2osp(value, 8);
}

/** Reads 8 big-endian bytes; the top byte must be zero, so the value fits a safe integer. */
export function readU64(data: Uint8Array, offset: number): number {
  if (offset + 8 > data.length) throw new RangeError("readU64: out of range");
  if (data[offset] !== 0) throw new RangeError("readU64: value too large");
  return os2ip(data, offset + 1, 7);
}

/** Compares two byte arrays in time that depends only on their lengths. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const B64U_RE = /^[A-Za-z0-9_-]*$/;

/** base64url without padding (RFC 4648 §5). */
export function b64u(data: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict base64url decoding: the URL-safe alphabet, no padding, no whitespace. */
export function fromB64u(text: string): Bytes {
  if (!B64U_RE.test(text) || text.length % 4 === 1) throw new TypeError("not base64url");
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  // Re-encode so a non-canonical final character (stray low bits) is refused too.
  if (b64u(out) !== text) throw new TypeError("not canonical base64url");
  return out;
}

/** Decodes base64url and checks the decoded length. */
export function fromB64uLength(text: string, length: number): Bytes {
  const out = fromB64u(text);
  if (out.length !== length) throw new TypeError(`expected ${length} bytes`);
  return out;
}

export function hex(data: Uint8Array): string {
  let out = "";
  for (const byte of data) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(text: string): Bytes {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(text)) throw new TypeError("not hex");
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", own(data)));
}
