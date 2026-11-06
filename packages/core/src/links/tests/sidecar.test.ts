// The link over real iroh: two `clover-link` sidecars on loopback (no relay, nothing leaves the machine), the
// transport on top, and pairing through the pair ALPN. Runs when the sidecar is built: `CLOVER_LINK_BIN`, or
// native/link's release build (the link workflow builds it; locally `cargo build --release` in native/link).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContractError } from "../../contracts/common";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { FileDeviceRegistry } from "../../devices/registry";
import { SystemClock } from "../../clock/system-clock";
import { DeviceKey } from "../../identity/device-key";
import { PairingService } from "../pairing";
import { followRegistry, SidecarWire } from "../sidecar-wire";
import { type DeviceLinks, startDeviceLinks } from "../node";
import { CloverLinkTransport } from "../transport";

const BIN = process.env.CLOVER_LINK_BIN ?? join(import.meta.dir, "../../../../../native/link/target/release/clover-link");
const built = existsSync(BIN);
const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

async function device(name: string) {
  const store = new MemorySecretStore();
  const key = await DeviceKey.loadOrCreate(store);
  const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-h-sidecar-")), key, clock, self: { name } });
  const wire = await SidecarWire.start({ binary: BIN, key, relay: "disabled", n0Lookup: false, bind: "127.0.0.1:0" });
  stops.push(() => wire.close());
  const report = await wire.settledReport();
  return { name, store, key, registry, wire, direct: report.direct };
}
type Dev = Awaited<ReturnType<typeof device>>;

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
});

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}
