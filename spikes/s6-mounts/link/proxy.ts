#!/usr/bin/env bun
// The fake link: a TCP relay between the mount helper and the file service, with an added
// round-trip delay and switchable faults. It stands in for the local daemon's hop plus the
// device link (spec §8.2).
//
//   bun proxy.ts --listen 7500 --target 7400 [--control 7501] [--rtt-ms 0]
//
// Control (HTTP on 127.0.0.1:<control>):
//   POST /config {"rttMs": 20}          set the added round trip (half each way)
//   POST /config {"mode": "blackhole"}  stop delivering in both directions, keep sockets open
//                                       (a dropped Wi-Fi or a sleeping laptop: no FIN, no RST)
//   POST /config {"mode": "pass"}       deliver again, late bytes first, like TCP after an outage
//   POST /config {"rateKbps": 2000, "jitterMs": 20, "bufKB": 256}
//                                       a link of that bandwidth each way, a random extra delay
//                                       per chunk (order kept), and a buffer of that size per
//                                       direction: past it the sender is paused, as a real
//                                       link's TCP window would (0 = no limit, no jitter)
//   POST /reset                         close every relayed connection at once (a reset link)
//   GET  /status                        mode, delay and live connections

const args = parseArgs(process.argv.slice(2));
const LISTEN = Number(args.listen ?? 7500);
const TARGET_HOST = String(args["target-host"] ?? "127.0.0.1");
const TARGET = Number(args.target ?? 7400);
const CONTROL = Number(args.control ?? 0);
let rttMs = Number(args["rtt-ms"] ?? 0);
let mode: "pass" | "blackhole" = "pass";
let rateKbps = Number(args["rate-kbps"] ?? 0);
let jitterMs = Number(args["jitter-ms"] ?? 0);
let bufBytes = Number(args["buf-kb"] ?? 256) * 1024;

type S = import("bun").Socket<Side>;
interface Side {
  sock: S | null;
  peer: Side | null;
  pending: Uint8Array[]; // bytes waiting for the peer to connect
  queue: Array<{ due: number; chunk: Uint8Array }>; // delayed or held bytes heading to the peer
  out: Uint8Array[]; // bytes the kernel did not take yet
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  pair: Pair;
  busyUntil: number; // when this direction's link is free again (rate limit)
  lastDue: number; // the latest delivery time queued, so jitter never reorders bytes
  queued: number; // bytes in queue
  paused: boolean; // the sending socket is paused (the buffer is full)
}
interface Pair { client: Side; server: Side; id: number }
const pairs = new Set<Pair>();
let nextId = 1;

function newSide(pair: Pair): Side {
  return { sock: null, peer: null, pending: [], queue: [], out: [], timer: null, closed: false, pair, busyUntil: 0, lastDue: 0, queued: 0, paused: false };
}

/** Bytes that arrived on `from` go to `from.peer` after half the round trip. */
function relay(from: Side, chunk: Uint8Array) {
  if (from.closed) return;
  const to = from.peer!;
  const copy = new Uint8Array(chunk); // Bun reuses the read buffer
  const now = performance.now();
  let due = now + rttMs / 2;
  if (rateKbps > 0) {
    // The chunk leaves once the link has sent what is ahead of it, at the link's rate.
    from.busyUntil = Math.max(now, from.busyUntil) + (copy.length * 8) / rateKbps; // ms
    due = from.busyUntil + rttMs / 2;
  }
  if (jitterMs > 0) due += Math.random() * jitterMs;
  due = Math.max(due, from.lastDue);
  from.lastDue = due;
  from.queue.push({ due, chunk: copy });
  from.queued += copy.length;
  if (rateKbps > 0 && from.queued > bufBytes && !from.paused && from.sock) {
    from.paused = true;
    (from.sock as any).pause?.();
  }
  pump(from, to);
}
function pump(from: Side, to: Side) {
  if (from.timer) return;
  if (mode === "blackhole") return; // held until the link comes back
  const now = performance.now();
  while (from.queue.length && from.queue[0]!.due <= now + 0.25) {
    const c = from.queue.shift()!.chunk;
    from.queued -= c.length;
    write(to, c);
  }
  if (from.paused && from.queued < bufBytes / 2 && from.sock) {
    from.paused = false;
    (from.sock as any).resume?.();
  }
  if (from.queue.length) {
    from.timer = setTimeout(() => { from.timer = null; pump(from, to); }, Math.max(0, from.queue[0]!.due - now));
  }
}
function write(to: Side, chunk: Uint8Array) {
  if (to.closed) return;
  if (!to.sock) { to.pending.push(chunk); return; }
  if (to.out.length) { to.out.push(chunk); return; }
  const n = to.sock.write(chunk);
  if (n < chunk.length) to.out.push(chunk.subarray(Math.max(0, n)));
}
function drain(side: Side) {
  while (side.out.length && side.sock) {
    const c = side.out[0]!;
    const n = side.sock.write(c);
    if (n < c.length) { side.out[0] = c.subarray(Math.max(0, n)); return; }
    side.out.shift();
  }
}
function closePair(p: Pair) {
  if (!pairs.delete(p)) return;
  for (const s of [p.client, p.server]) {
    s.closed = true;
    if (s.timer) clearTimeout(s.timer);
    try { s.sock?.end(); } catch {}
  }
}
function resumeAll() {
  for (const p of pairs) { pump(p.client, p.server); pump(p.server, p.client); }
}

Bun.listen<Side>({
  hostname: "127.0.0.1",
  port: LISTEN,
  socket: {
    open(sock) {
      const pair = { id: nextId++ } as Pair;
      pair.client = newSide(pair);
      pair.server = newSide(pair);
      pair.client.peer = pair.server;
      pair.server.peer = pair.client;
      pair.client.sock = sock;
      sock.data = pair.client;
      sock.setNoDelay?.(true);
      pairs.add(pair);
      Bun.connect<Side>({
        hostname: TARGET_HOST,
        port: TARGET,
        socket: {
          open(up) {
            up.data = pair.server;
            if (pair.client.closed) { up.end(); return; }
            up.setNoDelay?.(true);
            pair.server.sock = up;
            for (const c of pair.server.pending.splice(0)) write(pair.server, c);
          },
          data(up, chunk) { if (up.data) relay(up.data, chunk); },
          drain(up) { if (up.data) drain(up.data); },
          close(up) { closePair(up.data?.pair ?? pair); },
          error(up) { closePair(up.data?.pair ?? pair); },
          connectError() { closePair(pair); },
        },
      }).catch(() => closePair(pair));
    },
    data(sock, chunk) { if (sock.data && !sock.data.closed) relay(sock.data, chunk); },
    drain(sock) { if (sock.data) drain(sock.data); },
    close(sock) { if (sock.data) closePair(sock.data.pair); },
    error(sock) { if (sock.data) closePair(sock.data.pair); },
  },
});

if (CONTROL) {
  Bun.serve({
    hostname: "127.0.0.1",
    port: CONTROL,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/config" && req.method === "POST") {
        const body = (await req.json()) as { rttMs?: number; mode?: "pass" | "blackhole"; rateKbps?: number; jitterMs?: number; bufKB?: number };
        if (typeof body.rttMs === "number") rttMs = body.rttMs;
        if (typeof body.rateKbps === "number") rateKbps = body.rateKbps;
        if (typeof body.jitterMs === "number") jitterMs = body.jitterMs;
        if (typeof body.bufKB === "number") bufBytes = body.bufKB * 1024;
        if (body.mode === "pass" || body.mode === "blackhole") {
          mode = body.mode;
          if (mode === "pass") resumeAll();
        }
        return Response.json({ mode, rttMs, rateKbps, jitterMs, bufKB: bufBytes / 1024, connections: pairs.size });
      }
      if (u.pathname === "/reset" && req.method === "POST") {
        const n = pairs.size;
        for (const p of [...pairs]) closePair(p);
        return Response.json({ closed: n });
      }
      if (u.pathname === "/status") return Response.json({ mode, rttMs, rateKbps, jitterMs, bufKB: bufBytes / 1024, connections: pairs.size });
      return new Response("not found", { status: 404 });
    },
  });
}
console.error(`[link] 127.0.0.1:${LISTEN} -> ${TARGET_HOST}:${TARGET}, rtt +${rttMs} ms (pid ${process.pid})`);

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}
