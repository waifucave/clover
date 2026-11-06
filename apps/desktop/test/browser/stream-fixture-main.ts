// The streamed view's CI fixture (spec §12.1 "From another device"): an Electron main process that streams a bot's
// offscreen tab the way the daemon will ask (`app.tab.command` `stream`/`stream-control`), takes the chunks the host
// hands `streamData`, and decodes them in a viewer page with WebCodecs' `VideoDecoder`, as the other device would.
// `../browser-stream.test.ts` builds and runs it (CI only) and asserts on the JSON it writes. Each step records
// ok/detail and never throws past itself.
import { app, BrowserWindow, webContents } from "electron";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createBrowserHost, isBrowserContents, isBrowserTab, PERSON_POLICY, type BrowserHost, type TabView } from "../../src/main/browser/index";
import type { AppTabEvent, StreamChunk } from "../../src/main/browser/contract";

const out = process.env.CLOVER_BROWSER_TEST_OUT ?? "";
const viewportAssets = { preload: process.env.CLOVER_BROWSER_TEST_PRELOAD ?? "", html: process.env.CLOVER_BROWSER_TEST_HTML ?? "" };
const streamAssets = { preload: process.env.CLOVER_STREAM_TEST_PRELOAD ?? "", html: process.env.CLOVER_STREAM_TEST_HTML ?? "" };
const viewerHtml = process.env.CLOVER_STREAM_TEST_VIEWER ?? "";

/** A red block that stays (the colour the viewer checks), on white, and below it eight bands of colour gradients
 *  that change every frame: the encoder spends about its whole target on them (2.8 Mbit/s at 2.5 in the headless
 *  shell's VP8), and at 300 kbit/s it gets down to about 0.5. (Random tiles or text can't: VP8 at its coarsest still
 *  needs 1.5 to 4 Mbit/s for them, so every target looks the same.) */
const ANIM = `<!doctype html><html><head><meta charset="utf-8"><title>Stream fixture</title>
<style>html,body{margin:0;background:#fff;overflow:hidden} #red{position:fixed;left:100px;top:100px;width:300px;height:300px;background:#d02020}
#c{position:fixed;left:0;top:460px} #n{position:fixed;left:600px;top:120px;font:40px monospace}</style></head>
<body><div id="red"></div><canvas id="c" width="1280" height="336"></canvas><div id="n">0</div><script>
  let i = 0; const n = document.getElementById("n"), ctx = document.getElementById("c").getContext("2d");
  (function f(){
    i++; n.textContent = String(i);
    for (let b = 0; b < 8; b++) {
      const g = ctx.createLinearGradient(0, 0, 1280, 0);
      g.addColorStop(0, "hsl(" + ((i * 5 + b * 40) % 360) + ",80%,50%)");
      g.addColorStop(1, "hsl(" + ((i * 7 + b * 90) % 360) + ",80%,50%)");
      ctx.fillStyle = g; ctx.fillRect(0, b * 42, 1280, 42);
    }
    requestAnimationFrame(f);
  })();
</script></body></html>`;
const STILL = `<!doctype html><html><head><meta charset="utf-8"><title>Still fixture</title>
<style>html,body{margin:0;background:#fff} #g{position:fixed;left:200px;top:200px;width:200px;height:200px;background:#20b040}</style></head>
<body><div id="g"></div></body></html>`;

interface Step { name: string; ok: boolean; detail: unknown; ms: number }
const steps: Step[] = [];
const summary: Record<string, unknown> = { platform: `${process.platform}-${process.arch}`, electron: process.versions.electron };
const got = new Map<string, { at: number; chunk: StreamChunk }[]>();

async function step(name: string, f: () => Promise<{ ok: boolean; detail?: unknown }>): Promise<void> {
  const t0 = Date.now();
  try {
    const r = await Promise.race([f(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out after 60 s")), 60_000))]);
    steps.push({ name, ok: r.ok, detail: r.detail ?? null, ms: Date.now() - t0 });
  } catch (e) {
    steps.push({ name, ok: false, detail: `error: ${e instanceof Error ? e.message : String(e)}`, ms: Date.now() - t0 });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | undefined | false | Promise<T | undefined | false>, ms = 10_000): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v !== undefined && v !== false) return v;
    await sleep(50);
  }
  return undefined;
}

const chunks = (stream: string) => got.get(stream) ?? [];
const frames = (stream: string) => chunks(stream).filter((c) => c.chunk.kind === "frame") as { at: number; chunk: Extract<StreamChunk, { kind: "frame" }> }[];
const configOf = (stream: string) => chunks(stream).map((c) => c.chunk).find((c) => c.kind === "config") as Extract<StreamChunk, { kind: "config" }> | undefined;
const endedOf = (stream: string) => chunks(stream).map((c) => c.chunk).find((c) => c.kind === "ended") as Extract<StreamChunk, { kind: "ended" }> | undefined;
const kinds = (stream: string) => chunks(stream).map((c) => (c.chunk.kind === "frame" ? (c.chunk.key ? "key" : "delta") : c.chunk.kind));

function tabContents(path: string): Electron.WebContents | undefined {
  return webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && isBrowserTab(wc) && wc.getURL().includes(path));
}
function encoderPages(): Electron.WebContents[] {
  return webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.getURL().endsWith("browser-stream.html"));
}
function visibleWindows(): number {
  return BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length;
}
/** kbit/s of a stream's frames that arrived in [from, to). */
function kbpsBetween(stream: string, from: number, to: number): number {
  const bytes = frames(stream).filter((f) => f.at >= from && f.at < to).reduce((n, f) => n + f.chunk.data.byteLength, 0);
  return Math.round((bytes * 8) / (to - from));
}

/** Decodes a stream's chunks from its first config and keyframe in the viewer page; the last picture's colours at
 *  the given points, its size, and how many pictures came out. */
async function decode(viewer: BrowserWindow, stream: string, points: [number, number][], max = 45): Promise<{ decoded: number; width: number; height: number; colours: number[][]; error?: string }> {
  const cfg = configOf(stream);
  if (cfg === undefined) throw new Error("no config");
  const all = frames(stream);
  const first = all.findIndex((f) => f.chunk.key);
  if (first < 0) throw new Error("no keyframe");
  const run = all.slice(first, first + max).map((f) => ({ key: f.chunk.key, ts: f.chunk.timestamp, b64: Buffer.from(f.chunk.data).toString("base64") }));
  return viewer.webContents.executeJavaScript(`window.decodeRun(${JSON.stringify(cfg)}, ${JSON.stringify(run)}, ${JSON.stringify(points)})`);
}

const near = (c: number[] | undefined, want: [number, number, number], tol: number) => c !== undefined && want.every((v, i) => Math.abs((c[i] ?? -999) - v) <= tol);

async function main(): Promise<void> {
  const created: { id: number; contents: boolean }[] = [];
  app.on("web-contents-created", (_e, wc) => { created.push({ id: wc.id, contents: isBrowserContents(wc) }); });
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url?.startsWith("/still") ? STILL : ANIM);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const reports: AppTabEvent[] = [];
  const opts = {
    computer: "ci",
    report: (events: AppTabEvent[]) => { reports.push(...events); },
    assets: viewportAssets,
    streamAssets,
    streamData: (stream: string, chunk: StreamChunk) => {
      const list = got.get(stream) ?? [];
      list.push({ at: Date.now(), chunk });
      got.set(stream, list);
    },
    // The fixture's pages are on loopback, which a bot's tab may not reach (R13): this lets the bot reach them.
    network: { policyFor: () => PERSON_POLICY },
  };
  const host: BrowserHost = createBrowserHost({ ...opts, screenReader: { override: false } });
  await host.start();
  // The other device's viewer: a page that is never shown, decoding with WebCodecs (a file: page, a secure context).
  const viewer = new BrowserWindow({ show: false, webPreferences: { partition: "clover-stream-test-viewer", sandbox: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } });
  await viewer.loadFile(viewerHtml);
  const bot = { kind: "bot" as const, bot: "alpha" };
  let tab!: TabView;
  // Recorded, not asserted: which encoders this runner says it has, with a hardware encoder required.
  summary.encoders = await viewer.webContents.executeJavaScript(`(async () => {
    const out = {};
    for (const codec of ["avc1.42E01F", "avc1.42E020", "avc1.42E028", "avc1.4D0028", "avc1.640028", "vp8", "vp09.00.10.08", "av01.0.04M.08"]) {
      for (const hw of ["prefer-hardware", "no-preference"]) {
        const cfg = { codec, width: 1280, height: 720, bitrate: 2500000, framerate: 30, latencyMode: "realtime", hardwareAcceleration: hw };
        if (codec.startsWith("avc1")) cfg.avc = { format: "annexb" };
        try { out[codec + " " + hw] = (await VideoEncoder.isConfigSupported(cfg)).supported; } catch (e) { out[codec + " " + hw] = String(e); }
      }
    }
    return out;
  })()`);

  await step("a bot's tab on an animating page opens offscreen at 10 fps, with no window on screen", async () => {
    tab = await host.open({ id: "tab_anim", owner: bot, url: `${origin}/anim`, place: "headless" });
    const wc = await until(() => tabContents("/anim"));
    await until(() => wc !== undefined && !wc.isLoading());
    return { ok: wc?.getFrameRate() === 10 && visibleWindows() === 0, detail: { fps: wc?.getFrameRate(), visible: visibleWindows() } };
  });

  await step("a stream starts with a config, then a keyframe, then deltas at a sensible rate; the tab paints at 30 fps", async () => {
    await host.command(tab.id, { kind: "stream", stream: "s1", on: true });
    const k = await until(() => frames("s1").length >= 3 && frames("s1"), 20_000);
    const firstFrameAt = frames("s1")[0]?.at ?? Date.now();
    await sleep(3000);
    const window = frames("s1").filter((f) => f.at >= firstFrameAt + 1000 && f.at < firstFrameAt + 3000);
    const fps = window.length / 2;
    const order = kinds("s1").slice(0, 3);
    const cfg = configOf("s1");
    const stats = host.streams().find((s) => s.stream === "s1");
    summary.default = { codec: cfg?.codec, codecString: cfg?.codecString, hardware: stats?.hardware, size: `${cfg?.width}x${cfg?.height}`, fps, kbps: kbpsBetween("s1", firstFrameAt + 1000, firstFrameAt + 3000) };
    const tabFps = tabContents("/anim")?.getFrameRate();
    // The default pick: hardware H.264 where there is one, else VP8, never software H.264.
    const pickOk = cfg !== undefined && ((cfg.codec === "h264" && stats?.hardware === true) || cfg.codec === "vp8");
    return {
      ok: k !== undefined && order[0] === "config" && order[1] === "key" && order[2] === "delta" && fps >= 5 && tabFps === 30 && pickOk && cfg?.width === 1280 && cfg?.height === 800,
      detail: { order, fps, tabFps, summary: summary.default, frames: frames("s1").length },
    };
  });

  await step("the encoder page is the browser's own, never shown, and no window came on screen", async () => {
    const pages = encoderPages();
    const page = pages[0];
    const atCreation = page !== undefined ? created.find((c) => c.id === page.id) : undefined;
    return {
      ok: pages.length === 1 && atCreation?.contents === true && page !== undefined && isBrowserContents(page) && visibleWindows() === 0,
      detail: { pages: pages.length, atCreation, visible: visibleWindows() },
    };
  });

  await step("the viewer decodes the stream with VideoDecoder, and a decoded picture has the page's red block and white page", async () => {
    const r = await decode(viewer, "s1", [[250, 250], [1100, 60], [150, 380]]);
    const ok = r.error === undefined && r.decoded >= 10 && r.width === 1280 && r.height === 800
      && near(r.colours[0], [208, 32, 32], 48) && near(r.colours[1], [255, 255, 255], 30) && near(r.colours[2], [208, 32, 32], 48);
    return { ok, detail: r };
  });

  await step("stream-control lowers the bitrate, and the stream follows", async () => {
    const t0 = Date.now();
    await sleep(3000);
    const before = kbpsBetween("s1", t0, Date.now());
    await host.command(tab.id, { kind: "stream-control", stream: "s1", kbps: 300 });
    await sleep(1000);
    const t1 = Date.now();
    await sleep(3000);
    const after = kbpsBetween("s1", t1, Date.now());
    const stats = host.streams().find((s) => s.stream === "s1");
    summary.bitrate = { before, after, target: 300 };
    return { ok: stats?.kbps === 300 && stats.encoderKbps === 300 && after < before * 0.6, detail: { before, after, stats } };
  });

  await step("stopping sends `ended`, lets the encoder page go and puts the tab back at 10 fps", async () => {
    await host.command(tab.id, { kind: "stream", stream: "s1", on: false });
    const ended = endedOf("s1");
    const gone = await until(() => encoderPages().length === 0, 5000);
    const fps = tabContents("/anim")?.getFrameRate();
    return { ok: ended?.reason === "stopped" && gone === true && fps === 10 && host.streams().length === 0, detail: { ended, pages: encoderPages().length, fps } };
  });

  let still!: TabView;
  await step("a still page streams a config and a keyframe, then nothing, until a keyframe is asked for", async () => {
    still = await host.open({ id: "tab_still", owner: bot, url: `${origin}/still`, place: "resting" });
    await until(() => { const wc = tabContents("/still"); return wc !== undefined && !wc.isLoading(); });
    await host.command(still.id, { kind: "stream", stream: "s2", on: true, maxKbps: 1000 });
    await until(() => frames("s2").some((f) => f.chunk.key), 20_000);
    await sleep(1500);
    const keysBefore = frames("s2").filter((f) => f.chunk.key).length;
    const restingFps = tabContents("/still")?.getFrameRate();
    await host.command(still.id, { kind: "stream-control", stream: "s2", keyframe: true });
    const more = await until(() => frames("s2").filter((f) => f.chunk.key).length > keysBefore, 5000);
    const r = await decode(viewer, "s2", [[300, 300], [50, 50]]);
    return {
      ok: more === true && restingFps === 30 && near(r.colours[0], [32, 176, 64], 48) && near(r.colours[1], [255, 255, 255], 30),
      detail: { keysBefore, keysAfter: frames("s2").filter((f) => f.chunk.key).length, frames: frames("s2").length, restingFps, decoded: r },
    };
  });

  await step("stopping a resting tab's stream stops its painting again", async () => {
    await host.command(still.id, { kind: "stream", stream: "s2", on: false });
    const wc = tabContents("/still");
    return { ok: endedOf("s2")?.reason === "stopped" && wc !== undefined && !wc.isPainting(), detail: { painting: wc?.isPainting() } };
  });

  await step("a receiver that decodes only VP8 gets VP8", async () => {
    await host.command(tab.id, { kind: "stream", stream: "s3", on: true, codecs: ["vp8"] });
    await until(() => frames("s3").length >= 5, 20_000);
    const cfg = configOf("s3");
    const r = await decode(viewer, "s3", [[250, 250]]);
    await host.command(tab.id, { kind: "stream", stream: "s3", on: false });
    summary.vp8 = { codecString: cfg?.codecString };
    return { ok: cfg?.codec === "vp8" && near(r.colours[0], [208, 32, 32], 48), detail: { cfg, decoded: r.decoded } };
  });

  await step("a receiver that decodes only H.264 gets H.264, hardware where there is one, else the software encoder", async () => {
    await host.command(tab.id, { kind: "stream", stream: "s4", on: true, codecs: ["h264"] });
    await until(() => frames("s4").length >= 5 || endedOf("s4") !== undefined, 20_000);
    const cfg = configOf("s4");
    const stats = host.streams().find((s) => s.stream === "s4");
    summary.h264 = { codecString: cfg?.codecString, hardware: stats?.hardware, ended: endedOf("s4") };
    const r = cfg !== undefined ? await decode(viewer, "s4", [[250, 250]]) : undefined;
    await host.command(tab.id, { kind: "stream", stream: "s4", on: false }).catch(() => undefined);
    return { ok: cfg?.codec === "h264" && cfg.codecString.startsWith("avc1.42E0") && near(r?.colours[0], [208, 32, 32], 48), detail: { cfg, hardware: stats?.hardware, decoded: r?.decoded } };
  });

  await step("a receiver that decodes no video gets JPEG pictures, each a keyframe", async () => {
    await host.command(tab.id, { kind: "stream", stream: "s5", on: true, codecs: ["jpeg"], maxKbps: 4000 });
    await until(() => frames("s5").length >= 3, 15_000);
    const cfg = configOf("s5");
    const all = frames("s5");
    const jpeg = all.every((f) => f.chunk.key && f.chunk.data[0] === 0xff && f.chunk.data[1] === 0xd8);
    await host.command(tab.id, { kind: "stream", stream: "s5", on: false });
    return { ok: cfg?.codec === "jpeg" && all.length >= 3 && jpeg && encoderPages().length === 0, detail: { cfg, frames: all.length, pages: encoderPages().length } };
  });

  await step("a tab that closes while it streams ends its stream (`closed`)", async () => {
    await host.command(tab.id, { kind: "stream", stream: "s6", on: true });
    await until(() => frames("s6").length >= 2, 20_000);
    await host.command(tab.id, { kind: "close" });
    const ended = await until(() => endedOf("s6"), 5000);
    const gone = await until(() => encoderPages().length === 0, 5000);
    return { ok: ended?.reason === "closed" && gone === true && host.streams().length === 0, detail: { ended, pages: encoderPages().length } };
  });

  await step("nothing put a window on screen", async () => ({ ok: visibleWindows() === 0, detail: { visible: visibleWindows() } }));

  // The screen-reader hybrid: a real view in the hidden host window streams through its frame subscription.
  const hostHybrid = createBrowserHost({ ...opts, screenReader: { override: true } });
  await hostHybrid.start();
  await step("a screen-reader host tab streams too (its frames by subscription)", async () => {
    const t = await hostHybrid.open({ id: "tab_host", owner: bot, url: `${origin}/anim`, place: "headless" });
    await sleep(1500);
    await hostHybrid.command(t.id, { kind: "stream", stream: "s7", on: true });
    await until(() => frames("s7").length >= 5, 20_000);
    const cfg = configOf("s7");
    const r = cfg !== undefined ? await decode(viewer, "s7", [[250, 250]]) : undefined;
    await hostHybrid.command(t.id, { kind: "stream", stream: "s7", on: false });
    summary.hostTab = { codec: cfg?.codec, size: `${cfg?.width}x${cfg?.height}`, frames: frames("s7").length };
    // The host tab's picture may be at the display's scale: its red block is at (250, 250) times that.
    const scale = cfg !== undefined ? cfg.width / 1280 : 1;
    const r2 = cfg !== undefined ? await decode(viewer, "s7", [[Math.round(250 * scale), Math.round(250 * scale)]]) : undefined;
    return { ok: kinds("s7")[0] === "config" && kinds("s7")[1] === "key" && (near(r?.colours[0], [208, 32, 32], 48) || near(r2?.colours[0], [208, 32, 32], 48)), detail: { kinds: kinds("s7").slice(0, 4), cfg, r, r2 } };
  });
  hostHybrid.shutdown();

  host.shutdown();
  viewer.destroy();
  server.close();
}

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.whenReady().then(async () => {
  let fatal: string | undefined;
  try {
    await main();
  } catch (e) {
    fatal = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
  }
  writeFileSync(out, JSON.stringify({ platform: summary.platform, electron: process.versions.electron, steps, summary, fatal }, null, 2));
  app.exit(0);
});
app.on("window-all-closed", () => undefined);
