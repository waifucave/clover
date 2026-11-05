// The probe page: what a tab's page can see of itself. Every check loads it in a tab and reads `__s7.snapshot()`
// through executeJavaScript (Electron) or Runtime.evaluate (Chrome for Testing). It keeps:
//   - identity: a random token made at load, the load time and the navigation type (a reload makes a new token);
//   - timers: a 10 ms interval and a chained 10 ms timeout, counted, with the longest gap between ticks;
//   - rAF: counted, the longest gap, and the times of the last frames;
//   - page lifecycle: visibilitychange, resize, focus, freeze/resume, pageshow/pagehide, with times;
//   - state that a reload would lose: a field's value, sessionStorage, the scroll position, an open SSE stream;
//   - media: a looping <video> with sound (played time, decoded frames, pauses) and an AudioContext;
//   - the frame marker (shared/marker.ts) drawn on every rAF and timer tick, or twice a second for `static`.
// Query: scenario=probe|anim|static, media=1, sse=0, tab=<id>.
import { drawMarker, MARKER_HEIGHT, MARKER_WIDTH } from "../shared/marker.ts";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "probe";
const tabId = params.get("tab") ?? "";
const fastTimers = scenario !== "static";

interface Gap { n: number; lastAt: number; maxGap: number }
function gap(): Gap { return { n: 0, lastAt: 0, maxGap: 0 }; }
function tickGap(g: Gap, now: number): void {
  if (g.lastAt > 0) g.maxGap = Math.max(g.maxGap, now - g.lastAt);
  g.lastAt = now;
  g.n++;
}

const RAF_RING = 600;
const rafTimes: number[] = [];
const events: Array<{ t: number; kind: string; detail?: string }> = [];
function log(kind: string, detail?: string): void {
  events.push({ t: Date.now(), kind, detail });
  if (events.length > 200) events.shift();
}

const S = {
  token: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : String(Math.random()).slice(2),
  loadedAt: Date.now(),
  navType: (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type ?? "unknown",
  interval: gap(),
  chain: gap(),
  raf: gap(),
  frame: 0,
  lastMarkerAt: 0,
  sse: { opens: 0, errors: 0, msgs: 0, lastSeq: -1, gaps: 0 },
  media: { played: 0, lastTime: -1, pauses: 0, plays: 0, waiting: 0, error: "" },
};

// --- the marker ---------------------------------------------------------------------------------------------------
const markerCanvas = document.getElementById("marker") as HTMLCanvasElement;
let markerCtx: CanvasRenderingContext2D | null = null;
let markerDpr = 0;
function markerContext(): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  if (markerCtx === null || dpr !== markerDpr) {
    markerDpr = dpr;
    markerCanvas.width = Math.round(MARKER_WIDTH * dpr);
    markerCanvas.height = Math.round(MARKER_HEIGHT * dpr);
    markerCtx = markerCanvas.getContext("2d", { alpha: false });
    markerCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return markerCtx;
}
function drawNow(): void {
  const ctx = markerContext();
  if (ctx === null) return;
  const now = Date.now();
  S.frame = (S.frame + 1) & 0xffff;
  drawMarker(ctx, now, S.frame);
  S.lastMarkerAt = now;
}

// --- the animated background (scenario=anim) ----------------------------------------------------------------------
const bg = document.getElementById("bg") as HTMLCanvasElement;
let bgCtx: CanvasRenderingContext2D | null = null;
function drawBackground(now: number): void {
  if (bgCtx === null) return;
  const w = window.innerWidth, h = window.innerHeight;
  if (bg.width !== w || bg.height !== h) { bg.width = w; bg.height = h; }
  const t = now / 1000;
  const g = bgCtx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${(t * 40) % 360} 70% 55%)`);
  g.addColorStop(1, `hsl(${(t * 40 + 120) % 360} 70% 45%)`);
  bgCtx.fillStyle = g;
  bgCtx.fillRect(0, 0, w, h);
  for (let i = 0; i < 30; i++) {
    const x = (Math.sin(t * (0.3 + i * 0.05) + i) * 0.5 + 0.5) * w;
    const y = (Math.cos(t * (0.4 + i * 0.03) + i * 2) * 0.5 + 0.5) * h;
    bgCtx.fillStyle = `hsl(${(i * 37 + t * 60) % 360} 80% 60% / 0.7)`;
    bgCtx.beginPath();
    bgCtx.arc(x, y, 20 + (i % 7) * 8, 0, Math.PI * 2);
    bgCtx.fill();
  }
  bgCtx.fillStyle = "#111";
  bgCtx.font = "28px system-ui, sans-serif";
  for (let i = 0; i < 12; i++) {
    const y = ((i * 70 + t * 90) % (h + 70)) - 20;
    bgCtx.fillText(`The Clover Browser S7 — moving text line ${i} — ${Math.floor(t * 10)}`, 40, y);
  }
}
if (scenario === "anim") {
  bg.style.display = "block";
  bgCtx = bg.getContext("2d", { alpha: false });
}

// --- content -------------------------------------------------------------------------------------------------------
const content = document.getElementById("content")!;
const words = "bots browse the web in their own tabs while the person watches from any device".split(" ");
for (let i = 0; i < 60; i++) {
  const d = document.createElement("div");
  d.className = "block";
  let text = `Block ${i}. `;
  for (let j = 0; j < 40; j++) text += words[(i * 7 + j) % words.length] + " ";
  d.textContent = text;
  content.appendChild(d);
}

// --- timers and rAF ------------------------------------------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  tickGap(S.interval, now);
  drawNow();
}, fastTimers ? 10 : 500);

if (fastTimers) {
  const chain = (): void => {
    tickGap(S.chain, Date.now());
    setTimeout(chain, 10);
  };
  setTimeout(chain, 10);
}

const onFrame = (ts: number): void => {
  const now = Date.now();
  tickGap(S.raf, now);
  rafTimes.push(now);
  if (rafTimes.length > RAF_RING) rafTimes.shift();
  if (fastTimers) drawNow();
  if (bgCtx !== null) drawBackground(ts);
  requestAnimationFrame(onFrame);
};
requestAnimationFrame(onFrame);
drawNow();

// --- lifecycle -----------------------------------------------------------------------------------------------------
document.addEventListener("visibilitychange", () => log("visibility", document.visibilityState));
window.addEventListener("resize", () => log("resize", `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`));
window.addEventListener("focus", () => log("focus"));
window.addEventListener("blur", () => log("blur"));
document.addEventListener("freeze", () => log("freeze"));
document.addEventListener("resume", () => log("resume"));
window.addEventListener("pageshow", (e) => log("pageshow", e.persisted ? "persisted" : ""));
window.addEventListener("pagehide", () => log("pagehide"));
log("load", document.visibilityState);

// --- SSE -------------------------------------------------------------------------------------------------------------
if (params.get("sse") !== "0") {
  const es = new EventSource(`/sse?tab=${encodeURIComponent(tabId)}`);
  es.onopen = () => { S.sse.opens++; };
  es.onerror = () => { S.sse.errors++; };
  es.onmessage = (e) => {
    const seq = Number(e.data);
    if (S.sse.lastSeq >= 0 && seq !== S.sse.lastSeq + 1) S.sse.gaps++;
    S.sse.lastSeq = seq;
    S.sse.msgs++;
  };
}

// --- media -----------------------------------------------------------------------------------------------------------
let video: HTMLVideoElement | null = null;
let audio: AudioContext | null = null;
async function startMedia(): Promise<string> {
  const box = document.getElementById("media")!;
  video = document.createElement("video");
  video.loop = true;
  video.playsInline = true;
  video.src = "/media/clip.webm";
  video.addEventListener("pause", () => { S.media.pauses++; log("media", "pause"); });
  video.addEventListener("play", () => { S.media.plays++; });
  video.addEventListener("waiting", () => { S.media.waiting++; });
  video.addEventListener("error", () => { S.media.error = String(video?.error?.message ?? video?.error?.code ?? "error"); });
  video.addEventListener("timeupdate", () => {
    const v = video!;
    const cur = v.currentTime;
    if (S.media.lastTime >= 0) {
      let d = cur - S.media.lastTime;
      if (d < 0 && Number.isFinite(v.duration)) d += v.duration;
      if (d > 0 && d < 5) S.media.played += d;
    }
    S.media.lastTime = cur;
  });
  box.appendChild(video);
  // Neither promise is guaranteed to settle (a browser with no audio device, a headless shell): never wait forever.
  const settle = <T>(p: Promise<T>, ms: number): Promise<string> =>
    Promise.race([p.then(() => "ok", (e: unknown) => `failed: ${String(e)}`), new Promise<string>((r) => setTimeout(() => r(`no answer in ${ms} ms`), ms))]);
  let result = `video.play ${await settle(video.play(), 3000)}`;
  try {
    audio = new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    if (audio.state !== "running") result += `; audio.resume ${await settle(audio.resume(), 2000)}`;
    result += `; audio ${audio.state}`;
  } catch (e) {
    result += `; audio: ${String(e)}`;
  }
  return result;
}

// --- the API the checks call ---------------------------------------------------------------------------------------
interface SetupOptions { field?: string; scroll?: number; media?: boolean }
const api = {
  async setup(o: SetupOptions): Promise<Record<string, unknown>> {
    const field = document.getElementById("field") as HTMLInputElement;
    if (o.field !== undefined) {
      field.value = o.field;
      sessionStorage.setItem("s7", o.field);
    }
    if (o.scroll !== undefined) window.scrollTo(0, o.scroll);
    const media = o.media === true ? await startMedia() : "off";
    return { media, scrollY: window.scrollY };
  },
  snapshot(): Record<string, unknown> {
    const field = document.getElementById("field") as HTMLInputElement;
    const q = video?.getVideoPlaybackQuality?.();
    return {
      token: S.token,
      loadedAt: S.loadedAt,
      navType: S.navType,
      now: Date.now(),
      visibility: document.visibilityState,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
      scrollY: window.scrollY,
      field: field.value,
      session: sessionStorage.getItem("s7"),
      interval: { ...S.interval },
      chain: { ...S.chain },
      raf: { ...S.raf },
      frame: S.frame,
      lastMarkerAt: S.lastMarkerAt,
      sse: { ...S.sse },
      media: video === null ? null : {
        played: S.media.played,
        currentTime: video.currentTime,
        paused: video.paused,
        readyState: video.readyState,
        decodedFrames: q?.totalVideoFrames ?? -1,
        droppedFrames: q?.droppedVideoFrames ?? -1,
        pauses: S.media.pauses,
        plays: S.media.plays,
        waiting: S.media.waiting,
        error: S.media.error,
        audioState: audio?.state ?? "none",
        audioTime: audio?.currentTime ?? -1,
      },
      events: events.slice(),
    };
  },
  /** Reset the longest-gap trackers (the start of a measurement window). */
  resetGaps(): void {
    for (const g of [S.interval, S.chain, S.raf]) { g.maxGap = 0; g.lastAt = 0; }
  },
  /** The first rAF at or after `t` (ms since the epoch), or -1. */
  rafAfter(t: number): number {
    for (const x of rafTimes) if (x >= t) return x;
    return -1;
  },
  /** The first event of `kind` (optionally with `detail`) at or after `t`, or -1. */
  eventAfter(t: number, kind: string, detail?: string): number {
    for (const e of events) if (e.t >= t && e.kind === kind && (detail === undefined || e.detail === detail)) return e.t;
    return -1;
  },
};
(window as unknown as { __s7: typeof api }).__s7 = api;
