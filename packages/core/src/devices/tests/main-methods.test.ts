// The main computer's methods (`main.get`, `main.set`, `main.handOver`) and its `lease_changed` events, over two
// account-less daemons whose lease lives on their group's record at a local stand-in for the handshake. Choosing this
// computer is the user's terminal at once, or a sealed card from the app; choosing another computer asks that one,
// which shows its own card.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import { SystemClock } from "../../clock/system-clock";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { HandshakeClient } from "../../links/handshake";
import { startFakeHandshake } from "../../links/handshake-fake";
import { MemoryNetwork } from "../../links/memory-wire";
import { type DeviceLinks, startDeviceLinks } from "../../links/node";
import { brokerCardOpener, devicesEvents, devicesMethods, mountMainChoiceRequests } from "../rpc";

const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

const terminal: Caller = { kind: "user", client: "cli" };
const app: Caller = { kind: "user", client: "app" };

async function waitFor(cond: () => boolean, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

async function daemon(net: MemoryNetwork, hs: { url: string }, name: string) {
  const store = new MemorySecretStore();
  const links = await startDeviceLinks({
    home: mkdtempSync(join(tmpdir(), "clover-h-main-")), store, clock, self: { name }, wire: (k) => net.endpoint(k.publicKey),
    handshake: new HandshakeClient({ baseUrl: hs.url, clock }), mainComputer: { watchSleep: false, monotonic: () => performance.now() },
  });
  stops.push(() => links.close());
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const openCard = brokerCardOpener(broker);
  const methods = devicesMethods({ registry: links.registry, pairing: links.pairing, transport: links.transport, clock: links.clock, openCard, revoke: { store }, main: links.main! });
  stops.push(mountMainChoiceRequests({ transport: links.transport, registry: links.registry, main: links.main!, openCard }));
  const events: { type: string; lease?: { holder: string | null } }[] = [];
  stops.push(devicesEvents({ registry: links.registry, transport: links.transport, pairing: links.pairing, clock: links.clock, main: links.main! }, (e) => events.push(e)));
  const call = (method: string, params: unknown, caller: Caller) => methods[method]!(params, { caller });
  return { links, broker, call, events };
}

async function pair(a: DeviceLinks, b: DeviceLinks) {
  const view = await a.pairing.begin();
  const joined = await b.pairing.join(view.qr!);
  await waitFor(() => a.pairing.get(view.pairingId)?.status === "words");
  await Promise.all([a.pairing.confirm(view.pairingId, joined.words!, { terminal: true }), b.pairing.confirm(view.pairingId, joined.words!, { terminal: true })]);
  await waitFor(() => a.registry.pairWith(b.key.id)?.registeredAt !== undefined && b.registry.group() !== undefined);
}

const approve = async (d: Awaited<ReturnType<typeof daemon>>, cardId: string) => {
  const card = d.broker.cards().find((c) => c.id === cardId)!;
  expect(card.change).toBe("main-computer");
  const channel = d.broker.frameChannel(card.id)!;
  expect(await d.broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: { via: "sealed-frame", frame: channel, input: "click", at: Date.now() } }, { role: "app" })).toBe("accepted");
};

describe("the main computer's methods", () => {
  test("main.set here from the terminal, from the app by its card, and of another computer by that computer's card", async () => {
    const hs = startFakeHandshake();
    stops.push(() => hs.stop());
    const net = new MemoryNetwork();
    const a = await daemon(net, hs, "Studio");
    const b = await daemon(net, hs, "Laptop");
    await pair(a.links, b.links);
    await b.links.transport.connect(a.links.key.id);

    expect(await a.call("main.set", { device: a.links.key.id }, terminal)).toEqual({ applied: true });
    await waitFor(() => a.links.main!.lease.canAct());
    expect(((await a.call("main.get", {}, app)) as { lease: { holder: string; main: string } }).lease).toMatchObject({ holder: a.links.key.id, main: a.links.key.id });
    await waitFor(() => a.events.some((e) => e.type === "lease_changed" && e.lease?.holder === a.links.key.id));
    const list = (await a.call("device.list", {}, app)) as { devices: { id: string; isMain: boolean }[] };
    expect(list.devices.find((d) => d.id === a.links.key.id)?.isMain).toBe(true);

    // From the app on the studio, the user chooses the laptop: the laptop shows its own card.
    const r = (await a.call("main.set", { device: b.links.key.id }, app)) as { applied: boolean; card?: string };
    expect(r.applied).toBe(false);
    expect(b.broker.cards().some((c) => c.id === r.card)).toBe(true);
    expect(a.links.main!.lease.canAct()).toBe(true);
    await approve(b, r.card!);
    await waitFor(() => b.links.main!.lease.canAct() && !a.links.main!.lease.canAct());
    await waitFor(() => a.links.main!.choice.current() === b.links.key.id);

    // Hand over and quit, from the laptop: the studio takes the bots at once.
    expect(await b.call("main.handOver", {}, app)).toEqual({ to: a.links.key.id });
    // The studio may be mid-step (waiting on a nudge or a takeover delay) when the "take" arrives; it acts on it next.
    await waitFor(() => a.links.main!.lease.canAct(), 20_000);
  }, 45_000);
});
