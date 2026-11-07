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
  return { v: 1, stream: m.stream, tab: m.tab, computer: m.computer };
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
  #buffered = new Uint8Array(0);

  push(bytes: Uint8Array): StreamChunk[] {
    let all = bytes;
    if (this.#buffered.byteLength > 0) {
      all = new Uint8Array(this.#buffered.byteLength + bytes.byteLength);
      all.set(this.#buffered, 0);
      all.set(bytes, this.#buffered.byteLength);
    }
    const out: StreamChunk[] = [];
    let at = 0;
    while (all.byteLength - at >= STREAM_HEADER_BYTES) {
      const length = new DataView(all.buffer, all.byteOffset + at, STREAM_HEADER_BYTES).getUint32(12);
      if (length > STREAM_MAX_PAYLOAD) throw new StreamFormatError("a stream frame is larger than any picture");
      const end = at + STREAM_HEADER_BYTES + length;
      if (end > all.byteLength) break;
      out.push(decodeStreamFrame(all.subarray(at, end)));
      at = end;
    }
    this.#buffered = all.slice(at);
    return out;
  }
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
