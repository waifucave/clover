// A computer's tab, streamed to this device (`browser.stream`, spec §12.1): the receiving side of the frames lane L's
// sender writes (packages/core/src/browser/stream.ts, whose header is the format's statement). The sender opens one
// link stream per (tab, device) labelled "browser.stream" at `screenshots` priority, with meta
// `{ v: 1, stream, tab, computer }`. Every frame is a 16-byte big-endian header and its payload:
//
//   0  version (1)   1  kind: 1 config, 2 frame, 3 ended   2  flags: bit 0 = keyframe   3  reserved
//   4  timestamp, microseconds, signed 64-bit (frames only)   12  payload length, unsigned 32-bit   16  payload
//
// A config's payload is JSON {codec, width, height, codecString}; a frame's is H.264 (Annex B, SPS and PPS in band
// before each keyframe), a VP8 frame, or one whole JPEG picture; an ended frame's is JSON {reason, message?}.
// The link may hand the bytes over as one run, so `StreamFrameReader` splits them by the length field.
//
// When the meta says `acks: true`, the receiver writes one ack back on the same link stream for every frame (kind 2)
// it decoded or dropped, in order: a header alone, kind 4, flags 0, the frame's timestamp, payload length 0. The
// sender keeps at most two frames unacked once acks start (lane L, lane/l-m3); a receiver that doesn't ack is unaffected
// but gets no latency bound.

export const STREAM_LINK_LABEL = "browser.stream";
export const STREAM_FRAME_VERSION = 1;
export const STREAM_HEADER_BYTES = 16;
/** A frame larger than this is a broken stream, not a picture: the length field alone must not decide what we buffer. */
export const STREAM_MAX_PAYLOAD = 16 * 1024 * 1024;

export type StreamCodec = "h264" | "vp8" | "jpeg";
export const STREAM_CODECS: readonly StreamCodec[] = ["h264", "vp8", "jpeg"];

export type StreamChunk =
  | { kind: "config"; codec: StreamCodec; width: number; height: number; codecString: string }
  | { kind: "frame"; key: boolean; /** Microseconds. */ timestamp: number; data: Uint8Array }
  | { kind: "ended"; reason: "stopped" | "closed" | "failed"; message?: string };

export interface StreamLinkMeta {
  v: 1;
  stream: string;
  tab: string;
  computer: string;
  /** The sender wants an ack for every frame (`encodeStreamAck`). */
  acks: boolean;
}

/** The ack for the frame stamped `timestamp` (microseconds): the 16-byte header alone, kind 4. */
export function encodeStreamAck(timestamp: number): Uint8Array {
  const out = new Uint8Array(STREAM_HEADER_BYTES);
  const view = new DataView(out.buffer);
  view.setUint8(0, STREAM_FRAME_VERSION);
  view.setUint8(1, 4);
  view.setBigInt64(4, BigInt(Math.round(timestamp)));
  return out;
}

export class StreamFormatError extends Error {
  override name = "StreamFormatError";
}

const REASONS = ["stopped", "closed", "failed"] as const;
const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

/** The link stream's meta, or null when it isn't one this reads. */
export function readStreamMeta(meta: unknown): StreamLinkMeta | null {
  if (meta === null || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  if (m.v !== STREAM_FRAME_VERSION) return null;
  if (typeof m.stream !== "string" || typeof m.tab !== "string" || typeof m.computer !== "string") return null;
  return { v: 1, stream: m.stream, tab: m.tab, computer: m.computer, acks: m.acks === true };
}

/** Exactly one frame back to its chunk; throws `StreamFormatError` on anything else. */
export function decodeStreamFrame(bytes: Uint8Array): StreamChunk {
  if (bytes.byteLength < STREAM_HEADER_BYTES) throw new StreamFormatError("a stream frame is at least 16 bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== STREAM_FRAME_VERSION) throw new StreamFormatError(`stream frame version ${version} isn't one this reads`);
  const length = view.getUint32(12);
  if (length > STREAM_MAX_PAYLOAD) throw new StreamFormatError("a stream frame is larger than any picture");
  if (bytes.byteLength !== STREAM_HEADER_BYTES + length) throw new StreamFormatError("the stream frame's length doesn't match its bytes");
  const payload = bytes.subarray(STREAM_HEADER_BYTES);
  const kind = view.getUint8(1);
  switch (kind) {
    case 1: {
      const c = json(payload);
      if (!STREAM_CODECS.includes(c.codec as StreamCodec) || !isSize(c.width) || !isSize(c.height) || typeof c.codecString !== "string") {
        throw new StreamFormatError("a bad stream config");
      }
      return { kind: "config", codec: c.codec as StreamCodec, width: c.width, height: c.height, codecString: c.codecString };
    }
    case 2:
      return { kind: "frame", key: (view.getUint8(2) & 1) === 1, timestamp: Number(view.getBigInt64(4)), data: payload.slice() };
    case 3: {
      const e = json(payload);
      const reason = REASONS.includes(e.reason as (typeof REASONS)[number]) ? (e.reason as (typeof REASONS)[number]) : "failed";
      return typeof e.message === "string" ? { kind: "ended", reason, message: e.message } : { kind: "ended", reason };
    }
    default:
      throw new StreamFormatError(`stream frame kind ${kind} isn't one this reads`);
  }
}

/** Splits bytes that arrive as one run back into chunks. A malformed frame throws, and the stream is done with. */
export class StreamFrameReader {
  /** The pieces of an unfinished frame, joined once it is whole (so a large frame in many pieces is copied once). */
  #parts: Uint8Array[] = [];
  #size = 0;
  /** The unfinished frame's whole length, once its header is in. */
  #need = 0;

  push(bytes: Uint8Array): StreamChunk[] {
    const out: StreamChunk[] = [];
    let rest = bytes;
    while (rest.byteLength > 0) {
      if (this.#size === 0) {
        // Whole frames straight from the piece, without copying.
        while (rest.byteLength >= STREAM_HEADER_BYTES) {
          const end = STREAM_HEADER_BYTES + payloadLength(rest);
          if (end > rest.byteLength) break;
          out.push(decodeStreamFrame(rest.subarray(0, end)));
          rest = rest.subarray(end);
        }
        if (rest.byteLength === 0) break;
      }
      if (this.#need === 0) {
        // Gather the header first: until then the frame's length isn't known.
        const take = Math.min(rest.byteLength, STREAM_HEADER_BYTES - this.#size);
        this.#add(rest.subarray(0, take));
        rest = rest.subarray(take);
        if (this.#size < STREAM_HEADER_BYTES) break;
        this.#need = STREAM_HEADER_BYTES + payloadLength(this.#join());
      }
      const take = Math.min(rest.byteLength, this.#need - this.#size);
      this.#add(rest.subarray(0, take));
      rest = rest.subarray(take);
      if (this.#size < this.#need) break;
      const whole = this.#join();
      this.#parts = [];
      this.#size = 0;
      this.#need = 0;
      out.push(decodeStreamFrame(whole));
    }
    return out;
  }

  #add(piece: Uint8Array): void {
    // The link may reuse its buffer: keep a copy of what waits.
    this.#parts.push(piece.slice());
    this.#size += piece.byteLength;
  }

  #join(): Uint8Array {
    if (this.#parts.length === 1) return this.#parts[0]!;
    const all = new Uint8Array(this.#size);
    let at = 0;
    for (const p of this.#parts) {
      all.set(p, at);
      at += p.byteLength;
    }
    this.#parts = [all];
    return all;
  }
}

/** A header's payload length, refused past the cap before anything is buffered for it. */
function payloadLength(header: Uint8Array): number {
  const length = new DataView(header.buffer, header.byteOffset, STREAM_HEADER_BYTES).getUint32(12);
  if (length > STREAM_MAX_PAYLOAD) throw new StreamFormatError("a stream frame is larger than any picture");
  return length;
}

function json(payload: Uint8Array): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(fromUtf8.decode(payload));
  } catch {
    throw new StreamFormatError("a stream frame's JSON doesn't parse");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new StreamFormatError("a stream frame's JSON isn't an object");
  return v as Record<string, unknown>;
}

function isSize(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 16384;
}
