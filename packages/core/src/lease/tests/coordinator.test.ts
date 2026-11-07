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
import { ContractError } from "../../contracts/common";
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

type Scope = ReturnType<MemoryLeaseService["scope"]>;

async function computers(names: string[], wrap?: (name: string, scope: Scope) => Scope, pairs?: [string, string][]) {
  const c = await makeLinkCluster(names, { clock, transport: { failFastMs: 300, dialTimeoutMs: 500 }, ...(pairs ? { pairAll: false } : {}) });
  if (pairs) for (const [a, b] of pairs) await c.pair(a, b);
  stops.push(() => c.close());
  const service = new MemoryLeaseService(clock, { minTtlSec: 0 });
  const nodes = new Map<string, Node>();
  for (const name of names) {
    const device = c.devices.get(name)!;
    const scope = wrap ? wrap(name, service.scope(device.id)) : service.scope(device.id);
    const node: Node = { name, device, handBacks: 0, active: false, mc: undefined as unknown as MainComputerHandle };
    node.mc = startMainComputer({
      home: mkdtempSync(join(tmpdir(), "clover-h-lease-")), self: device.id, registry: device.registry, transport: device.transport,
      clock, scope: () => scope, monotonic: () => performance.now(), watchSleep: false, timings: TIMINGS, userActive: () => node.active,
      ...(process.env.LANE_H_DEBUG ? { log: (l: string) => console.log(`${Date.now() % 100000} ${name} ${l}`) } : {}),
    });
    stops.push(() => node.mc.close());
    nodes.set(name, node);
  }
  // Every computer keeps its links up, as the daemon does.
  const paired = (a: string, b: string) => !pairs || pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  for (const a of names) for (const b of names) if (a < b && paired(a, b)) await c.devices.get(a)!.transport.connect(c.devices.get(b)!.id);
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

/** Over 20 samples, how many found more than one of `names` acting. */
async function twoActing(w: Awaited<ReturnType<typeof computers>>, names: string[]): Promise<number> {
  let two = 0;
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(150);
    if (names.filter((n) => w.n(n).mc.lease.canAct()).length > 1) two++;
  }
  return two;
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

  test("a group member the main can't name turns its exception off: cut off from the handshake, it stops at its deadline (check 4)", async () => {
    const w = await computers(["Studio", "Laptop"], (name, scope) => (name === "Studio" ? { ...scope, unknownMembers: () => 1 } : scope));
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio" && w.n("Studio").mc.lease.canAct());
    w.service.cutOff(w.id("Studio"));
    // Linked to every computer it knows, but the service lists a member it can't name, which may have taken over.
    await waitFor(() => !w.n("Studio").mc.lease.canAct(), 3 * TIMINGS.ttlMs);
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

  for (const when of ["reaches the service after the release", "is answered after the release"] as const) {
    test(`a hand-over racing the holder's renew: the renew ${when}, and the bots still go to the other computer`, async () => {
      // The renew loop's next renew is held while the hand-over releases: either it reaches the service after the
      // release (refused, the record free), or the service renews first and its answer comes after the release's.
      let hold = false;
      let held: (() => void) | undefined;
      let pending = false;
      const w = await computers(["Studio", "Laptop"], (name, scope) => name !== "Studio" ? scope : {
        ...scope,
        op: async (op, epoch, ttlSec) => {
          if (op !== "renew" || !hold) return scope.op(op, epoch, ttlSec);
          hold = false;
          pending = true;
          const gate = new Promise<void>((r) => (held = r));
          if (when === "reaches the service after the release") {
            await gate;
            return scope.op(op, epoch, ttlSec);
          }
          const answer = await scope.op(op, epoch, ttlSec);
          await gate;
          return answer;
        },
      });
      await w.n("Studio").mc.coordinator.chooseSelf();
      await waitFor(() => w.holder() === "Studio" && w.n("Studio").mc.lease.canAct());
      hold = true;
      await waitFor(() => pending);
      const since = w.service.log.length;
      expect(await w.n("Studio").mc.coordinator.handOver()).toEqual({ to: w.id("Laptop") });
      // From the hand-over on, the studio never holds it again, not even for a moment.
      let heldAgain = false;
      stops.push(w.n("Studio").mc.lease.watch(() => {
        if (w.n("Studio").mc.lease.holds()) heldAgain = true;
      }));
      held!();
      await waitFor(() => w.holder() === "Laptop");
      // And it stays there: the studio neither takes it back nor acts on.
      await Bun.sleep(TIMINGS.ttlMs);
      expect(w.holder()).toBe("Laptop");
      expect(w.n("Studio").mc.lease.canAct()).toBe(false);
      expect(w.service.log.slice(since).filter((l) => l === `${w.id("Studio")} acquire`)).toEqual([]);
      expect(heldAgain).toBe(false);
    }, 20_000);
  }

  test("L3: the old main's links come back after a takeover while the service stays out of its reach: it doesn't act on (check 3)", async () => {
    const w = await computers(["Studio", "Laptop", "Server"]);
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio" && w.n("Studio").mc.lease.canAct());
    w.off("Studio");
    await waitFor(() => w.holder() !== "Studio" && w.holder() !== null);
    const taker = w.holder()!;
    await waitFor(() => w.n(taker).mc.lease.canAct());
    // Only the links heal; the handshake stays out of the studio's reach. Links that came back after its deadline
    // don't let it act on: one of those computers took over meanwhile.
    w.c.net.heal(w.c.devices.get("Studio")!.key.publicKey);
    for (const n of ["Laptop", "Server"]) await w.c.devices.get("Studio")!.transport.connect(w.id(n)).catch(() => undefined);
    await waitFor(() => w.c.devices.get("Studio")!.transport.links().filter((l) => l.up).length === 2);
    let both = 0;
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(100);
      if (w.n("Studio").mc.lease.canAct() && w.n(taker).mc.lease.canAct()) both++;
    }
    expect(both).toBe(0);
    expect(w.n("Studio").mc.lease.canAct()).toBe(false);
  }, 30_000);

  test("L4: a main cut off from the service only, linked to every computer it knows, stops once a computer it never paired with takes over (check 4)", async () => {
    // The studio and the server never paired; the laptop is paired with both.
    const w = await computers(["Studio", "Laptop", "Server"], undefined, [["Studio", "Laptop"], ["Laptop", "Server"]]);
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio" && w.n("Studio").mc.lease.canAct());
    w.service.cutOff(w.id("Studio"), true);
    await waitFor(() => w.holder() !== "Studio" && w.holder() !== null, 10_000);
    let two = 0;
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(100);
      if (["Studio", "Laptop", "Server"].filter((n) => w.n(n).mc.lease.canAct()).length > 1) two++;
    }
    expect(two).toBe(0);
    expect(w.n("Studio").mc.lease.canAct()).toBe(false);
  }, 30_000);

  test("L5: down a three-hop chain, the main cut off from the service hears of the takeover (check 5)", async () => {
    const names = ["Studio", "Laptop", "Server", "Mini"];
    const w = await computers(names, undefined, [["Studio", "Laptop"], ["Laptop", "Server"], ["Server", "Mini"]]);
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio" && w.n("Studio").mc.lease.canAct());
    w.service.cutOff(w.id("Studio"), true);
    await waitFor(() => w.holder() !== "Studio" && w.holder() !== null, 10_000);
    expect(await twoActing(w, names)).toBe(0);
  }, 30_000);

  test("L5b: a computer that read the new epoch from the service before the taker's word reached it passes it on (check 5)", async () => {
    let slow = false;
    const w = await computers(["Studio", "Laptop", "Server"], (name, scope) => name !== "Server" ? scope : {
      ...scope,
      // The server's acquire lands at the service, but its answer (and so its announcement) comes late.
      op: async (op, epoch, ttl) => {
        const r = await scope.op(op, epoch, ttl);
        if (op === "acquire" && slow) await Bun.sleep(1200);
        return r;
      },
    }, [["Studio", "Laptop"], ["Laptop", "Server"]]);
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio" && w.n("Studio").mc.lease.canAct());
    slow = true;
    w.service.cutOff(w.id("Studio"), true);
    await waitFor(() => w.holder() !== "Studio" && w.holder() !== null, 10_000);
    expect(await twoActing(w, ["Studio", "Laptop", "Server"])).toBe(0);
  }, 30_000);

  test("L6: an announcement lost to a dropped link still reaches the main once the link is back (check 5)", async () => {
    const names = ["Studio", "Laptop", "Server"];
    // The laptop doesn't vote yet, so the server is the one that takes over.
    const w = await computers(names, (name, scope) => (name === "Laptop" ? { ...scope, votes: () => false } : scope), [["Studio", "Laptop"], ["Laptop", "Server"]]);
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio" && w.n("Studio").mc.lease.canAct());
    const [lk, sk] = [w.c.devices.get("Laptop")!.key.publicKey, w.c.devices.get("Server")!.key.publicKey];
    w.service.cutOff(w.id("Studio"), true);
    // The laptop-server link drops just as the record lapses; the server still reaches the service and takes over.
    await waitFor(() => w.n("Server").mc.lease.known().expiresAt !== null && Date.now() >= w.n("Server").mc.lease.known().expiresAt! - 200, 10_000);
    w.c.net.partition(lk, sk);
    await waitFor(() => w.holder() !== "Studio" && w.holder() !== null, 10_000);
    await Bun.sleep(500);
    w.c.net.heal(lk, sk);
    await w.c.devices.get("Laptop")!.transport.connect(w.id("Server")).catch(() => undefined);
    expect(await twoActing(w, names)).toBe(0);
  }, 30_000);

  test("L7: a bogus epoch from a paired computer costs the main one renew, and never keeps the real takeover's word from it (check 5)", async () => {
    const names = ["Studio", "Laptop", "Server"];
    // The laptop doesn't vote yet, so the server is the one that takes over.
    const w = await computers(names, (name, scope) => (name === "Laptop" ? { ...scope, votes: () => false } : scope), [["Studio", "Laptop"], ["Laptop", "Server"]]);
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio" && w.n("Studio").mc.lease.canAct());
    const scope = w.n("Laptop").mc.lease.scopeId();
    await (await w.c.devices.get("Server")!.transport.connect(w.id("Laptop"))).notify("link.lease.epoch", { scope, epoch: 1_000_000_000 });
    // The studio stops, renews, and acts again.
    await Bun.sleep(1_000);
    await waitFor(() => w.n("Studio").mc.lease.canAct(), 3_000);
    w.service.cutOff(w.id("Studio"), true);
    await waitFor(() => w.holder() !== "Studio" && w.holder() !== null, 10_000);
    expect(await twoActing(w, names)).toBe(0);
  }, 30_000);

  test("L8: under a stream of fake epochs from a paired computer, the holder acts on and renews only on its schedule; the fakes aren't passed on (check 6)", async () => {
    const w = await computers(["Studio", "Laptop", "Server"], undefined, [["Studio", "Laptop"], ["Studio", "Server"]]);
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio" && w.n("Studio").mc.lease.canAct());
    const scope = w.n("Studio").mc.lease.scopeId();
    const link = await w.c.devices.get("Laptop")!.transport.connect(w.id("Studio"));
    let relayed = 0;
    w.c.devices.get("Server")!.transport.onNotify("link.lease.epoch", () => relayed++);
    const since = w.service.log.length;
    let stop = false;
    let fake = 1_000_000;
    const stream = (async () => {
      while (!stop) {
        link.notify("link.lease.epoch", { scope, epoch: fake++ });
        await Bun.sleep(5);
      }
    })();
    const N = 400;
    let acting = 0;
    for (let i = 0; i < N; i++) {
      await Bun.sleep(5);
      if (w.n("Studio").mc.lease.canAct()) acting++;
    }
    stop = true;
    await stream;
    expect(acting).toBeGreaterThanOrEqual(N * 0.9);
    // Renews stay on the schedule (one every renewEveryMs), not one per fake.
    const renews = w.service.log.slice(since).filter((l) => l === `${w.id("Studio")} renew`).length;
    expect(renews).toBeLessThanOrEqual(Math.ceil((N * 10) / TIMINGS.renewEveryMs) + 4);
    // Of about 400 fakes the studio passed on a few a second at most (a burst of 4, then 4 a second, and none while
    // the laptop is distrusted).
    expect(relayed).toBeLessThanOrEqual(4 + Math.ceil((N * 10 * 4) / 1000));
  }, 30_000);

  test("L10: the user chooses a computer the main isn't linked to while the main can't reach the service, before its deadline: the main stops (check 7)", async () => {
    const names = ["Studio", "Laptop", "Server"];
    const w = await computers(names, undefined, [["Studio", "Laptop"], ["Laptop", "Server"]]);
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio" && w.n("Studio").mc.lease.canAct());
    // Right after a renew: most of the time to the deadline is left.
    const n0 = w.service.log.length;
    await waitFor(() => w.service.log.length > n0 && w.service.log.at(-1) === `${w.id("Studio")} renew`, 3_000);
    w.service.cutOff(w.id("Studio"), true);
    const t0 = performance.now();
    await w.n("Server").mc.coordinator.chooseSelf();
    let two = 0;
    while (performance.now() - t0 < 1_500) {
      await Bun.sleep(25);
      if (names.filter((n) => w.n(n).mc.lease.canAct()).length > 1) two++;
    }
    expect(w.holder()).toBe("Server");
    expect(two).toBe(0);
  }, 30_000);

  test("L11: as L10, but the main's requests to the service hang instead of failing: the claim unanswered stops it (H-M3)", async () => {
    const names = ["Studio", "Laptop", "Server"];
    let hang = false;
    const never = new Promise<never>(() => undefined);
    const w = await computers(names, (name, scope) => name !== "Studio" ? scope : {
      ...scope,
      op: (op, epoch, ttl) => (hang ? never : scope.op(op, epoch, ttl)),
      read: () => (hang ? never : scope.read()),
    }, [["Studio", "Laptop"], ["Laptop", "Server"]]);
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio" && w.n("Studio").mc.lease.canAct());
    const n0 = w.service.log.length;
    await waitFor(() => w.service.log.length > n0 && w.service.log.at(-1) === `${w.id("Studio")} renew`, 3_000);
    hang = true;
    const t0 = performance.now();
    await w.n("Server").mc.coordinator.chooseSelf();
    let two = 0;
    while (performance.now() - t0 < 1_500) {
      await Bun.sleep(25);
      if (names.filter((n) => w.n(n).mc.lease.canAct()).length > 1) two++;
    }
    expect(w.holder()).toBe("Server");
    expect(two).toBe(0);
  }, 30_000);

  test("only a computer that votes starts a new tenure: a non-voter never takes over a lapse, nor is handed the lease, and a not_voter refusal stops its tries (check 3)", async () => {
    let refused = 0;
    const w = await computers(["Studio", "Laptop", "Server"], (name, scope) => {
      // The laptop joined lately: its group record says it doesn't vote yet. The server's record is stale (it reads
      // as voting) but the service refuses it `not_voter`.
      if (name === "Laptop") return { ...scope, votes: () => false };
      if (name === "Server") {
        return {
          ...scope,
          op: async (op, epoch, ttl) => {
            if (op === "acquire") {
              refused++;
              throw new ContractError("refused", "not a voter yet", { notVoter: true });
            }
            return scope.op(op, epoch, ttl);
          },
        };
      }
      return scope;
    });
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio" && w.n("Studio").mc.lease.canAct());
    const since = w.service.log.length;
    const refusedBefore = refused;
    w.off("Studio");
    await Bun.sleep(4 * TIMINGS.ttlMs);
    // Nobody may take it: the laptop doesn't try, and the server tried once and then held off.
    expect(w.service.log.slice(since).filter((l) => l.endsWith(" acquire") || l.endsWith(" takeover"))).toEqual([]);
    expect(refused - refusedBefore).toBeLessThanOrEqual(1);
    expect(w.n("Laptop").mc.lease.canAct()).toBe(false);
    expect(w.n("Server").mc.lease.canAct()).toBe(false);
    // The studio comes back and takes its own lapsed lease again (the last holder needs no vote).
    w.off("Studio", false);
    await waitFor(() => w.holder() === "Studio" && w.n("Studio").mc.lease.canAct());
  }, 30_000);

  test("a hand-over goes only to a computer that votes", async () => {
    const w = await computers(["Studio", "Laptop", "Server"], (name, scope) => (name === "Studio" ? { ...scope, votes: (_now, device) => device !== w.id("Laptop") } : scope));
    await w.n("Studio").mc.coordinator.chooseSelf();
    await waitFor(() => w.holder() === "Studio");
    expect(await w.n("Studio").mc.coordinator.handOver()).toEqual({ to: w.id("Server") });
    await waitFor(() => w.holder() === "Server");
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

  test("a hand-back on its way to the automatic main stops when the user makes the holder the main meanwhile", async () => {
    const w = await computers(["Studio", "Laptop"]);
    // With no choice made, the automatic main is the computer with the lower id; the other comes to hold the lease by a
    // takeover, and starts handing the bots back once the main is back.
    const [main, other] = w.id("Studio") < w.id("Laptop") ? ["Studio", "Laptop"] : ["Laptop", "Studio"];
    await waitFor(() => w.holder() === main);
    w.n(other).mc.setHandBack(async () => {
      w.n(other).handBacks++;
      await w.n(other).mc.lease.release();
    });
    w.off(main);
    await waitFor(() => w.holder() === other && w.n(other).mc.lease.canAct());
    const epoch = w.service.record.epoch;
    // The main's answer to "ready?" waits until the user has chosen.
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((r) => (answer = r));
    let asked = false;
    w.n(main).device.transport.handle("link.lease.ready", async () => {
      asked = true;
      await answered;
      return { ready: true };
    });
    w.off(main, false);
    await waitFor(() => asked);
    // The user makes the holder the main while it is asking: the bots stay with it.
    const chosen = w.n(other).mc.coordinator.chooseSelf();
    answer();
    await chosen;
    // chooseSelf waited for the hand-back to stop; a moment more shows it never released.
    await Bun.sleep(300);
    expect(w.n(other).handBacks).toBe(0);
    expect(w.holder()).toBe(other);
    expect(w.service.record.epoch).toBe(epoch);
    expect(w.n(other).mc.lease.canAct()).toBe(true);
    expect(w.n(other).mc.lease.state().state).toBe("held");
    await waitFor(() => w.n(main).mc.choice.current() === w.id(other));
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
