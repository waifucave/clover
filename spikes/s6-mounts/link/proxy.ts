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
//   POST /reset                         close every relayed connection at once (a reset link)
//   GET  /status                        mode, delay and live connections

const args = parseArgs(process.argv.slice(2));
const LISTEN = Number(args.listen ?? 7500);
const TARGET_HOST = String(args["target-host"] ?? "127.0.0.1");
const TARGET = Number(args.target ?? 7400);
const CONTROL = Number(args.control ?? 0);
let rttMs = Number(args["rtt-ms"] ?? 0);
let mode: "pass" | "blackhole" = "pass";

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
}
interface Pair { client: Side; server: Side; id: number }
const pairs = new Set<Pair>();
let nextId = 1;

function newSide(pair: Pair): Side {
  return { sock: null, peer: null, pending: [], queue: [], out: [], timer: null, closed: false, pair };
}

/** Bytes that arrived on `from` go to `from.peer` after half the round trip. */
function relay(from: Side, chunk: Uint8Array) {
  const to = from.peer!;
  const copy = new Uint8Array(chunk); // Bun reuses the read buffer
  from.queue.push({ due: performance.now() + rttMs / 2, chunk: copy });
  pump(from, to);
}
function pump(from: Side, to: Side) {
  if (from.timer) return;
  if (mode === "blackhole") return; // held until the link comes back
  const now = performance.now();
  while (from.queue.length && from.queue[0]!.due <= now + 0.25) {
    write(to, from.queue.shift()!.chunk);
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
            if (pair.client.closed) { up.end(); return; }
            up.data = pair.server;
            up.setNoDelay?.(true);
            pair.server.sock = up;
            for (const c of pair.server.pending.splice(0)) write(pair.server, c);
          },
          data(up, chunk) { relay(up.data, chunk); },
          drain(up) { drain(up.data); },
          close(up) { closePair(up.data.pair); },
          error(up) { closePair(up.data.pair); },
          connectError() { closePair(pair); },
        },
      }).catch(() => closePair(pair));
    },
    data(sock, chunk) { relay(sock.data, chunk); },
    drain(sock) { drain(sock.data); },
    close(sock) { closePair(sock.data.pair); },
    error(sock) { closePair(sock.data.pair); },
  },
});

if (CONTROL) {
  Bun.serve({
    hostname: "127.0.0.1",
    port: CONTROL,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/config" && req.method === "POST") {
        const body = (await req.json()) as { rttMs?: number; mode?: "pass" | "blackhole" };
        if (typeof body.rttMs === "number") rttMs = body.rttMs;
        if (body.mode === "pass" || body.mode === "blackhole") {
          mode = body.mode;
          if (mode === "pass") resumeAll();
        }
        return Response.json({ mode, rttMs, connections: pairs.size });
      }
      if (u.pathname === "/reset" && req.method === "POST") {
        const n = pairs.size;
        for (const p of [...pairs]) closePair(p);
        return Response.json({ closed: n });
      }
      if (u.pathname === "/status") return Response.json({ mode, rttMs, connections: pairs.size });
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
