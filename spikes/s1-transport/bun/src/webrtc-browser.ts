// S1 question 5: a WebRTC data channel from a browser to the Bun side (node-datachannel).
// Lane I builds the web companion on this (spec §8.4).
//
//   bun src/webrtc-browser.ts --browser chrome|firefox|safari [--mdns reveal|hide] [--exe <path>]
//
// Bun serves one page on 127.0.0.1 and answers its offer over HTTP (the lab's signalling). The
// page opens "ctrl" and "bulk" channels and measures: time to open, 64-byte round trips, upload
// (browser to Bun) and download throughput, and round trips while an upload runs. It posts the
// numbers back, with the ICE candidates it gathered and the pair that won, and this process
// prints them as one S1RESULT line.
//
// `--mdns reveal` (the default) turns off Chrome's and Firefox's hiding of host addresses behind
// mDNS names; `--mdns hide` leaves it on, as on a real page. Safari has no switch: it always runs
// as it ships, headed, through safaridriver (`sudo safaridriver --enable` once).
//
// Browsers start only in CI: elsewhere this exits unless S1_ALLOW_LOCAL_BROWSER=1, so a local
// run never opens a browser on someone's screen.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeDataChannel from "node-datachannel";
import { arg, emit, mbps, round, summary, withTimeout } from "./lib/report.ts";

const browser = arg("browser", "chrome")!;
const mdns = browser === "safari" ? "hide" : arg("mdns", "reveal")!;
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
  const gathered = [];
  pc.onicecandidate = (e) => {
    if (!e.candidate || !e.candidate.candidate) return;
    const f = e.candidate.candidate.split(" ");
    gathered.push({ type: f[7], address: f[4], protocol: f[2] });
  };
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
  const stats = await pc.getStats();
  let pair = null;
  stats.forEach((s) => { if (s.type === "candidate-pair" && (s.selected || s.nominated) && s.state === "succeeded") pair = { rttMs: (s.currentRoundTripTime || 0) * 1000, local: s.localCandidateId, remote: s.remoteCandidateId }; });
  const cand = (id) => { const c = id && stats.get(id); return c ? { type: c.candidateType, address: c.address || c.ip || null, protocol: c.protocol } : null; };
  if (pair) { pair.local = cand(pair.local); pair.remote = cand(pair.remote); }
  await post("/result", JSON.stringify({ ua: navigator.userAgent, openMs, rtts, upMs, downMs, under, loadMs, pair, gathered }));
}
main().catch((e) => post("/result", JSON.stringify({ error: String((e && e.stack) || e) })));
</script>`;
}

// safaridriver: one WebDriver session that opens `url`; returns how to end it.
async function openInSafari(url: string): Promise<() => Promise<void>> {
  const port = 4400 + Math.floor(Math.random() * 500);
  const driver = Bun.spawn(["safaridriver", "--port", String(port)], { stdout: "ignore", stderr: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/status`)).ok) break;
    } catch {
      /* not listening yet */
    }
    await Bun.sleep(100);
  }
  const created = (await (
    await fetch(`${base}/session`, {
      method: "POST",
      body: JSON.stringify({ capabilities: { alwaysMatch: { browserName: "safari" } } }),
    })
  ).json()) as { value?: { sessionId?: string; message?: string } };
  const id = created.value?.sessionId;
  if (!id) {
    driver.kill();
    throw new Error(`safaridriver: no session (${created.value?.message ?? "unknown error"}); run sudo safaridriver --enable`);
  }
  // Navigation returns once the page has loaded; the page then runs on its own.
  await fetch(`${base}/session/${id}/url`, { method: "POST", body: JSON.stringify({ url }) });
  return async () => {
    await fetch(`${base}/session/${id}`, { method: "DELETE" }).catch(() => undefined);
    driver.kill();
    await driver.exited;
  };
}

async function main(): Promise<void> {
  if (!process.env.CI && process.env.S1_ALLOW_LOCAL_BROWSER !== "1") {
    console.error("webrtc-browser starts a browser, so it runs only in CI (set S1_ALLOW_LOCAL_BROWSER=1 to override)");
    process.exit(3);
  }
  const exe = browser === "safari" ? "safaridriver" : findExe();
  let resolveResult: (v: Record<string, unknown>) => void = () => {};
  const result = new Promise<Record<string, unknown>>((r) => (resolveResult = r));
  const peers: unknown[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/")
        return new Response(page(), {
          headers: {
            "content-type": "text/html",
            // Cross-origin isolation lifts the browsers' clamp on performance.now() (Firefox
            // otherwise rounds to 1 ms, which hides sub-millisecond round trips).
            "cross-origin-opener-policy": "same-origin",
            "cross-origin-embedder-policy": "require-corp",
          },
        });
      if (req.method === "POST" && url.pathname === "/result") {
        const body: unknown = await req.json();
        resolveResult(body !== null && typeof body === "object" ? (body as Record<string, unknown>) : { error: `bad result: ${String(body)}` });
        return new Response("ok");
      }
      if (req.method === "POST" && url.pathname === "/offer") return new Response(await answerOffer(await req.text(), peers));
      return new Response("not found", { status: 404 });
    },
  });

  const profile = mkdtempSync(join(tmpdir(), `s1-${browser}-`));
  let close: () => Promise<void>;
  if (browser === "safari") {
    close = await openInSafari(server.url.href);
  } else {
    let argv: string[];
    if (browser === "firefox") {
      // Firefox hides host candidates behind mDNS names by default; libdatachannel can't resolve
      // them. `--mdns reveal` turns that off.
      writeFileSync(
        join(profile, "user.js"),
        [
          ...(mdns === "reveal" ? ['user_pref("media.peerconnection.ice.obfuscate_host_addresses", false);'] : []),
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
        // Chrome hides host candidates behind mDNS names by default; libdatachannel can't resolve
        // them. `--mdns reveal` turns that off.
        ...(mdns === "reveal" ? ["--disable-features=WebRtcHideLocalIpsWithMdns"] : []),
        `--user-data-dir=${profile}`,
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        server.url.href,
      ];
    }
    const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
    close = async () => {
      proc.kill();
      await proc.exited;
    };
  }
  try {
    const r = await withTimeout(result, 90_000, `${browser} result`);
    if (r.error) throw new Error(`page: ${r.error}`);
    const rtts = r.rtts as number[];
    const under = r.under as number[];
    const gathered = (r.gathered as { type: string; address: string }[] | undefined) ?? [];
    const sel = bunPc?.getSelectedCandidatePair() ?? null;
    const selectedPair = sel && {
      local: { type: sel.local.type, address: sel.local.address, transport: sel.local.transportType },
      remote: { type: sel.remote.type, address: sel.remote.address, transport: sel.remote.transportType },
    };
    emit("webrtc-browser", {
      ok: true,
      browser,
      mdns,
      ua: r.ua,
      openMs: round(r.openMs as number, 1),
      rtt64B: summary(rtts),
      uploadMBps: mbps(sizes.upMB * 1e6, r.upMs as number),
      downloadMBps: mbps(sizes.downMB * 1e6, r.downMs as number),
      rttUnderUpload: { ...summary(under), uploadMBps: mbps(sizes.loadMB * 1e6, r.loadMs as number) },
      // What the browser offered: host candidates as mDNS names, or as addresses.
      browserCandidates: {
        total: gathered.length,
        mdnsHost: gathered.filter((c) => c.type === "host" && c.address.endsWith(".local")).length,
        ipHost: gathered.filter((c) => c.type === "host" && !c.address.endsWith(".local")).length,
        other: gathered.filter((c) => c.type !== "host").map((c) => c.type),
      },
      // The pair that carried the channel, from each side: with mDNS names, the Bun side learns
      // the browser's address from its connectivity checks (a peer-reflexive candidate).
      pair: r.pair,
      bunPair: selectedPair,
      sizes,
    });
  } finally {
    await close();
    server.stop(true);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* the browser may still hold files on Windows */
    }
  }
}

let bunPc: InstanceType<typeof nodeDataChannel.PeerConnection> | null = null;

async function answerOffer(offer: string, keep: unknown[]): Promise<string> {
  const pc = new nodeDataChannel.PeerConnection("bun", { iceServers: [] });
  bunPc = pc;
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
  emit("webrtc-browser", { ok: false, browser, mdns, error: String((e as Error)?.stack ?? e) });
  process.exit(1);
}
