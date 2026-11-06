// The main computer across real links (spec §6.4): computers on the in-memory wire, each with its coordinator over one
// lease record kept by the handshake's rules in memory, on real time with short leases. Takeover only after the main
// can't be reached over any link, the main taking the bots back between turns when it returns, a holder cut off from
// the handshake but linked to everyone acting on, hand-over for a quit or a sleep, the user's choice, the computer in
// use going first, and a wake.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemClock } from "../../clock/system-clock";
import { makeLinkCluster, type ClusterDevice } from "../../links/testing";
import { startMainComputer, type MainComputerHandle } from "../main";
import { MemoryLeaseService } from "../testing";

const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

const TIMINGS = {
  ttlMs: 900, marginMs: 150, ttlSec: 0.9, renewEveryMs: 250, readEveryMs: 250, takeoverDelayMs: 300, nudgeWaitMs: 200, reachTimeoutMs: 300, retryMs: 100,
};

interface Node {
  name: string;
  device: ClusterDevice;
  mc: MainComputerHandle;
  handBacks: number;
  active: boolean;
}

async function computers(names: string[]) {
  const c = await makeLinkCluster(names, { clock, transport: { failFastMs: 300, dialTimeoutMs: 500 } });
  stops.push(() => c.close());
  const service = new MemoryLeaseService(clock, { minTtlSec: 0 });
  const nodes = new Map<string, Node>();
  for (const name of names) {
    const device = c.devices.get(name)!;
    const scope = service.scope(device.id);
    const node: Node = { name, device, handBacks: 0, active: false, mc: undefined as unknown as MainComputerHandle };
    node.mc = startMainComputer({
      home: mkdtempSync(join(tmpdir(), "clover-h-lease-")), self: device.id, registry: device.registry, transport: device.transport,
      clock, scope: () => scope, monotonic: () => performance.now(), watchSleep: false, timings: TIMINGS, userActive: () => node.active,
    });
    stops.push(() => node.mc.close());
    nodes.set(name, node);
  }
  // Every computer keeps its links up, as the daemon does.
  for (const a of names) for (const b of names) if (a < b) await c.devices.get(a)!.transport.connect(c.devices.get(b)!.id);
  const id = (n: string) => c.devices.get(n)!.id;
  const holder = () => {
    const h = service.record.holder;
    return h === null ? null : [...nodes.values()].find((n) => n.device.id === h)!.name;
  };
  /** Cuts a computer off from everything: the links and the handshake. */
  const off = (n: string, cut = true) => {
    const k = c.devices.get(n)!.key.publicKey;
    if (cut) c.net.partition(k);
    else c.net.heal(k);
    service.cutOff(id(n), cut);
  };
  return { c, service, nodes, n: (name: string) => nodes.get(name)!, id, holder, off };
}

async function waitFor(cond: () => boolean, ms = 6_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

describe("the main computer", () => {
  test("the main takes the lease; another computer takes over only when the main can't be reached at all", async () => {
    const w = await computers(["Studio", "Laptop"]);
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio" && w.n("Studio").mc.lease.canAct());
    expect(w.n("Laptop").mc.lease.canAct()).toBe(false);
    // The laptop learned the main from the studio's own claim.
    await waitFor(() => w.n("Laptop").mc.choice.current() === w.id("Studio"));
    expect(w.n("Laptop").mc.lease.state().main).toBe(w.id("Studio"));

    w.off("Studio");
    await waitFor(() => w.holder() === "Laptop");
    expect(w.service.record.epoch).toBe(2);
    await waitFor(() => w.n("Laptop").mc.lease.canAct());
    // The studio, cut off from everything, stopped acting before its lease ran out.
    expect(w.n("Studio").mc.lease.canAct()).toBe(false);
  }, 20_000);

  test("when the main returns, the takeover computer hands the bots back between turns", async () => {
    const w = await computers(["Studio", "Laptop"]);
    let release: () => void = () => undefined;
    const turnEnded = new Promise<void>((r) => (release = r));
    // Lane D's handBack: waits for the running turn to end, then gives the lease up.
    w.n("Laptop").mc.setHandBack(async () => {
      w.n("Laptop").handBacks++;
      await turnEnded;
      await w.n("Laptop").mc.lease.release();
    });
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.n("Laptop").mc.choice.current() === w.id("Studio") && w.holder() === "Studio");
    w.off("Studio");
    await waitFor(() => w.holder() === "Laptop");
    w.off("Studio", false);
    await waitFor(() => w.n("Laptop").handBacks === 1);
    // Mid-turn: the laptop still holds the lease and acts.
    expect(w.holder()).toBe("Laptop");
    expect(w.n("Laptop").mc.lease.state().state).toBe("handing-over");
    release();
    await waitFor(() => w.holder() === "Studio" && w.n("Studio").mc.lease.canAct());
    expect(w.service.record.epoch).toBe(3);
    expect(w.n("Laptop").mc.lease.canAct()).toBe(false);
  }, 20_000);

  test("a main cut off from the handshake but linked to every computer acts on, and isn't taken over", async () => {
    const w = await computers(["Studio", "Laptop"]);
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio" && w.n("Laptop").mc.choice.current() === w.id("Studio"));
    w.service.cutOff(w.id("Studio"));
    await Bun.sleep(TIMINGS.ttlMs * 2.5);
    // The record lapsed at the service, but the laptop reaches the studio over its link: no takeover.
    expect(w.service.record.holder).toBe(w.id("Studio"));
    expect(w.n("Studio").mc.lease.canAct()).toBe(true);
    // Once the link goes too, the studio stops, and the laptop takes over.
    w.c.net.partition(w.c.devices.get("Studio")!.key.publicKey);
    await waitFor(() => !w.n("Studio").mc.lease.canAct());
    await waitFor(() => w.holder() === "Laptop");
  }, 20_000);

  test("Hand over and quit: the lease goes at once to a computer that is on, which takes it", async () => {
    const w = await computers(["Studio", "Laptop"]);
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio");
    const t0 = Date.now();
    expect(await w.n("Studio").mc.coordinator.handOver()).toEqual({ to: w.id("Laptop") });
    await waitFor(() => w.holder() === "Laptop");
    // Told to take it, the laptop didn't wait out a lapse.
    expect(Date.now() - t0).toBeLessThan(TIMINGS.ttlMs);
    expect(w.n("Studio").mc.lease.canAct()).toBe(false);
  }, 20_000);

  test("with no other computer on, a hand-over keeps the bots here", async () => {
    const w = await computers(["Studio", "Laptop"]);
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio");
    w.c.net.partition(w.c.devices.get("Laptop")!.key.publicKey);
    await waitFor(() => !w.c.devices.get("Studio")!.transport.links().some((l) => l.up));
    expect(await w.n("Studio").mc.coordinator.handOver()).toEqual({ to: null });
    expect(w.holder()).toBe("Studio");
  }, 20_000);

  test("the user's choice of another main: the holder hands back between turns, and the new main holds it", async () => {
    const w = await computers(["Studio", "Laptop"]);
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio" && w.n("Laptop").mc.choice.current() === w.id("Studio"));
    w.n("Studio").mc.setHandBack(async () => {
      w.n("Studio").handBacks++;
      await w.n("Studio").mc.lease.release();
    });
    await w.n("Laptop").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Laptop" && w.n("Laptop").mc.lease.canAct());
    expect(w.n("Studio").handBacks).toBe(1);
    await waitFor(() => w.n("Studio").mc.choice.current() === w.id("Laptop"));
    // Handed back, not taken: the studio's lease was released, so one new epoch.
    expect(w.service.record.epoch).toBe(2);
  }, 20_000);

  test("the user's choice when the holder can't be reached: a takeover with a new epoch", async () => {
    const w = await computers(["Studio", "Laptop"]);
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio");
    w.c.net.partition(w.c.devices.get("Studio")!.key.publicKey);
    await waitFor(() => !w.c.devices.get("Laptop")!.transport.links().some((l) => l.up));
    await w.n("Laptop").mc.coordinator.chooseSelf();
    expect(w.holder()).toBe("Laptop");
    expect(w.service.record.epoch).toBe(2);
    // The studio, still reaching the handshake, sees its renew refused and stops.
    await waitFor(() => !w.n("Studio").mc.lease.canAct());
    expect(w.n("Studio").mc.lease.isStale(1)).toBe(true);
  }, 20_000);

  test("with the main gone, the computer the user is using takes the lease first", async () => {
    const w = await computers(["Studio", "Laptop", "Server"]);
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio" && w.n("Server").mc.choice.current() === w.id("Studio") && w.n("Laptop").mc.choice.current() === w.id("Studio"));
    w.n("Server").active = true;
    w.off("Studio");
    await waitFor(() => w.holder() !== "Studio" && w.holder() !== null);
    expect(w.holder()).toBe("Server");
  }, 20_000);

  test("after a wake nothing is acted on until a renew succeeds", async () => {
    const w = await computers(["Studio", "Laptop"]);
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio" && w.n("Studio").mc.lease.canAct());
    w.service.cutOff(w.id("Studio"));
    w.n("Studio").mc.coordinator.wake();
    expect(w.n("Studio").mc.lease.canAct()).toBe(false);
    await Bun.sleep(100);
    expect(w.n("Studio").mc.lease.canAct()).toBe(false);
    w.service.cutOff(w.id("Studio"), false);
    await waitFor(() => w.n("Studio").mc.lease.canAct());
    expect(w.service.record.epoch).toBe(1);
  }, 20_000);
});
