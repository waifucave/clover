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
import { SidecarWire } from "../sidecar-wire";
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
  const report = await wire.netReport();
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

  test("a key the core didn't allow is closed at the sidecar's door", async () => {
    const a = await device("Studio");
    const b = await device("Stranger");
    a.wire.allow([]);
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
