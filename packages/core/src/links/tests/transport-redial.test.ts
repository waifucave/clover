// A dial that hangs (headed for an address the peer has left) doesn't hold a link down: the peer's own dial in ends
// the wait, and a "dial now" starts a fresh dial beside it.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemClock } from "../../clock/system-clock";
import { FileDeviceRegistry } from "../../devices/registry";
import { MemoryNetwork } from "../memory-wire";
import { makeDeviceKey, makeLinkCluster, recordFor } from "../testing";
import { CloverLinkTransport } from "../transport";
import { WireOffline, type DialOptions, type DialTarget, type WireConn, type WireEndpoint } from "../wire";

const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

/** A wire whose first `hang` dials never answer (until their signal aborts). */
function hanging(inner: WireEndpoint, hang: number): WireEndpoint & { dials: number } {
  const w = {
    dials: 0,
    publicKey: inner.publicKey,
    dial(target: DialTarget, opts: DialOptions): Promise<WireConn> {
      w.dials++;
      if (w.dials <= hang) {
        return new Promise((_, reject) => opts.signal?.addEventListener("abort", () => reject(new WireOffline("aborted")), { once: true }));
      }
      return inner.dial(target, opts);
    },
    onIncoming: inner.onIncoming.bind(inner),
    networkChanged: inner.networkChanged.bind(inner),
    close: inner.close.bind(inner),
  };
  return w;
}

async function pairOf(hangA: number) {
  const net = new MemoryNetwork();
  const ka = await makeDeviceKey();
  const kb = await makeDeviceKey();
  const reg = async (k: typeof ka, name: string) => FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-h-redial-")), key: k, clock, self: { name } });
  const ra = await reg(ka, "a");
  const rb = await reg(kb, "b");
  await ra.add(recordFor(kb, "b"), { via: "terminal" });
  await rb.add(recordFor(ka, "a"), { via: "terminal" });
  const wa = hanging(net.endpoint(ka.publicKey), hangA);
  const keyOf = new Map([[ka.id, ka.publicKey], [kb.id, kb.publicKey]]);
  const directory = { target: (id: string) => ({ key: keyOf.get(id)!, relay: "https://relay.test/" }) };
  const ta = new CloverLinkTransport({ self: ka.id, wire: wa, registry: ra, directory, clock, dialTimeoutMs: 20_000 });
  const tb = new CloverLinkTransport({ self: kb.id, wire: net.endpoint(kb.publicKey), registry: rb, directory, clock });
  stops.push(() => ta.close(), () => tb.close());
  tb.handle("who", () => "b");
  return { ka, kb, ta, tb, wa };
}

describe("a connection that loses the rank", () => {
  test("still answers the request it is serving before it closes", async () => {
    const c = await makeLinkCluster(["a", "b"], { clock });
    stops.push(() => c.close());
    const a = c.devices.get("a")!;
    const b = c.devices.get("b")!;
    b.transport.handle("slow", async () => {
      await Bun.sleep(300);
      return "done";
    });
    const link = await a.transport.connect(b.id);
    const inFlight = link.request<string>("slow", null);
    await Bun.sleep(30);
    // B dials too (its network changed): the new connection outranks the one serving A's request.
    b.transport.networkChanged();
    expect(await inFlight).toBe("done");
    await waitForCond(() => a.transport.link(b.id).sessions.size === 1 && b.transport.link(a.id).sessions.size === 1);
    expect(await link.request<string>("slow", null)).toBe("done");
  });
});

async function waitForCond(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

describe("a hung dial", () => {
  test("gives way to the peer's own dial in", async () => {
    const { kb, ka, ta, tb } = await pairOf(1);
    const started = Date.now();
    const waiting = ta.connect(kb.id);
    await Bun.sleep(50);
    await tb.connect(ka.id);
    const link = await waiting;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await link.request<string>("who", null)).toBe("b");
  });

  test("gives way to a fresh dial on \"dial now\"", async () => {
    const { kb, ta, wa } = await pairOf(1);
    const started = Date.now();
    const waiting = ta.connect(kb.id);
    await Bun.sleep(50);
    ta.dialNow(kb.id);
    const link = await waiting;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(wa.dials).toBe(2);
    expect(await link.request<string>("who", null)).toBe("b");
  });
});
