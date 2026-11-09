import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemClock } from "../../src/clock/system-clock";
import { MemoryNetwork } from "../../src/links/memory-wire";
import { MemoryRendezvous } from "../../src/links/pairing";
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
  test("no sidecar: the links start local-only (one computer on its own), say so, and reach no other device", async () => {
    const lines: string[] = [];
    const handlers: Record<string, CloverHandler> = {};
    const d = await startDaemonLinks({
      home: mkdtempSync(join(tmpdir(), "x-")), store: new CloverSecretStore({ home: mkdtempSync(join(tmpdir(), "y-")), values: new KeychainValues(memoryVault()), status: { backend: "memory", plaintext: false, state: "unlocked" } }),
      // The defaults: local-only must not reach for production's handshake, SNTP or the network watch on its own.
      clock, handlers, binary: null, mainComputer: { watchSleep: false },
      self: { name: "Studio", os: "macos" }, dispatch: async () => null, log: (l) => lines.push(l),
    });
    stops.push(() => d.close());
    expect(lines[0]).toMatch(/runs local-only, without links to other devices/);
    const links = d.links!;
    expect(links).toBeDefined();
    expect(links.registry.get(links.key.id)).toMatchObject({ name: "Studio" });
    expect(Object.keys(handlers)).toContain("device.list");
    expect(links.sidecarPid()).toBeUndefined();
    // Nothing leaves the machine: no handshake's directory or group, no directories' driver.
    expect(links.directory).toBeUndefined();
    expect(links.groups).toBeUndefined();
    expect(links.driver).toBeUndefined();
    // A lone computer: its own main, holding its lease.
    for (let i = 0; i < 200 && links.main?.lease.state().holder !== links.key.id; i++) await Bun.sleep(10);
    expect(links.main?.lease.state().holder).toBe(links.key.id);
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

  // Lane I's account settings (#258): the default handshake, the account and short codes' rendezvous all come from
  // `waifucaveAccount` (here `<clover home>/account.json`, read as a test build reads it), at a local stand-in.
  async function accountBoot(settings: Record<string, string>) {
    // The environment's overrides (a dev or test build reads them) would win over the file: none while this runs.
    const saved = Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith("CLOVER_ACCOUNT_") || k === "CLOVER_HANDSHAKE_URL").map((k) => [k, process.env[k]]));
    for (const k of Object.keys(saved)) delete process.env[k];
    stops.push(async () => void Object.assign(process.env, saved));
    const seen: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(req) {
        const u = new URL(req.url);
        seen.push(`${req.method} ${u.pathname}`);
        if (u.pathname.startsWith("/v1/rendezvous/") && req.method === "PUT") return new Response(null, { status: 201 });
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });
    stops.push(async () => void server.stop(true));
    const url = `http://127.0.0.1:${server.port}`;
    const home = mkdtempSync(join(tmpdir(), "clover-int-account-"));
    writeFileSync(join(home, "account.json"), JSON.stringify(Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, v.replace("$URL", url)]))));
    const store = new CloverSecretStore({ home, values: new KeychainValues(memoryVault()), status: { backend: "memory", plaintext: false, state: "unlocked" } });
    const lines: string[] = [];
    const net = new MemoryNetwork();
    const d = await startDaemonLinks({
      home, store, clock, self: { name: "Studio", os: "macos" }, handlers: {}, binary: null,
      publicTime: null, mainComputer: { watchSleep: false }, driver: false,
      wire: (key) => net.endpoint(key.publicKey),
      dispatch: async () => null, watch: () => () => {}, log: (l) => lines.push(l),
    });
    stops.push(() => d.close());
    return { d, seen, lines };
  }

  test("the account settings pick the handshake and the short codes' rendezvous; with no sign-in project the device runs signed out", async () => {
    const { d, seen, lines } = await accountBoot({ handshakeUrl: "$URL" });
    const links = d.links!;
    expect(links.directory).toBeDefined();
    expect(links.accountDirectory).toBeUndefined();
    expect(lines.some((l) => /\[account\].*runs signed out/.test(l))).toBe(true);
    const view = await links.pairing.begin();
    expect(view.code).toBeDefined();
    expect(seen.some((r) => r.startsWith("PUT /v1/rendezvous/"))).toBe(true);
  });

  test("with a sign-in project the links get the account client (and its devices at the handshake)", async () => {
    const { d, lines } = await accountBoot({ handshakeUrl: "$URL", authUrl: "$URL/supabase", anonKey: "anon-public-key", serviceUrl: "$URL/auth" });
    expect(d.links!.accountDirectory).toBeDefined();
    expect(lines.some((l) => /runs signed out/.test(l))).toBe(false);
  });

  test("a test's own handshake (or none) has no account or rendezvous unless it passes them", async () => {
    const net = new MemoryNetwork();
    const start = async (account?: { rendezvous: MemoryRendezvous }) => {
      const home = mkdtempSync(join(tmpdir(), "clover-int-account-"));
      const d = await startDaemonLinks({
        home, store: new CloverSecretStore({ home, values: new KeychainValues(memoryVault()), status: { backend: "memory", plaintext: false, state: "unlocked" } }),
        clock, self: { name: "Studio", os: "macos" }, handlers: {}, binary: null, handshake: null, publicTime: null,
        mainComputer: { watchSleep: false }, driver: false, wire: (key) => net.endpoint(key.publicKey),
        dispatch: async () => null, watch: () => () => {}, ...(account ? { account } : {}),
      });
      stops.push(() => d.close());
      return d.links!;
    };
    expect((await (await start()).pairing.begin()).code).toBeUndefined();
    const rendezvous = new MemoryRendezvous();
    expect((await (await start({ rendezvous })).pairing.begin()).code).toBeDefined();
    expect(rendezvous.slots.size).toBe(1);
  });

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

  test("a dev build with a handshake it can't use (http to a host that isn't this one) doesn't start its links, and never falls back to production's", async () => {
    const saved = process.env.CLOVER_HANDSHAKE_URL;
    process.env.CLOVER_HANDSHAKE_URL = "http://handshake.example.invalid";
    try {
      const home = mkdtempSync(join(tmpdir(), "clover-int-account-"));
      const net = new MemoryNetwork();
      const err = await startDaemonLinks({
        home, store: new CloverSecretStore({ home, values: new KeychainValues(memoryVault()), status: { backend: "memory", plaintext: false, state: "unlocked" } }),
        clock, self: { name: "Studio", os: "macos" }, handlers: {}, binary: null, publicTime: null, mainComputer: { watchSleep: false }, driver: false,
        wire: (key) => net.endpoint(key.publicKey), dispatch: async () => null, watch: () => () => {},
      }).then((d) => (stops.push(() => d.close()), undefined), (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/the links don't start: handshakeUrl \(from env\) isn't used.*never falls back to production's handshake/);
      expect((err as Error).message).not.toContain("example.invalid"); // the value itself is never said
    } finally {
      if (saved === undefined) delete process.env.CLOVER_HANDSHAKE_URL;
      else process.env.CLOVER_HANDSHAKE_URL = saved;
    }
  });
});
