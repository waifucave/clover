// The account-less devices' group (H-M2): two groups merging into one when their computers pair (R18), hop by hop;
// removing a member with a quorum of voters, each asked by its own card; a member that doesn't vote yet can't take
// the lease over; recovery after another member removed this one (lane I's proposal, the two-voter case); and
// registrations past the service's 10-minute window signed again over the link. The service is lane H's stand-in,
// which follows lane I's "Group recovery" proposal.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemClock } from "../../clock/system-clock";
import { isContractError } from "../../contracts/common";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { retryRevokes, revokeDevice } from "../../devices/account-devices";
import { brokerCardOpener } from "../../devices/rpc";
import { toBase64Url } from "../../identity/bytes";
import { ed25519FromSecret } from "../../identity/keys";
import { GroupLeaseScope } from "../../lease/scope";
import { eligibleVoters, survivor } from "../group";
import { groupKeyRef, HandshakeClient, removeStatement } from "../handshake";
import { startFakeHandshake, type FakeHandshake, type FakeHandshakeOptions } from "../handshake-fake";
import { MemoryNetwork } from "../memory-wire";
import { type DeviceLinks, startDeviceLinks } from "../node";

const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

function service(opts?: FakeHandshakeOptions): FakeHandshake {
  // Four devices pairing and merging register more than the service's default ten a minute.
  const hs = startFakeHandshake({ registrationsPerMinute: 100, ...opts });
  stops.push(() => hs.stop());
  return hs;
}

interface Daemon { name: string; links: DeviceLinks; store: MemorySecretStore; broker: FakeApprovalBroker; client: HandshakeClient }

async function daemon(net: MemoryNetwork, hs: FakeHandshake, name: string, o: { down?: () => boolean; skew?: () => number } = {}): Promise<Daemon> {
  const store = new MemorySecretStore();
  const client = new HandshakeClient({
    baseUrl: hs.url, clock: { now: () => Date.now() + (o.skew?.() ?? 0) },
    fetch: (req) => (o.down?.() ? Promise.reject(new Error("no network")) : fetch(req)),
  });
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const links = await startDeviceLinks({
    home: mkdtempSync(join(tmpdir(), "clover-h-group-")), store, clock, self: { name }, wire: (k) => net.endpoint(k.publicKey),
    handshake: client, openCard: brokerCardOpener(broker), mainComputer: false, driver: false,
    ...(process.env.LANE_H_DEBUG ? { log: (l: string) => console.error(`${name} ${l}`) } : {}),
  });
  stops.push(() => links.close());
  return { name, links, store, broker, client };
}

async function pair(a: Daemon, b: Daemon): Promise<void> {
  const view = await a.links.pairing.begin();
  const joined = await b.links.pairing.join(view.qr!);
  await waitFor(() => a.links.pairing.get(view.pairingId)?.status === "words");
  await Promise.all([
    a.links.pairing.confirm(view.pairingId, joined.words!, { terminal: true }),
    b.links.pairing.confirm(view.pairingId, joined.words!, { terminal: true }),
  ]);
  await waitFor(() => a.links.registry.get(b.links.key.id) !== undefined && b.links.registry.get(a.links.key.id) !== undefined && b.links.registry.group() !== undefined);
  await waitFor(() => a.links.transport.links().some((l) => l.peer === b.links.key.id && l.up));
}

async function answer(d: Daemon, change: string, allow: boolean): Promise<void> {
  await waitFor(() => d.broker.cards().some((c) => c.change === change));
  const card = d.broker.cards().find((c) => c.change === change)!;
  const channel = d.broker.frameChannel(card.id)!;
  expect(await d.broker.answer(card.id, { optionId: allow ? "approve" : "deny", hash: card.hash, proof: { via: "sealed-frame", frame: channel, input: "click", at: Date.now() } }, { role: "app" })).toBe("accepted");
}

const groupOf = (d: Daemon) => d.links.registry.group()?.id;

describe("merging two groups (R18)", () => {
  test("the survivor's computer admits the other's, whose old mates follow hop by hop; the old group is gone", async () => {
    const hs = service();
    const net = new MemoryNetwork();
    const [a, b, c, d] = [await daemon(net, hs, "Studio"), await daemon(net, hs, "Laptop"), await daemon(net, hs, "Server"), await daemon(net, hs, "Mini")];
    await pair(a, b);
    await pair(c, d);
    const g1 = groupOf(a)!;
    const g2 = groupOf(c)!;
    expect(g1).not.toBe(g2);
    await waitFor(() => hs.groups.get(g1)?.members.size === 2 && hs.groups.get(g2)?.members.size === 2);
    // The laptop and the server pair: their groups are two of two, so the smaller id survives.
    await pair(b, c);
    const kept = survivor({ id: g1, size: 2 }, { id: g2, size: 2 });
    const gone = kept === g1 ? g2 : g1;
    await waitFor(() => [a, b, c, d].every((x) => groupOf(x) === kept), 15_000);
    await waitFor(() => hs.groups.get(kept)?.members.size === 4 && !hs.groups.has(gone));
    // Each left its old group for good, and the computers that admitted them know their keys.
    const movers = kept === g1 ? [c, d] : [a, b];
    for (const m of movers) expect(m.links.registry.groupLeft(gone)?.how).toBe("moved");
    expect(b.links.registry.group()!.members[c.links.key.id]?.key).toBeDefined();
    expect(c.links.registry.group()!.members[b.links.key.id]?.key).toBeDefined();
  }, 40_000);
});

describe("voters and the quorum (lane I's proposal)", () => {
  test("removing a member asks the other voters, each by its card: one declines, one agrees, and that's a quorum", async () => {
    const hs = service({ voteAfterMs: 0 });
    const net = new MemoryNetwork();
    const [a, b, c, d] = [await daemon(net, hs, "Studio"), await daemon(net, hs, "Laptop"), await daemon(net, hs, "Server"), await daemon(net, hs, "Mini")];
    await pair(a, b);
    await pair(a, c);
    await pair(a, d);
    const g = groupOf(a)!;
    await waitFor(() => hs.groups.get(g)?.members.size === 4);
    const dKey = d.links.registry.group()!.ownKey;
    // Three voters besides the mini: two must agree. The studio is one; it asks the laptop and the server.
    const out = revokeDevice(a.links.revokeOptions(), d.links.key.id);
    await answer(b, "device-revoke", false);
    await answer(c, "device-revoke", true);
    const steps = (await out).steps;
    expect(steps.find((s) => s.step === "handshake-group")).toMatchObject({ ok: true });
    expect(hs.groups.get(g)?.members.has(dKey)).toBe(false);
    expect(hs.groups.get(g)?.members.size).toBe(3);
  }, 40_000);

  test("short of a quorum the step waits; a member that doesn't vote yet can't take the lease over", async () => {
    const hs = service();
    const net = new MemoryNetwork();
    const [a, b, c] = [await daemon(net, hs, "Studio"), await daemon(net, hs, "Laptop"), await daemon(net, hs, "Server")];
    await pair(a, b);
    await pair(a, c);
    const g = groupOf(a)!;
    await waitFor(() => hs.groups.get(g)?.members.size === 3);
    // The laptop came in on the studio's admit alone when the studio was the only voter: it votes. The server came in
    // on one admit of two voters: it votes in 72 hours.
    await c.links.groups!.refresh();
    expect(c.links.registry.group()!.votesFrom! > Date.now() + 71 * 3600_000).toBe(true);
    await a.links.groups!.refresh();
    expect(a.links.registry.group()!.members[b.links.key.id]?.votesFrom).toBeLessThanOrEqual(Date.now());
    const scope = (await GroupLeaseScope.open({ client: c.client, registry: c.links.registry, store: c.store }))!;
    const err = await scope.op("takeover", 0, 30).catch((e: unknown) => e);
    expect(isContractError(err, "refused")).toBe(true);
    expect((err as Error).message).toContain("once it votes");
    // The studio revokes the laptop with no card to answer on the server (it doesn't vote): just the studio, which is
    // the only voter besides the laptop. Done.
    const out = await revokeDevice(a.links.revokeOptions(), b.links.key.id);
    expect(out.steps.find((s) => s.step === "handshake-group")).toMatchObject({ ok: true });
    // Now the server alone can't remove the studio: it doesn't vote.
    const cKey = ed25519FromSecret((await c.store.get(groupKeyRef(g)))!.value);
    const aKey = a.links.registry.group()!.ownKey;
    const refused = await c.client.removeGroupMember(g, cKey, aKey).catch((e: unknown) => e);
    expect((refused as { code?: string }).code).toBe("no_quorum");
  }, 40_000);

  test("who counts: voters now, not the target, not the keys it admitted in the last 7 days", () => {
    const now = Date.now();
    const m = (key: string, votesFrom: number | null, admittedBy: string[] = [], joinedAt = now - 1000) => ({ key, joinedAt, votesFrom, admittedBy });
    const members = [m("A", now - 10), m("B", now - 10, ["A"]), m("C", now + 1000, ["A"]), m("D", now - 10, ["B"]), m("E", now - 10, ["B"], now - 8 * 86_400_000)];
    expect(eligibleVoters(members, "B", now).map((x) => x.key)).toEqual(["A", "E"]);
    expect(eligibleVoters(members, "A", now).map((x) => x.key)).toEqual(["D", "E"]);
  });
});

describe("recovery after another member removed this one (two voters)", () => {
  test("the removed computer founds a new group; the computer it's still linked with follows when its user agrees", async () => {
    const hs = service({ rollbackMs: 1 });
    const net = new MemoryNetwork();
    const [a, b, c] = [await daemon(net, hs, "Studio"), await daemon(net, hs, "Laptop"), await daemon(net, hs, "Server")];
    await pair(a, b);
    await pair(a, c);
    const g = groupOf(a)!;
    await waitFor(() => hs.groups.get(g)?.members.size === 3);
    await Bun.sleep(5);
    // The laptop is stolen. The thief removes the studio: the laptop is the only voter besides it.
    const bKey = ed25519FromSecret((await b.store.get(groupKeyRef(g)))!.value);
    const aKey = a.links.registry.group()!.ownKey;
    const t = b.client.now();
    await b.client.removeGroupMember(g, bKey, aKey, { t, removes: [{ by: toBase64Url(bKey.publicKey), sig: toBase64Url(bKey.sign(removeStatement(g, aKey, t))) }] });
    expect(hs.groups.get(g)?.members.has(aKey)).toBe(false);
    // The user revokes the laptop on the studio: here at once, but not at the group, which no longer has the studio.
    const out = await revokeDevice(a.links.revokeOptions(), b.links.key.id);
    expect(out.steps.find((s) => s.step === "handshake-group")).toMatchObject({ ok: false });
    // The studio's next refresh finds it was removed: it founds a new group and invites the server.
    void a.links.refresh();
    await answer(c, "device-add", true);
    await waitFor(() => groupOf(c) !== undefined && groupOf(c) === groupOf(a) && groupOf(a) !== g);
    const fresh = groupOf(a)!;
    await waitFor(() => hs.groups.get(fresh)?.members.size === 2);
    expect(a.links.registry.group()!.recoveredFrom).toBe(g);
    expect(a.links.registry.groupLeft(g)?.how).toBe("removed");
    expect(c.links.registry.groupLeft(g)?.how).toBe("moved");
    expect(hs.groups.get(g)?.members.size).toBe(1);
    // The revocation's group step is done: the studio left that group.
    await retryRevokes(a.links.revokeOptions());
    expect(a.links.registry.pendingRevokes()).toEqual([]);
  }, 40_000);
});

describe("registrations past the service's window (H-M1's review)", () => {
  test("a pair and a group the service never took are signed again, the peer's half over the link", async () => {
    let down = true;
    let skew = 0;
    const hs = service({ now: () => Date.now() + skew });
    const net = new MemoryNetwork();
    const o = { down: () => down, skew: () => skew };
    const [a, b] = [await daemon(net, hs, "Studio", o), await daemon(net, hs, "Laptop", o)];
    await pair(a, b);
    expect(a.links.registry.group()?.pendingCreate).toBeDefined();
    expect(b.links.registry.group()?.pendingJoin).toBeDefined();
    // Eleven minutes on, the service is back: the statements signed at pairing are out of its window.
    skew = 11 * 60_000;
    down = false;
    await a.links.refresh();
    await b.links.refresh();
    await a.links.refresh();
    expect(hs.pairs.size).toBe(1);
    expect(a.links.registry.pairWith(b.links.key.id)?.registeredAt).toBeDefined();
    const g = groupOf(a)!;
    expect(hs.groups.get(g)?.members.size).toBe(2);
    expect(a.links.registry.group()?.pendingCreate).toBeUndefined();
    expect(b.links.registry.group()?.pendingJoin).toBeUndefined();
  }, 40_000);
});
