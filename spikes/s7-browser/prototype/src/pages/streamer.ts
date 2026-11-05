// The streamer: an app-internal page (not a tab) that captures a tab as a video track and sends it to the viewer,
// either over WebRTC (its own transport) or as WebCodecs chunks over the link (a WebSocket here). Driven by the
// Electron main process through executeJavaScript (window.__st).
import { frame } from "../shared/framing.ts";
import type { TrackProcessorCtor } from "./media-types.ts";

let track: MediaStreamTrack | null = null;
let pc: RTCPeerConnection | null = null;
let ws: WebSocket | null = null;
let encoding = false;
const counters = { encoded: 0, dropped: 0, keyFrames: 0, bytes: 0, errors: [] as string[], codec: "", hardware: "" };

function note(e: unknown): void {
  const s = String(e instanceof Error ? e.message : e);
  if (counters.errors.length < 20 && !counters.errors.includes(s)) counters.errors.push(s);
}

function gathered(p: RTCPeerConnection): Promise<void> {
  if (p.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 3000);
    p.addEventListener("icegatheringstatechange", () => {
      if (p.iceGatheringState === "complete") { clearTimeout(t); resolve(); }
    });
  });
}

const api = {
  /** Capture the tab whose media source id the main process made for this page (chromeMediaSource "tab"). */
  async captureTab(sourceId: string, maxWidth: number, maxHeight: number, maxFps: number): Promise<Record<string, unknown>> {
    const constraints = {
      audio: false,
      video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: sourceId, maxWidth, maxHeight, maxFrameRate: maxFps } },
    } as unknown as MediaStreamConstraints;
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    track = stream.getVideoTracks()[0] ?? null;
    if (track !== null) track.contentHint = "detail";
    return { settings: track?.getSettings() ?? null, via: "getUserMedia(tab)" };
  },
  /** The other road: getDisplayMedia, answered by the main process's setDisplayMediaRequestHandler with the tab. */
  async captureDisplay(maxFps: number): Promise<Record<string, unknown>> {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: maxFps }, audio: false });
    track = stream.getVideoTracks()[0] ?? null;
    if (track !== null) track.contentHint = "detail";
    return { settings: track?.getSettings() ?? null, via: "getDisplayMedia" };
  },
  codecs(): string[] {
    return (RTCRtpSender.getCapabilities("video")?.codecs ?? []).map((c) => c.mimeType).filter((m, i, a) => a.indexOf(m) === i);
  },
  async rtcOffer(prefer: string): Promise<RTCSessionDescriptionInit> {
    if (track === null) throw new Error("no track");
    pc?.close();
    pc = new RTCPeerConnection({ iceServers: [] });
    const tx = pc.addTransceiver(track, { direction: "sendonly" });
    if (prefer !== "") {
      const caps = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
      const first = caps.filter((c) => c.mimeType.toLowerCase() === prefer.toLowerCase());
      if (first.length > 0) tx.setCodecPreferences([...first, ...caps.filter((c) => c.mimeType.toLowerCase() !== prefer.toLowerCase())]);
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await gathered(pc);
    return pc.localDescription!.toJSON() as RTCSessionDescriptionInit;
  },
  async rtcAccept(answer: RTCSessionDescriptionInit): Promise<void> {
    await pc!.setRemoteDescription(answer);
  },
  async rtcStats(): Promise<Record<string, unknown>> {
    if (pc === null) return {};
    const out: Record<string, unknown> = { connection: pc.connectionState };
    const report = await pc.getStats();
    report.forEach((s: Record<string, unknown>) => {
      if (s.type === "outbound-rtp" && s.kind === "video") {
        out.bytesSent = s.bytesSent;
        out.framesEncoded = s.framesEncoded;
        out.framesSent = s.framesSent;
        out.frameWidth = s.frameWidth;
        out.frameHeight = s.frameHeight;
        out.encoderImplementation = s.encoderImplementation;
        out.powerEfficientEncoder = s.powerEfficientEncoder;
        out.qualityLimitationReason = s.qualityLimitationReason;
        out.targetBitrate = s.targetBitrate;
        out.totalEncodeTime = s.totalEncodeTime;
      }
      if (s.type === "candidate-pair" && s.state === "succeeded") out.availableOutgoingBitrate = s.availableOutgoingBitrate;
    });
    return out;
  },
  /** Encode the track with WebCodecs and send the chunks over the link. Resolves once the encoder is configured. */
  async webcodecs(url: string, codec: string, bitrate: number, pageWidth: number): Promise<Record<string, unknown>> {
    if (track === null) throw new Error("no track");
    const Ctor = (globalThis as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor;
    if (Ctor === undefined) throw new Error("no MediaStreamTrackProcessor in a window");
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error("link")); });
    const reader = new Ctor({ track }).readable.getReader();
    let width = 0, height = 0, n = 0;
    const st: { encoder: VideoEncoder | null } = { encoder: null };
    counters.codec = codec;
    const configure = async (w: number, h: number): Promise<void> => {
      const old = st.encoder;
      if (old !== null) { try { await old.flush(); } catch { /* reconfiguring */ } old.close(); }
      width = w; height = h;
      const encoder = new VideoEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          if (chunk.type === "key") counters.keyFrames++;
          counters.encoded++;
          counters.bytes += data.byteLength;
          ws?.send(frame({ kind: "chunk", type: chunk.type, ts: chunk.timestamp, codec, w: width, h: height, innerWidth: pageWidth }, data));
        },
        error: (e) => note(e),
      });
      const config: VideoEncoderConfig = { codec, width: w, height: h, bitrate, framerate: 30, latencyMode: "realtime", hardwareAcceleration: "no-preference" };
      if (codec.startsWith("avc1")) (config as VideoEncoderConfig & { avc?: { format: string } }).avc = { format: "annexb" };
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported !== true) throw new Error(`encoder config not supported: ${codec} ${w}x${h}`);
      encoder.configure(config);
      st.encoder = encoder;
      n = 0;
    };
    encoding = true;
    const first = await reader.read();
    if (first.done || first.value === undefined) throw new Error("no frame from the track");
    await configure(first.value.codedWidth & ~1, first.value.codedHeight & ~1);
    first.value.close();
    void (async () => {
      while (encoding) {
        const { value, done } = await reader.read();
        if (done || value === undefined) break;
        try {
          if ((value.codedWidth & ~1) !== width || (value.codedHeight & ~1) !== height) await configure(value.codedWidth & ~1, value.codedHeight & ~1);
          const enc = st.encoder!;
          if (enc.encodeQueueSize > 2 || (ws?.bufferedAmount ?? 0) > 2_000_000) { counters.dropped++; }
          else enc.encode(value, { keyFrame: n % 60 === 0 });
          n++;
        } catch (e) {
          note(e);
        }
        value.close();
      }
      try { await st.encoder?.flush(); } catch { /* stopping */ }
      st.encoder?.close();
    })();
    return { width, height, codec };
  },
  counters(): typeof counters {
    return counters;
  },
  resetCounters(): void {
    Object.assign(counters, { encoded: 0, dropped: 0, keyFrames: 0, bytes: 0, errors: [] });
  },
  stop(): void {
    encoding = false;
    pc?.close();
    pc = null;
    ws?.close();
    ws = null;
    track?.stop();
    track = null;
  },
};

(window as unknown as { __st: typeof api }).__st = api;
