// The links as the daemon owns them (lane J's ask): two daemons' links on temp homes pair, link, survive a restart
// with the same identity and pairing, and hand lane J's computer node its transport, registry and tree name.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { SystemClock } from "../../clock/system-clock";
import { MemoryNetwork } from "../memory-wire";
import { computerNodeLinks, type DeviceLinks, startDeviceLinks } from "../node";

const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

async function daemon(net: MemoryNetwork, name: string, home = mkdtempSync(join(tmpdir(), "clover-h-node-")), store = new MemorySecretStore()) {
  const links = await startDeviceLinks({ home, store, clock, self: { name, os: "macos" }, wire: (key) => net.endpoint(key.publicKey) });
  stops.push(() => links.close());
  return { links, home, store };
}

async function pair(a: DeviceLinks, b: DeviceLinks) {
  const view = await a.pairing.begin();
  const joined = await b.pairing.join(view.qr!);
  await waitFor(() => a.pairing.get(view.pairingId)?.status === "words");
  await Promise.all([a.pairing.confirm(view.pairingId, joined.words!, { terminal: true }), b.pairing.confirm(view.pairingId, joined.words!, { terminal: true })]);
  await waitFor(() => a.registry.get(b.key.id) !== undefined && b.registry.get(a.key.id) !== undefined);
}

describe("the daemon's links", () => {
  test("two daemons pair and link; a restart keeps the identity and the pairing, and links again", async () => {
    const net = new MemoryNetwork();
    const a = await daemon(net, "Studio");
    const b = await daemon(net, "Laptop");
    await pair(a.links, b.links);
    b.links.transport.handle("who", () => "laptop");
    expect(await (await a.links.transport.connect(b.links.key.id)).request<string>("who", null)).toBe("laptop");

    const id = b.links.key.id;
    await b.links.close();
    const again = await daemon(net, "Laptop", b.home, b.store);
    expect(again.links.key.id).toBe(id);
    expect(again.links.registry.get(a.links.key.id)?.revokedAt).toBeUndefined();
    again.links.transport.handle("who", () => "laptop again");
    const link = await a.links.transport.connect(id);
    await waitFor(() => link.view().up);
    expect(await link.request<string>("who", null)).toBe("laptop again");
  });

  test("lane J's computer node gets the transport, the registry and this computer's tree name", async () => {
    const net = new MemoryNetwork();
    const a = await daemon(net, "Studio");
    const handoff = computerNodeLinks(a.links);
    expect(handoff.self).toEqual({ name: "Studio", device: a.links.key.id });
    expect(handoff.transport).toBe(a.links.transport);
    expect(handoff.devices.self().computer).toBe("Studio");
    expect(a.links.registry.boxKey(a.links.key.id)).toBe(a.links.boxKey.publicKeyBase64Url);
  });
});

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}
