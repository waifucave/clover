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

export interface TabStreamViewOptions {
  decoders?: TabStreamDecoders;
  /** The newest picture. */
  onPicture(picture: TabPicture): void;
  /** The computer ended the stream (stopped, the tab closed, or it failed). */
  onEnded?(ended: { reason: "stopped" | "closed" | "failed"; message?: string }): void;
  /** This side can't go on: a malformed frame, or a codec this browser can't decode. The stream should be ended. */
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
        this.#o.onEnded?.(c.message !== undefined ? { reason: c.reason, message: c.message } : { reason: c.reason });
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
    const decoder = new Decoder({
      output: (frame) => {
        if (generation !== this.#generation || this.#done) {
          frame.close();
          return;
        }
        this.#o.onPicture({ image: frame, width: frame.displayWidth, height: frame.displayHeight, close: () => frame.close() });
      },
      // A decoder that errs is closed; the next keyframe opens a new one.
      error: () => {
        if (generation !== this.#generation) return;
        this.#video = undefined;
        this.#needKey = true;
      },
    });
    // H.264 with no `description` is Annex B, as the sender writes it (SPS and PPS in band before each keyframe).
    decoder.configure({ codec: c.codecString, codedWidth: c.width, codedHeight: c.height, optimizeForLatency: true });
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
    if (this.#video === undefined || this.#video.state === "closed") this.#openVideo(config);
    try {
      this.#video!.decode(new this.#d.EncodedVideoChunk!({ type: f.key ? "key" : "delta", timestamp: f.timestamp, data: f.data }));
    } catch {
      this.#closeVideo();
      this.#needKey = true;
    }
  }

  /** Newest picture first: while one decodes, only the latest that arrived meanwhile waits. */
  #image(jpeg: Uint8Array): void {
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
    stream.onEnd(() => {
      offData();
      view.close();
    });
  });
}
