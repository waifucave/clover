// The fencing token on acts between computers, from lane H's lease (J-M3's ask: `startComputerNode`'s `lease` option,
// lane/j-m3-asks 65ec27de1, which the links hand over in `computerNodeLinks`). Each computer stamps the acts it asks of
// another with its lease's token and judges the acts asked of it against its own lease, as J's `leaseFence` and
// `checkActFence` do (#187's `FenceGuard`). After a takeover, the former main's acts are refused at every other
// computer, end to end over real links: a token from its old tenure, and what its own lease gives it now.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FencingToken } from "@waifucave/clover-protocol";
import { SystemClock } from "../../clock/system-clock";
import { ContractError, isContractError } from "../../contracts/common";
import { FenceGuard, fencingTokenOf } from "../../contracts/lease";
import { fencingLease } from "../../links/node";
import { makeLinkCluster } from "../../links/testing";
import { startMainComputer, type MainComputerHandle } from "../main";
import { MemoryLeaseService } from "../testing";

const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

const TIMINGS = { ttlMs: 900, marginMs: 150, ttlSec: 0.9, renewEveryMs: 250, readEveryMs: 250, takeoverDelayMs: 300, nudgeWaitMs: 200, reachTimeoutMs: 300, retryMs: 100 };
const ACT = "test.act";

async function waitFor(cond: () => boolean, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

describe("acts between computers carry the lease's fencing token", () => {
  test("after a takeover, a former main's acts are refused at the other computers, end to end", async () => {
    const names = ["Studio", "Laptop", "Server"];
    const c = await makeLinkCluster(names, { clock, transport: { failFastMs: 300, dialTimeoutMs: 500 } });
    stops.push(() => c.close());
    const service = new MemoryLeaseService(clock, { minTtlSec: 0 });
    const mc = new Map<string, MainComputerHandle>();
    for (const n of names) {
      const d = c.devices.get(n)!;
      const scope = service.scope(d.id);
      const m = startMainComputer({
        home: mkdtempSync(join(tmpdir(), "clover-h-fence-")), self: d.id, registry: d.registry, transport: d.transport, clock,
        scope: () => scope, monotonic: () => performance.now(), watchSleep: false, timings: TIMINGS,
      });
      stops.push(() => m.close());
      mc.set(n, m);
      // What J's node does with the lease the links hand it: a guard fed only from this computer's own lease, which
      // judges every act asked of it.
      const lease = fencingLease(m.lease);
      const guard = new FenceGuard();
      guard.observe(lease.state());
      stops.push(lease.watch((s) => guard.observe(s)));
      d.transport.handle(ACT, (p) => {
        const v = guard.check((p as { fence?: FencingToken } | undefined)?.fence);
        if (v !== "ok") throw new ContractError("not_main", `refused: ${v}`, { fence: v });
        return "done";
      });
    }
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) await c.devices.get(names[i]!)!.transport.connect(c.devices.get(names[j]!)!.id);
    const id = (n: string) => c.devices.get(n)!.id;
    const token = (n: string) => fencingTokenOf(fencingLease(mc.get(n)!.lease).state());
    const act = async (from: string, to: string, fence: FencingToken | undefined) => {
      const link = await c.devices.get(from)!.transport.connect(id(to));
      return link.request(ACT, fence ? { fence } : {}).then((r) => r, (e: unknown) => (isContractError(e, "not_main") ? `not_main: ${(e as Error).message}` : e));
    };

    await mc.get("Studio")!.coordinator.chooseSelf();
    await waitFor(() => service.record.holder === id("Studio") && mc.get("Studio")!.lease.canAct()
      && names.every((n) => mc.get(n)!.lease.state().holder === id("Studio")));
    const old = token("Studio")!;
    expect(old).toMatchObject({ scope: "memory", epoch: 1, holder: id("Studio") });
    // The main's acts are taken while it holds the lease.
    expect(await act("Studio", "Laptop", old)).toBe("done");
    expect(await act("Studio", "Server", old)).toBe("done");

    // The studio is cut off from everything; one of the others takes over with a new epoch (whichever is first).
    const studioKey = c.devices.get("Studio")!.key.publicKey;
    c.net.partition(studioKey);
    service.cutOff(id("Studio"), true);
    await waitFor(() => service.record.holder !== null && service.record.holder !== id("Studio") && service.record.epoch === 2);
    const taker = names.find((n) => id(n) === service.record.holder)!;
    const other = taker === "Laptop" ? "Server" : "Laptop";
    await waitFor(() => [taker, other].every((n) => mc.get(n)!.lease.state().epoch === 2 && mc.get(n)!.lease.state().holder === id(taker)));

    // Its links come back, the handshake still out of its reach: whatever it sends is refused at both.
    c.net.heal(studioKey);
    for (const to of ["Laptop", "Server"]) {
      // The token of its old tenure.
      expect(await act("Studio", to, old)).toBe("not_main: refused: stale");
      // And what its own lease gives it now (none once its record ran out): no token is refused too, once the
      // receiver has taken one for this scope.
      expect(String(await act("Studio", to, token("Studio")))).toMatch(/^not_main: refused: (stale|missing)$/);
    }
    // The new holder's acts are taken.
    expect(await act(taker, other, token(taker))).toBe("done");
  }, 30_000);

  test("a lease held locally, with no record, carries no token", async () => {
    const c = await makeLinkCluster(["Studio"], { clock });
    stops.push(() => c.close());
    const d = c.devices.get("Studio")!;
    const m = startMainComputer({
      home: mkdtempSync(join(tmpdir(), "clover-h-fence-")), self: d.id, registry: d.registry, transport: d.transport, clock,
      scope: () => undefined, monotonic: () => performance.now(), watchSleep: false, timings: TIMINGS,
    });
    stops.push(() => m.close());
    await waitFor(() => m.lease.canAct());
    expect(fencingTokenOf(fencingLease(m.lease).state())).toBeUndefined();
  });
});
