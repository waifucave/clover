// Question 6: a tab's frames streamed to another client, by four roads, measured at the viewer from each frame's own
// marker (frame rate, end-to-end latency) and at the link (bandwidth):
//   screencast  — CDP Page.startScreencast JPEGs over the link, newest only: one frame in flight to the viewer, the
//                 browser acked only when the viewer has acked (so it never encodes far ahead)
//   capturePoll — capturePage({stayHidden}) + toJPEG in the main process, one in flight, the same acks
//   webrtc      — tab capture (getMediaSourceId, chromeMediaSource "tab") into an RTCPeerConnection, VP8 or H.264
//   webcodecs   — the same capture encoded with VideoEncoder, the chunks sent over the link, VideoDecoder at the viewer
// The "link" here is a loopback WebSocket, so the numbers are the floor before any real network.
import { BrowserWindow, session, type WebContents } from "electron";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { cpuBetween, sample } from "./metrics.ts";
import type { Place, Tab, TabHost } from "./tabs.ts";
import { errorText, sleep, summarize, waitFor, withTimeout, type Summary } from "../shared/stats.ts";

type Log = (line: string) => void;

export interface StreamRow {
  road: string;
  scenario: string;
  source: Place;
  seconds: number;
  framesPerSec: number;
  decodedPerSec: number;
  latencyMs: Summary;
  /** Gaps between frames at the viewer. */
  interFrameMs: Summary;
  bytesPerSec: number;
  kbitPerSec: number;
  avgFrameBytes: number;
  frameWidths: Record<string, number>;
  senderCpuPct: number;
  viewerCpuPct: number;
  dropped?: number;
  extra?: Record<string, unknown>;
  errors: string[];
}

function frameNode(header: Record<string, unknown>, payload: Buffer): Buffer {
  const h = Buffer.from(JSON.stringify(header), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(h.length, 0);
  return Buffer.concat([len, h, payload]);
}

/** The loopback "link": the viewer and the streamer connect here; the main process sends to the viewer. */
export class Link {
  readonly wss = new WebSocketServer({ noServer: true });
  viewer?: WebSocket;
  streamer?: WebSocket;
  bytesToViewer = 0;
  framesToViewer = 0;
  onAck?: (seq: number) => void;

  constructor() {
    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (path === "/link/viewer") {
        this.viewer = ws;
        ws.on("message", (data: RawData, isBinary: boolean) => {
          if (isBinary) return;
          try {
            const m = JSON.parse(data.toString()) as { ack?: number };
            if (typeof m.ack === "number") this.onAck?.(m.ack);
          } catch {
            // not ours
          }
        });
      } else if (path === "/link/streamer") {
        this.streamer = ws;
        ws.on("message", (data: RawData, isBinary: boolean) => {
          if (!isBinary || this.viewer === undefined) return;
          const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
          this.bytesToViewer += buf.length;
          this.framesToViewer++;
          this.viewer.send(buf);
        });
      }
    });
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (!path.startsWith("/link/")) { socket.destroy(); return; }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }

  sendToViewer(header: Record<string, unknown>, payload: Buffer): void {
    const buf = frameNode(header, payload);
    this.bytesToViewer += buf.length;
    this.framesToViewer++;
    this.viewer?.send(buf);
  }

  reset(): void {
    this.bytesToViewer = 0;
    this.framesToViewer = 0;
  }
}

async function exec<T>(wc: WebContents, code: string, ms = 15_000): Promise<T> {
  return (await withTimeout(wc.executeJavaScript(code, true), ms, code.slice(0, 40))) as T;
}

interface ViewerStats { frames: number; decoded: number; bytes: number; latencies: number[]; arrivals: number[]; widths: Record<string, number>; errors: string[] }

function gapsOf(arrivals: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < arrivals.length; i++) out.push(arrivals[i]! - arrivals[i - 1]!);
  return out;
}

export async function streamCheck(host: TabHost, origin: string, link: Link, log: Log, seconds = 10): Promise<StreamRow[]> {
  const rows: StreamRow[] = [];
  const wsOrigin = origin.replace("http://", "ws://");
  const viewer = new BrowserWindow({ show: true, x: 1080, y: 40, width: 420, height: 320, webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true } });
  const streamer = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true } });
  await viewer.loadURL(`${origin}/pages/viewer.html`);
  await streamer.loadURL(`${origin}/pages/streamer.html`);
  const viewerPid = (): string => String(viewer.webContents.getOSProcessId());
  const codecs = await exec<string[]>(streamer.webContents, "window.__st.codecs()").catch(() => [] as string[]);
  log(`  stream: WebRTC send codecs here: ${codecs.join(", ")}`);

  const measure = async (road: string, scenario: string, source: Place, tab: Tab, innerWidth: number, run: () => Promise<Record<string, unknown> | undefined>, after?: () => Promise<Record<string, unknown>>): Promise<void> => {
    const row: StreamRow = {
      road, scenario, source, seconds, framesPerSec: 0, decodedPerSec: 0, latencyMs: summarize([]), interFrameMs: summarize([]),
      bytesPerSec: 0, kbitPerSec: 0, avgFrameBytes: 0, frameWidths: {}, senderCpuPct: 0, viewerCpuPct: 0, errors: [],
    };
    try {
      await exec(viewer.webContents, `window.__v.reset(${JSON.stringify(road)}, ${innerWidth})`);
      const startExtra = await run();
      await sleep(2000); // warm up
      await exec(viewer.webContents, `window.__v.reset(${JSON.stringify(road)}, ${innerWidth})`);
      link.reset();
      const rtc0 = road.startsWith("webrtc") ? await exec<Record<string, number>>(viewer.webContents, "window.__v.rtcStats()") : undefined;
      const m0 = sample();
      await sleep(seconds * 1000);
      const m1 = sample();
      const vs = await exec<ViewerStats>(viewer.webContents, "window.__v.stats()");
      const cpu = cpuBetween(m0, m1);
      row.viewerCpuPct = cpu.byPid[viewerPid()] ?? 0;
      row.senderCpuPct = cpu.total - row.viewerCpuPct;
      row.framesPerSec = vs.frames / seconds;
      row.decodedPerSec = vs.decoded / seconds;
      row.latencyMs = summarize(vs.latencies);
      row.interFrameMs = summarize(gapsOf(vs.arrivals));
      row.frameWidths = vs.widths;
      row.errors.push(...vs.errors);
      if (road.startsWith("webrtc")) {
        const rtc1 = await exec<Record<string, number>>(viewer.webContents, "window.__v.rtcStats()");
        const bytes = Number(rtc1.bytesReceived ?? 0) - Number(rtc0?.bytesReceived ?? 0);
        row.bytesPerSec = bytes / seconds;
        row.avgFrameBytes = vs.frames > 0 ? bytes / vs.frames : 0;
        row.extra = { viewer: rtc1, sender: await exec(streamer.webContents, "window.__st.rtcStats()").catch((e) => ({ error: errorText(e) })) };
      } else {
        row.bytesPerSec = link.bytesToViewer / seconds;
        row.avgFrameBytes = link.framesToViewer > 0 ? link.bytesToViewer / link.framesToViewer : 0;
      }
      row.kbitPerSec = (row.bytesPerSec * 8) / 1000;
      if (after !== undefined) row.extra = { ...(row.extra ?? {}), ...(await after()) };
      if (startExtra !== undefined) row.extra = { ...(row.extra ?? {}), start: startExtra };
    } catch (e) {
      row.errors.push(errorText(e));
    }
    rows.push(row);
    log(`  stream ${road}/${scenario}/${source}: ${row.framesPerSec.toFixed(1)} fps (${row.decodedPerSec.toFixed(1)} decoded), latency p50 ${row.latencyMs.p50} p95 ${row.latencyMs.p95} ms, ${row.kbitPerSec.toFixed(0)} kbit/s, sender cpu ${row.senderCpuPct.toFixed(0)}%${row.errors.length ? ` errors: ${row.errors.slice(0, 3).join("; ")}` : ""}`);
  };

  await exec(viewer.webContents, `window.__v.connect(${JSON.stringify(`${wsOrigin}/link/viewer`)})`);
  await waitFor(() => link.viewer, 5000);

  const plan: Array<{ road: string; scenario: string; source: Place }> = [];
  for (const scenario of ["anim", "static"]) {
    for (const road of ["screencast", "capturePoll", "webrtc-vp8", "webrtc-h264", "webcodecs-vp8", "webcodecs-h264"]) plan.push({ road, scenario, source: "hiddenWindow" });
  }
  plan.push({ road: "screencast", scenario: "anim", source: "shown" });
  plan.push({ road: "webrtc-vp8", scenario: "anim", source: "shown" });

  for (const p of plan) {
    let tab: Tab | undefined;
    let stop: (() => Promise<void>) | undefined;
    try {
      tab = await host.create({ place: p.source, partition: "bot-stream", throttling: false, path: `/pages/probe.html?scenario=${p.scenario}&sse=0` });
      await sleep(1000);
      const snap = await host.snapshot(tab);
      const t = tab;
      if (p.road === "screencast") {
        let inFlight: number | undefined;
        let pending: { session: number; data: Buffer; width: number } | undefined;
        let seq = 0, dropped = 0;
        const ackBrowser = (s: number): void => { void t.wc.debugger.sendCommand("Page.screencastFrameAck", { sessionId: s }).catch(() => undefined); };
        const send = (f: { session: number; data: Buffer; width: number }): void => {
          inFlight = f.session;
          link.sendToViewer({ kind: "jpeg", seq: seq++, innerWidth: f.width }, f.data);
        };
        const onMessage = (_e: unknown, method: string, params: Record<string, unknown>): void => {
          if (method !== "Page.screencastFrame") return;
          const meta = params.metadata as { deviceWidth?: number } | undefined;
          const f = { session: Number(params.sessionId), data: Buffer.from(String(params.data), "base64"), width: meta?.deviceWidth ?? snap.innerWidth };
          if (inFlight === undefined) send(f);
          else {
            if (pending !== undefined) { dropped++; ackBrowser(pending.session); }
            pending = f;
          }
        };
        link.onAck = () => {
          if (inFlight !== undefined) ackBrowser(inFlight);
          inFlight = undefined;
          if (pending !== undefined) { const f = pending; pending = undefined; send(f); }
        };
        await host.debuggerFor(t);
        t.wc.debugger.on("message", onMessage);
        stop = async () => {
          await t.wc.debugger.sendCommand("Page.stopScreencast").catch(() => undefined);
          t.wc.debugger.removeListener("message", onMessage);
          link.onAck = undefined;
        };
        await measure(p.road, p.scenario, p.source, t, snap.innerWidth, async () => {
          await t.wc.debugger.sendCommand("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
          return undefined;
        }, async () => ({ droppedInMain: dropped }));
      } else if (p.road === "capturePoll") {
        let running = true;
        let seq = 0, encodeMs = 0, captures = 0;
        const loop = async (): Promise<void> => {
          while (running) {
            const acked = new Promise<void>((resolve) => { link.onAck = () => resolve(); });
            try {
              const img = await t.wc.capturePage(undefined, { stayHidden: true });
              const e0 = Date.now();
              const jpg = img.toJPEG(70);
              encodeMs += Date.now() - e0;
              captures++;
              link.sendToViewer({ kind: "jpeg", seq: seq++, innerWidth: snap.innerWidth }, jpg);
              await withTimeout(acked, 2000, "viewer ack").catch(() => undefined);
            } catch {
              await sleep(50);
            }
          }
        };
        stop = async () => { running = false; await sleep(100); link.onAck = undefined; };
        await measure(p.road, p.scenario, p.source, t, snap.innerWidth, async () => { void loop(); return undefined; },
          async () => ({ mainThreadJpegMsPerFrame: captures > 0 ? encodeMs / captures : 0 }));
      } else {
        // tab capture for webrtc-* and webcodecs-*
        const sourceId = t.wc.getMediaSourceId(streamer.webContents);
        let via: Record<string, unknown>;
        try {
          via = await exec(streamer.webContents, `window.__st.captureTab(${JSON.stringify(sourceId)}, 1280, 800, 30)`);
        } catch (e) {
          session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => cb({ video: t.wc.mainFrame }));
          via = { tabCaptureError: errorText(e), ...(await exec<Record<string, unknown>>(streamer.webContents, "window.__st.captureDisplay(30)")) };
        }
        stop = async () => { await exec(streamer.webContents, "window.__st.stop()").catch(() => undefined); await exec(viewer.webContents, "window.__v.stop()").catch(() => undefined); };
        if (p.road.startsWith("webrtc")) {
          const prefer = p.road === "webrtc-h264" ? "video/H264" : "video/VP8";
          if (!codecs.some((c) => c.toLowerCase() === prefer.toLowerCase())) {
            rows.push({ road: p.road, scenario: p.scenario, source: p.source, seconds: 0, framesPerSec: 0, decodedPerSec: 0, latencyMs: summarize([]), interFrameMs: summarize([]), bytesPerSec: 0, kbitPerSec: 0, avgFrameBytes: 0, frameWidths: {}, senderCpuPct: 0, viewerCpuPct: 0, errors: [`${prefer} not offered here`] });
            continue;
          }
          await measure(p.road, p.scenario, p.source, t, snap.innerWidth, async () => {
            const offer = await exec<RTCSessionDescriptionInitLike>(streamer.webContents, `window.__st.rtcOffer(${JSON.stringify(prefer)})`);
            const answer = await exec<RTCSessionDescriptionInitLike>(viewer.webContents, `window.__v.rtcAnswer(${JSON.stringify(offer)})`);
            await exec(streamer.webContents, `window.__st.rtcAccept(${JSON.stringify(answer)})`);
            const state = await waitFor(async () => {
              const s = await exec<{ connection?: string }>(viewer.webContents, "window.__v.rtcStats()");
              return s.connection === "connected" ? s.connection : undefined;
            }, 10_000, 100);
            return { capture: via, connected: state ?? "not connected in 10 s" };
          });
        } else {
          const codec = p.road === "webcodecs-h264" ? "avc1.42E028" : "vp8";
          await exec(viewer.webContents, `window.__v.connect(${JSON.stringify(`${wsOrigin}/link/viewer`)})`);
          await measure(p.road, p.scenario, p.source, t, snap.innerWidth, async () => {
            await exec(streamer.webContents, "window.__st.resetCounters()");
            const cfg = await exec<Record<string, unknown>>(streamer.webContents, `window.__st.webcodecs(${JSON.stringify(`${wsOrigin}/link/streamer`)}, ${JSON.stringify(codec)}, 2000000, ${snap.innerWidth})`);
            return { capture: via, encoder: cfg };
          }, async () => ({ encoder: await exec(streamer.webContents, "window.__st.counters()") }));
          // the viewer's link socket was closed by stop(); reconnect for the next road
        }
      }
    } catch (e) {
      rows.push({ road: p.road, scenario: p.scenario, source: p.source, seconds: 0, framesPerSec: 0, decodedPerSec: 0, latencyMs: summarize([]), interFrameMs: summarize([]), bytesPerSec: 0, kbitPerSec: 0, avgFrameBytes: 0, frameWidths: {}, senderCpuPct: 0, viewerCpuPct: 0, errors: [errorText(e)] });
      log(`  stream ${p.road}/${p.scenario}: ERROR ${errorText(e)}`);
    } finally {
      if (stop !== undefined) await stop().catch(() => undefined);
      if (tab !== undefined) await host.close(tab);
      if (link.viewer === undefined || link.viewer.readyState !== 1) {
        await exec(viewer.webContents, `window.__v.connect(${JSON.stringify(`${wsOrigin}/link/viewer`)})`).catch(() => undefined);
        await sleep(200);
      }
    }
  }
  viewer.destroy();
  streamer.destroy();
  return rows;
}

interface RTCSessionDescriptionInitLike { type: string; sdp?: string }
