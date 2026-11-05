// S1 questions 2 and 5: WebRTC data channels under Bun with node-datachannel (libdatachannel),
// and inside `bun build --compile`. Two peer connections in one process over loopback.
//
//   bun src/webrtc-dc.ts [--quick]
//
// Channel "ctrl" echoes binary frames (RPCs); channel "bulk" sinks bytes and acks on ctrl.

import nodeDataChannel from "node-datachannel";
import { arg, emit, flag, mbps, now, round, sleep, summary, withTimeout } from "./lib/report.ts";

const quick = flag("quick");
const sizes = {
  rpc: Number(arg("rpc", quick ? "200" : "2000")),
  bulkMB: Number(arg("bulk-mb", quick ? "8" : "64")),
  loadMB: Number(arg("load-mb", quick ? "8" : "32")),
  chunk: Number(arg("chunk", String(64 * 1024))),
};
const HIGH = 4 * 1024 * 1024; // keep at most this much queued in the SCTP send buffer
type DC = ReturnType<InstanceType<typeof nodeDataChannel.PeerConnection>["createDataChannel"]>;

function toBuf(m: string | Buffer | ArrayBuffer): Buffer {
  if (typeof m === "string") return Buffer.from(m);
  return Buffer.isBuffer(m) ? m : Buffer.from(m);
}

async function connectPair() {
  const a = new nodeDataChannel.PeerConnection("a", { iceServers: [] });
  const b = new nodeDataChannel.PeerConnection("b", { iceServers: [] });
  a.onLocalDescription((sdp, type) => b.setRemoteDescription(sdp, type));
  b.onLocalDescription((sdp, type) => a.setRemoteDescription(sdp, type));
  a.onLocalCandidate((c, mid) => b.addRemoteCandidate(c, mid));
  b.onLocalCandidate((c, mid) => a.addRemoteCandidate(c, mid));
  const remote = new Map<string, DC>();
  const remoteReady = new Promise<void>((resolve) => {
    b.onDataChannel((dc) => {
      remote.set(dc.getLabel(), dc as DC);
      if (remote.size === 2) resolve();
    });
  });
  const t = now();
  const ctrl = a.createDataChannel("ctrl");
  const bulk = a.createDataChannel("bulk");
  await withTimeout(new Promise<void>((r) => ctrl.onOpen(() => r())), 10_000, "ctrl open");
  const openMs = now() - t;
  await withTimeout(new Promise<void>((r) => (bulk.isOpen() ? r() : bulk.onOpen(() => r()))), 10_000, "bulk open");
  await remoteReady;
  return { a, b, ctrl: ctrl as DC, bulk: bulk as DC, rctrl: remote.get("ctrl")!, rbulk: remote.get("bulk")!, openMs };
}

async function main(): Promise<void> {
  const { a, b, ctrl, bulk, rctrl, rbulk, openMs } = await connectPair();

  // Remote side: echo binary on ctrl; count bulk bytes and ack each completed transfer on ctrl.
  let expect = 0;
  let got = 0;
  rctrl.onMessage((m) => {
    if (typeof m === "string") {
      expect = Number(m);
      got = 0;
    } else rctrl.sendMessageBinary(toBuf(m));
  });
  rbulk.onMessage((m) => {
    got += toBuf(m).length;
    if (expect > 0 && got >= expect) {
      rctrl.sendMessage(`ack:${got}`);
      expect = 0;
    }
  });

  // Local side: binary replies answer the pending ping; "ack:" texts answer the pending send.
  let pingResolve: (() => void) | null = null;
  let ackResolve: (() => void) | null = null;
  ctrl.onMessage((m) => {
    if (typeof m === "string") {
      if (m.startsWith("ack:")) {
        const r = ackResolve;
        ackResolve = null;
        r?.();
      }
    } else {
      const r = pingResolve;
      pingResolve = null;
      r?.();
    }
  });
  const frame = Buffer.alloc(64, 7);
  const ping = async (): Promise<number> => {
    const t = now();
    const p = new Promise<void>((r) => (pingResolve = r));
    ctrl.sendMessageBinary(frame);
    await p;
    return now() - t;
  };

  const rtts: number[] = [];
  for (let i = 0; i < sizes.rpc; i++) rtts.push(await ping());

  // Bulk with backpressure (bufferedAmount), as any real sender must.
  let lowResolve: (() => void) | null = null;
  bulk.setBufferedAmountLowThreshold(HIGH / 4);
  bulk.onBufferedAmountLow(() => {
    const r = lowResolve;
    lowResolve = null;
    r?.();
  });
  async function send(bytes: number): Promise<number> {
    const chunk = Buffer.alloc(sizes.chunk, 1);
    const ack = new Promise<void>((r) => (ackResolve = r));
    ctrl.sendMessage(String(bytes));
    const t = now();
    let sent = 0;
    while (sent < bytes) {
      if (bulk.bufferedAmount() > HIGH) await new Promise<void>((r) => (lowResolve = r));
      const n = Math.min(sizes.chunk, bytes - sent);
      bulk.sendMessageBinary(n === sizes.chunk ? chunk : chunk.subarray(0, n));
      sent += n;
    }
    await ack;
    return now() - t;
  }

  const gaps: number[] = [];
  let last = now();
  const timer = setInterval(() => {
    const t = now();
    gaps.push(t - last);
    last = t;
  }, 10);
  const bulkMs = await send(sizes.bulkMB * 1e6);
  clearInterval(timer);

  // Delay on ctrl while bulk runs. SCTP has no stream priorities in libdatachannel.
  let done = false;
  const loaded = send(sizes.loadMB * 1e6).then((ms) => {
    done = true;
    return ms;
  });
  const under: number[] = [];
  await sleep(20);
  while (!done) {
    under.push(await ping());
    await sleep(5);
  }
  const loadMs = await loaded;

  emit("webrtc-node-datachannel", {
    ok: true,
    mode: "two peer connections in one process, loopback host candidates",
    lib: "node-datachannel 0.33.6 (libdatachannel)",
    openMs: round(openMs, 1),
    rtt64B: summary(rtts),
    bulk: {
      mb: sizes.bulkMB,
      ms: round(bulkMs, 1),
      MBps: mbps(sizes.bulkMB * 1e6, bulkMs),
      timer10ms: { expected: Math.floor(bulkMs / 10), fired: gaps.length, maxGapMs: round(Math.max(0, ...gaps), 1) },
    },
    rttUnderLoad: { ...summary(under), bulkMBps: mbps(sizes.loadMB * 1e6, loadMs) },
    selectedPair: a.getSelectedCandidatePair(),
  });
  ctrl.close();
  bulk.close();
  a.close();
  b.close();
}

try {
  await main();
  nodeDataChannel.cleanup();
  process.exit(0);
} catch (e) {
  emit("webrtc-node-datachannel", { ok: false, error: String((e as Error)?.stack ?? e) });
  process.exit(1);
}
