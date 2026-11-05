// S1 questions 2 and 4 for iroh through its official napi binding, @number0/iroh 1.2.0
// (iroh 1.4.1, noq 1.4.0), under Bun and inside `bun build --compile`.
//
//   bun src/iroh-napi.ts                    two endpoints in one process, over loopback, relay off
//   bun src/iroh-napi.ts --quick            the same with small sizes (the compile smoke test)
//   bun src/iroh-napi.ts --serve --ticket-file t.txt [--bind 0.0.0.0:47000]
//   bun src/iroh-napi.ts --dial-ticket-file t.txt   the client half, across network namespaces
//
// The bench protocol is the same one native/link-sidecar speaks (see its README): the first byte
// of every bidirectional stream picks the handler — E echoes 64-byte frames, R answers one RPC,
// S sinks a bulk transfer and acks its byte count.

import { readFileSync, writeFileSync } from "node:fs";
import { arg, emit, flag, mbps, now, round, sleep, summary, withTimeout } from "./lib/report.ts";

const tLoad0 = now();
const iroh = await import("@number0/iroh");
const loadMs = now() - tLoad0;

const ALPN = Array.from(new TextEncoder().encode("clover/s1/bench/1"));
const FRAME = 64;
const quick = flag("quick");
const sizes = {
  rpc: Number(arg("rpc", quick ? "200" : "2000")),
  rpcStreams: Number(arg("rpc-streams", quick ? "50" : "300")),
  bulkMB: Number(arg("bulk-mb", quick ? "8" : "64")),
  shots: Number(arg("shots", quick ? "5" : "20")),
  loadMB: Number(arg("load-mb", quick ? "8" : "64")),
  chunk: Number(arg("chunk", String(64 * 1024))),
  loadGapMs: Number(arg("load-gap-ms", "5")),
  yieldEvery: Number(arg("yield-every", "0")),
};

type Conn = InstanceType<typeof iroh.Connection>;
type Ep = InstanceType<typeof iroh.Endpoint>;
const keepAlive: unknown[] = []; // FFI objects must outlive their last use (Winter's IrohSpikeTests finding)

async function bindEndpoint(bindAddr: string, alpns?: number[][]): Promise<Ep> {
  const b = iroh.Endpoint.builder();
  iroh.presetMinimal(b);
  b.relayMode(iroh.RelayMode.disabled());
  b.bindAddr(bindAddr);
  if (alpns) b.alpns(alpns);
  return await b.bind();
}

function u64(n: number): number[] {
  const out = new Array<number>(8).fill(0);
  let v = BigInt(n);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function fromU64(b: number[]): number {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return Number(v);
}

// ---------- server side ----------

async function serveEndpoint(ep: Ep): Promise<void> {
  for (;;) {
    const inc = await ep.acceptNext();
    if (!inc) return;
    keepAlive.push(inc);
    void (async () => {
      try {
        const conn = await (await inc.accept()).connect();
        keepAlive.push(conn);
        for (;;) {
          const bi = await conn.acceptBi();
          keepAlive.push(bi);
          void handleStream(bi).catch(() => {});
        }
      } catch {
        /* connection closed */
      }
    })();
  }
}

async function handleStream(bi: InstanceType<typeof iroh.BiStream>): Promise<void> {
  const send = bi.send;
  const recv = bi.recv;
  const op = String.fromCharCode((await recv.readExact(1))[0]!);
  if (op === "E") {
    for (;;) {
      let f: number[];
      try {
        f = await recv.readExact(FRAME);
      } catch {
        break;
      }
      await send.writeAll(f);
    }
    await send.finish();
  } else if (op === "R") {
    const req = await recv.readToEnd(4096);
    await send.writeAll(req);
    await send.finish();
  } else if (op === "S") {
    let n = 0;
    for (;;) {
      const c = await recv.read(256 * 1024);
      if (c.length === 0) break;
      n += c.length;
    }
    await send.writeAll(u64(n));
    await send.finish();
  }
}

// ---------- client side ----------

async function rpcOnOneStream(conn: Conn, n: number, priority?: number, gapMs = 0, stopAt?: () => boolean) {
  const bi = await conn.openBi();
  keepAlive.push(bi);
  if (priority !== undefined) await bi.send.setPriority(priority);
  await bi.send.writeAll([69]); // 'E'
  const frame = new Array<number>(FRAME).fill(7);
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    if (stopAt?.()) break;
    const t = now();
    await bi.send.writeAll(frame);
    await bi.recv.readExact(FRAME);
    samples.push(now() - t);
    if (gapMs > 0) await sleep(gapMs);
  }
  await bi.send.finish();
  return samples;
}

async function rpcPerStream(conn: Conn, n: number) {
  const req = [82, ...new Array<number>(FRAME).fill(9)]; // 'R' + 64 bytes
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = now();
    const bi = await conn.openBi();
    await bi.send.writeAll(req);
    await bi.send.finish();
    await bi.recv.readToEnd(4096);
    samples.push(now() - t);
    keepAlive.push(bi);
  }
  return samples;
}

async function sink(conn: Conn, bytes: number, chunk: number, priority?: number) {
  const bi = await conn.openBi();
  keepAlive.push(bi);
  if (priority !== undefined) await bi.send.setPriority(priority);
  const buf = new Array<number>(chunk).fill(1);
  const t = now();
  await bi.send.writeAll([83]); // 'S'
  let sent = 0;
  let writes = 0;
  while (sent < bytes) {
    const n = Math.min(chunk, bytes - sent);
    await bi.send.writeAll(n === chunk ? buf : buf.slice(0, n));
    sent += n;
    // Optional mitigation for Bun's timer starvation: hand the event loop a macrotask turn.
    if (sizes.yieldEvery > 0 && ++writes % sizes.yieldEvery === 0) await new Promise((r) => setImmediate(r));
  }
  await bi.send.finish();
  const ack = fromU64(await bi.recv.readExact(8));
  const ms = now() - t;
  if (ack !== bytes) throw new Error(`sink ack ${ack} != ${bytes}`);
  return ms;
}

async function runClient(conn: Conn): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  out.rpcStream = summary(await rpcOnOneStream(conn, sizes.rpc));
  out.rpcPerStream = summary(await rpcPerStream(conn, sizes.rpcStreams));

  // A 10 ms interval timer runs during the bulk transfer: a daemon's keepalives, lease renewals
  // and clock sync ride on timers like this one, so record how late they fire.
  const gaps: number[] = [];
  let last = now();
  const timer = setInterval(() => {
    const t = now();
    gaps.push(t - last);
    last = t;
  }, 10);
  const bulkMs = await sink(conn, sizes.bulkMB * 1e6, sizes.chunk);
  clearInterval(timer);
  out.bulk = {
    mb: sizes.bulkMB,
    ms: round(bulkMs, 1),
    MBps: mbps(sizes.bulkMB * 1e6, bulkMs),
    chunk: sizes.chunk,
    timer10msDuringBulk: { expected: Math.floor(bulkMs / 10), fired: gaps.length, maxGapMs: round(Math.max(0, ...gaps), 1) },
  };

  const shots: number[] = [];
  for (let i = 0; i < sizes.shots; i++) shots.push(await sink(conn, 1e6, sizes.chunk));
  out.screenshot1MB = summary(shots);

  // Small-message delay while a bulk transfer runs on the same connection (spec §8.3 item 4).
  for (const [label, rpcPrio, bulkPrio] of [
    ["prioritised", 10, 0],
    ["equal", 0, 0],
  ] as const) {
    let done = false;
    const bulk = sink(conn, sizes.loadMB * 1e6, sizes.chunk, bulkPrio).then((ms) => {
      done = true;
      return ms;
    });
    if (sizes.loadGapMs > 0) await sleep(20);
    const samples = await rpcOnOneStream(conn, 1e9, rpcPrio, sizes.loadGapMs, () => done);
    const bulkMsUnderLoad = await bulk;
    out[`rpcUnderLoad_${label}`] = { ...summary(samples), bulkMBps: mbps(sizes.loadMB * 1e6, bulkMsUnderLoad) };
  }

  const paths = conn.paths();
  out.paths = paths.map((p) => ({ remote: p.remoteAddr, selected: p.isSelected, ip: p.isIp, relay: p.isRelay, rttMs: p.rttMs }));
  out.stats = conn.stats();
  return out;
}

// ---------- modes ----------

async function inProcess(): Promise<void> {
  const tb = now();
  const server = await bindEndpoint("127.0.0.1:0", [ALPN]);
  const bindMs = now() - tb;
  const client = await bindEndpoint("127.0.0.1:0");
  keepAlive.push(server, client);
  void serveEndpoint(server);

  const addr = server.addr();
  const connectSamples: number[] = [];
  let first: Conn | undefined;
  for (let i = 0; i < (quick ? 3 : 10); i++) {
    const t = now();
    const c = await withTimeout(client.connect(addr, ALPN), 10_000, "connect");
    connectSamples.push(now() - t);
    keepAlive.push(c);
    if (!first) first = c;
    else c.close(0n, []);
  }
  const results = await runClient(first!);
  emit("iroh-napi", {
    ok: true,
    mode: "in-process loopback, relay off",
    iroh: "@number0/iroh 1.2.0 (iroh 1.4.1, noq 1.4.0)",
    loadMs: round(loadMs, 1),
    bindMs: round(bindMs, 1),
    connectFirstMs: round(connectSamples[0]!, 2),
    connect: summary(connectSamples.slice(1)),
    sizes,
    ...results,
  });
  first!.close(0n, []);
  await client.close();
  await server.close();
}

async function serveMode(): Promise<void> {
  const bind = arg("bind", "0.0.0.0:47000")!;
  const ep = await bindEndpoint(bind, [ALPN]);
  keepAlive.push(ep);
  const extra = arg("advertise"); // ip:port the client should dial
  const addr = extra ? new iroh.EndpointAddr(ep.id(), null, [extra]) : ep.addr();
  const ticket = iroh.EndpointTicket.fromAddr(addr).toString();
  writeFileSync(arg("ticket-file", "ticket.txt")!, ticket);
  console.error(`serving ${ep.id().fmtShort()} on ${ep.boundSockets().join(",")}`);
  await serveEndpoint(ep);
}

async function dialMode(): Promise<void> {
  const ticketText = readFileSync(arg("dial-ticket-file")!, "utf8").trim();
  const addr = iroh.EndpointTicket.fromString(ticketText).endpointAddr();
  const ep = await bindEndpoint(arg("bind", "0.0.0.0:0")!);
  keepAlive.push(ep);
  const t = now();
  const conn = await withTimeout(ep.connect(addr, ALPN), 15_000, "connect");
  const connectMs = now() - t;
  keepAlive.push(conn);
  const results = await runClient(conn);
  emit("iroh-napi-remote", { ok: true, profile: arg("profile", "unknown"), connectMs: round(connectMs, 2), sizes, ...results });
  conn.close(0n, []);
  await ep.close();
}

try {
  if (flag("serve")) await serveMode();
  else if (arg("dial-ticket-file")) await dialMode();
  else await inProcess();
  if (!flag("serve")) process.exit(0);
} catch (e) {
  emit(arg("dial-ticket-file") ? "iroh-napi-remote" : "iroh-napi", { ok: false, error: String((e as Error)?.stack ?? e) });
  process.exit(1);
}
