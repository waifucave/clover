// The link's payload encoding: a deterministic subset of CBOR (RFC 8949) for structured-clone data, since the
// LinkTransport contract carries structured-clone payloads between devices that may run different Clover releases
// (Bun's own serialization format isn't stable across versions). What travels:
//   undefined, null, booleans, numbers (integers as CBOR integers, others as float64), bigints (tags 2 and 3),
//   strings, Uint8Array (byte strings) and the other typed arrays (RFC 8746 little-endian tags), arrays, plain
//   objects (text keys), Map (tag 259), Set (tag 258) and Date (tag 1).
// Other objects travel as their own enumerable properties, as structured clone does for class instances; functions,
// symbols and cycles are refused. The decoder refuses indefinite lengths, nesting past `MAX_DEPTH` and trailing bytes.
import { ContractError } from "../contracts/common";

export const MAX_DEPTH = 128;

const TAG_DATE = 1;
const TAG_POS_BIGNUM = 2;
const TAG_NEG_BIGNUM = 3;
const TAG_SET = 258;
const TAG_MAP = 259;

type TypedArrayCtor =
  | Int8ArrayConstructor | Uint8ClampedArrayConstructor | Uint16ArrayConstructor | Uint32ArrayConstructor
  | Int16ArrayConstructor | Int32ArrayConstructor | Float32ArrayConstructor | Float64ArrayConstructor
  | BigUint64ArrayConstructor | BigInt64ArrayConstructor;
/** RFC 8746 tags for little-endian typed arrays. */
const TYPED_TAGS: readonly [number, TypedArrayCtor][] = [
  [72, Int8Array], [68, Uint8ClampedArray], [69, Uint16Array], [70, Uint32Array], [71, BigUint64Array],
  [77, Int16Array], [78, Int32Array], [79, BigInt64Array], [85, Float32Array], [86, Float64Array],
];
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

class Writer {
  #buf = new Uint8Array(256);
  #len = 0;

  #grow(n: number): void {
    if (this.#len + n <= this.#buf.length) return;
    let size = this.#buf.length * 2;
    while (size < this.#len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.#buf.subarray(0, this.#len));
    this.#buf = next;
  }

  byte(b: number): void {
    this.#grow(1);
    this.#buf[this.#len++] = b;
  }

  bytes(b: Uint8Array): void {
    this.#grow(b.byteLength);
    this.#buf.set(b, this.#len);
    this.#len += b.byteLength;
  }

  head(major: number, n: number | bigint): void {
    const m = major << 5;
    if (typeof n === "bigint") {
      this.byte(m | 27);
      const v = new DataView(new ArrayBuffer(8));
      v.setBigUint64(0, n, false);
      this.bytes(new Uint8Array(v.buffer));
      return;
    }
    if (n < 24) this.byte(m | n);
    else if (n < 0x100) {
      this.byte(m | 24);
      this.byte(n);
    } else if (n < 0x10000) {
      this.byte(m | 25);
      this.byte(n >> 8);
      this.byte(n & 0xff);
    } else if (n < 0x100000000) {
      this.byte(m | 26);
      const v = new DataView(new ArrayBuffer(4));
      v.setUint32(0, n, false);
      this.bytes(new Uint8Array(v.buffer));
    } else {
      this.head(major, BigInt(n));
    }
  }

  float(n: number): void {
    this.byte(0xfb);
    const v = new DataView(new ArrayBuffer(8));
    v.setFloat64(0, n, false);
    this.bytes(new Uint8Array(v.buffer));
  }

  done(): Uint8Array {
    return this.#buf.slice(0, this.#len);
  }
}

function bigToBytes(n: bigint): Uint8Array {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function encodeValue(w: Writer, value: unknown, seen: Set<object>, depth: number): void {
  if (depth > MAX_DEPTH) throw new ContractError("invalid", "the payload is nested too deeply");
  switch (typeof value) {
    case "undefined":
      w.byte(0xf7);
      return;
    case "boolean":
      w.byte(value ? 0xf5 : 0xf4);
      return;
    case "number":
      if (Number.isSafeInteger(value) && !Object.is(value, -0)) {
        if (value >= 0) w.head(0, value);
        else w.head(1, -1 - value);
      } else w.float(value);
      return;
    case "bigint":
      if (value >= 0n) {
        w.head(6, TAG_POS_BIGNUM);
        const b = bigToBytes(value);
        w.head(2, b.byteLength);
        w.bytes(b);
      } else {
        w.head(6, TAG_NEG_BIGNUM);
        const b = bigToBytes(-1n - value);
        w.head(2, b.byteLength);
        w.bytes(b);
      }
      return;
    case "string": {
      const b = new TextEncoder().encode(value.toWellFormed());
      w.head(3, b.byteLength);
      w.bytes(b);
      return;
    }
    case "object":
      break;
    default:
      throw new ContractError("invalid", `a ${typeof value} can't travel over a link`);
  }
  if (value === null) {
    w.byte(0xf6);
    return;
  }
  const obj = value as object;
  if (seen.has(obj)) throw new ContractError("invalid", "the payload has a cycle");
  seen.add(obj);
  try {
    if (obj instanceof Uint8Array) {
      w.head(2, obj.byteLength);
      w.bytes(obj);
    } else if (obj instanceof ArrayBuffer) {
      w.head(2, obj.byteLength);
      w.bytes(new Uint8Array(obj));
    } else if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
      const entry = TYPED_TAGS.find(([, ctor]) => obj instanceof ctor);
      if (!entry) throw new ContractError("invalid", "this typed array can't travel over a link");
      let bytes: Uint8Array = new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength).slice();
      if (!LITTLE_ENDIAN) bytes = swapEndian(bytes, (obj as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT);
      w.head(6, entry[0]);
      w.head(2, bytes.byteLength);
      w.bytes(bytes);
    } else if (Array.isArray(obj)) {
      w.head(4, obj.length);
      for (let i = 0; i < obj.length; i++) encodeValue(w, obj[i], seen, depth + 1);
    } else if (obj instanceof Map) {
      w.head(6, TAG_MAP);
      w.head(5, obj.size);
      for (const [k, v] of obj) {
        encodeValue(w, k, seen, depth + 1);
        encodeValue(w, v, seen, depth + 1);
      }
    } else if (obj instanceof Set) {
      w.head(6, TAG_SET);
      w.head(4, obj.size);
      for (const v of obj) encodeValue(w, v, seen, depth + 1);
    } else if (obj instanceof Date) {
      w.head(6, TAG_DATE);
      w.float(obj.getTime() / 1000);
    } else if (typeof (obj as { then?: unknown }).then === "function") {
      throw new ContractError("invalid", "a promise can't travel over a link");
    } else {
      const keys = Object.keys(obj);
      w.head(5, keys.length);
      for (const k of keys) {
        encodeValue(w, k, seen, depth + 1);
        encodeValue(w, (obj as Record<string, unknown>)[k], seen, depth + 1);
      }
    }
  } finally {
    seen.delete(obj);
  }
}

function swapEndian(bytes: Uint8Array, width: number): Uint8Array {
  const out = new Uint8Array(bytes.byteLength);
  for (let i = 0; i < bytes.byteLength; i += width) for (let j = 0; j < width; j++) out[i + j] = bytes[i + width - 1 - j]!;
  return out;
}

/** The value's CBOR bytes; `invalid` for what can't travel. */
export function encode(value: unknown): Uint8Array {
  const w = new Writer();
  encodeValue(w, value, new Set(), 0);
  return w.done();
}

class Reader {
  #at = 0;
  readonly #view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get at(): number {
    return this.#at;
  }
  get left(): number {
    return this.bytes.byteLength - this.#at;
  }
  need(n: number): void {
    if (n > this.left) throw new ContractError("invalid", "the payload is cut short");
  }
  u8(): number {
    this.need(1);
    return this.bytes[this.#at++]!;
  }
  take(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.slice(this.#at, this.#at + n);
    this.#at += n;
    return out;
  }
  u16(): number {
    this.need(2);
    const v = this.#view.getUint16(this.#at, false);
    this.#at += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.#view.getUint32(this.#at, false);
    this.#at += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.#view.getBigUint64(this.#at, false);
    this.#at += 8;
    return v;
  }
  f16(): number {
    const h = this.u16();
    const exp = (h >> 10) & 0x1f;
    const mant = h & 0x3ff;
    const sign = h & 0x8000 ? -1 : 1;
    if (exp === 0) return sign * 2 ** -14 * (mant / 1024);
    if (exp === 31) return mant ? Number.NaN : sign * Number.POSITIVE_INFINITY;
    return sign * 2 ** (exp - 15) * (1 + mant / 1024);
  }
  f32(): number {
    this.need(4);
    const v = this.#view.getFloat32(this.#at, false);
    this.#at += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.#view.getFloat64(this.#at, false);
    this.#at += 8;
    return v;
  }
}

function readArg(r: Reader, info: number): number | bigint {
  if (info < 24) return info;
  if (info === 24) return r.u8();
  if (info === 25) return r.u16();
  if (info === 26) return r.u32();
  if (info === 27) {
    const v = r.u64();
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  }
  throw new ContractError("invalid", "indefinite lengths aren't accepted");
}

function readLength(r: Reader, info: number, minBytesEach: number): number {
  const n = readArg(r, info);
  if (typeof n === "bigint" || n * minBytesEach > r.left) throw new ContractError("invalid", "a length runs past the payload");
  return n;
}

function decodeValue(r: Reader, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new ContractError("invalid", "the payload is nested too deeply");
  const first = r.u8();
  const major = first >> 5;
  const info = first & 31;
  switch (major) {
    case 0: {
      const n = readArg(r, info);
      return n;
    }
    case 1: {
      const n = readArg(r, info);
      return typeof n === "bigint" ? -1n - n : -1 - n;
    }
    case 2:
      return r.take(readLength(r, info, 1));
    case 3:
      return new TextDecoder("utf-8", { fatal: true }).decode(r.take(readLength(r, info, 1)));
    case 4: {
      const n = readLength(r, info, 1);
      const out: unknown[] = new Array(n);
      for (let i = 0; i < n; i++) out[i] = decodeValue(r, depth + 1);
      return out;
    }
    case 5: {
      const n = readLength(r, info, 2);
      const out: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) {
        const k = decodeValue(r, depth + 1);
        if (typeof k !== "string") throw new ContractError("invalid", "an object key must be text");
        const v = decodeValue(r, depth + 1);
        Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    case 6:
      return decodeTagged(r, readArg(r, info), depth);
    case 7:
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 23) return undefined;
      if (info === 25) return r.f16();
      if (info === 26) return r.f32();
      if (info === 27) return r.f64();
      throw new ContractError("invalid", "an unknown simple value");
    default:
      throw new ContractError("invalid", "an unknown major type");
  }
}

function decodeTagged(r: Reader, tag: number | bigint, depth: number): unknown {
  if (tag === TAG_DATE) {
    const s = decodeValue(r, depth + 1);
    if (typeof s !== "number") throw new ContractError("invalid", "a date must be a number");
    return new Date(Math.round(s * 1000));
  }
  if (tag === TAG_POS_BIGNUM || tag === TAG_NEG_BIGNUM) {
    const b = decodeValue(r, depth + 1);
    if (!(b instanceof Uint8Array)) throw new ContractError("invalid", "a bignum must be bytes");
    const n = b.byteLength === 0 ? 0n : BigInt(`0x${Buffer.from(b).toString("hex")}`);
    return tag === TAG_POS_BIGNUM ? n : -1n - n;
  }
  if (tag === TAG_SET) {
    const items = decodeValue(r, depth + 1);
    if (!Array.isArray(items)) throw new ContractError("invalid", "a set must be an array");
    return new Set(items);
  }
  if (tag === TAG_MAP) {
    const first = r.u8();
    if (first >> 5 !== 5) throw new ContractError("invalid", "a map must be a map");
    const n = readLength(r, first & 31, 2);
    const out = new Map<unknown, unknown>();
    for (let i = 0; i < n; i++) {
      const k = decodeValue(r, depth + 1);
      out.set(k, decodeValue(r, depth + 1));
    }
    return out;
  }
  const typed = TYPED_TAGS.find(([t]) => t === tag);
  if (typed) {
    const bytes = decodeValue(r, depth + 1);
    const ctor = typed[1];
    if (!(bytes instanceof Uint8Array) || bytes.byteLength % ctor.BYTES_PER_ELEMENT !== 0) throw new ContractError("invalid", "a typed array's bytes don't fit it");
    const own = LITTLE_ENDIAN ? bytes : swapEndian(bytes, ctor.BYTES_PER_ELEMENT);
    return new ctor(own.buffer.slice(own.byteOffset, own.byteOffset + own.byteLength) as ArrayBuffer);
  }
  throw new ContractError("invalid", `an unknown tag ${tag}`);
}

/** The value the bytes encode; `invalid` for anything malformed or with bytes left over. */
export function decode(bytes: Uint8Array): unknown {
  const r = new Reader(bytes);
  const value = decodeValue(r, 0);
  if (r.left !== 0) throw new ContractError("invalid", "the payload has bytes left over");
  return value;
}
