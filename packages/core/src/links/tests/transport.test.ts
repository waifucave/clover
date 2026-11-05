// CloverLinkTransport over the in-memory wire. The first ten cases follow the LinkTransport conformance suite
// (contracts/conformance/link-transport.ts) case by case; where the fake answers at once and a real transport has to
// re-dial (after a heal), the case waits for the link instead. The rest pin what the real transport adds: pairing and
// revocation at the door, one connection after both sides dial, re-dials, networkChanged, and the payload encoding.
import { afterEach, describe, expect, test } from "bun:test";
import type { LinkView } from "@waifucave/clover-protocol";
import { SystemClock } from "../../clock/system-clock";
import { ContractError, isContractError } from "../../contracts/common";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { makeLinkCluster } from "../testing";
import { ALPN_LINK } from "../wire";

const rejection = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function cluster(names: string[], opts: Parameters<typeof makeLinkCluster>[1] = { clock: new SystemClock() }) {
  const c = await makeLinkCluster(names, opts);
  closers.push(() => c.close());
  const t = (n: string) => c.devices.get(n)!.transport;
  const id = (n: string) => c.devices.get(n)!.id;
  const key = (n: string) => c.devices.get(n)!.key.publicKey;
  return { ...c, t, id, key };
}

describe("CloverLinkTransport, the conformance cases", () => {
  test("a request reaches the peer's handler with a copy of its params, and the answer comes back", async () => {
    const c = await cluster(["studio", "laptop"]);
    c.t("laptop").handle("tree.stat", (params, from) => ({ path: (params as { path: string }).path, from }));
    const params = { path: "home/Laptop1/a.txt" };
    const link = await c.t("studio").connect(c.id("laptop"));
    const answer = link.request("tree.stat", params);
    params.path = "mutated after sending";
    expect(await answer).toEqual({ path: "home/Laptop1/a.txt", from: c.id("studio") });
  });

  test("one link per pair, whichever side dialled", async () => {
    const c = await cluster(["a", "b"]);
    const ab = await c.t("a").connect(c.id("b"));
    expect(await c.t("a").connect(c.id("b"))).toBe(ab);
    await c.t("b").connect(c.id("a"));
    expect(c.t("a").links()).toEqual([expect.objectContaining({ peer: c.id("b"), up: true, path: "lan", rttMs: 1 })]);
    expect(c.t("b").links().map((l) => l.peer)).toEqual([c.id("a")]);
  });

  test("a handler's ContractError reaches the caller with its code; a missing method answers not_found", async () => {
    const c = await cluster(["a", "b"]);
    c.t("b").handle("tree.read", () => {
      throw new ContractError("fenced", "the fence keeps bots out of settings");
    });
    const link = await c.t("a").connect(c.id("b"));
    const err = await rejection(link.request("tree.read", {}));
    expect(isContractError(err, "fenced")).toBe(true);
    expect((err as Error).message).toBe("the fence keeps bots out of settings");
    expect(isContractError(await rejection(link.request("nope", {})), "not_found")).toBe(true);
  });

  test("a cut path fails fast: dialling, new requests and requests in flight all answer offline; it re-dials after a heal", async () => {
    const c = await cluster(["a", "b"]);
    c.t("b").handle("slow", () => new Promise(() => {}));
    const link = await c.t("a").connect(c.id("b"));
    const views: LinkView[] = [];
    c.t("a").watch((v) => views.push(v));
    const inFlight = link.request("slow", {});
    await flush();
    c.net.partition(c.key("a"), c.key("b"));
    expect(isContractError(await rejection(inFlight), "offline")).toBe(true);
    expect(isContractError(await rejection(link.request("slow", {})), "offline")).toBe(true);
    expect(isContractError(await rejection(c.t("a").connect(c.id("b"))), "offline")).toBe(true);
    expect(link.view().up).toBe(false);
    c.net.heal(c.key("a"), c.key("b"));
    await waitFor(() => link.view().up, 3000);
    expect(views.map((v) => v.up)).toEqual([false, true]);
  });

  test("a device cut from everyone is unreachable from each peer", async () => {
    const c = await cluster(["a", "b", "c"]);
    for (const d of ["a", "b", "c"]) c.t(d).handle("ping", () => d);
    const ab = await c.t("a").connect(c.id("b"));
    const ac = await c.t("a").connect(c.id("c"));
    c.net.partition(c.key("c"));
    expect(await ab.request<string>("ping", null)).toBe("b");
    expect(isContractError(await rejection(ac.request("ping", null)), "offline")).toBe(true);
    expect(isContractError(await rejection(c.t("b").connect(c.id("c"))), "offline")).toBe(true);
  });

  test("notifications arrive in order; to a cut peer they are dropped", async () => {
    const c = await cluster(["a", "b"]);
    const got: unknown[] = [];
    c.t("b").onNotify("core.event", (p, from) => got.push([from, p]));
    const link = await c.t("a").connect(c.id("b"));
    link.notify("core.event", { n: 1 });
    link.notify("core.event", { n: 2 }, { priority: "tokens" });
    await waitFor(() => got.length === 2);
    c.net.partition(c.key("a"), c.key("b"));
    link.notify("core.event", { n: 3 });
    await flush();
    expect(got).toEqual([[c.id("a"), { n: 1 }], [c.id("a"), { n: 2 }]]);
  });

  test("a stream carries its chunks in order, then ends; a cut path ends it with offline", async () => {
    const c = await cluster(["a", "b"]);
    const received: number[][] = [];
    const ends: (Error | undefined)[] = [];
    c.t("b").onStream("screenshot", (stream, meta) => {
      expect(meta).toEqual({ tab: "tab_1" });
      expect(stream.priority).toBe("screenshots");
      stream.onData((chunk) => received.push([...chunk]));
      stream.onEnd((e) => ends.push(e));
    });
    const link = await c.t("a").connect(c.id("b"));
    const s = link.openStream("screenshot", "screenshots", { tab: "tab_1" });
    const chunk = new Uint8Array([1, 2, 3]);
    await s.write(chunk);
    chunk[0] = 9;
    await s.write(new Uint8Array([4]));
    s.end();
    await waitFor(() => ends.length === 1);
    expect(received).toEqual([[1, 2, 3], [4]]);
    expect(ends).toEqual([undefined]);

    const s2 = link.openStream("screenshot", "screenshots", { tab: "tab_1" });
    let mine: Error | undefined;
    s2.onEnd((e) => (mine = e));
    await s2.write(new Uint8Array([7]));
    await waitFor(() => received.length === 3);
    c.net.partition(c.key("a"), c.key("b"));
    await waitFor(() => mine !== undefined && ends.length === 2);
    expect(isContractError(mine, "offline")).toBe(true);
    expect(isContractError(ends.at(-1), "offline")).toBe(true);
    expect(isContractError(await rejection(s2.write(new Uint8Array([1]))), "offline")).toBe(true);
  });

  test("a stream no one takes ends not_found", async () => {
    const c = await cluster(["a", "b"]);
    const s = (await c.t("a").connect(c.id("b"))).openStream("files", "files");
    const err = await new Promise<Error | undefined>((resolve) => s.onEnd(resolve));
    expect(isContractError(err, "not_found")).toBe(true);
  });

  test("a request's own limit runs on the fake clock", async () => {
    const clock = new FakeClock();
    const c = await cluster(["a", "b"], { clock });
    c.t("b").handle("slow", () => new Promise(() => {}));
    const link = await c.t("a").connect(c.id("b"));
    const p = link.request("slow", {}, { timeoutMs: 1000 });
    await flush();
    clock.advance(1000);
    expect(isContractError(await rejection(p), "timeout")).toBe(true);
  });

  test("several daemons talk in one test; a relay path shows; network changes are counted; a closed peer is offline", async () => {
    const c = await cluster(["studio", "desktop1", "laptop1"], { clock: new SystemClock(), transport: { relayLabel: () => "clover/relay-n0" } });
    const names = ["studio", "desktop1", "laptop1"];
    for (const n of names) c.t(n).handle("whoami", () => n);
    const answers = await Promise.all(names.slice(1).map(async (n) => (await c.t("studio").connect(c.id(n))).request("whoami", null)));
    expect(answers).toEqual(["desktop1", "laptop1"]);
    c.net.setPath(c.key("studio"), c.key("laptop1"), { kind: "relay", rttMs: 80, relay: "https://relay.test/" });
    expect((await c.t("studio").connect(c.id("laptop1"))).view()).toMatchObject({ path: "relay", relay: "clover/relay-n0", rttMs: 80 });
    c.t("studio").networkChanged();
    expect(c.t("studio").networkChanges).toBe(1);
    expect(c.devices.get("studio")!.endpoint.networkChanges).toBe(1);
    await c.t("laptop1").close();
    await waitFor(() => !c.t("studio").link(c.id("laptop1")).up);
    expect(isContractError(await rejection(c.t("studio").connect(c.id("laptop1"))), "offline")).toBe(true);
  });
});

describe("CloverLinkTransport, beyond the contract's cases", () => {
  test("a key that isn't paired is refused at the door, and connect refuses an unpaired device", async () => {
    const c = await cluster(["a", "b", "stranger"], { clock: new SystemClock(), pairAll: false });
    await c.pair("a", "b");
    expect(isContractError(await rejection(c.t("stranger").connect(c.id("a"))), "refused")).toBe(true);
    // The stranger dials anyway, at the wire: a's transport closes the connection.
    const conn = await c.devices.get("stranger")!.endpoint.dial({ key: c.key("a") }, { alpn: ALPN_LINK });
    const closed = await conn.closed;
    expect(closed.reason).toBe("not a paired device");
    expect(await (await c.t("a").connect(c.id("b"))).request("missing", null).catch((e: unknown) => (e as ContractError).code)).toBe("not_found");
  });

  test("revoking a device cuts its link at once and refuses it afterwards", async () => {
    const c = await cluster(["a", "b"]);
    c.t("b").handle("slow", () => new Promise(() => {}));
    const link = await c.t("a").connect(c.id("b"));
    const inFlight = link.request("slow", {});
    await flush();
    await c.devices.get("a")!.registry.revoke(c.id("b"));
    expect(isContractError(await rejection(inFlight), "refused")).toBe(true);
    expect(link.view().up).toBe(false);
    expect(isContractError(await rejection(c.t("a").connect(c.id("b"))), "refused")).toBe(true);
    // b can't get back in either: a refuses its key at the door, saying why.
    await waitFor(() => !c.t("b").link(c.id("a")).up);
    expect(isContractError(await rejection(c.t("b").connect(c.id("a"))), "refused")).toBe(true);
  });

  test("when both sides dial at once, they settle on one connection", async () => {
    const c = await cluster(["a", "b"]);
    c.t("a").handle("who", () => "a");
    c.t("b").handle("who", () => "b");
    const [ab, ba] = await Promise.all([c.t("a").connect(c.id("b")), c.t("b").connect(c.id("a"))]);
    expect(await ab.request<string>("who", null)).toBe("b");
    expect(await ba.request<string>("who", null)).toBe("a");
    await waitFor(() => c.t("a").link(c.id("b")).sessions.size === 1 && c.t("b").link(c.id("a")).sessions.size === 1);
    const sa = [...c.t("a").link(c.id("b")).sessions][0]!;
    const sb = [...c.t("b").link(c.id("a")).sessions][0]!;
    expect(sa.conn.id).toBe(sb.conn.id);
    expect(await ab.request<string>("who", null)).toBe("b");
  });

  test("a lost link re-dials by itself, backing off, once the path is back", async () => {
    const clock = new FakeClock();
    const c = await cluster(["a", "b"], { clock });
    c.t("b").handle("who", () => "b");
    const link = await c.t("a").connect(c.id("b"));
    c.net.partition(c.key("a"), c.key("b"));
    await flush();
    expect(link.view().up).toBe(false);
    clock.advance(0);
    await flush();
    expect(link.view().up).toBe(false);
    c.net.heal(c.key("a"), c.key("b"));
    clock.advance(250);
    await waitFor(() => link.view().up);
    expect(await link.request<string>("who", null)).toBe("b");
  });

  test("a network change re-dials, and the new connection takes over from the old", async () => {
    const c = await cluster(["a", "b"]);
    c.t("b").handle("who", () => "b");
    const link = await c.t("a").connect(c.id("b"));
    const before = [...c.t("a").link(c.id("b")).sessions][0]!.conn.id;
    c.t("a").networkChanged();
    await waitFor(() => {
      const s = [...c.t("a").link(c.id("b")).sessions];
      return s.length === 1 && s[0]!.conn.id !== before;
    });
    expect(await link.request<string>("who", null)).toBe("b");
    await waitFor(() => [...c.t("b").link(c.id("a")).sessions].length === 1);
  });

  test("payloads keep bytes, maps, sets, dates, bigints and undefined", async () => {
    const c = await cluster(["a", "b"]);
    c.t("b").handle("echo", (p) => p);
    const link = await c.t("a").connect(c.id("b"));
    const value = { bytes: new Uint8Array([1, 2, 255]), map: new Map<unknown, unknown>([[1, "one"], ["k", [true]]]), set: new Set(["x"]), at: new Date(1781270000123), big: 2n ** 70n, none: undefined, neg: -5, f: 1.5 };
    expect(await link.request<unknown>("echo", value)).toEqual(value);
    expect(isContractError(await rejection(link.request("echo", { f: () => 1 })), "invalid")).toBe(true);
  });

  test("a stream works both ways: the side that took it can write back", async () => {
    const c = await cluster(["a", "b"]);
    c.t("b").onStream("echo", (s) => {
      s.onData((chunk) => void s.write(chunk.map((x) => x + 1)));
    });
    const s = (await c.t("a").connect(c.id("b"))).openStream("echo", "files");
    const back: number[][] = [];
    s.onData((chunk) => back.push([...chunk]));
    await s.write(new Uint8Array([1, 2]));
    await waitFor(() => back.length === 1);
    expect(back).toEqual([[2, 3]]);
    s.end();
  });
});
