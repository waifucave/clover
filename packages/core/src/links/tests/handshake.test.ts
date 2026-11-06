// The handshake client against a stand-in that checks what services/handshake/PROTOCOL.md says the service checks:
// signed requests and their replay rule, sealed `addr` records, "dial now" through the inbox and the socket, ending a
// pair, the group's lease; then the directory and the dial policy built on them.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { revokeDevice } from "../../devices/account-devices";
import { FileDeviceRegistry } from "../../devices/registry";
import { fromBase64Url, randomBytes, toBase64Url, utf8 } from "../../identity/bytes";
import { DeviceKey } from "../../identity/device-key";
import { generateEd25519 } from "../../identity/keys";
import { SystemClock } from "../../clock/system-clock";
import { DialPolicy, DIRECT_FIRST, mappingOf, RACE_RELAY } from "../dial-policy";
import {
  authorizationHeader, groupStatement, HandshakeClient, HandshakeError, openPairBox, pairBoxKey, pairStatement, sealPairBox,
} from "../handshake";
import { HandshakeDirectory } from "../handshake-directory";
import { startFakeHandshake, type FakeHandshake } from "../handshake-fake";
import { MemoryNetwork } from "../memory-wire";
import { PairingService } from "../pairing";

const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

function service(opts?: { registrationsPerMinute?: number }): FakeHandshake {
  const hs = startFakeHandshake(opts);
  stops.push(() => hs.stop());
  return hs;
}

async function registeredPair(hs: FakeHandshake) {
  const client = new HandshakeClient({ baseUrl: hs.url, clock });
  const a = generateEd25519();
  const b = generateEd25519();
  const pair = toBase64Url(randomBytes(16));
  const keys: [string, string] = [toBase64Url(a.publicKey), toBase64Url(b.publicKey)];
  const t = client.now();
  const st = pairStatement(pair, keys, t);
  expect(await client.registerPair({ pair, keys, t, sigs: [toBase64Url(a.sign(st)), toBase64Url(b.sign(st))] })).toBe(true);
  return { client, a, b, pair, keys };
}

describe("handshake client", () => {
  test("a pair registers once with both signatures; again is idempotent; one signature short is refused", async () => {
    const hs = service();
    const { client, a, b, pair, keys } = await registeredPair(hs);
    const t = client.now();
    const st = pairStatement(pair, keys, t);
    expect(await client.registerPair({ pair, keys, t, sigs: [toBase64Url(a.sign(st)), toBase64Url(b.sign(st))] })).toBe(false);
    const other = toBase64Url(randomBytes(16));
    const bad = await client.registerPair({ pair: other, keys, t, sigs: [toBase64Url(a.sign(pairStatement(other, keys, t))), toBase64Url(a.sign(pairStatement(other, keys, t)))] }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(HandshakeError);
    expect((bad as HandshakeError).status).toBe(401);
  });

  test("records are sealed under the pair's secret; the service holds only the box; a newer gen replaces it", async () => {
    const hs = service();
    const { client, a, b, pair, keys } = await registeredPair(hs);
    const box = pairBoxKey(randomBytes(32), pair);
    const ctx = (gen: number) => ({ scope: pair, from: keys[0], to: keys[1], kind: "addr" as const, gen });
    expect(await client.putRecord(pair, a, "addr", { gen: 2, ttl: 60, box: sealPairBox(box, ctx(2), { v: 1, at: 2, relay: "https://r/" }) })).toBe(true);
    expect(await client.putRecord(pair, a, "addr", { gen: 1, ttl: 60, box: sealPairBox(box, ctx(1), { v: 1, at: 1 }) })).toBe(false);
    const read = await client.readPair(pair, b);
    expect(read.records).toHaveLength(1);
    expect(openPairBox(box, ctx(2), read.records[0]!.box)).toEqual({ v: 1, at: 2, relay: "https://r/" });
    // Moved to another generation, direction or kind, the box doesn't open.
    expect(openPairBox(box, ctx(3), read.records[0]!.box)).toBeUndefined();
    expect(openPairBox(box, { ...ctx(2), from: keys[1], to: keys[0] }, read.records[0]!.box)).toBeUndefined();
    // The writer doesn't see its own record.
    expect((await client.readPair(pair, a)).records).toHaveLength(0);
  });

  test("a replayed signed request is refused; the client's t keeps rising", async () => {
    const hs = service();
    const { client, a, pair } = await registeredPair(hs);
    await client.sendMessage(pair, a, { kind: "dial", ttl: 30, box: toBase64Url(randomBytes(40)) });
    const body = utf8(JSON.stringify({ kind: "dial", ttl: 30, box: toBase64Url(randomBytes(40)) }));
    const path = `/v1/pairs/${pair}/messages`;
    const t = Date.now() - 5_000;
    const res = await fetch(`${hs.url}${path}`, { method: "POST", headers: { authorization: authorizationHeader(a, "POST", path, t, body), "content-type": "application/json" }, body });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "replay" });
    // Many at once from one client: queued, each with a later t.
    await Promise.all(Array.from({ length: 5 }, () => client.sendMessage(pair, a, { kind: "dial", ttl: 30, box: toBase64Url(randomBytes(40)) })));
  });

  test("a message waits in the inbox when the peer has no socket, and arrives at once when it has", async () => {
    const hs = service();
    const { client, a, b, pair } = await registeredPair(hs);
    expect((await client.sendMessage(pair, a, { kind: "dial", ttl: 30, box: toBase64Url(randomBytes(40)) })).delivered).toBe(false);
    expect(await client.inbox(pair, b)).toHaveLength(1);
    expect(await client.inbox(pair, b)).toHaveLength(0);
    const { url } = await client.pairTicket(pair, b);
    const ws = new WebSocket(url);
    const frames: Record<string, unknown>[] = [];
    ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data)) as Record<string, unknown>));
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    await waitFor(() => frames.some((f) => f.t === "hello"));
    expect((await client.sendMessage(pair, a, { kind: "dial", ttl: 30, box: toBase64Url(randomBytes(40)) })).delivered).toBe(true);
    await waitFor(() => frames.some((f) => f.t === "message"));
    ws.close();
  });

  test("an ended pair answers 410 and refuses a new registration", async () => {
    const hs = service();
    const { client, a, b, pair, keys } = await registeredPair(hs);
    await client.endPair(pair, a);
    await client.endPair(pair, b);
    const t = client.now();
    const st = pairStatement(pair, keys, t);
    const err = await client.registerPair({ pair, keys, t, sigs: [toBase64Url(a.sign(st)), toBase64Url(b.sign(st))] }).catch((e: unknown) => e);
    expect((err as HandshakeError).status).toBe(410);
  });

  test("registration is rate-limited hardest", async () => {
    const hs = service({ registrationsPerMinute: 2 });
    await registeredPair(hs);
    await registeredPair(hs);
    const err = await registeredPair(hs).catch((e: unknown) => e);
    expect((err as HandshakeError).status).toBe(429);
    expect((err as HandshakeError).retryAfter).toBe(60);
  });

  test("the group: founded, a member's lease acquired and renewed, another held off until takeover", async () => {
    const hs = service();
    const client = new HandshakeClient({ baseUrl: hs.url, clock });
    const a = generateEd25519();
    const group = toBase64Url(randomBytes(16));
    const t = client.now();
    expect(await client.createGroup({ group, key: toBase64Url(a.publicKey), t, sig: toBase64Url(a.sign(groupStatement(group, toBase64Url(a.publicKey), t))) })).toBe(true);
    const lease = await client.lease(group, a, { op: "acquire", epoch: 0 });
    expect(lease.holder).toBe(toBase64Url(a.publicKey));
    expect((await client.lease(group, a, { op: "renew", epoch: lease.epoch })).epoch).toBe(lease.epoch);
    expect((await client.readGroup(group, a)).members).toHaveLength(1);
  });
});

describe("who may hold a group's lease (lane I's lane/i-lease-voter, H-M2's check 3)", () => {
  test("every new tenure needs a member that votes now: a non-voter's acquire of a free lease is refused not_voter; holding on needs no vote", async () => {
    const { admitStatement, joinStatement } = await import("../handshake");
    const hs = service();
    const client = new HandshakeClient({ baseUrl: hs.url, clock });
    const [a, b, c] = [generateEd25519(), generateEd25519(), generateEd25519()];
    const k = (x: typeof a) => toBase64Url(x.publicKey);
    const group = toBase64Url(randomBytes(16));
    let t = client.now();
    expect(await client.createGroup({ group, key: k(a), t, sig: toBase64Url(a.sign(groupStatement(group, k(a), t))) })).toBe(true);
    // b comes in on the founder's admit, the only voter then: it votes at once. c comes in on one admit of two
    // voters: it votes in 7 days.
    for (const x of [b, c]) {
      t = client.now();
      expect(await client.joinGroup(group, { key: k(x), t, sig: toBase64Url(x.sign(joinStatement(group, k(x), t))), by: k(a), bysig: toBase64Url(a.sign(admitStatement(group, k(x), t))) })).toBe(true);
    }
    const status = (e: unknown) => (e instanceof HandshakeError ? [e.status, e.code] : [(e as { code?: string }).code]);
    // The lease never held: the non-voter can't take it; the founder can.
    expect(status(await client.lease(group, c, { op: "acquire", epoch: 0 }).catch((e: unknown) => e))).toEqual([403, "not_voter"]);
    const held = await client.lease(group, a, { op: "acquire", epoch: 0 });
    expect(held.holder).toBe(k(a));
    // Holding on needs no vote check; a held lease is refused as held (the client's conflict), not as a vote.
    expect((await client.lease(group, a, { op: "acquire", epoch: held.epoch })).epoch).toBe(held.epoch);
    expect(status(await client.lease(group, c, { op: "acquire", epoch: 0 }).catch((e: unknown) => e))).toEqual(["conflict"]);
    // Released: the non-voter still can't, a voter can, and the last holder takes its own back.
    await client.lease(group, a, { op: "release", epoch: held.epoch });
    expect(status(await client.lease(group, c, { op: "acquire", epoch: 0 }).catch((e: unknown) => e))).toEqual([403, "not_voter"]);
    const again = await client.lease(group, a, { op: "acquire", epoch: held.epoch });
    expect(again.holder).toBe(k(a));
    await client.lease(group, a, { op: "release", epoch: again.epoch });
    expect((await client.lease(group, b, { op: "acquire", epoch: again.epoch })).holder).toBe(k(b));
    expect(status(await client.lease(group, c, { op: "takeover", epoch: 0 }).catch((e: unknown) => e))).toEqual([403, "not_voter"]);
  });
});

describe("a join that moves a key (lane I's #195)", () => {
  test("the statement names the group it moves from as a fifth line, byte for byte with the service's; a move signed without it is refused", async () => {
    const { joinStatement, admitStatement } = await import("../handshake");
    const text = (b: Uint8Array) => new TextDecoder().decode(b);
    expect(text(joinStatement("g", "k", 1793000000123, "old"))).toBe("clover-handshake-v1 join\ng\nk\n1793000000123\nold");
    expect(text(joinStatement("g", "k", 1793000000123))).toBe("clover-handshake-v1 join\ng\nk\n1793000000123");
    const hs = service();
    const client = new HandshakeClient({ baseUrl: hs.url, clock });
    const host = generateEd25519();
    const mover = generateEd25519();
    const [g1, g2] = [toBase64Url(randomBytes(16)), toBase64Url(randomBytes(16))];
    const k = (x: typeof host) => toBase64Url(x.publicKey);
    let t = client.now();
    for (const [g, key] of [[g1, host], [g2, mover]] as const) {
      expect(await client.createGroup({ group: g, key: k(key), t, sig: toBase64Url(key.sign(groupStatement(g, k(key), t))) })).toBe(true);
    }
    t = client.now();
    const admit = { by: k(host), bysig: toBase64Url(host.sign(admitStatement(g1, k(mover), t))) };
    // Signed as a plain join, with `from` sent anyway: refused.
    const four = await client.joinGroup(g1, { key: k(mover), t, sig: toBase64Url(mover.sign(joinStatement(g1, k(mover), t))), ...admit, from: g2 }).catch((e: unknown) => e);
    expect((four as HandshakeError).status).toBe(401);
    // Signed with the group it moves from: in, and out of the old group.
    expect(await client.joinGroup(g1, { key: k(mover), t, sig: toBase64Url(mover.sign(joinStatement(g1, k(mover), t, g2))), ...admit, from: g2 })).toBe(true);
    expect(hs.groups.get(g1)?.members.has(k(mover))).toBe(true);
    expect(hs.groups.has(g2)).toBe(false);
  });
});

describe("handshake directory", () => {
  test("paired devices find each other's addresses, sealed, and a dial-now reaches the peer", async () => {
    const hs = service();
    const net = new MemoryNetwork();
    const devs = await Promise.all(["Studio", "Laptop"].map(async (name, i) => {
      const store = new MemorySecretStore();
      const key = await DeviceKey.loadOrCreate(store);
      const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-h-dir-")), key, clock, self: { name } });
      const client = new HandshakeClient({ baseUrl: hs.url, clock });
      const pairing = new PairingService({ self: key, registry, wire: net.endpoint(key.publicKey), clock, store, selfTarget: () => ({}), account: () => null, handshake: client });
      stops.push(() => pairing.close());
      const dialled: string[] = [];
      const directory = new HandshakeDirectory({
        registry, store, client, clock, onDialNow: (p) => dialled.push(p),
        localAddr: async () => ({ lan: [`192.168.1.${10 + i}:4000`], stun: [`203.0.113.${10 + i}:4000`], mapping: "same", relay: "https://relay.test/" }),
      });
      return { name, store, key, registry, client, pairing, directory, dialled };
    }));
    const [a, b] = devs as [typeof devs[0], typeof devs[0]];
    const view = await a.pairing.begin();
    const joined = await b.pairing.join(view.qr!);
    await waitFor(() => a.pairing.get(view.pairingId)?.status === "words");
    await Promise.all([a.pairing.confirm(view.pairingId, joined.words!, { terminal: true }), b.pairing.confirm(view.pairingId, joined.words!, { terminal: true })]);
    await waitFor(() => a.registry.pairWith(b.key.id)?.registeredAt !== undefined && b.registry.pairWith(a.key.id) !== undefined);
    // Before anything is published, the target is the key alone: the n0 lookup's fallback.
    expect(await b.directory.target(a.key.id)).toEqual({ key: a.key.publicKey });
    expect(await a.directory.publish()).toBe(1);
    const t = (await new HandshakeDirectory({ registry: b.registry, store: b.store, client: b.client, clock, localAddr: async () => ({}) }).target(a.key.id))!;
    expect(t).toMatchObject({ lan: ["192.168.1.10:4000"], direct: ["203.0.113.10:4000"], relay: "https://relay.test/" });
    // The service never saw an address in the clear.
    const read = await b.client.readPair(a.registry.pairWith(b.key.id)!.pairId, generateEd25519()).catch((e: unknown) => e);
    expect(read).toBeInstanceOf(HandshakeError);
    // Dial now: through the inbox, then through the socket.
    await a.directory.dialNow(b.key.id);
    expect(await b.directory.poll()).toEqual([a.key.id]);
    const close = await b.directory.connectSocket(a.key.id);
    await a.directory.dialNow(b.key.id);
    await waitFor(() => b.dialled.length === 2);
    close();
    // Revoking ends the pair at the service and removes the member from the group.
    const group = a.registry.group()!.id;
    await waitFor(() => hs.groups.get(group)?.members.size === 2);
    const out = await revokeDevice({ registry: a.registry, store: a.store, handshake: a.client }, b.key.id);
    expect(out.steps.map((s) => `${s.step}:${s.ok}`).sort()).toEqual(["handshake-group:true", "handshake-pair:true"]);
    expect(hs.ended.size).toBe(1);
    expect(hs.groups.get(group)?.members.size).toBe(1);
    // The revoked side's requests are refused: its pair is gone.
    expect(((await b.directory.publish().catch((e: unknown) => e)) as HandshakeError).status).toBe(410);
  });
});

describe("a revocation the service didn't hear (S5 of H-M1's review)", () => {
  test("its steps wait, with the pair's keys kept, and go through on the next refresh", async () => {
    const hs = service();
    const net = new MemoryNetwork();
    let down = false;
    const devs = await Promise.all(["Studio", "Laptop"].map(async (name) => {
      const store = new MemorySecretStore();
      const key = await DeviceKey.loadOrCreate(store);
      const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-h-hs-")), key, clock, self: { name } });
      const client = new HandshakeClient({ baseUrl: hs.url, clock, fetch: (req) => (down ? Promise.reject(new Error("no network")) : fetch(req)) });
      const pairing = new PairingService({ self: key, registry, wire: net.endpoint(key.publicKey), clock, store, selfTarget: () => ({}), account: () => null, handshake: client });
      stops.push(() => pairing.close());
      return { store, key, registry, client, pairing };
    }));
    const [a, b] = devs as [typeof devs[0], typeof devs[0]];
    const view = await a.pairing.begin();
    const joined = await b.pairing.join(view.qr!);
    await waitFor(() => a.pairing.get(view.pairingId)?.status === "words");
    await Promise.all([a.pairing.confirm(view.pairingId, joined.words!, { terminal: true }), b.pairing.confirm(view.pairingId, joined.words!, { terminal: true })]);
    await waitFor(() => a.registry.pairWith(b.key.id)?.registeredAt !== undefined);
    const pairId = a.registry.pairWith(b.key.id)!.pairId;
    const group = a.registry.group()!.id;
    // The laptop's join is in at the service before the network goes.
    await waitFor(() => hs.groups.get(group)?.members.size === 2);
    down = true;
    const { pairKeyRef, pairSecretRef } = await import("../handshake");
    const { retryRevokes } = await import("../../devices/account-devices");
    const out = await revokeDevice({ registry: a.registry, store: a.store, handshake: a.client }, b.key.id);
    expect(out.steps.every((x) => !x.ok)).toBe(true);
    // The revoke here took at once; the keys that end the pair at the service are kept, and the steps wait.
    expect(a.registry.get(b.key.id)?.revokedAt).toBeDefined();
    expect(await a.store.get(pairKeyRef(pairId))).not.toBeNull();
    expect(a.registry.pendingRevokes().map((r) => r.steps.sort())).toEqual([["handshake-group", "handshake-pair"]]);
    expect(hs.ended.size).toBe(0);
    down = false;
    await retryRevokes({ registry: a.registry, store: a.store, handshake: a.client });
    expect(hs.ended.has(pairId)).toBe(true);
    expect(hs.groups.get(group)?.members.size).toBe(1);
    expect(await a.store.get(pairKeyRef(pairId))).toBeNull();
    expect(await a.store.get(pairSecretRef(pairId))).toBeNull();
    expect(a.registry.pendingRevokes()).toEqual([]);
  });
});

describe("dial policy (c)", () => {
  const policy = (self: "same" | "varies" | "unknown", peer: "same" | "varies" | "unknown") => new DialPolicy({ selfMapping: () => self, peerMapping: () => peer });
  const key = fromBase64Url(toBase64Url(randomBytes(32)))!;
  test("two matching STUN answers on both sides: direct first, again at 100 ms, the relay at 500 ms", () => {
    expect(mappingOf(["203.0.113.5:1", "203.0.113.5:1"])).toBe("same");
    expect(mappingOf(["203.0.113.5:1", "203.0.113.5:2"])).toBe("varies");
    expect(mappingOf(["203.0.113.5:1"])).toBe("unknown");
    expect(policy("same", "same").plan("p", { key, direct: ["203.0.113.5:1"], relay: "https://r/" })).toEqual([...DIRECT_FIRST]);
  });
  test("otherwise the relay races from the start; the LAN is always direct first", () => {
    expect(policy("same", "varies").plan("p", { key, direct: ["203.0.113.5:1"], relay: "https://r/" })).toEqual([...RACE_RELAY]);
    expect(policy("unknown", "same").plan("p", { key, direct: ["203.0.113.5:1"], relay: "https://r/" })).toEqual([...RACE_RELAY]);
    expect(policy("varies", "varies").plan("p", { key, lan: ["192.168.1.2:1"], relay: "https://r/" })).toEqual([...DIRECT_FIRST]);
    expect(policy("same", "same").plan("p", { key, relay: "https://r/" })).toEqual([{ atMs: 0, directOnly: false }]);
  });
});

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}
