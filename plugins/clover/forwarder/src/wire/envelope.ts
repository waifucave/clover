// The sealed envelope a held webhook is stored and delivered in (spec §7: "the Worker encrypts each payload to
// the user's device keys on arrival, so a held payload is never stored in plaintext").
//
// One random content key (AES-256-GCM) encrypts the request once; it is wrapped for every registered
// computer with HPKE (RFC 9180 base mode, X25519 / HKDF-SHA256 / AES-256-GCM), so whichever computer holds
// the routine when it is delivered can open it, including after the routine moves.
//
// Layout, version 1 (all integers big-endian):
//
//   version       1 byte    = 1
//   routineLen    1 byte    1..64
//   routineId     routineLen bytes, [A-Za-z0-9_-]
//   receivedAt    8 bytes   milliseconds since the epoch
//   pid           16 bytes  random payload id
//   count         1 byte    1..32 recipients, then per recipient:
//     kid         8 bytes   keyId(publicKey)
//     enc         32 bytes  the HPKE encapsulated key
//     wrapped     48 bytes  the content key sealed with HPKE (aad = kid)
//   nonce         12 bytes  content nonce
//   ciphertext    the rest  AES-256-GCM of the request record, aad = every byte before it
//
// Each recipient's HPKE info is "clover forwarder v1" || 0x00 || the bytes from version through pid, which
// binds the wrapped key to this routine, this arrival time and this payload.

import { concat, fromUtf8, own, randomBytes, readU64, sha256, u64, utf8, type Bytes } from "./bytes";
import { AEAD_AES_256_GCM, aeadOpen, aeadSeal, openBase, sealBase, type X25519KeyPair } from "./hpke";

export const ENVELOPE_VERSION = 1;
export const KID_BYTES = 8;
export const PID_BYTES = 16;
export const MAX_RECIPIENTS = 32;
export const ROUTINE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const ENC_BYTES = 32;
const WRAPPED_BYTES = 32 + 16;
const RECIPIENT_BYTES = KID_BYTES + ENC_BYTES + WRAPPED_BYTES;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const INFO_LABEL = concat(utf8("clover forwarder v1"), Uint8Array.of(0));

export interface EnvelopeRecipient {
  kid: Uint8Array;
  publicKey: Uint8Array;
}

/** A computer's forwarder key: its X25519 pair and the key id the envelope names it by. */
export interface DeviceKey extends X25519KeyPair {
  kid: Bytes;
}

/** One HPKE base-mode, single-shot open (DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM). */
export interface HpkeOpenInput {
  enc: Uint8Array;
  info: Uint8Array;
  aad: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * Opens envelopes for one computer without holding its private key: `open` is the core's keys.open (the
 * forwarder plugin never sees the key), or localOpener's for tests and for code that does hold one.
 */
export interface EnvelopeOpener {
  kid: Uint8Array;
  open(input: HpkeOpenInput): Promise<Uint8Array>;
}

export function localOpener(key: DeviceKey): EnvelopeOpener {
  return { kid: key.kid, open: (input) => openBase(AEAD_AES_256_GCM, key, input.enc, input.info, input.aad, input.ciphertext) };
}

export interface EnvelopeHeader {
  version: number;
  routineId: string;
  receivedAt: number;
  pid: Bytes;
  kids: Bytes[];
}

/** The 8-byte key id of a forwarder public key. */
export async function keyId(publicKey: Uint8Array): Promise<Bytes> {
  return (await sha256(concat(utf8("clover forwarder kid"), publicKey))).slice(0, KID_BYTES);
}

function prefixBytes(routineId: string, receivedAt: number, pid: Uint8Array): Bytes {
  if (!ROUTINE_ID_RE.test(routineId)) throw new TypeError("envelope: bad routine id");
  if (pid.length !== PID_BYTES) throw new TypeError("envelope: pid must be 16 bytes");
  const id = utf8(routineId);
  return concat(Uint8Array.of(ENVELOPE_VERSION, id.length), id, u64(receivedAt), pid);
}

/**
 * Seals a request to every recipient. With `onRecipientError`, a recipient whose key cannot be sealed to (a
 * small-order point, say) is left out and reported, and the others still get the envelope; without it, any
 * failure throws. It throws when no recipient is left.
 */
export async function sealEnvelope(input: {
  routineId: string;
  receivedAt: number;
  recipients: readonly EnvelopeRecipient[];
  plaintext: Uint8Array;
  pid?: Uint8Array;
  onRecipientError?: (recipient: EnvelopeRecipient, error: unknown) => void;
}): Promise<Bytes> {
  const { recipients } = input;
  if (recipients.length < 1 || recipients.length > MAX_RECIPIENTS) throw new RangeError("envelope: 1..32 recipients");
  const pid = input.pid ?? randomBytes(PID_BYTES);
  const prefix = prefixBytes(input.routineId, input.receivedAt, pid);
  const info = concat(INFO_LABEL, prefix);
  const contentKey = randomBytes(32);
  const sealed: Uint8Array[] = [];
  for (const recipient of recipients) {
    if (recipient.kid.length !== KID_BYTES) throw new TypeError("envelope: kid must be 8 bytes");
    try {
      const { enc, ciphertext } = await sealBase(AEAD_AES_256_GCM, recipient.publicKey, info, recipient.kid, contentKey);
      sealed.push(recipient.kid, enc, ciphertext);
    } catch (err) {
      if (!input.onRecipientError) throw err;
      input.onRecipientError(recipient, err);
    }
  }
  if (sealed.length === 0) {
    contentKey.fill(0);
    throw new RangeError("envelope: no recipient could be sealed to");
  }
  const parts: Uint8Array[] = [prefix, Uint8Array.of(sealed.length / 3), ...sealed];
  const nonce = randomBytes(NONCE_BYTES);
  parts.push(nonce);
  const aad = concat(...parts);
  const ciphertext = await aeadSeal(contentKey, nonce, aad, input.plaintext);
  contentKey.fill(0);
  return concat(aad, ciphertext);
}

interface ParsedEnvelope extends EnvelopeHeader {
  prefixEnd: number;
  recipients: { kid: Bytes; enc: Bytes; wrapped: Bytes }[];
  aadEnd: number;
}

function parse(envelope: Uint8Array): ParsedEnvelope {
  const fail = (why: string): never => {
    throw new TypeError(`envelope: ${why}`);
  };
  if (envelope.length < 2) fail("truncated");
  const version = envelope[0]!;
  if (version !== ENVELOPE_VERSION) fail(`unknown version ${version}`);
  const idLength = envelope[1]!;
  let offset = 2;
  if (idLength < 1 || idLength > 64 || envelope.length < offset + idLength + 8 + PID_BYTES + 1) fail("truncated");
  const routineId = fromUtf8(envelope.subarray(offset, offset + idLength));
  if (!ROUTINE_ID_RE.test(routineId)) fail("bad routine id");
  offset += idLength;
  const receivedAt = readU64(envelope, offset);
  offset += 8;
  const pid = own(envelope.subarray(offset, offset + PID_BYTES));
  offset += PID_BYTES;
  const prefixEnd = offset;
  const count = envelope[offset]!;
  offset += 1;
  if (count < 1 || count > MAX_RECIPIENTS) fail("bad recipient count");
  if (envelope.length < offset + count * RECIPIENT_BYTES + NONCE_BYTES + TAG_BYTES) fail("truncated");
  const recipients: ParsedEnvelope["recipients"] = [];
  for (let i = 0; i < count; i++) {
    const kid = own(envelope.subarray(offset, offset + KID_BYTES));
    const enc = own(envelope.subarray(offset + KID_BYTES, offset + KID_BYTES + ENC_BYTES));
    const wrapped = own(envelope.subarray(offset + KID_BYTES + ENC_BYTES, offset + RECIPIENT_BYTES));
    recipients.push({ kid, enc, wrapped });
    offset += RECIPIENT_BYTES;
  }
  offset += NONCE_BYTES;
  return { version, routineId, receivedAt, pid, kids: recipients.map((r) => r.kid), prefixEnd, recipients, aadEnd: offset };
}

/** The envelope's clear header (who it is for and when it came), without decrypting anything. */
export function readEnvelopeHeader(envelope: Uint8Array): EnvelopeHeader {
  const { version, routineId, receivedAt, pid, kids } = parse(envelope);
  return { version, routineId, receivedAt, pid, kids };
}

/** Whether the envelope names `kid` among its recipients. */
export function isSealedFor(envelope: Uint8Array, kid: Uint8Array): boolean {
  return parse(envelope).recipients.some((r) => r.kid.every((b, i) => b === kid[i]));
}

/**
 * Opens an envelope with this computer's key, or with an opener that holds it elsewhere (the core). Throws
 * when it is not for this key or does not authenticate.
 */
export async function openEnvelope(envelope: Uint8Array, key: DeviceKey | EnvelopeOpener): Promise<{ header: EnvelopeHeader; plaintext: Bytes }> {
  const opener = "privateKey" in key ? localOpener(key) : key;
  const parsed = parse(envelope);
  const mine = parsed.recipients.find((r) => r.kid.every((b, i) => b === opener.kid[i]));
  if (!mine) throw new Error("envelope: not sealed for this key");
  const info = concat(INFO_LABEL, envelope.subarray(0, parsed.prefixEnd));
  const contentKey = own(await opener.open({ enc: mine.enc, info, aad: mine.kid, ciphertext: mine.wrapped }));
  if (contentKey.length !== 32) throw new Error("envelope: bad content key");
  try {
    const aad = envelope.subarray(0, parsed.aadEnd);
    const nonce = envelope.subarray(parsed.aadEnd - NONCE_BYTES, parsed.aadEnd);
    const plaintext = await aeadOpen(contentKey, nonce, aad, envelope.subarray(parsed.aadEnd));
    const { version, routineId, receivedAt, pid, kids } = parsed;
    return { header: { version, routineId, receivedAt, pid, kids }, plaintext };
  } finally {
    contentKey.fill(0);
  }
}

// ---- The request record: what is sealed ----

/** A webhook as the sender made it, less the routine's key and the edge's own headers. */
export interface WebhookRequest {
  method: string;
  /** The query string without the leading "?" and without the `key` parameter; "" when none. */
  query: string;
  headers: [string, string][];
  /** The sender's address as the edge saw it, when known. */
  ip?: string;
  body: Uint8Array;
}

interface RecordMeta {
  v: 1;
  m: string;
  q: string;
  h: [string, string][];
  ip?: string;
}

/** [u32 meta length][meta JSON][body]. */
export function encodeRequestRecord(request: WebhookRequest): Bytes {
  const meta: RecordMeta = { v: 1, m: request.method, q: request.query, h: request.headers };
  if (request.ip) meta.ip = request.ip;
  const metaBytes = utf8(JSON.stringify(meta));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, metaBytes.length);
  return concat(length, metaBytes, request.body);
}

export function decodeRequestRecord(record: Uint8Array): WebhookRequest {
  if (record.length < 4) throw new TypeError("request record: truncated");
  const metaLength = new DataView(record.buffer, record.byteOffset, record.byteLength).getUint32(0);
  if (record.length < 4 + metaLength) throw new TypeError("request record: truncated");
  const meta = JSON.parse(fromUtf8(record.subarray(4, 4 + metaLength))) as Partial<RecordMeta>;
  if (meta.v !== 1 || typeof meta.m !== "string" || typeof meta.q !== "string" || !Array.isArray(meta.h)) {
    throw new TypeError("request record: bad meta");
  }
  const headers: [string, string][] = [];
  for (const pair of meta.h) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
      throw new TypeError("request record: bad header");
    }
    headers.push([pair[0], pair[1]]);
  }
  const out: WebhookRequest = { method: meta.m, query: meta.q, headers, body: own(record.subarray(4 + metaLength)) };
  if (typeof meta.ip === "string") out.ip = meta.ip;
  return out;
}
