// The daemon integration, on a real daemon in a temp home: lane H's links, lane J's computer node and lane D's bot side
// start over the links once the socket is bound; `device.*`, `main.*` and `bot.*` answer over the Clover socket; the
// main computer is the lease's (a computer that doesn't hold it is never `isMain`, so what runs on the main alone runs
// on one computer); and the stop closes them all, leaving no socket and no sidecar behind.
//
// Fakes only where each part's own lane uses them: H's in-memory network and local handshake, D's plugin registry and
// session drivers. The second computer is built from the same assembly the daemon uses (`startDaemonLinks`,
// `startDaemonParts`), since one process runs one daemon. The sidecar test runs the real `clover-link` on loopback
// (no relay, nothing published) when it is built, as lane H's sidecar tests do.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../src/auth/secret-store";
import { botManifest, Drivers, pluginFromFolder, writePlugin } from "../src/bots/tests/fixtures";
import { catalogPointDecl } from "../../plugin-sdk/src/catalogs/index";
import { SystemClock } from "../src/clock/system-clock";
import { FakePluginRegistry } from "../src/contracts/fakes/plugin-registry";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { startDaemonParts, type DaemonBotsInput, type DaemonParts } from "../src/daemon-parts";
import { startDaemonLinks, type DaemonLinks } from "../src/ipc/device-links";
import { cloverCall } from "../src/ipc/clover-client";
import { HandshakeClient } from "../src/links/handshake";
import { startFakeHandshake } from "../src/links/handshake-fake";
import { MemoryNetwork } from "../src/links/memory-wire";
import type { DeviceLinks } from "../src/links/node";
import { CloverSecretStore, KeychainValues, memoryVault } from "../src/secrets/clover-secret-store";
import { mainSessionIdFor } from "../src/sessions/ids";

const clock = new SystemClock();
let stops: Array<() => unknown> = [];
let daemon: RunningDaemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  for (const s of stops.reverse()) await s();
  stops = [];
});

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

async function waitFor(what: string, cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

/** Lane D's fakes: a registry holding one bot read from its folder, and drivers a test could steer. */
async function fakeBots(): Promise<DaemonBotsInput & { fakes: Drivers }> {
  const root = temp("clover-int-plugins-");
  const luna = writePlugin(root, "luna", { "clover.json": botManifest("luna", "Luna"), "bot/instructions.md": "You are Luna." });
  const registry = new FakePluginRegistry({ catalog: catalogPointDecl, plugins: (await pluginFromFolder(luna)).inputs });
  const fakes = new Drivers();
  return { registry, drivers: () => fakes.factory, defaultModel: () => ({ model: "winter-test/calls" }), fakes };
}

/** The lease's timings and clocks as lane H's tests set them: no sleep watch, the process's monotonic clock. */
const mainComputer = { watchSleep: false, monotonic: () => performance.now() };

/** A second computer, from the same assembly the daemon runs. */
async function peer(net: MemoryNetwork, hs: { url: string }, name: string): Promise<{ d: DaemonLinks; parts: DaemonParts; links: DeviceLinks }> {
  const home = temp("clover-int-peer-");
  const store = new CloverSecretStore({ home, values: new KeychainValues(memoryVault()), status: { backend: "memory", plaintext: false, state: "unlocked" } });
  const handlers = {};
  const d = await startDaemonLinks({
    home, store, clock, self: { name, os: "linux" }, handlers, binary: null, wire: (k) => net.endpoint(k.publicKey),
    handshake: new HandshakeClient({ baseUrl: hs.url, clock }), publicTime: null, mainComputer, watch: () => () => {},
    dispatch: async () => null,
  });
  stops.push(() => d.close());
  const parts = await startDaemonParts({ cloverHome: home, userHome: temp("clover-int-user-"), clock, links: d.links, handlers, bots: await fakeBots() });
  stops.push(() => parts.close());
  return { d, parts, links: d.links! };
}

async function pair(a: DeviceLinks, b: DeviceLinks): Promise<void> {
  const view = await a.pairing.begin();
  const joined = await b.pairing.join(view.qr!);
  await waitFor("the words", () => a.pairing.get(view.pairingId)?.status === "words");
  await Promise.all([a.pairing.confirm(view.pairingId, joined.words!, { terminal: true }), b.pairing.confirm(view.pairingId, joined.words!, { terminal: true })]);
  await waitFor("the pair", () => a.registry.pairWith(b.key.id)?.registeredAt !== undefined && b.registry.group() !== undefined);
}

describe("the daemon's Clover parts, booted", () => {
  test("links, node and bot side start; device.*, main.* and bot.* answer over the socket; the main computer is the lease's; the stop closes them", async () => {
    const hs = startFakeHandshake();
    stops.push(() => hs.stop());
    const net = new MemoryNetwork();
    const home = temp("clover-int-home-");
    const bots = await fakeBots();
    const leaseNotes: string[] = [];
    daemon = await startDaemon({
      home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, pair: false,
      links: {
        wire: (k) => net.endpoint(k.publicKey), handshake: new HandshakeClient({ baseUrl: hs.url, clock }), publicTime: null,
        mainComputer: { ...mainComputer, log: (l: string) => void leaseNotes.push(l) }, watch: () => () => {}, self: { name: "Studio", os: "macos" },
      },
      parts: { userHome: temp("clover-int-user-"), bots },
    });
    await daemon.cloverParts.ready;
    const links = daemon.cloverParts.links()!;
    const node = daemon.cloverParts.node()!;
    const side = daemon.cloverParts.bots()!;
    expect(links).toBeDefined();
    expect(node.registry.self()).toMatchObject({ name: "Studio", device: links.key.id });
    expect(side.bots.list().map((b) => b.id)).toEqual(["luna"]);
    expect(bots.fakes.made.length).toBeGreaterThan(0); // the bot side opened Luna's conversation

    const cli = { role: "cli" as const, token: daemon.tokens.harness, clientName: "int-test" };
    const call = <T>(method: string, params: unknown = {}) => cloverCall(daemon!.socketPath, cli, method, params) as Promise<T>;
    const listed = await call<{ devices: { id: string; isThis: boolean }[] }>("device.list");
    expect(listed.devices).toEqual([expect.objectContaining({ id: links.key.id, isThis: true })]);
    expect((await call<{ bots: { id: string }[] }>("bot.list")).bots.map((b) => b.id)).toEqual(["luna"]);
    expect(await call("update.status")).toMatchObject({ idle: true }); // lane M's handlers sit beside the lanes'

    // A second computer pairs; the user makes this one the main computer from the terminal.
    const laptop = await peer(net, hs, "Laptop");
    await pair(links, laptop.links);
    expect(await call("main.set", { device: links.key.id })).toEqual({ applied: true });
    await waitFor("this computer holding the lease", () => links.main!.lease.state().holder === links.key.id && node.registry.self().isMain);
    await waitFor("the laptop seeing it", () => laptop.links.main!.lease.state().holder === links.key.id);
    const laptopNode = laptop.parts.node!;
    await waitFor("the laptop's tree naming Studio", () => laptopNode.registry.get("Studio")?.isMain === true);
    // The laptop isn't the main computer: nothing that runs on the main alone runs there, and it runs no bots.
    expect(laptopNode.registry.self().isMain).toBe(false);
    expect(laptop.parts.bots!.bots.botsRunHere()).toEqual([]);
    expect(side.bots.botsRunHere()).toEqual(["luna"]);
    expect((await call<{ lease: { holder: string | null } }>("main.get")).lease.holder).toBe(links.key.id);
    expect((await call<{ devices: { id: string; isMain: boolean }[] }>("device.list")).devices.find((d) => d.id === links.key.id)?.isMain).toBe(true);

    // An update's restart: the lease renews just before it, on the daemon's own gate (H-M3's `beforeRestart`).
    await daemon.updateGate.prepareRestart();
    expect(leaseNotes.some((l) => l.startsWith("[lease] renewed before an update's restart"))).toBe(true);

    // A bot's running turn holds the restart: the gate stays open while it runs, and closes once it ended.
    const luna = mainSessionIdFor("luna");
    await side.host.sendUser(luna, { text: "hello", device: links.key.id, sentAt: Date.now(), clientMessageId: "m1" });
    await waitFor("Luna's turn", () => bots.fakes.for(luna).running);
    expect(daemon.updateGate.verdict()).toMatchObject({ idle: false, busy: ["bots:1"] });
    expect(await daemon.updateGate.closeForRestart({ timeoutMs: 1_000 })).toBe(false);
    expect(daemon.updateGate.closed).toBe(false);
    bots.fakes.for(luna).end();
    await waitFor("the turn's end", () => side.host.turnOrigin(luna) === undefined);
    expect(daemon.updateGate.verdict().busy).not.toContain("bots:1");

    // The stop: the bot side, the node and the links close (the laptop's link goes down), and the socket goes.
    const socket = daemon.socketPath;
    await daemon.stop();
    daemon = undefined;
    expect(existsSync(socket)).toBe(false);
    await waitFor("the laptop's link to go down", () => !laptop.links.transport.links().some((l) => l.peer === links.key.id && l.up));
  }, 60_000);

  test("node: false and bots: false start the links alone; links: false starts nothing", async () => {
    const net = new MemoryNetwork();
    const home = temp("clover-int-home-");
    daemon = await startDaemon({
      home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, pair: false,
      links: { wire: (k) => net.endpoint(k.publicKey), handshake: null, publicTime: null, mainComputer, watch: () => () => {} },
      parts: { node: false, bots: false },
    });
    await daemon.cloverParts.ready;
    expect(daemon.cloverParts.links()).toBeDefined();
    expect(daemon.cloverParts.node()).toBeUndefined();
    expect(daemon.cloverParts.bots()).toBeUndefined();
    await daemon.stop();

    const home2 = temp("clover-int-home-");
    daemon = await startDaemon({ home: home2, secrets: new FileSecretStore(join(home2, "secrets.json")), agentProvider: null, pair: false, links: false });
    await daemon.cloverParts.ready;
    expect(daemon.cloverParts.links()).toBeUndefined();
  }, 30_000);
});

const BIN = process.env.CLOVER_LINK_BIN ?? join(import.meta.dir, "../../../native/link/target/release/clover-link");
const built = existsSync(BIN) && process.platform !== "win32";

/** This process's children running `clover-link`. */
function sidecarChildren(): number[] {
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" });
  return out.split("\n").map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 3 && Number(f[1]) === process.pid && f.slice(2).join(" ").endsWith("clover-link")).map((f) => Number(f[0]));
}

describe("the daemon's Clover parts at the edges", () => {
  test("a secret store locked at boot: the daemon answers at once, and the links start once the store unlocks", async () => {
    const net = new MemoryNetwork();
    const home = temp("clover-int-home-");
    const store = new CloverSecretStore({ home, values: new KeychainValues(memoryVault()), status: { backend: "memory", plaintext: false, state: "unlocked" }, locked: "the keyring is locked" });
    daemon = await startDaemon({
      home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, pair: false, contractSecrets: store,
      links: { wire: (k) => net.endpoint(k.publicKey), handshake: null, publicTime: null, mainComputer, watch: () => () => {} },
      parts: { userHome: temp("clover-int-user-"), bots: await fakeBots() },
    });
    const cli = { role: "cli" as const, token: daemon.tokens.harness, clientName: "int-test" };
    expect(await cloverCall(daemon.socketPath, cli, "update.status", {})).toMatchObject({ idle: true }); // the socket answers meanwhile
    await Bun.sleep(100);
    expect(daemon.cloverParts.links()).toBeUndefined();
    store.unlock();
    await daemon.cloverParts.ready;
    const links = daemon.cloverParts.links()!;
    expect(links).toBeDefined();
    expect(daemon.cloverParts.bots()).toBeDefined();
    const listed = await cloverCall(daemon.socketPath, cli, "device.list", {}) as { devices: { id: string; isThis: boolean }[] };
    expect(listed.devices).toEqual([expect.objectContaining({ id: links.key.id, isThis: true })]);
  }, 30_000);

  test("a start that never finishes: the stop waits about 5 s, closes what started, and leaves no socket", async () => {
    const home = temp("clover-int-home-");
    daemon = await startDaemon({
      home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, pair: false,
      // The wire never comes up: the links' start hangs.
      links: { wire: () => new Promise(() => {}), handshake: null, publicTime: null, mainComputer, watch: () => () => {} },
    });
    const socket = daemon.socketPath;
    const started = Date.now();
    await daemon.stop();
    daemon = undefined;
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(4_500);
    expect(took).toBeLessThan(10_000);
    expect(existsSync(socket)).toBe(false);
  }, 30_000);
});

describe.skipIf(!built)("the daemon's sidecar", () => {
  test("the stop ends the link sidecar it started: no child is left behind", async () => {
    const home = temp("clover-int-home-");
    daemon = await startDaemon({
      home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, pair: false,
      // Loopback only, no relay, nothing published: nothing leaves the machine.
      links: { binary: BIN, sidecar: { relay: "disabled", n0Lookup: false, bind: "127.0.0.1:0" }, handshake: null, publicTime: null, mainComputer, watch: () => () => {} },
      parts: { userHome: temp("clover-int-user-"), bots: await fakeBots() },
    });
    await daemon.cloverParts.ready;
    expect(daemon.cloverParts.node()).toBeDefined();
    expect(sidecarChildren()).toEqual([daemon.cloverParts.links()!.sidecarPid()!]); // the Clover server's `linkPid`
    await daemon.stop();
    daemon = undefined;
    await waitFor("the sidecar to exit", () => sidecarChildren().length === 0, 10_000);
  }, 30_000);
});
