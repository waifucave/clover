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
// * Frames are inert pixels: each must be one whole image in the declared format (its magic bytes) and at most
//   `PICTURE_FRAME_MAX_BYTES`; anything else ends the picture (`too-large`, or `publisher` for a frame that isn't its
//   format). Readers get the latest frame (a slow reader skips, never queues).
// * Readers are scoped by kind; a picture ends when its publisher ends it, its session ends, or its plugin stops.
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

export type PictureEvent = { picture: PictureView } | { ended: string; why: "publisher" | "session" | "plugin-stopped" | "too-large" };

export interface LivePictures {
  publish(call: ToolCallContext, meta: PicturePublishMeta): PicturePublisher;
  list(kind: DataKind, reader: FeedReader, of?: { session?: string; bot?: string }): PictureView[];
  open(id: string, reader: FeedReader): PictureReader;
  sessionEnded(session: string): void;
  pluginStopped(pluginId: string): void;
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
