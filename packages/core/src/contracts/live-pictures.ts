// Contract: LivePictures (spec revision 19, §3.6 "A tool's live picture", §6.10, §12.1; G5, items 111 and 115). Owner:
// lane AF, with lane HS for the browser's tabs (a tab's picture is one) and lane MA for MOSS's side panel.
//
// Any tool plugin whose server declares `picture: true` may publish a live picture of its work for the session of the tool
// call it serves, over the engine's byte stream. MOSS's side panel shows it (watch only); a plugin shows it by kind
// (`picture.read.sessions`, `picture.read.bots`).
//
// What the contract promises:
// * `publish` is keyed to the tool call the plugin host carries (`ToolCallContext`), never to anything the publisher
//   names: its `meta` is the format and size alone (`PicturePublishMeta`, strict). It is refused when the plugin's server
//   doesn't declare `picture`, or when the call has ended. The id is the engine's.
// * One picture per (session, publisher): a second publish replaces the first, which ends.
// * Frames are inert pixels: each must be one whole image in the declared format (its magic bytes), whose own header's
//   width and height are no larger than the picture's declared size, and at most `PICTURE_FRAME_MAX_BYTES`; anything else
//   ends the picture (`too-large`, or `publisher` for a frame that isn't its format or claims more pixels than declared),
//   so a reader is never asked to decode a bomb. Readers get the latest frame (a slow reader skips, never queues).
// * Readers are scoped by kind. A picture ends when its publisher ends it or goes (its stream ends or aborts), its session
//   ends, or its plugin stops; and, when its publisher tied it to the call (`endsWithCall`), when that tool call ends
//   (`callEnded`), which is the only way the engine learns a call ended: a bot's session never does.
import type { DataKind, PicturePublishMeta, PictureView } from "@waifucave/moss-protocol";
import type { Unsubscribe } from "./common";
import type { FeedReader } from "./activity-feed";

/** The tool call a publisher serves, as the plugin host carries it (§5.4 "The caller", R7): never the plugin's word. */
export interface ToolCallContext {
  session: string;
  kind: DataKind;
  bot?: string;
  pluginId: string;
  tool: string;
  callId: string;
  /** Whether the plugin's server declares `picture: true` (from the registry's validated manifest). */
  declares: boolean;
  /** Whether the call is still running. */
  open: boolean;
}

export interface PicturePublisher {
  readonly id: string;
  /** One whole image; ends the picture if it isn't one. */
  frame(bytes: Uint8Array): void;
  end(): void;
}

export interface PictureReader {
  latest(): Uint8Array | undefined;
  onFrame(fn: (bytes: Uint8Array) => void): Unsubscribe;
  close(): void;
}

export type PictureEndWhy = "publisher" | "session" | "plugin-stopped" | "too-large" | "call-ended";
export type PictureEvent = { picture: PictureView } | { ended: string; why: PictureEndWhy };

export interface LivePictures {
  publish(call: ToolCallContext, meta: PicturePublishMeta): PicturePublisher;
  list(kind: DataKind, reader: FeedReader, of?: { session?: string; bot?: string }): PictureView[];
  open(id: string, reader: FeedReader): PictureReader;
  sessionEnded(session: string): void;
  pluginStopped(pluginId: string): void;
  /** A tool call ended (the plugin host's own record of it): the pictures published in it with `endsWithCall` end. */
  callEnded(callId: string): void;
  watch(kind: DataKind, reader: FeedReader, fn: (event: PictureEvent) => void): Unsubscribe;
}

/** Whether `bytes` start as an image of `format` (its magic bytes): JPEG `FF D8 FF`, PNG's eight-byte signature, WebP
 *  `RIFF….WEBP`. */
export function isImageOf(format: PicturePublishMeta["format"], bytes: Uint8Array): boolean {
  const at = (i: number, ...v: number[]) => v.every((b, j) => bytes[i + j] === b);
  if (format === "jpeg") return bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff);
  if (format === "png") return bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  return bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50);
}

/** The pixel size an image's own header declares, or undefined when the bytes are not a readable image of `format`: a PNG's
 *  IHDR, a JPEG's first start-of-frame marker, a WebP's VP8, VP8L or VP8X chunk. Reads the header only; never decodes. */
export function imageSize(format: PicturePublishMeta["format"], bytes: Uint8Array): { width: number; height: number } | undefined {
  if (!isImageOf(format, bytes)) return undefined;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format === "png") {
    // 8-byte signature, then the IHDR chunk: length(4) "IHDR"(4) width(4) height(4).
    if (bytes.length < 24 || dv.getUint32(12) !== 0x49484452) return undefined;
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (format === "jpeg") {
    let i = 2;
    while (i + 4 <= bytes.length) {
      if (bytes[i] !== 0xff) return undefined;
      let marker = bytes[i + 1]!;
      while (marker === 0xff && i + 2 < bytes.length) { i++; marker = bytes[i + 1]!; }
      i += 2;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (i + 2 > bytes.length) return undefined;
      const len = dv.getUint16(i);
      // Start of frame (baseline, extended, progressive, lossless and their arithmetic kin; not DHT 0xC4, JPG 0xC8, DAC 0xCC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (len < 8 || i + 7 > bytes.length) return undefined;
        return { height: dv.getUint16(i + 3), width: dv.getUint16(i + 5) };
      }
      if (marker === 0xda || marker === 0xd9) return undefined;
      i += len;
    }
    return undefined;
  }
  // WebP: "RIFF" size "WEBP", then the first chunk.
  if (bytes.length < 30) return undefined;
  const fourcc = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (fourcc === "VP8X") return { width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)), height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) };
  if (fourcc === "VP8L") {
    if (bytes[20] !== 0x2f) return undefined;
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (fourcc === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined;
    return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
  }
  return undefined;
}

/** What a frame is to a picture declared as `meta`: fine, too large in bytes, or not an image of the declared format whose
 *  header says no more pixels than were declared (the picture then ends as the publisher's). */
export function frameVerdict(meta: Pick<PicturePublishMeta, "format" | "width" | "height">, bytes: Uint8Array, maxBytes: number): "ok" | "too-large" | "not-an-image" {
  if (bytes.length > maxBytes) return "too-large";
  const size = imageSize(meta.format, bytes);
  if (size === undefined || size.width < 1 || size.height < 1 || size.width > meta.width || size.height > meta.height) return "not-an-image";
  return "ok";
}
