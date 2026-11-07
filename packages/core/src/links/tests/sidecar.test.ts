// The link over real iroh: two `clover-link` sidecars on loopback (no relay, nothing leaves the machine), the
// transport on top, and pairing through the pair ALPN. Runs when the sidecar is built: `CLOVER_LINK_BIN`, or
// native/link's release build (CI's link job builds it, and sets CLOVER_LINK_REQUIRE_BINARY=1 so a missing one
// fails; locally `cargo build --release` in native/link). The restart's bookkeeping also runs against a fake sidecar
// process, which needs no build.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContractError } from "../../contracts/common";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { FileDeviceRegistry } from "../../devices/registry";
import { SystemClock } from "../../clock/system-clock";
import { fromBase64, fromUtf8, toHex, utf8 } from "../../identity/bytes";
import { DeviceKey } from "../../identity/device-key";
import { FrameReader, MAX_FRAME } from "../frames";
import { bundledLinkBinary } from "../sidecar-binary";
import { PairingService } from "../pairing";
import { followRegistry, pipeWriter, type SidecarProcess, SidecarWire, type SidecarWireOptions, spawnSidecar, STREAM_WINDOW } from "../sidecar-wire";
import { type DeviceLinks, startDeviceLinks } from "../node";
import { CloverLinkTransport } from "../transport";
import { CLOSE_LOST, RESET_CONN_LOST, type WireConn, WireOffline, type WireStream } from "../wire";

const BIN = process.env.CLOVER_LINK_BIN ?? join(import.meta.dir, "../../../../../native/link/target/release/clover-link");
const built = existsSync(BIN);
// CI builds the sidecar before these run, and says so: there a missing binary fails the file instead of skipping it.
if (!built && process.env.CLOVER_LINK_REQUIRE_BINARY === "1") throw new Error(`CLOVER_LINK_REQUIRE_BINARY=1, but there is no clover-link at ${BIN}`);
const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

async function device(name: string, extra: Partial<SidecarWireOptions> = {}) {
  const store = new MemorySecretStore();
  const key = await DeviceKey.loadOrCreate(store);
  const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-h-sidecar-")), key, clock, self: { name } });
  const wire = await SidecarWire.start({ binary: BIN, key, relay: "disabled", n0Lookup: false, bind: "127.0.0.1:0", ...extra });
  stops.push(() => wire.close());
  const report = await wire.settledReport();
  return { name, store, key, registry, wire, direct: report.direct };
}
type Dev = Awaited<ReturnType<typeof device>>;

/** Each lets the other's link connections through, and has taken that in before anyone dials. `allow` is a message to
 *  the sidecar, and a dial that beats it there is closed at the door as unpaired: the dialer's first write then finds
 *  the connection lost (S6.2's flake on the arm runner). A request answered after it on the same ordered pipe says
 *  the sidecar has it. */
async function allowEach(a: Dev, b: Dev): Promise<void> {
  a.wire.allow([b.key.publicKey]);
  b.wire.allow([a.key.publicKey]);
  await Promise.all([a.wire.stats(), b.wire.stats()]);
}

function transport(d: Dev, peers: Map<string, Dev>) {
  const t = new CloverLinkTransport({
    self: d.key.id, wire: d.wire, registry: d.registry, clock,
    directory: { target: (id) => { const p = peers.get(id); return p ? { key: p.key.publicKey, direct: p.direct } : undefined; } },
  });
  stops.push(() => t.close());
  return t;
}

describe.skipIf(!built)("link sidecar (iroh on loopback)", () => {
  test("starts under the device's key, pairs two devices over the pair ALPN, and links them", async () => {
    const a = await device("Studio");
    const b = await device("Laptop");
    // Each sidecar takes link connections only from its registry's devices; pairing has its own ALPN.
    stops.push(followRegistry(a.wire, a.registry), followRegistry(b.wire, b.registry));
    expect(Buffer.from(a.wire.publicKey).toString("hex")).toBe(Buffer.from(a.key.publicKey).toString("hex"));
    expect(a.direct.some((x) => x.startsWith("127.0.0.1:"))).toBe(true);

    const pa = new PairingService({ self: a.key, registry: a.registry, wire: a.wire, clock, store: a.store, selfTarget: () => ({ direct: a.direct }), account: () => null });
    const pb = new PairingService({ self: b.key, registry: b.registry, wire: b.wire, clock, store: b.store, selfTarget: () => ({ direct: b.direct }), account: () => null });
    stops.push(() => pa.close(), () => pb.close());
    const view = await pa.begin();
    const joined = await pb.join(view.qr!);
    await waitFor(() => pa.get(view.pairingId)?.status === "words");
    expect(pa.get(view.pairingId)!.view.words).toEqual(joined.words!);
    await Promise.all([pa.confirm(view.pairingId, joined.words!, { terminal: true }), pb.confirm(view.pairingId, joined.words!, { terminal: true })]);
    await waitFor(() => a.registry.get(b.key.id) !== undefined && b.registry.get(a.key.id) !== undefined);

    const peers = new Map([[a.key.id, a], [b.key.id, b]]);
    const ta = transport(a, peers);
    const tb = transport(b, peers);
    tb.handle("echo", (p) => p);
    const received = new Promise<number>((resolve) => {
      tb.onStream("blob", (s) => {
        let n = 0;
        s.onData((c) => (n += c.byteLength));
        s.onEnd(() => resolve(n));
      });
    });
    const link = await ta.connect(b.key.id);
    expect(link.view()).toMatchObject({ up: true, path: "lan" });
    expect(await link.request<unknown>("echo", { n: 1, bytes: new Uint8Array([1, 2, 3]) })).toEqual({ n: 1, bytes: new Uint8Array([1, 2, 3]) });
    const big = new Uint8Array(3 * 1024 * 1024).fill(7);
    const s = link.openStream("blob", "files");
    for (let i = 0; i < big.byteLength; i += 256 * 1024) await s.write(big.subarray(i, i + 256 * 1024));
    s.end();
    expect(await received).toBe(big.byteLength);

    // Revoking cuts the link at once.
    await a.registry.revoke(b.key.id);
    expect(isContractError(await link.request("echo", 1).catch((e: unknown) => e), "refused")).toBe(true);
  }, 30_000);

  test("the daemon's links over two sidecars: pair, link, and a restart under the same key", async () => {
    const homes = [mkdtempSync(join(tmpdir(), "clover-h-sidecar-node-")), mkdtempSync(join(tmpdir(), "clover-h-sidecar-node-"))];
    const stores = [new MemorySecretStore(), new MemorySecretStore()];
    // No handshake here: each daemon finds the other at its loopback address. n0's lookup stays off, so nothing
    // leaves the machine.
    const where = new Map<string, DeviceLinks>();
    const directory = { target: (id: string) => { const p = where.get(id); return p ? { key: p.key.publicKey, direct: p.localAddresses().direct } : undefined; } };
    const start = async (i: number, name: string) => {
      const l = await startDeviceLinks({ home: homes[i]!, store: stores[i]!, clock, self: { name }, directory, sidecar: { binary: BIN, relay: "disabled", bind: "127.0.0.1:0", n0Lookup: false } });
      where.set(l.key.id, l);
      return l;
    };
    const a = await start(0, "Studio");
    let b = await start(1, "Laptop");
    stops.push(() => a.close(), () => b.close());
    expect(a.localAddresses().direct.some((x) => x.startsWith("127.0.0.1:"))).toBe(true);
    const view = await a.pairing.begin();
    const joined = await b.pairing.join(view.qr!);
    await waitFor(() => a.pairing.get(view.pairingId)?.status === "words");
    await Promise.all([a.pairing.confirm(view.pairingId, joined.words!, { terminal: true }), b.pairing.confirm(view.pairingId, joined.words!, { terminal: true })]);
    await waitFor(() => a.registry.get(b.key.id) !== undefined && b.registry.get(a.key.id) !== undefined);
    b.transport.handle("who", () => "laptop");
    expect(await (await a.transport.connect(b.key.id)).request<string>("who", null)).toBe("laptop");

    // A restart: the same key and pairing, a new sidecar on a new port, and the link comes back.
    const id = b.key.id;
    await b.close();
    b = await start(1, "Laptop");
    expect(b.key.id).toBe(id);
    expect(b.registry.get(a.key.id)?.revokedAt).toBeUndefined();
    b.transport.handle("who", () => "laptop again");
    const link = await a.transport.connect(id);
    await waitFor(() => link.view().up, 15_000);
    expect(await link.request<string>("who", null)).toBe("laptop again");
  }, 40_000);

  test("a revoked device is told so at the sidecar's door, and stops dialling (S1 of H-M1's review)", async () => {
    const where = new Map<string, DeviceLinks>();
    const directory = { target: (id: string) => { const p = where.get(id); return p ? { key: p.key.publicKey, direct: p.localAddresses().direct } : undefined; } };
    const start = async (name: string) => {
      const l = await startDeviceLinks({
        home: mkdtempSync(join(tmpdir(), "clover-h-sidecar-rev-")), store: new MemorySecretStore(), clock, self: { name }, directory,
        sidecar: { binary: BIN, relay: "disabled", bind: "127.0.0.1:0", n0Lookup: false }, transport: { redialBackoffMs: [0, 200, 200, 200] },
      });
      where.set(l.key.id, l);
      stops.push(() => l.close());
      return l;
    };
    const a = await start("Studio");
    const b = await start("Laptop");
    const view = await a.pairing.begin();
    const joined = await b.pairing.join(view.qr!);
    await waitFor(() => a.pairing.get(view.pairingId)?.status === "words");
    await Promise.all([a.pairing.confirm(view.pairingId, joined.words!, { terminal: true }), b.pairing.confirm(view.pairingId, joined.words!, { terminal: true })]);
    await waitFor(() => a.registry.get(b.key.id) !== undefined && b.registry.get(a.key.id) !== undefined);
    const link = await b.transport.connect(a.key.id);
    await waitFor(() => link.view().up, 10_000);
    await a.registry.revoke(b.key.id);
    await waitFor(() => !link.view().up, 10_000);
    const e = (await link.request("echo", 1).catch((x: unknown) => x)) as { code?: string; detail?: Record<string, unknown> };
    expect(e.code).toBe("refused");
    expect(e.detail?.revoked).toBe(true);
    // Told it was revoked, it stops wanting the link, so it doesn't keep dialling.
    expect((link as unknown as { wanted: boolean }).wanted).toBe(false);
    await Bun.sleep(800);
    expect(link.view().up).toBe(false);
    expect(isContractError(await link.request("echo", 1).catch((x: unknown) => x), "refused")).toBe(true);
  }, 40_000);

  test("a key the core didn't allow is closed at the sidecar's door", async () => {
    const a = await device("Studio");
    const b = await device("Stranger");
    // The allow list follows A's registry, which pairs no one.
    stops.push(followRegistry(a.wire, a.registry));
    a.wire.onIncoming("clover/link/1", () => {
      throw new Error("the sidecar let an unknown key through");
    });
    const conn = await b.wire.dial({ key: a.key.publicKey, direct: a.direct }, { alpn: "clover/link/1", timeoutMs: 5000 }).catch((e: unknown) => e);
    if (conn instanceof Error) return; // refused during the handshake
    const closed = await (conn as { closed: Promise<{ code: number }> }).closed;
    expect(closed.code).toBe(2);
  }, 20_000);

  test("a big transfer to a slow reader keeps what each side holds within the stream window, and the reader can answer after the writer's FIN (S6.2)", async () => {
    const a = await device("Studio");
    const b = await device("Laptop");
    await allowEach(a, b);
    const W = STREAM_WINDOW;
    const total = 48 * 1024 * 1024;
    const chunk = 256 * 1024;
    // The reader takes nothing until `go`, then takes its time: a pause after every 512 KiB.
    let go!: () => void;
    const started = new Promise<void>((r) => (go = r));
    let reading = false;
    let got = 0;
    let since = 0;
    const theirs = new Bun.CryptoHasher("sha256");
    const finished = new Promise<WireStream>((resolve) => {
      b.wire.onIncoming("clover/link/1", (conn) => conn.onStream((ws) => {
        ws.onData(async (c) => {
          if (!reading) await started;
          got += c.byteLength;
          theirs.update(c);
          since += c.byteLength;
          if (since >= 512 * 1024) {
            since = 0;
            await Bun.sleep(5);
          }
        });
        ws.onFin(() => resolve(ws));
      }));
    });
    const conn = await a.wire.dial({ key: b.key.publicKey, direct: b.direct }, { alpn: "clover/link/1", timeoutMs: 5000 });
    const s = conn.openStream(0);
    const ours = new Bun.CryptoHasher("sha256");
    const base = crypto.getRandomValues(new Uint8Array(chunk));
    let written = 0;
    const writing = (async () => {
      for (let i = 0; written < total; i++) {
        const c = base.slice();
        new DataView(c.buffer).setUint32(0, i);
        ours.update(c);
        await s.write(c);
        written += c.byteLength;
      }
      s.finish();
    })();
    // A failed write fails the test at the next sample, with its own error, not as an unhandled one between tests.
    let writeFailed: unknown;
    writing.catch((e: unknown) => (writeFailed = e ?? new Error("the write failed")));

    // Nothing is read: the writer is held back after QUIC's stream window and a window on each side of each pipe.
    // What is guaranteed is that bound, never how far the writer gets by a given moment (a loaded runner may be slow to
    // fill it): so every sample over a while stays within it, and the windows on both sides with it. No lower bound on
    // a sample.
    const ahead = 1_250_000 + 3 * W + chunk;
    const bound = async () => {
      if (writeFailed !== undefined) throw writeFailed;
      const [sa, sb] = await Promise.all([a.wire.stats(), b.wire.stats()]);
      expect(written - got).toBeLessThanOrEqual(ahead);
      expect(sa.core.queuedWrites).toBeLessThanOrEqual(chunk);
      expect(sa.core.unackedWrites).toBeLessThanOrEqual(W);
      expect(sa.sidecar.queuedWrites).toBeLessThanOrEqual(W);
      expect(sb.sidecar.unconsumed).toBeLessThanOrEqual(W);
      expect(sb.sidecar.outBytes).toBeLessThanOrEqual(W);
      expect(sb.core.unconsumed).toBeLessThanOrEqual(W);
      return { sa, sb };
    };
    const end = Date.now() + 1_500;
    while (Date.now() < end) {
      await bound();
      await Bun.sleep(50);
    }
    // Something did reach the reader, which waits on the core's side (waited for: when depends on the runner).
    for (const until = Date.now() + 15_000; ; await Bun.sleep(25)) {
      const { sb } = await bound();
      if (sb.sidecar.unconsumed + sb.core.unconsumed > 0) break;
      if (Date.now() > until) throw new Error("nothing reached the reader's side");
    }
    expect(got).toBe(0);
    expect(written).toBeLessThanOrEqual(ahead);

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
    // A sample that fails ends the wait for the FIN with its error.
    const ws = await Promise.race([finished, samples.then(() => finished)]);
    await writing;
    sampling = false;
    expect(await samples).toBeGreaterThan(0);
    expect(got).toBe(written);
    expect(theirs.digest("hex")).toBe(ours.digest("hex"));

    // The writer finished; the reader's own direction is still open, and its answer gets back.
    const answer = new Promise<number>((resolve) => {
      let n = 0;
      s.onData((c) => {
        n += c.byteLength;
      });
      s.onFin(() => resolve(n));
    });
    await ws.write(new Uint8Array(3 * W).fill(1));
    ws.finish();
    expect(await answer).toBe(3 * W);
  }, 90_000);

  test("a reset gets through while the writer waits on a reader that takes nothing", async () => {
    const a = await device("Studio");
    const b = await device("Laptop");
    await allowEach(a, b);
    const reset = new Promise<number>((resolve) => {
      b.wire.onIncoming("clover/link/1", (conn) => conn.onStream((ws) => {
        ws.onData(() => new Promise<void>(() => undefined));
        ws.onReset(resolve);
      }));
    });
    const conn = await a.wire.dial({ key: b.key.publicKey, direct: b.direct }, { alpn: "clover/link/1", timeoutMs: 5000 });
    const s = conn.openStream(0);
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 32; i++) writes.push(s.write(new Uint8Array(256 * 1024)).then(() => "ok", (e: unknown) => e));
    await Bun.sleep(500);
    expect((await a.wire.stats()).sidecar.queuedWrites).toBeGreaterThan(0);
    s.reset(1);
    expect(await reset).toBe(1);
    const settled = await Promise.all(writes);
    expect(settled.some((r) => r instanceof WireOffline)).toBe(true);
    // The writer let its queue go with the stream.
    let left = -1;
    for (let i = 0; i < 100 && left !== 0; i++) {
      left = (await a.wire.stats()).sidecar.queuedWrites;
      if (left !== 0) await Bun.sleep(20);
    }
    expect(left).toBe(0);
  }, 20_000);

  test("a sidecar killed mid-link is started again under the same key, and the link comes back (S6.1)", async () => {
    const procs: SidecarProcess[] = [];
    const spawn = (argv: readonly string[]) => {
      const p = spawnSidecar(argv);
      procs.push(p);
      return p;
    };
    const where = new Map<string, DeviceLinks>();
    const directory = { target: (id: string) => { const p = where.get(id); return p ? { key: p.key.publicKey, direct: p.localAddresses().direct } : undefined; } };
    const start = async (name: string, own: boolean) => {
      const l = await startDeviceLinks({
        home: mkdtempSync(join(tmpdir(), "clover-h-sidecar-restart-")), store: new MemorySecretStore(), clock, self: { name }, directory,
        sidecar: { binary: BIN, relay: "disabled", bind: "127.0.0.1:0", n0Lookup: false, ...(own ? { spawn } : {}) },
        transport: { redialBackoffMs: [0, 200, 500, 1000] },
      });
      where.set(l.key.id, l);
      stops.push(() => l.close());
      return l;
    };
    const a = await start("Studio", true);
    const b = await start("Laptop", false);
    await pairBoth(a, b);
    a.transport.handle("who", () => "studio");
    b.transport.handle("who", () => "laptop");
    const link = await a.transport.connect(b.key.id);
    expect(await link.request<string>("who", null)).toBe("laptop");

    const wire = a.wire as SidecarWire;
    let restarts = 0;
    wire.onRestart(() => restarts++);
    const before = a.localAddresses().direct.join();
    process.kill(procs[0]!.pid!, "SIGKILL");
    await waitFor(() => !link.view().up, 5000);
    await waitFor(() => restarts === 1, 10_000);
    expect(procs.length).toBe(2);
    expect(a.wire).toBe(wire);
    expect(toHex(wire.publicKey)).toBe(toHex(a.key.publicKey));
    // The link comes back by itself (the transport re-dials), to the same device under the same key.
    await waitFor(() => link.view().up, 15_000);
    expect(await link.request<string>("who", null)).toBe("laptop");
    // The daemon read the net report again: the new sidecar is on another port.
    await waitFor(() => a.localAddresses().direct.join() !== before, 5000);
    // And the other side links back to it.
    const back = await b.transport.connect(a.key.id);
    await waitFor(() => back.view().up, 10_000);
    expect(await back.request<string>("who", null)).toBe("studio");
  }, 60_000);

  test("the controller is BBR with its window sized to each path, and control messages get through during a bulk transfer (S6.5)", async () => {
    const where = new Map<string, DeviceLinks>();
    const directory = { target: (id: string) => { const p = where.get(id); return p ? { key: p.key.publicKey, direct: p.localAddresses().direct } : undefined; } };
    const start = async (name: string) => {
      const l = await startDeviceLinks({
        home: mkdtempSync(join(tmpdir(), "clover-h-sidecar-cc-")), store: new MemorySecretStore(), clock, self: { name }, directory,
        sidecar: { binary: BIN, relay: "disabled", bind: "127.0.0.1:0", n0Lookup: false },
      });
      where.set(l.key.id, l);
      stops.push(() => l.close());
      return l;
    };
    const a = await start("Studio");
    const b = await start("Laptop");
    await pairBoth(a, b);
    b.transport.handle("echo", (p) => p);
    const received = new Promise<number>((resolve) => {
      b.transport.onStream("blob", (st) => {
        let n = 0;
        st.onData((c) => (n += c.byteLength));
        st.onEnd(() => resolve(n));
      });
    });
    const link = await a.transport.connect(b.key.id);
    expect(await link.request<number>("echo", 1)).toBe(1);

    const total = 96 * 1024 * 1024;
    const piece = new Uint8Array(256 * 1024).fill(9);
    let done = false;
    const s = link.openStream("blob", "files");
    const writing = (async () => {
      for (let n = 0; n < total; n += piece.byteLength) await s.write(piece);
      s.end();
    })();
    // Control requests all through the transfer.
    const took: number[] = [];
    const asking = (async () => {
      while (!done) {
        const t = performance.now();
        expect(await link.request<number>("echo", took.length)).toBe(took.length);
        took.push(performance.now() - t);
        await Bun.sleep(5);
      }
    })();
    // The window, sampled all through the transfer and after it: always BBR's, within its floor and ceiling, and
    // whenever it is in probeBw (which a sample may or may not catch: a fast loopback transfer can end before BBR
    // leaves startup), 1.25 times the path's bandwidth-delay product plus the ACK aggregation seen.
    const check = async (): Promise<void> => {
      const st = (await (a.wire as SidecarWire).stats()).sidecar;
      expect(st.congestion).toBe("bbr");
      expect(st.quic).toMatchObject({ windowGain: 1.25, windowFloor: 64 * 1024, windowCeiling: 16 * 1024 * 1024, streamWindow: 1_250_000 });
      const paths = st.conns.flatMap((c) => c.paths);
      const sel = paths.find((p) => p.selected === true);
      expect(sel).toBeDefined();
      const bbr = sel!.bbr as { mode: string; bandwidth: number; minRttNs: number; ackHeight: number; window: number; sized: number; recovery: boolean };
      expect(bbr).not.toBeNull();
      expect(bbr.window).toBeLessThanOrEqual(16 * 1024 * 1024);
      if (bbr.mode === "probeBw") {
        const bdp = (bbr.bandwidth * bbr.minRttNs) / 1e9;
        const want = Math.min(16 * 1024 * 1024, Math.max(64 * 1024, 1.25 * bdp + bbr.ackHeight));
        expect(Math.abs(bbr.sized - want)).toBeLessThanOrEqual(2);
        if (!bbr.recovery) expect(bbr.window).toBeLessThanOrEqual(bbr.sized);
      }
    };
    let samples = 0;
    const sampling = (async () => {
      while (!done) {
        await check();
        samples++;
        await Bun.sleep(25);
      }
    })();
    await writing;
    done = true;
    await Promise.all([asking, sampling]);
    expect(await received).toBe(total);
    await check();
    expect(samples).toBeGreaterThan(0);
    // Control messages get through while the bulk stream runs: each one within a generous bound (loopback, a loaded
    // runner), never waiting for the stream to drain.
    expect(took.length).toBeGreaterThan(0);
    expect(Math.max(...took)).toBeLessThan(2000);

    // `cubic` keeps noq's own controller.
    const c = await device("Cubic", { congestion: "cubic" });
    expect((await c.wire.stats()).sidecar.congestion).toBe("cubic");
  }, 90_000);
});

async function pairBoth(a: DeviceLinks, b: DeviceLinks): Promise<void> {
  const view = await a.pairing.begin();
  const joined = await b.pairing.join(view.qr!);
  await waitFor(() => a.pairing.get(view.pairingId)?.status === "words");
  await Promise.all([a.pairing.confirm(view.pairingId, joined.words!, { terminal: true }), b.pairing.confirm(view.pairingId, joined.words!, { terminal: true })]);
  await waitFor(() => a.registry.get(b.key.id) !== undefined && b.registry.get(a.key.id) !== undefined);
}

/** A sidecar process in memory: it answers `init` with `ready` (or an error) and records the core's control messages. */
class FakeSidecar implements SidecarProcess {
  readonly ops: Record<string, unknown>[] = [];
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly #reader = new FrameReader(MAX_FRAME + 16);
  #ctl!: ReadableStreamDefaultController<Uint8Array>;
  #exit!: (n: number) => void;
  #dead = false;

  constructor(readonly publicKey: string, readonly fail = false) {
    this.stdout = new ReadableStream<Uint8Array>({ start: (c) => void (this.#ctl = c) });
    this.exited = new Promise((r) => (this.#exit = r));
  }

  write(bytes: Uint8Array): void {
    if (this.#dead) return;
    for (const f of this.#reader.push(bytes)) {
      if (f[0] !== 0) continue;
      const m = JSON.parse(fromUtf8(f.subarray(1))) as Record<string, unknown>;
      this.ops.push(m);
      if (m.op === "init") {
        if (this.fail) {
          this.emit({ ev: "error", message: "bind failed", fatal: true });
          this.kill();
        } else this.emit({ ev: "ready", publicKey: this.publicKey, relay: null });
      } else if (m.op === "shutdown") this.kill();
    }
  }

  emit(m: Record<string, unknown>): void {
    if (this.#dead) return;
    const body = utf8(JSON.stringify(m));
    const f = new Uint8Array(5 + body.byteLength);
    new DataView(f.buffer).setUint32(0, 1 + body.byteLength);
    f.set(body, 5);
    this.#ctl.enqueue(f);
  }

  kill(): void {
    if (this.#dead) return;
    this.#dead = true;
    this.#ctl.close();
    this.#exit(0);
  }
}

describe("the link sidecar's binary", () => {
  test("without a binary, the wire starts the one shipped beside the daemon, never one from the PATH", async () => {
    const key = await DeviceKey.loadOrCreate(new MemorySecretStore());
    const argv: string[][] = [];
    const wire = await SidecarWire.start({
      key, relay: "disabled", n0Lookup: false,
      spawn: (a) => {
        argv.push([...a]);
        return new FakeSidecar(toHex(key.publicKey), false);
      },
    });
    stops.push(() => wire.close());
    expect(argv).toEqual([[bundledLinkBinary()]]);
  });
});

describe("the sidecar's stdin", () => {
  test("a write to a process that just died never throws, nor leaves a rejection behind (EPIPE, as Windows answers it later)", async () => {
    let unhandled = 0;
    const count = () => void unhandled++;
    process.on("unhandledRejection", count);
    try {
      const epipe = () => Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" });
      const later = pipeWriter({ write: () => Promise.reject(epipe()), flush: () => Promise.reject(epipe()) });
      const now = pipeWriter({ write: () => { throw epipe(); }, flush: () => 0 });
      later(new Uint8Array(4));
      now(new Uint8Array(4));
      await Bun.sleep(20);
      expect(unhandled).toBe(0);
    } finally {
      process.off("unhandledRejection", count);
    }
  });
});

describe("the link sidecar's restart (S6.1), against a fake process", () => {
  test("restarts with backoff under the same seed, allow list and lookup, ends what it carried offline, and holds dials until it is back", async () => {
    const store = new MemorySecretStore();
    const key = await DeviceKey.loadOrCreate(store);
    const seedHex = toHex(fromBase64(key.seed().reveal())!);
    const procs: FakeSidecar[] = [];
    const logs: string[] = [];
    let failNext = false;
    const wire = await SidecarWire.start({
      binary: "clover-link", key, relay: "disabled", n0Lookup: false, restartBackoffMs: [30, 150, 400],
      onLog: (l) => logs.push(l),
      spawn: () => {
        const p = new FakeSidecar(toHex(key.publicKey), failNext);
        failNext = false;
        procs.push(p);
        return p;
      },
    });
    stops.push(() => wire.close());
    const peer = new Uint8Array(32).fill(7);
    wire.allow([peer]);
    wire.setN0Lookup(true);
    expect(procs[0]!.ops.map((o) => o.op)).toEqual(["init", "allow", "n0Lookup"]);
    expect(procs[0]!.ops[0]).toMatchObject({ seed: seedHex, n0Lookup: false, window: STREAM_WINDOW, allow: [], revoked: [] });
    expect(procs[0]!.ops[2]).toMatchObject({ on: true });

    // A connection with a stream, and a dial in flight, when the process dies.
    const conns: WireConn[] = [];
    wire.onIncoming("clover/link/1", (c) => conns.push(c));
    procs[0]!.emit({ ev: "incoming", conn: 1, peerKey: toHex(peer), alpn: "clover/link/1", path: { kind: "lan" } });
    await waitFor(() => conns.length === 1);
    const streams: WireStream[] = [];
    conns[0]!.onStream((st) => streams.push(st));
    procs[0]!.emit({ ev: "stream", conn: 1, stream: 1 });
    await waitFor(() => streams.length === 1);
    const resets: number[] = [];
    streams[0]!.onReset((c) => resets.push(c));
    const inFlight = wire.dial({ key: peer, direct: ["127.0.0.1:9"] }, { alpn: "clover/link/1", timeoutMs: 5000 }).catch((e: unknown) => e);
    await waitFor(() => procs[0]!.ops.some((o) => o.op === "dial"));
    let restarts = 0;
    wire.onRestart(() => restarts++);

    const t0 = Date.now();
    procs[0]!.kill();
    expect(await conns[0]!.closed).toMatchObject({ code: CLOSE_LOST, local: false });
    expect(await inFlight).toBeInstanceOf(WireOffline);
    expect(resets).toEqual([RESET_CONN_LOST]);
    expect(await streams[0]!.write(new Uint8Array(1)).catch((e: unknown) => e)).toBeInstanceOf(WireOffline);
    // A dial made while it restarts waits for the new process.
    const waiting = wire.dial({ key: peer, direct: ["127.0.0.1:9"] }, { alpn: "clover/link/1", timeoutMs: 5000 });
    await waitFor(() => restarts === 1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(procs.length).toBe(2);
    // The same seed, over stdin again, with the last allow list and the lookup as it is now.
    expect(procs[1]!.ops[0]).toMatchObject({ op: "init", seed: seedHex, allow: [toHex(peer)], revoked: [], n0Lookup: true });
    await waitFor(() => procs[1]!.ops.some((o) => o.op === "dial"));
    const d = procs[1]!.ops.find((o) => o.op === "dial")!;
    procs[1]!.emit({ ev: "dialed", id: d.id, conn: 1, path: { kind: "lan" } });
    const again = await waiting;
    expect(again.id).not.toBe(conns[0]!.id);
    // What belonged to the dead process stays dead: no stream of the old connection reaches the new one.
    const late = conns[0]!.openStream(3);
    expect(await late.write(new Uint8Array(1)).catch((e: unknown) => e)).toBeInstanceOf(WireOffline);
    expect(procs[1]!.ops.some((o) => o.op === "open")).toBe(false);

    // Dying again at once backs off further, and a start that fails backs off once more.
    failNext = true;
    const t1 = Date.now();
    procs[1]!.kill();
    await waitFor(() => procs.length === 3);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(140);
    await waitFor(() => restarts === 2, 3000);
    expect(procs.length).toBe(4);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(140 + 390);
    expect(logs.some((l) => l.includes("starting it again"))).toBe(true);
    // The seed went only over stdin: never into a log line.
    expect(logs.some((l) => l.includes(seedHex))).toBe(false);

    // Closing ends it for good.
    await wire.close();
    expect(procs[3]!.ops.at(-1)?.op).toBe("shutdown");
    await Bun.sleep(500);
    expect(procs.length).toBe(4);
    expect(await wire.dial({ key: peer }, { alpn: "clover/link/1" }).catch((e: unknown) => e)).toBeInstanceOf(WireOffline);
  }, 20_000);
});

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}
