// The viewer: the "other device" of question 6. It receives a tab's frames by one of three roads and decodes the
// frame marker from each one, so every frame gives its own end-to-end latency (on one machine's clock):
//   jpeg      — pictures over the link (a WebSocket here), newest only: each one acked before the next is sent
//   webcodecs — encoded video chunks over the link, decoded with VideoDecoder
//   webrtc    — an RTCPeerConnection's video track
// Driven by the Electron main process through executeJavaScript (window.__v).
import { ageMs, decodeMarker, MARKER_HEIGHT, MARKER_WIDTH, rgbaReader } from "../shared/marker.ts";
import { unframe } from "../shared/framing.ts";
import type { TrackProcessorCtor } from "./media-types.ts";

interface Stats {
  mode: string;
  frames: number;
  decoded: number;
  bytes: number;
  latencies: number[];
  arrivals: number[];
  widths: Record<string, number>;
  errors: string[];
  firstAt: number;
  lastAt: number;
}
let stats: Stats = fresh("none");
function fresh(mode: string): Stats {
  return { mode, frames: 0, decoded: 0, bytes: 0, latencies: [], arrivals: [], widths: {}, errors: [], firstAt: 0, lastAt: 0 };
}

let sourceWidth = 1280;
let sourceHeight = 800;
let ws: WebSocket | null = null;
let decoder: VideoDecoder | null = null;
let decoderCodec = "";
let pc: RTCPeerConnection | null = null;
let rtcRunning = false;
const canvas = new OffscreenCanvas(MARKER_WIDTH, MARKER_HEIGHT);
const ctx = canvas.getContext("2d", { willReadFrequently: true });

function note(e: unknown): void {
  const s = String(e instanceof Error ? e.message : e);
  if (stats.errors.length < 20 && !stats.errors.includes(s)) stats.errors.push(s);
}

/**
 * Decode the marker from a picture `width` x `height` image pixels of a page `pageWidth` x `pageHeight` CSS px. A tab
 * capture scales the page to fit its frame, keeping the aspect ratio (letterboxed), so the strip may be offset.
 */
function readMarker(src: CanvasImageSource, width: number, pageWidth: number, height = 0, pageHeight = 0): void {
  if (ctx === null) return;
  let scale = width / pageWidth, ox = 0, oy = 0;
  if (height > 0 && pageHeight > 0) {
    scale = Math.min(width / pageWidth, height / pageHeight);
    ox = Math.round((width - pageWidth * scale) / 2);
    oy = Math.round((height - pageHeight * scale) / 2);
  }
  const w = Math.ceil(MARKER_WIDTH * scale), h = Math.ceil(MARKER_HEIGHT * scale);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.drawImage(src, ox, oy, w, h, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const m = decodeMarker(rgbaReader(img.data, w, h), scale);
  const now = Date.now();
  stats.frames++;
  stats.arrivals.push(now);
  if (stats.firstAt === 0) stats.firstAt = now;
  stats.lastAt = now;
  stats.widths[String(width)] = (stats.widths[String(width)] ?? 0) + 1;
  if (m !== null) {
    stats.decoded++;
    stats.latencies.push(ageMs(now, m.t24));
  }
}

async function onJpeg(header: Record<string, unknown>, payload: Uint8Array): Promise<void> {
  try {
    const bmp = await createImageBitmap(new Blob([payload as BlobPart], { type: "image/jpeg" }));
    readMarker(bmp, bmp.width, Number(header.innerWidth ?? sourceWidth));
    bmp.close();
  } catch (e) {
    note(e);
  }
  ws?.send(JSON.stringify({ ack: header.seq }));
}

function onChunk(header: Record<string, unknown>, payload: Uint8Array): void {
  const codec = String(header.codec);
  try {
    if (decoder === null || decoderCodec !== codec || decoder.state === "closed") {
      if (header.type !== "key") return; // wait for a key frame
      decoder?.close();
      const pageWidth = Number(header.innerWidth ?? sourceWidth);
      decoder = new VideoDecoder({
        output: (frame) => {
          try { readMarker(frame, frame.displayWidth, pageWidth, frame.displayHeight, sourceHeight); } catch (e) { note(e); }
          frame.close();
        },
        error: (e) => note(e),
      });
      decoder.configure({ codec, codedWidth: Number(header.w), codedHeight: Number(header.h), optimizeForLatency: true });
      decoderCodec = codec;
    }
    decoder.decode(new EncodedVideoChunk({ type: header.type === "key" ? "key" : "delta", timestamp: Number(header.ts), data: payload }));
  } catch (e) {
    note(e);
  }
}

async function readTrack(track: MediaStreamTrack): Promise<void> {
  const Ctor = (globalThis as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor;
  if (Ctor !== undefined) {
    const reader = new Ctor({ track }).readable.getReader();
    while (rtcRunning) {
      const { value, done } = await reader.read();
      if (done || value === undefined) break;
      try { readMarker(value, value.displayWidth, sourceWidth, value.displayHeight, sourceHeight); } catch (e) { note(e); }
      value.close();
    }
    return;
  }
  // No MediaStreamTrackProcessor here: a <video> and requestVideoFrameCallback (needs this page to render).
  note("no MediaStreamTrackProcessor: using video.requestVideoFrameCallback");
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = new MediaStream([track]);
  document.body.appendChild(video);
  await video.play();
  const onFrame = (): void => {
    if (!rtcRunning) return;
    try { readMarker(video, video.videoWidth, sourceWidth, video.videoHeight, sourceHeight); } catch (e) { note(e); }
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}

const api = {
  reset(mode: string, pageWidth: number, pageHeight: number): void {
    stats = fresh(mode);
    sourceWidth = pageWidth;
    sourceHeight = pageHeight;
  },
  stats(): Stats {
    return stats;
  },
  connect(url: string): Promise<string> {
    return new Promise((resolve) => {
      ws?.close();
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => resolve("open");
      ws.onerror = () => resolve("error");
      ws.onmessage = (e) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        stats.bytes += e.data.byteLength;
        const { header, payload } = unframe(e.data);
        if (header.kind === "jpeg") void onJpeg(header, payload);
        else if (header.kind === "chunk") onChunk(header, payload);
      };
    });
  },
  async rtcAnswer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    pc?.close();
    pc = new RTCPeerConnection({ iceServers: [] });
    rtcRunning = true;
    pc.ontrack = (e) => { void readTrack(e.track); };
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await gathered(pc);
    return pc.localDescription!.toJSON() as RTCSessionDescriptionInit;
  },
  async rtcStats(): Promise<Record<string, unknown>> {
    if (pc === null) return {};
    const out: Record<string, unknown> = { connection: pc.connectionState, ice: pc.iceConnectionState };
    const report = await pc.getStats();
    const codecs = new Map<string, string>();
    report.forEach((s: Record<string, unknown>) => { if (s.type === "codec") codecs.set(String(s.id), String(s.mimeType)); });
    report.forEach((s: Record<string, unknown>) => {
      if (s.type === "inbound-rtp" && s.kind === "video") {
        out.bytesReceived = s.bytesReceived;
        out.framesDecoded = s.framesDecoded;
        out.framesReceived = s.framesReceived;
        out.framesDropped = s.framesDropped;
        out.frameWidth = s.frameWidth;
        out.frameHeight = s.frameHeight;
        out.decoderImplementation = s.decoderImplementation;
        out.jitterBufferDelay = s.jitterBufferDelay;
        out.jitterBufferEmittedCount = s.jitterBufferEmittedCount;
        out.codec = codecs.get(String(s.codecId));
      }
    });
    return out;
  },
  stop(): void {
    rtcRunning = false;
    pc?.close();
    pc = null;
    decoder?.close();
    decoder = null;
    ws?.close();
    ws = null;
  },
};

function gathered(p: RTCPeerConnection): Promise<void> {
  if (p.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 3000);
    p.addEventListener("icegatheringstatechange", () => {
      if (p.iceGatheringState === "complete") { clearTimeout(t); resolve(); }
    });
  });
}

(window as unknown as { __v: typeof api }).__v = api;
