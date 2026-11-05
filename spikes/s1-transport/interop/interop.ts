// S1: does the iOS app's iroh talk to clover-core's? The app ships iroh-ffi 1.1.0, whose
// Cargo.lock pins iroh 1.0.2 (noq 1.0.1); n0's napi binding @number0/iroh 1.1.0 is the same
// release of the same crate, so it stands in for the Swift binding here. clover-link-sidecar is
// iroh 1.4.1. Both directions, over loopback, relays off, with the bench protocol of
// spikes/s1-transport/README.md:
//
//   1. 1.0.2 dials 1.4.1: echo RPCs on one stream, then a 4 MB transfer acked by the server
//   2. 1.4.1 dials 1.0.2: the sidecar's `ping` sends echoes for 2 s and checks every one came back
//
//   bun interop.ts --sidecar <clover-link-sidecar>
//
// CI only by default (platform-checks.sh): n0's binding can't turn off iroh's port mapper.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Endpoint, EndpointAddr, EndpointId, presetMinimal, RelayMode } from "@number0/iroh";
import { arg, emit, now, round, summary, withTimeout } from "../bun/src/lib/report.ts";

const ALPN = Array.from(new TextEncoder().encode("clover/s1/bench/1"));
const sidecar = arg("sidecar");
const FRAME = 64;

async function bind(addr: string): Promise<Endpoint> {
  const b = Endpoint.builder();
  presetMinimal(b);
  b.alpns([ALPN]);
  b.relayMode(RelayMode.disabled());
  b.bindAddr(addr);
  return await b.bind();
}

async function waitFor(path: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try {
      const s = readFileSync(path, "utf8");
      if (s) return s;
    } catch {
      /* not there yet */
    }
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${path}`);
}

// 1. iroh 1.0.2 dials the sidecar's iroh 1.4.1.
async function dialNative(dir: string): Promise<Record<string, unknown>> {
  const info = join(dir, "server.json");
  const server = Bun.spawn([sidecar!, "serve", "--transport", "iroh", "--bind", "127.0.0.1:47310", "--info-file", info], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const ep = await bind("127.0.0.1:0");
  try {
    const { identity } = JSON.parse(await waitFor(info)) as { identity: string };
    const t = now();
    const conn = await withTimeout(ep.connect(new EndpointAddr(EndpointId.fromString(identity), null, ["127.0.0.1:47310"]), ALPN), 15_000, "connect");
    const connectMs = now() - t;
    const echo = await conn.openBi();
    await echo.send.write(Array.from(new TextEncoder().encode("E")));
    const frame = new Array<number>(FRAME).fill(7);
    const rtts: number[] = [];
    for (let i = 0; i < 100; i++) {
      const s = now();
      await echo.send.write(frame);
      const back = await echo.recv.readExact(FRAME);
      if (back.length !== FRAME) throw new Error(`echo returned ${back.length} bytes`);
      rtts.push(now() - s);
    }
    await echo.send.finish();
    const sink = await conn.openBi();
    const total = 4_000_000;
    const chunk = new Array<number>(64 * 1024).fill(1);
    const s = now();
    await sink.send.write(Array.from(new TextEncoder().encode("S")));
    for (let sent = 0; sent < total; sent += chunk.length) await sink.send.write(sent + chunk.length <= total ? chunk : chunk.slice(0, total - sent));
    await sink.send.finish();
    const ack = await sink.recv.readExact(8);
    const acked = Number(new DataView(Uint8Array.from(ack).buffer).getBigUint64(0));
    const sinkMs = now() - s;
    conn.close(0n, Array.from(new TextEncoder().encode("done")));
    return { ok: acked === total, connectMs: round(connectMs, 2), rtt: summary(rtts), sinkBytesAcked: acked, sinkMs: round(sinkMs, 1) };
  } finally {
    await ep.close();
    server.kill();
    await server.exited;
  }
}

// 2. The sidecar's iroh 1.4.1 dials iroh 1.0.2, which echoes like the bench's `E` handler.
async function serveForNative(dir: string): Promise<Record<string, unknown>> {
  const ep = await bind("127.0.0.1:47311");
  const info = join(dir, "ffi.json");
  writeFileSync(info, JSON.stringify({ transport: "iroh", identity: ep.id().toString(), addrs: ["127.0.0.1:47311"] }));
  let served = 0;
  const loop = (async () => {
    for (;;) {
      const incoming = await ep.acceptNext();
      if (!incoming) return;
      const conn = await (await incoming.accept()).connect();
      void (async () => {
        for (;;) {
          const bi = await conn.acceptBi().catch(() => null);
          if (!bi) return;
          void (async () => {
            const op = await bi.recv.readExact(1);
            if (op[0] !== "E".charCodeAt(0)) return;
            for (;;) {
              const f = await bi.recv.readExact(FRAME).catch(() => null);
              if (!f) break;
              await bi.send.write(f);
              served++;
            }
            await bi.send.finish().catch(() => undefined);
          })();
        }
      })();
    }
  })();
  try {
    const ping = Bun.spawn(
      [sidecar!, "ping", "--info-file", info, "--connect", "127.0.0.1:47311", "--duration-s", "2", "--grace-s", "3", "--label", "interop"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(ping.stdout).text();
    await ping.exited;
    const line = out.split("\n").find((l) => l.startsWith("S1RESULT "));
    if (!line) return { ok: false, error: "the sidecar's ping printed no result" };
    const r = JSON.parse(line.slice("S1RESULT ".length)) as Record<string, unknown>;
    return { ok: r.recovered === true, sent: r.sent, received: r.received, rtt: r.rtt, echoesServed: served, error: r.error ?? null };
  } finally {
    await ep.close();
    void loop;
  }
}

try {
  if (!sidecar) throw new Error("--sidecar <clover-link-sidecar>");
  const dir = mkdtempSync(join(tmpdir(), "s1-interop-"));
  const dial = await dialNative(dir);
  const serve = await serveForNative(dir);
  rmSync(dir, { recursive: true, force: true });
  emit("iroh-ffi-interop", {
    ok: dial.ok === true && serve.ok === true,
    older: "iroh 1.0.2 (@number0/iroh 1.1.0 = iroh-ffi 1.1.0)",
    newer: "iroh 1.4.1 (clover-link-sidecar)",
    olderDialsNewer: dial,
    newerDialsOlder: serve,
  });
  process.exit(0);
} catch (e) {
  emit("iroh-ffi-interop", { ok: false, error: String((e as Error)?.stack ?? e) });
  process.exit(1);
}
