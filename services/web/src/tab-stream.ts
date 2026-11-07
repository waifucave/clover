// A computer's tab shown in the web companion (`browser.stream`, spec §12.1): the frames of one link stream
// (protocol/browser-stream.ts) decoded into pictures. H.264 and VP8 go to WebCodecs' VideoDecoder; a JPEG stream (a
// headless computer's, which runs no encoder) is a whole picture per frame, decoded as an image, newest first.
//
// The page asks for what it can show: `decodableCodecs()` goes into `browser.stream`'s `codecs`, so a computer
// without a hardware H.264 encoder never sends VP8 to a browser that can't decode it.

import {
  readStreamMeta,
  STREAM_LINK_LABEL,
  StreamFrameReader,
  type StreamChunk,
  type StreamCodec,
  type StreamLinkMeta,
} from "../protocol/browser-stream";
import type { LinkStream } from "../protocol/rtc-link";

/** One picture to draw. The receiver owns it and calls `close()` once drawn (a VideoFrame holds decoder memory). */
export interface TabPicture {
  image: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

/** What decodes: the browser's own by default (`browserDecoders()`), fakes in tests. */
export interface TabStreamDecoders {
  /** One whole JPEG picture. */
  decodeImage(jpeg: Uint8Array): Promise<TabPicture>;
  VideoDecoder?: typeof VideoDecoder;
  EncodedVideoChunk?: typeof EncodedVideoChunk;
}

export function browserDecoders(): TabStreamDecoders {
  return {
    decodeImage: async (jpeg) => {
      const bitmap = await createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
      return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    },
    ...(typeof VideoDecoder === "function" && typeof EncodedVideoChunk === "function" ? { VideoDecoder, EncodedVideoChunk } : {}),
  };
}

/** Test configs: baseline H.264 at the sender's highest level (4K), and VP8. */
const PROBES: readonly [StreamCodec, string][] = [
  ["h264", "avc1.42E033"],
  ["vp8", "vp8"],
];

/** The codecs this browser decodes, best first; JPEG always (any browser decodes a picture). */
export async function decodableCodecs(d: TabStreamDecoders = browserDecoders()): Promise<StreamCodec[]> {
  const out: StreamCodec[] = [];
  if (d.VideoDecoder) {
    for (const [codec, codecString] of PROBES) {
      const ok = await d.VideoDecoder.isConfigSupported({ codec: codecString, optimizeForLatency: true }).then(
        (r) => r.supported === true,
        () => false,
      );
      if (ok) out.push(codec);
    }
  }
  out.push("jpeg");
  return out;
}

/** The longest `ended` message the view passes on: it is the computer's text, shown as is. */
export const ENDED_MESSAGE_MAX = 200;
/** Deltas waiting in the decoder past this many mean it can't keep up: drop them until the next keyframe. */
export const DECODE_QUEUE_MAX = 3;
/** The largest picture side the view decodes, as the frame format's config allows. */
export const PICTURE_SIDE_MAX = 16384;

/** A JPEG's size from its start-of-frame marker, or null when it has none (not a JPEG). */
export function jpegSize(jpeg: Uint8Array): { width: number; height: number } | null {
  if (jpeg.byteLength < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= jpeg.byteLength) {
    if (jpeg[at] !== 0xff) return null;
    const marker = jpeg[at + 1]!;
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2; // markers with no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // the picture's data before any frame header
    const length = (jpeg[at + 2]! << 8) | jpeg[at + 3]!;
    if (length < 2) return null;
    // SOF0–SOF15, less DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > jpeg.byteLength) return null;
      return { height: (jpeg[at + 5]! << 8) | jpeg[at + 6]!, width: (jpeg[at + 7]! << 8) | jpeg[at + 8]! };
    }
    at += 2 + length;
  }
  return null;
}

function capped(message: string): string {
  const chars = Array.from(message);
  return chars.length <= ENDED_MESSAGE_MAX ? message : `${chars.slice(0, ENDED_MESSAGE_MAX - 1).join("")}…`;
}

export interface TabStreamViewOptions {
  decoders?: TabStreamDecoders;
  /** The newest picture. */
  onPicture(picture: TabPicture): void;
  /** The stream ended: the computer's `ended` frame (stopped, the tab closed, or it failed; its message at most
   *  `ENDED_MESSAGE_MAX` characters), or the link stream finishing without one (`failed`). */
  onEnded?(ended: { reason: "stopped" | "closed" | "failed"; message?: string }): void;
  /** This side can't go on (a malformed frame, a codec or config this browser can't decode), or the link stream
   *  broke. The stream should be ended. */
  onError?(message: string): void;
}

type Config = Extract<StreamChunk, { kind: "config" }>;

/** One stream's decoding: push the link stream's bytes in, pictures come out. */
export class TabStreamView {
  readonly #o: TabStreamViewOptions;
  readonly #d: TabStreamDecoders;
  readonly #reader = new StreamFrameReader();
  #config: Config | undefined;
  #video: VideoDecoder | undefined;
  /** Waiting for a keyframe: after a config, a decoder error, or before the first frame. */
  #needKey = true;
  /** A JPEG being decoded, and the newest one waiting behind it (older ones are dropped). */
  #imageBusy = false;
  #imageNext: Uint8Array | undefined;
  /** Bumped on every config and on close, so a decode that finishes late is dropped. */
  #generation = 0;
  #done = false;
  #ended = false;

  constructor(o: TabStreamViewOptions) {
    this.#o = o;
    this.#d = o.decoders ?? browserDecoders();
  }

  get closed(): boolean {
    return this.#done;
  }

  /** The computer ended it (an `ended` frame), as opposed to this side giving up. */
  get ended(): boolean {
    return this.#ended;
  }

  push(bytes: Uint8Array): void {
    if (this.#done) return;
    let chunks: StreamChunk[];
    try {
      chunks = this.#reader.push(bytes);
    } catch (e) {
      this.#fail(e instanceof Error ? e.message : String(e));
      return;
    }
    for (const c of chunks) {
      if (this.#done) return;
      this.#take(c);
    }
  }

  close(): void {
    if (this.#done) return;
    this.#done = true;
    this.#generation++;
    this.#imageNext = undefined;
    this.#closeVideo();
  }

  #take(c: StreamChunk): void {
    switch (c.kind) {
      case "config":
        this.#configure(c);
        return;
      case "frame":
        this.#frame(c);
        return;
      case "ended":
        this.#ended = true;
        this.close();
        this.#o.onEnded?.(c.message !== undefined ? { reason: c.reason, message: capped(c.message) } : { reason: c.reason });
        return;
    }
  }

  #configure(c: Config): void {
    this.#generation++;
    this.#closeVideo();
    this.#imageNext = undefined;
    this.#config = c;
    this.#needKey = true;
    if (c.codec === "jpeg") return;
    if (!this.#d.VideoDecoder || !this.#d.EncodedVideoChunk) {
      this.#fail(`this browser can't decode ${c.codec} video`);
      return;
    }
    this.#openVideo(c);
  }

  #openVideo(c: Config): void {
    const generation = this.#generation;
    const Decoder = this.#d.VideoDecoder!;
    const unsupported = `this browser can't decode ${c.codec} video (${c.codecString} at ${c.width}x${c.height})`;
    let decoder: VideoDecoder;
    try {
      decoder = new Decoder({
      output: (frame) => {
        if (generation !== this.#generation || this.#done) {
          frame.close();
          return;
        }
        this.#o.onPicture({ image: frame, width: frame.displayWidth, height: frame.displayHeight, close: () => frame.close() });
      },
      error: (e) => {
        if (generation !== this.#generation || this.#done) return;
        this.#video = undefined;
        // A config the browser can't decode won't decode at the next keyframe either: the stream is done with.
        if ((e as { name?: string } | undefined)?.name === "NotSupportedError") return this.#fail(unsupported);
        // Anything else (one bad frame): the next keyframe opens a new decoder.
        this.#needKey = true;
      },
      });
      // H.264 with no `description` is Annex B, as the sender writes it (SPS and PPS in band before each keyframe).
      decoder.configure({ codec: c.codecString, codedWidth: c.width, codedHeight: c.height, optimizeForLatency: true });
    } catch {
      this.#fail(unsupported);
      return;
    }
    this.#video = decoder;
  }

  #frame(f: Extract<StreamChunk, { kind: "frame" }>): void {
    const config = this.#config;
    if (config === undefined) return; // A frame before any config: nothing to decode it with.
    if (this.#needKey && !f.key) return;
    this.#needKey = false;
    if (config.codec === "jpeg") {
      this.#image(f.data);
      return;
    }
    if (this.#video === undefined || this.#video.state === "closed") {
      this.#openVideo(config);
      if (this.#done) return;
    }
    // A decoder that can't keep up: drop deltas until the next keyframe rather than fall further behind.
    if (!f.key && this.#video!.decodeQueueSize > DECODE_QUEUE_MAX) {
      this.#needKey = true;
      return;
    }
    try {
      this.#video!.decode(new this.#d.EncodedVideoChunk!({ type: f.key ? "key" : "delta", timestamp: f.timestamp, data: f.data }));
    } catch {
      this.#closeVideo();
      this.#needKey = true;
    }
  }

  /** Newest picture first: while one decodes, only the latest that arrived meanwhile waits. */
  #image(jpeg: Uint8Array): void {
    // A picture of no size, or larger than any tab, is never handed to the image decoder.
    const size = jpegSize(jpeg);
    if (size === null || size.width === 0 || size.height === 0 || size.width > PICTURE_SIDE_MAX || size.height > PICTURE_SIDE_MAX) return;
    if (this.#imageBusy) {
      this.#imageNext = jpeg;
      return;
    }
    this.#imageBusy = true;
    const generation = this.#generation;
    void this.#d.decodeImage(jpeg).then(
      (picture) => {
        if (generation !== this.#generation || this.#done) picture.close();
        else this.#o.onPicture(picture);
      },
      () => {
        // One bad picture: the next one replaces it (every JPEG frame is whole).
      },
    ).finally(() => {
      this.#imageBusy = false;
      const next = this.#imageNext;
      this.#imageNext = undefined;
      if (next !== undefined && !this.#done) this.#image(next);
    });
  }

  #closeVideo(): void {
    const v = this.#video;
    this.#video = undefined;
    if (v !== undefined && v.state !== "closed") v.close();
  }

  /** The link stream finished (`error` undefined) or broke without the computer's `ended` frame. */
  lose(error?: Error): void {
    if (this.#done) return;
    if (error !== undefined) return this.#fail(`the stream broke: ${capped(error.message)}`);
    this.close();
    this.#o.onEnded?.({ reason: "failed", message: "the stream ended without saying why" });
  }

  #fail(message: string): void {
    this.close();
    this.#o.onError?.(message);
  }
}

/** Takes a link's `browser.stream` streams: `open` returns the view for one (or null to refuse it), and the link
 *  stream's bytes go to it until either side ends. Returns the unsubscribe. */
export function receiveTabStreams(
  link: { onStream(label: string, fn: (stream: LinkStream, meta: unknown) => void): () => void },
  open: (meta: StreamLinkMeta, stream: LinkStream) => TabStreamView | null,
): () => void {
  return link.onStream(STREAM_LINK_LABEL, (stream, raw) => {
    const meta = readStreamMeta(raw);
    const view = meta === null ? null : open(meta, stream);
    if (view === null) {
      stream.abort(meta === null ? "not a stream this reads" : "not wanted");
      return;
    }
    const offData = stream.onData((bytes) => {
      view.push(bytes);
      if (view.closed) {
        offData();
        // The computer ends the stream after its `ended` frame; anything else is this side giving up.
        if (!view.ended) stream.abort("can't show it");
      }
    });
    stream.onEnd((error) => {
      offData();
      view.lose(error);
    });
  });
}
