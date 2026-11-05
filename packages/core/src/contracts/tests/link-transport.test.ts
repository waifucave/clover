// Pins the LinkTransport contract through FakeLinkNetwork: one link per pair, calls that fail fast when the path is
// gone, errors that keep their code, streams, and several daemons in one test.
import { describe, expect, test } from "bun:test";
import type { LinkView } from "@waifucave/clover-protocol";
import { ContractError, isContractError } from "../common";
import { FakeClock, flush } from "../fakes/clock";
import { FakeLinkNetwork } from "../fakes/link-transport";

const rejection = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

describe("FakeLinkNetwork", () => {
  test("a request reaches the peer's handler with a copy of its params, and the answer comes back", async () => {
    const net = new FakeLinkNetwork();
    const studio = net.endpoint("studio");
    const laptop = net.endpoint("laptop");
    laptop.handle("tree.stat", (params, from) => ({ path: (params as { path: string }).path, from }));
    const params = { path: "home/Laptop1/a.txt" };
    const link = await studio.connect("laptop");
    const answer = link.request("tree.stat", params);
    params.path = "mutated after sending";
    expect(await answer).toEqual({ path: "home/Laptop1/a.txt", from: "studio" });
  });

  test("one link per pair, whichever side dialled", async () => {
    const net = new FakeLinkNetwork();
    const a = net.endpoint("a");
    const b = net.endpoint("b");
    const ab = await a.connect("b");
    expect(await a.connect("b")).toBe(ab);
    await b.connect("a");
    expect(a.links()).toEqual([{ peer: "b", up: true, path: "lan", rttMs: 1 }]);
    expect(b.links().map((l) => l.peer)).toEqual(["a"]);
    expect(net.endpoint("a")).toBe(a);
  });

  test("a handler's ContractError reaches the caller with its code; a missing method answers not_found", async () => {
    const net = new FakeLinkNetwork();
    net.endpoint("b").handle("tree.read", () => {
      throw new ContractError("fenced", "the fence keeps bots out of settings");
    });
    const link = await net.endpoint("a").connect("b");
    const err = await rejection(link.request("tree.read", {}));
    expect(isContractError(err, "fenced")).toBe(true);
    expect((err as Error).message).toBe("the fence keeps bots out of settings");
    expect(isContractError(await rejection(link.request("nope", {})), "not_found")).toBe(true);
  });

  test("a cut path fails fast: dialling, new requests and requests in flight all answer offline", async () => {
    const net = new FakeLinkNetwork();
    const a = net.endpoint("a");
    const b = net.endpoint("b");
    b.handle("slow", () => new Promise(() => {}));
    const link = await a.connect("b");
    const views: LinkView[] = [];
    a.watch((v) => views.push(v));
    const inFlight = link.request("slow", {});
    await flush();
    net.partition("a", "b");
    expect(isContractError(await rejection(inFlight), "offline")).toBe(true);
    expect(isContractError(await rejection(link.request("slow", {})), "offline")).toBe(true);
    expect(isContractError(await rejection(a.connect("b")), "offline")).toBe(true);
    expect(link.view().up).toBe(false);
    net.heal("a", "b");
    expect(link.view().up).toBe(true);
    expect(views.map((v) => v.up)).toEqual([false, true]);
  });

  test("a device cut from everyone is unreachable from each peer", async () => {
    const net = new FakeLinkNetwork();
    for (const d of ["a", "b", "c"]) net.endpoint(d).handle("ping", () => d);
    const ab = await net.endpoint("a").connect("b");
    const ac = await net.endpoint("a").connect("c");
    net.partition("c");
    expect(await ab.request<string>("ping", null)).toBe("b");
    expect(isContractError(await rejection(ac.request("ping", null)), "offline")).toBe(true);
    expect(isContractError(await rejection(net.endpoint("b").connect("c")), "offline")).toBe(true);
  });

  test("notifications arrive in order; to a cut peer they are dropped", async () => {
    const net = new FakeLinkNetwork();
    const got: unknown[] = [];
    net.endpoint("b").onNotify("core.event", (p, from) => got.push([from, p]));
    const link = await net.endpoint("a").connect("b");
    link.notify("core.event", { n: 1 });
    link.notify("core.event", { n: 2 }, { priority: "tokens" });
    await flush();
    net.partition("a", "b");
    link.notify("core.event", { n: 3 });
    await flush();
    expect(got).toEqual([["a", { n: 1 }], ["a", { n: 2 }]]);
  });

  test("a stream carries its chunks in order, then ends; a cut path ends it with offline", async () => {
    const net = new FakeLinkNetwork();
    const received: number[][] = [];
    const ends: (Error | undefined)[] = [];
    net.endpoint("b").onStream("screenshot", (stream, meta) => {
      expect(meta).toEqual({ tab: "tab_1" });
      expect(stream.priority).toBe("screenshots");
      stream.onData((chunk) => received.push([...chunk]));
      stream.onEnd((e) => ends.push(e));
    });
    const link = await net.endpoint("a").connect("b");
    const s = link.openStream("screenshot", "screenshots", { tab: "tab_1" });
    const chunk = new Uint8Array([1, 2, 3]);
    await s.write(chunk);
    chunk[0] = 9;
    await s.write(new Uint8Array([4]));
    s.end();
    await flush();
    expect(received).toEqual([[1, 2, 3], [4]]);
    expect(ends).toEqual([undefined]);

    const s2 = link.openStream("screenshot", "screenshots", { tab: "tab_1" });
    let mine: Error | undefined;
    s2.onEnd((e) => (mine = e));
    await flush();
    net.partition("a", "b");
    await flush();
    expect(isContractError(mine, "offline")).toBe(true);
    expect(isContractError(ends.at(-1), "offline")).toBe(true);
    expect(isContractError(await rejection(s2.write(new Uint8Array([1]))), "offline")).toBe(true);
  });

  test("a stream no one takes ends not_found", async () => {
    const net = new FakeLinkNetwork();
    net.endpoint("b");
    const s = (await net.endpoint("a").connect("b")).openStream("files", "files");
    const err = await new Promise<Error | undefined>((resolve) => s.onEnd(resolve));
    expect(isContractError(err, "not_found")).toBe(true);
  });

  test("a request's own limit runs on the fake clock", async () => {
    const clock = new FakeClock();
    const net = new FakeLinkNetwork({ clock });
    net.endpoint("b").handle("slow", () => new Promise(() => {}));
    const link = await net.endpoint("a").connect("b");
    const p = link.request("slow", {}, { timeoutMs: 1000 });
    await flush();
    clock.advance(1000);
    expect(isContractError(await rejection(p), "timeout")).toBe(true);
  });

  test("several daemons talk in one test, and the OS's network-change events are counted", async () => {
    const net = new FakeLinkNetwork();
    const names = ["studio", "desktop1", "laptop1"];
    for (const n of names) net.endpoint(n).handle("whoami", () => n);
    const answers = await Promise.all(names.slice(1).map(async (n) => (await net.endpoint("studio").connect(n)).request("whoami", null)));
    expect(answers).toEqual(["desktop1", "laptop1"]);
    net.setPath("studio", "laptop1", "relay", 80);
    expect((await net.endpoint("studio").connect("laptop1")).view()).toMatchObject({ path: "relay", rttMs: 80 });
    net.endpoint("studio").networkChanged();
    expect(net.endpoint("studio").networkChanges).toBe(1);
    await net.endpoint("laptop1").close();
    expect(isContractError(await rejection(net.endpoint("studio").connect("laptop1")), "offline")).toBe(true);
  });
});
