// S1 question 5: a WebRTC data channel from a headless browser to the Bun side (node-datachannel).
// Lane I builds the web companion on this (spec §8.4).
//
//   bun src/webrtc-browser.ts --browser chrome|firefox [--exe <path>]
//
// Bun serves one page on 127.0.0.1 and answers its offer over HTTP (the lab's signalling). The
// page opens "ctrl" and "bulk" channels and measures: time to open, 64-byte round trips, upload
// (browser to Bun) and download throughput, and round trips while an upload runs. It posts the
// numbers back, and this process prints them as one S1RESULT line.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeDataChannel from "node-datachannel";
import { arg, emit, mbps, round, summary, withTimeout } from "./lib/report.ts";

const browser = arg("browser", "chrome")!;
const sizes = {
  rpc: Number(arg("rpc", "500")),
  upMB: Number(arg("up-mb", "32")),
  downMB: Number(arg("down-mb", "32")),
  loadMB: Number(arg("load-mb", "16")),
};
const HIGH = 4 * 1024 * 1024;

function findExe(): string {
  const given = arg("exe");
  if (given) return given;
  const candidates: Record<string, string[]> = {
    chrome: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
    firefox: [
      "/Applications/Firefox.app/Contents/MacOS/firefox",
      "/usr/bin/firefox",
      "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
    ],
  };
  const hit = (candidates[browser] ?? []).find((p) => existsSync(p));
  if (!hit) throw new Error(`no ${browser} executable found; pass --exe`);
  return hit;
}

// libdatachannel's local description may arrive before its candidates; put them in the SDP so a
// single offer/answer round trip carries everything (no trickle in this lab signalling).
function withCandidates(sdp: string, candidates: string[]): string {
  if (sdp.includes("a=candidate:") || candidates.length === 0) return sdp;
  const lines = sdp.trimEnd().split(/\r?\n/);
  const out: string[] = [];
  let inMedia = false;
  const flush = () => {
    for (const c of candidates) out.push(c.startsWith("a=") ? c : `a=${c}`);
    out.push("a=end-of-candidates");
  };
  for (const l of lines) {
    if (l.startsWith("m=")) {
      if (inMedia) flush();
      inMedia = true;
    }
    out.push(l);
  }
  if (inMedia) flush();
  return out.join("\r\n") + "\r\n";
}

function page(): string {
  return `<!doctype html><meta charset="utf-8"><title>S1 WebRTC</title><script>
const SIZES = ${JSON.stringify(sizes)};
const HIGH = ${HIGH};
const post = (path, body) => fetch(path, { method: "POST", body });
async function main() {
  const t0 = performance.now();
  const pc = new RTCPeerConnection({ iceServers: [] });
  const ctrl = pc.createDataChannel("ctrl");
  const bulk = pc.createDataChannel("bulk");
  ctrl.binaryType = "arraybuffer";
  bulk.binaryType = "arraybuffer";
  const opened = Promise.all([ctrl, bulk].map((dc) => new Promise((r) => (dc.onopen = r))));
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => {
    if (pc.iceGatheringState === "complete") return r();
    pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && r();
    setTimeout(r, 3000);
  });
  const answer = await (await post("/offer", pc.localDescription.sdp)).text();
  await pc.setRemoteDescription({ type: "answer", sdp: answer });
  await opened;
  const openMs = performance.now() - t0;

  let pingResolve = null, textResolve = null;
  ctrl.onmessage = (e) => {
    if (typeof e.data === "string") { const r = textResolve; textResolve = null; r && r(JSON.parse(e.data)); }
    else { const r = pingResolve; pingResolve = null; r && r(); }
  };
  const frame = new Uint8Array(64);
  const ping = async () => { const t = performance.now(); const p = new Promise((r) => (pingResolve = r)); ctrl.send(frame); await p; return performance.now() - t; };
  const rtts = [];
  for (let i = 0; i < SIZES.rpc; i++) rtts.push(await ping());

  bulk.bufferedAmountLowThreshold = HIGH / 4;
  const chunk = new Uint8Array(64 * 1024);
  async function upload(bytes) {
    const ack = new Promise((r) => (textResolve = r));
    ctrl.send(JSON.stringify({ op: "sink", bytes }));
    const t = performance.now();
    let sent = 0;
    while (sent < bytes) {
      if (bulk.bufferedAmount > HIGH) await new Promise((r) => (bulk.onbufferedamountlow = r));
      const n = Math.min(chunk.length, bytes - sent);
      bulk.send(n === chunk.length ? chunk : chunk.subarray(0, n));
      sent += n;
    }
    await ack;
    return performance.now() - t;
  }
  async function download(bytes) {
    let got = 0;
    const t = performance.now();
    const done = new Promise((r) => (bulk.onmessage = (e) => { got += e.data.byteLength; if (got >= bytes) r(); }));
    ctrl.send(JSON.stringify({ op: "source", bytes }));
    await done;
    bulk.onmessage = null;
    return performance.now() - t;
  }
  const upMs = await upload(SIZES.upMB * 1e6);
  const downMs = await download(SIZES.downMB * 1e6);
  let finished = false;
  const loaded = upload(SIZES.loadMB * 1e6).then((ms) => { finished = true; return ms; });
  const under = [];
  while (!finished) { under.push(await ping()); await new Promise((r) => setTimeout(r, 5)); }
  const loadMs = await loaded;
  let pair = null;
  (await pc.getStats()).forEach((s) => { if (s.type === "candidate-pair" && (s.selected || s.nominated) && s.state === "succeeded") pair = { rttMs: (s.currentRoundTripTime || 0) * 1000, local: s.localCandidateId, remote: s.remoteCandidateId }; });
  await post("/result", JSON.stringify({ ua: navigator.userAgent, openMs, rtts, upMs, downMs, under, loadMs, pair }));
}
main().catch((e) => post("/result", JSON.stringify({ error: String((e && e.stack) || e) })));
</script>`;
}

async function main(): Promise<void> {
  const exe = findExe();
  let resolveResult: (v: Record<string, unknown>) => void = () => {};
  const result = new Promise<Record<string, unknown>>((r) => (resolveResult = r));
  const peers: unknown[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/") return new Response(page(), { headers: { "content-type": "text/html" } });
      if (req.method === "POST" && url.pathname === "/result") {
        resolveResult(await req.json());
        return new Response("ok");
      }
      if (req.method === "POST" && url.pathname === "/offer") return new Response(await answerOffer(await req.text(), peers));
      return new Response("not found", { status: 404 });
    },
  });

  const profile = mkdtempSync(join(tmpdir(), `s1-${browser}-`));
  let argv: string[];
  if (browser === "firefox") {
    // Firefox hides host candidates behind mDNS names by default; libdatachannel can't resolve them.
    writeFileSync(
      join(profile, "user.js"),
      [
        'user_pref("media.peerconnection.ice.obfuscate_host_addresses", false);',
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
        'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
      ].join("\n"),
    );
    argv = [exe, "--headless", "--no-remote", "--profile", profile, server.url.href];
  } else {
    argv = [
      exe,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      // Chrome hides host candidates behind mDNS names by default; libdatachannel can't resolve them.
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      `--user-data-dir=${profile}`,
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      server.url.href,
    ];
  }
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
  try {
    const r = await withTimeout(result, 90_000, `${browser} result`);
    if (r.error) throw new Error(`page: ${r.error}`);
    const rtts = r.rtts as number[];
    const under = r.under as number[];
    emit("webrtc-browser", {
      ok: true,
      browser,
      ua: r.ua,
      openMs: round(r.openMs as number, 1),
      rtt64B: summary(rtts),
      uploadMBps: mbps(sizes.upMB * 1e6, r.upMs as number),
      downloadMBps: mbps(sizes.downMB * 1e6, r.downMs as number),
      rttUnderUpload: { ...summary(under), uploadMBps: mbps(sizes.loadMB * 1e6, r.loadMs as number) },
      pair: r.pair,
      sizes,
    });
  } finally {
    proc.kill();
    await proc.exited;
    server.stop(true);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* the browser may still hold files on Windows */
    }
  }
}

async function answerOffer(offer: string, keep: unknown[]): Promise<string> {
  const pc = new nodeDataChannel.PeerConnection("bun", { iceServers: [] });
  keep.push(pc);
  const candidates: string[] = [];
  pc.onLocalCandidate((c) => candidates.push(c));
  pc.onDataChannel((dc) => {
    keep.push(dc);
    const label = dc.getLabel();
    if (label === "ctrl") ctrlChannels.ctrl = dc;
    if (label === "bulk") ctrlChannels.bulk = dc;
    wire();
  });
  const gathered = new Promise<void>((r) => pc.onGatheringStateChange((s) => s === "complete" && r()));
  pc.setRemoteDescription(offer, "offer");
  await withTimeout(gathered, 10_000, "ICE gathering");
  const local = pc.localDescription();
  if (!local) throw new Error("no local description");
  return withCandidates(local.sdp, candidates);
}

type Channel = ReturnType<InstanceType<typeof nodeDataChannel.PeerConnection>["createDataChannel"]>;
const ctrlChannels: { ctrl?: Channel; bulk?: Channel } = {};
let wired = false;

function wire(): void {
  const { ctrl, bulk } = ctrlChannels;
  if (!ctrl || !bulk || wired) return;
  wired = true;
  let expect = 0;
  let got = 0;
  bulk.onMessage((m) => {
    got += typeof m === "string" ? m.length : (m as ArrayBuffer).byteLength;
    if (expect > 0 && got >= expect) {
      ctrl.sendMessage(JSON.stringify({ op: "ack", bytes: got }));
      expect = 0;
    }
  });
  ctrl.onMessage((m) => {
    if (typeof m !== "string") {
      ctrl.sendMessageBinary(Buffer.isBuffer(m) ? m : Buffer.from(m as ArrayBuffer));
      return;
    }
    const msg = JSON.parse(m) as { op: string; bytes: number };
    if (msg.op === "sink") {
      expect = msg.bytes;
      got = 0;
    } else if (msg.op === "source") void source(bulk, msg.bytes);
  });
}

async function source(bulk: Channel, bytes: number): Promise<void> {
  const chunk = Buffer.alloc(64 * 1024, 2);
  let lowResolve: (() => void) | null = null;
  bulk.setBufferedAmountLowThreshold(HIGH / 4);
  bulk.onBufferedAmountLow(() => {
    const r = lowResolve;
    lowResolve = null;
    r?.();
  });
  let sent = 0;
  while (sent < bytes) {
    if (bulk.bufferedAmount() > HIGH) await new Promise<void>((r) => (lowResolve = r));
    const n = Math.min(chunk.length, bytes - sent);
    bulk.sendMessageBinary(n === chunk.length ? chunk : chunk.subarray(0, n));
    sent += n;
  }
}

try {
  await main();
  nodeDataChannel.cleanup();
  process.exit(0);
} catch (e) {
  emit("webrtc-browser", { ok: false, browser, error: String((e as Error)?.stack ?? e) });
  process.exit(1);
}
