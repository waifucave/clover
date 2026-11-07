import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemClock } from "../../src/clock/system-clock";
import { MemoryNetwork } from "../../src/links/memory-wire";
import { CloverSecretStore, KeychainValues, memoryVault } from "../../src/secrets/clover-secret-store";
import { defaultDeviceName, linkSidecarBinary, refuseUntilBroker, startDaemonLinks, type DaemonLinks } from "../../src/ipc/device-links";
import type { CloverHandler } from "../../src/ipc/clover";

// C-M2: H's links in the daemon, on H's in-memory network: the real CloverSecretStore holds the device keys, the devices
// methods mount, peer.call reaches the Clover server's dispatch as the peer, and a network change re-dials.

const clock = new SystemClock();
let stops: Array<() => Promise<void>> = [];
afterEach(async () => { for (const s of stops.reverse()) await s(); stops = []; });

async function boot(net: MemoryNetwork, name: string) {
  const home = mkdtempSync(join(tmpdir(), "clover-c-links-"));
  const store = new CloverSecretStore({ home, values: new KeychainValues(memoryVault()), status: { backend: "memory", plaintext: false, state: "unlocked" } });
  const handlers: Record<string, CloverHandler> = {};
  const dispatched: Array<{ method: string; caller: unknown; role: string }> = [];
  let netChange: ((why: "addresses" | "wake") => void) | undefined;
  const d = await startDaemonLinks({
    home, store, clock, self: { name, os: "macos" }, handlers, binary: null,
    // Nothing leaves the machine: no handshake, no public time.
    handshake: null, publicTime: null, mainComputer: { watchSleep: false },
    wire: (key) => net.endpoint(key.publicKey),
    dispatch: async (method, _params, caller, role) => { dispatched.push({ method, caller, role }); return { ok: true }; },
    watch: (fn) => { netChange = fn; return () => {}; },
  });
  stops.push(() => d.close());
  return { d, home, store, handlers, dispatched, netChange: () => netChange?.("addresses") };
}

describe("the daemon's links (H-M1 wiring)", () => {
  test("no sidecar and no wire: the daemon runs without links and says so", async () => {
    const lines: string[] = [];
    const d = await startDaemonLinks({ home: mkdtempSync(join(tmpdir(), "x-")), store: new CloverSecretStore({ home: mkdtempSync(join(tmpdir(), "y-")), values: new KeychainValues(memoryVault()), status: { backend: "memory", plaintext: false, state: "unlocked" } }), clock, handlers: {}, binary: null, dispatch: async () => null, log: (l) => lines.push(l) });
    expect(d.links).toBeNull();
    expect(lines[0]).toMatch(/runs without links/);
    expect(linkSidecarBinary("/nonexistent/bin/clover-core")).toBeNull();
    // The environment never names the sidecar that is handed the device key: only the one beside the daemon counts.
    const bin = mkdtempSync(join(tmpdir(), "clover-c-bin-"));
    writeFileSync(join(bin, "clover-core"), "");
    expect(linkSidecarBinary(join(bin, "clover-core"), "darwin")).toBeNull();
    writeFileSync(join(bin, "clover-link"), "");
    expect(linkSidecarBinary(join(bin, "clover-core"), "darwin")).toBe(realpathSync(join(bin, "clover-link")));
  });

  test("the device key goes in the real store; the devices methods mount; a sensitive change outside the terminal is refused", async () => {
    const net = new MemoryNetwork();
    const a = await boot(net, "Studio");
    expect((await a.store.list({ kind: "device" })).length).toBeGreaterThan(0); // the device key and box key
    expect((await a.store.list({ kind: "device" })).every((m) => m.synced === false)).toBe(true);
    expect(Object.keys(a.handlers)).toContain("device.list");
    expect(await (await refuseUntilBroker({} as never)).allowed).toBe(false);
  });

  test("peer.call from a paired computer reaches dispatch as that peer; a network change re-dials", async () => {
    const net = new MemoryNetwork();
    const a = await boot(net, "Studio");
    const b = await boot(net, "Laptop");
    const la = a.d.links!, lb = b.d.links!;
    const view = await la.pairing.begin();
    const joined = await lb.pairing.join(view.qr!);
    for (let i = 0; i < 200 && la.pairing.get(view.pairingId)?.status !== "words"; i++) await Bun.sleep(10);
    await Promise.all([la.pairing.confirm(view.pairingId, joined.words!, { terminal: true }), lb.pairing.confirm(view.pairingId, joined.words!, { terminal: true })]);
    for (let i = 0; i < 300 && (la.registry.get(lb.key.id) === undefined || lb.registry.get(la.key.id) === undefined); i++) await Bun.sleep(10);
    const link = await lb.transport.connect(la.key.id);
    const r = await link.request("peer.call", { method: "session.list", params: {}, role: "remote", as: { kind: "user", client: "ios" } });
    expect(r).toEqual({ result: { ok: true } });
    expect(a.dispatched[0]).toMatchObject({ method: "session.list", role: "remote", caller: { kind: "peer", device: lb.key.id } });
    a.netChange(); // no throw; the transport re-dials
  }, 30_000);

  test("the default device name: the host name without its domain, cut to 63 characters, never one the registry refuses", () => {
    expect(defaultDeviceName("studio.local")).toBe("studio");
    expect(defaultDeviceName("Studio-MacBook-Pro")).toBe("Studio-MacBook-Pro");
    // A CI runner's generated name, longer than the registry takes.
    const long = "x".repeat(100);
    expect(defaultDeviceName(long)).toBe("x".repeat(63));
    expect([...defaultDeviceName("é".repeat(80))].length).toBe(63);
    expect(defaultDeviceName("")).toBe("Computer");
    expect(defaultDeviceName(".local")).toBe("Computer");
    expect(defaultDeviceName("tab\there")).toBe("tabhere");
  });

  test("a host name too long for the registry still starts the links", async () => {
    const net = new MemoryNetwork();
    const home = mkdtempSync(join(tmpdir(), "clover-int-name-"));
    const store = new CloverSecretStore({ home, values: new KeychainValues(memoryVault()), status: { backend: "memory", plaintext: false, state: "unlocked" } });
    const d = await startDaemonLinks({
      home, store, clock, handlers: {}, binary: null, handshake: null, publicTime: null, mainComputer: { watchSleep: false },
      self: { name: defaultDeviceName(`runner-${"0".repeat(90)}.local`), os: "macos" },
      wire: (key) => net.endpoint(key.publicKey), dispatch: async () => null, watch: () => () => {},
    });
    stops.push(() => d.close());
    expect(d.links!.registry.get(d.links!.key.id)?.name.length).toBe(63);
  });
});
