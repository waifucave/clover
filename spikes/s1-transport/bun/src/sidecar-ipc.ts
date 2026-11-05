// S1 question 2, the fallback path: clover-core (Bun, or a `bun build --compile` binary) starts
// native/link-sidecar and talks to it over stdio. Measures what that hop costs: small-frame
// round trips, bulk echo throughput, and whether a 10 ms timer keeps firing meanwhile.
//
//   bun src/sidecar-ipc.ts --sidecar <path to clover-link-sidecar>

import { arg, emit, mbps, now, round, summary } from "./lib/report.ts";

const sidecar = arg("sidecar", process.env.CLOVER_LINK_SIDECAR);
const rpcN = Number(arg("rpc", "2000"));
const bulkMB = Number(arg("bulk-mb", "64"));
const frameSize = Number(arg("frame", String(64 * 1024)));

function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length);
  out.set(payload, 4);
  return out;
}

class FrameReader {
  private buf = new Uint8Array(0);
  private waiters: Array<(f: Uint8Array) => void> = [];
  private frames: Uint8Array[] = [];
  constructor(stream: ReadableStream<Uint8Array>) {
    void (async () => {
      for await (const chunk of stream) {
        const merged = new Uint8Array(this.buf.length + chunk.length);
        merged.set(this.buf);
        merged.set(chunk, this.buf.length);
        this.buf = merged;
        for (;;) {
          if (this.buf.length < 4) break;
          const n = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(0);
          if (this.buf.length < 4 + n) break;
          const f = this.buf.slice(4, 4 + n);
          this.buf = this.buf.slice(4 + n);
          const w = this.waiters.shift();
          if (w) w(f);
          else this.frames.push(f);
        }
      }
    })();
  }
  next(): Promise<Uint8Array> {
    const f = this.frames.shift();
    if (f) return Promise.resolve(f);
    return new Promise((r) => this.waiters.push(r));
  }
}

async function main(): Promise<void> {
  if (!sidecar) throw new Error("--sidecar <path> or CLOVER_LINK_SIDECAR is required");
  const tSpawn = now();
  const proc = Bun.spawn([sidecar, "ipc"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = new FrameReader(proc.stdout as ReadableStream<Uint8Array>);
  const small = frame(new Uint8Array(64).fill(7));

  // First round trip includes process start.
  proc.stdin.write(small);
  proc.stdin.flush();
  await reader.next();
  const firstMs = now() - tSpawn;

  const rtts: number[] = [];
  for (let i = 0; i < rpcN; i++) {
    const t = now();
    proc.stdin.write(small);
    proc.stdin.flush();
    await reader.next();
    rtts.push(now() - t);
  }

  const gaps: number[] = [];
  let last = now();
  const timer = setInterval(() => {
    const t = now();
    gaps.push(t - last);
    last = t;
  }, 10);
  const big = frame(new Uint8Array(frameSize).fill(1));
  const frames = Math.ceil((bulkMB * 1e6) / frameSize);
  const tBulk = now();
  const readAll = (async () => {
    for (let i = 0; i < frames; i++) await reader.next();
  })();
  for (let i = 0; i < frames; i++) {
    proc.stdin.write(big);
    if (i % 16 === 15) await proc.stdin.flush();
  }
  await proc.stdin.flush();
  await readAll;
  const bulkMs = now() - tBulk;
  clearInterval(timer);
  proc.stdin.end();
  await proc.exited;

  emit("sidecar-ipc", {
    ok: true,
    spawnAndFirstRttMs: round(firstMs, 2),
    rtt64B: summary(rtts),
    echo: {
      mb: bulkMB,
      frame: frameSize,
      ms: round(bulkMs, 1),
      MBpsEachWay: mbps(frames * frameSize, bulkMs),
      timer10ms: { expected: Math.floor(bulkMs / 10), fired: gaps.length, maxGapMs: round(Math.max(0, ...gaps), 1) },
    },
  });
}

try {
  await main();
  process.exit(0);
} catch (e) {
  emit("sidecar-ipc", { ok: false, error: String((e as Error)?.stack ?? e) });
  process.exit(1);
}
