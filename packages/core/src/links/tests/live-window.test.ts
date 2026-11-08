// A live stream's window (L-M3's measurement: a real socket's buffers hid browser.stream's congestion, 6–15 s of delay
// on loopback). A stream opened at the `screenshots` priority gets a window of `LIVE_STREAM_WINDOW` each way, chosen at
// open and carried in the stream's header: the sender's core holds at most that much unacknowledged, its sidecar at
// most that much queued for QUIC, and the receiver's sidecar reads at most that much ahead of its core. Over real
// sidecars on loopback (no relay, nothing published), as lane H's sidecar tests run; skipped when `clover-link` isn't
// built, and required in CI.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemClock } from "../../clock/system-clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { FileDeviceRegistry } from "../../devices/registry";
import { DeviceKey } from "../../identity/device-key";
import { SidecarWire, STREAM_WINDOW } from "../sidecar-wire";
import { CloverLinkTransport } from "../transport";
import { LIVE_STREAM_WINDOW } from "../wire";

const BIN = process.env.CLOVER_LINK_BIN ?? join(import.meta.dir, "../../../../../native/link/target/release/clover-link");
const built = existsSync(BIN);
if (!built && process.env.CLOVER_LINK_REQUIRE_BINARY === "1") throw new Error(`CLOVER_LINK_REQUIRE_BINARY=1, but there is no clover-link at ${BIN}`);
const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

async function device(name: string) {
  const store = new MemorySecretStore();
  const key = await DeviceKey.loadOrCreate(store);
  const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-int-live-")), key, clock, self: { name } });
  const wire = await SidecarWire.start({ binary: BIN, key, relay: "disabled", n0Lookup: false, bind: "127.0.0.1:0" });
  stops.push(() => wire.close());
  const report = await wire.settledReport();
  // What the core sends its sidecar: the test reads the window ops off it.
  const ops: Record<string, unknown>[] = [];
  const send = wire.sendJson.bind(wire);
  wire.sendJson = (m, gen) => {
    ops.push(m);
    send(m, gen);
  };
  return { name, store, key, registry, wire, direct: report.direct, ops };
}
type Dev = Awaited<ReturnType<typeof device>>;

async function allowEach(a: Dev, b: Dev): Promise<void> {
  a.wire.allow([b.key.publicKey]);
  b.wire.allow([a.key.publicKey]);
  await Promise.all([a.wire.stats(), b.wire.stats()]);
}

describe.skipIf(!built)("a live stream's window (L-M3)", () => {
  test("a slow reader keeps what each side holds of a live stream within its window, end to end", async () => {
    const a = await device("Studio");
    const b = await device("Laptop");
    await allowEach(a, b);
    const W = LIVE_STREAM_WINDOW;
    const chunk = 16 * 1024;
    const total = 8 * 1024 * 1024;
    let reading = false;
    let go!: () => void;
    const started = new Promise<void>((r) => (go = r));
    let got = 0;
    const finished = new Promise<void>((resolve) => {
      b.wire.onIncoming("clover/link/1", (conn) => conn.onStream((ws) => {
        // As the receiving transport does once it read a live stream's header.
        ws.setWindow?.(W);
        ws.onData(async (c) => {
          if (!reading) await started;
          got += c.byteLength;
          await Bun.sleep(2); // a slow reader: about 8 MB/s at most
        });
        ws.onFin(() => resolve());
      }));
    });
    const conn = await a.wire.dial({ key: b.key.publicKey, direct: b.direct }, { alpn: "clover/link/1", timeoutMs: 5000 });
    const s = conn.openStream(1, { window: W });
    expect(a.ops.find((m) => m.op === "open")).toMatchObject({ window: W });
    let written = 0;
    let writeFailed: unknown;
    const writing = (async () => {
      const c = new Uint8Array(chunk).fill(5);
      while (written < total) {
        await s.write(c);
        written += c.byteLength;
      }
      s.finish();
    })();
    writing.catch((e: unknown) => (writeFailed = e ?? new Error("the write failed")));

    // Beyond the two cores and two sidecars, only QUIC's own stream window (noq's 1.25 MB, the same for every stream:
    // noq has no per-stream window) can hold the stream's bytes; everything this side controls stays within W.
    const ahead = 1_250_000 + 3 * W + chunk;
    const bound = async () => {
      if (writeFailed !== undefined) throw writeFailed;
      const [sa, sb] = await Promise.all([a.wire.stats(), b.wire.stats()]);
      expect(written - got).toBeLessThanOrEqual(ahead);
      expect(sa.core.unackedWrites).toBeLessThanOrEqual(W);
      expect(sa.sidecar.queuedWrites).toBeLessThanOrEqual(W);
      expect(sb.sidecar.unconsumed).toBeLessThanOrEqual(W);
      expect(sb.core.unconsumed).toBeLessThanOrEqual(W);
      return { sa, sb };
    };
    // Nothing read yet: the writer is held back.
    for (const end = Date.now() + 1_500; Date.now() < end; await Bun.sleep(50)) await bound();
    expect(got).toBe(0);
    // The receiver's side never widened it: an incoming stream starts at the live window.
    expect(b.ops.some((m) => m.op === "window")).toBe(false);
    // Then it reads, slowly, and the bounds hold all the way.
    reading = true;
    go();
    let sampling = true;
    const samples = (async () => {
      let n = 0;
      while (sampling) {
        await bound();
        n++;
        await Bun.sleep(40);
      }
      return n;
    })();
    await Promise.race([finished, samples.then(() => finished)]);
    await writing;
    sampling = false;
    expect(await samples).toBeGreaterThan(0);
    expect(got).toBe(written);
  }, 90_000);

  test("the transport gives a screenshots stream the live window at open and tells the receiver in its header; a files stream keeps the wire's", async () => {
    const a = await device("Studio");
    const b = await device("Laptop");
    await allowEach(a, b);
    const peers = new Map([[a.key.id, a], [b.key.id, b]]);
    const transport = (d: Dev) => {
      const t = new CloverLinkTransport({
        self: d.key.id, wire: d.wire, registry: d.registry, clock,
        directory: { target: (id) => { const p = peers.get(id); return p ? { key: p.key.publicKey, direct: p.direct } : undefined; } },
      });
      stops.push(() => t.close());
      return t;
    };
    await a.registry.add({ id: b.key.id, name: "Laptop", kind: "desktop", runsCore: true, publicKey: b.key.publicKeyBase64 }, { via: "terminal" });
    await b.registry.add({ id: a.key.id, name: "Studio", kind: "desktop", runsCore: true, publicKey: a.key.publicKeyBase64 }, { via: "terminal" });
    const ta = transport(a);
    const tb = transport(b);
    const got = new Map<string, number>();
    const ended = new Map<string, Promise<void>>();
    for (const label of ["live", "bulk"]) {
      ended.set(label, new Promise<void>((resolve) => tb.onStream(label, (st) => {
        st.onData((c) => got.set(label, (got.get(label) ?? 0) + c.byteLength));
        st.onEnd(() => resolve());
      })));
    }
    const link = await ta.connect(b.key.id);
    const live = link.openStream("live", "screenshots", { tab: "tab_1" });
    await live.write(new Uint8Array(100_000).fill(1));
    live.end();
    const bulk = link.openStream("bulk", "files");
    await bulk.write(new Uint8Array(100_000).fill(2));
    bulk.end();
    await Promise.all(ended.values());
    expect(got.get("live")).toBe(100_000);
    expect(got.get("bulk")).toBe(100_000);
    // The opener's sidecar was told the live window at open; the bulk stream's open names none (the wire's).
    const opens = a.ops.filter((m) => m.op === "open");
    expect(opens.some((m) => m.window === LIVE_STREAM_WINDOW)).toBe(true);
    expect(opens.filter((m) => m.window !== undefined)).toHaveLength(1);
    // The receiver read each stream's header: the live stream keeps the live window it started with (no op), and every
    // other one (the lanes, the bulk stream) is widened to the wire's.
    const windows = b.ops.filter((m) => m.op === "window").map((m) => m.window);
    expect(windows.filter((w) => w !== STREAM_WINDOW)).toEqual([]);
    expect(windows.length).toBeGreaterThanOrEqual(2); // a lane at least, and the bulk stream
    expect(STREAM_WINDOW).toBeGreaterThan(LIVE_STREAM_WINDOW);
  }, 60_000);
});
