// The forwarder client against a fake hooks.waifucave.com: registering the core's key, its one connection,
// keep-alives, reconnecting with backoff, delivery and acknowledgement, revocation, and what the review of
// I-M1 asked for (two copies of one computer, expired tokens, drops, ownership, no account, hung requests).

import { describe, expect, test } from "bun:test";

import { ForwarderClient, RoutineHeldElsewhere, type ClientState, type Delivery } from "../src/client";
import { memoryKeys, type ForwarderKeys } from "../src/keys";
import { b64u, fromUtf8 } from "../src/wire/bytes";
import { keyId } from "../src/wire/envelope";
import { generateX25519 } from "../src/wire/hpke";
import { CLOSE_REAUTH, CLOSE_REPLACED, hookKeyHash, PING, PONG } from "../src/wire/protocol";
import { FakeClock, FakeService, settle, until } from "./fakes";

/** The core's key store, in memory; `unavailable` makes publicKey throw as a locked store would. */
function testKeys(): ForwarderKeys & { unavailable: boolean; publicKeyNow(): Promise<Uint8Array> } {
  const held = memoryKeys();
  const keys = {
    unavailable: false,
    publicKeyNow: async () => (await held).publicKey(),
    publicKey: async () => {
      if (keys.unavailable) throw new Error("the key store is locked");
      return (await held).publicKey();
    },
    open: async (input: Parameters<ForwarderKeys["open"]>[0]) => (await held).open(input),
  };
  return keys;
}

function setup(options: { service?: FakeService; requestTimeoutMs?: number } = {}) {
  const service = options.service ?? new FakeService();
  const clock = new FakeClock();
  const keys = testKeys();
  const deliveries: Delivery[] = [];
  const states: ClientState[] = [];
  const logs: string[] = [];
  const client = new ForwarderClient({
    origin: "https://hooks.test",
    fetch: service.fetch,
    keys,
    connect: service.connect,
    onDelivery: (d) => deliveries.push(d),
    onState: (s) => states.push(s),
    log: (level, message) => logs.push(`${level}: ${message}`),
    clock,
    random: () => 1,
    deviceName: "Laptop",
    ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  });
  return { service, clock, client, deliveries, states, logs, keys };
}

async function connected(t: ReturnType<typeof setup>) {
  await t.client.start();
  await t.clock.advance(0);
  t.service.socket.open();
  await settle();
  expect(t.client.state).toBe("open");
}

describe("registration", () => {
  test("registers the public half of the key the core holds", async () => {
    const t = setup();
    await t.client.start();
    const publicKey = await t.keys.publicKeyNow();
    expect(b64u(t.service.encKey!)).toBe(b64u(publicKey));
    expect(t.service.calls[0]).toEqual({ method: "PUT", path: "/v1/devices/self", body: { encKey: b64u(publicKey), name: "Laptop" } });
    expect(t.client.tag).toBe("T".repeat(24));
  });

  test("while the core's key store is unavailable it waits, and never registers a key of its own", async () => {
    const t = setup();
    t.keys.unavailable = true;
    await t.client.start();
    expect(t.service.calls).toHaveLength(0);
    expect(t.client.state).toBe("waiting");
    t.keys.unavailable = false;
    await t.clock.advance(1_000);
    expect(b64u(t.service.encKey!)).toBe(b64u(await t.keys.publicKeyNow()));
  });

  test("with no account signed in it waits quietly and looks again every few minutes", async () => {
    const service = new FakeService();
    service.noAccount = true;
    const t = setup({ service });
    await t.client.start();
    expect(t.client.state).toBe("signed-out");
    expect(t.clock.pending()).toEqual([5 * 60_000]);
    await t.clock.advance(5 * 60_000);
    expect(t.client.state).toBe("signed-out");
    service.noAccount = false;
    await t.clock.advance(5 * 60_000);
    expect(service.sockets).toHaveLength(1);
    expect(t.logs.filter((l) => l.includes("no waifucave account"))).toHaveLength(1);
  });

  test("a request that never answers is abandoned, and the client tries again", async () => {
    const service = new FakeService();
    service.hang = true;
    const t = setup({ service, requestTimeoutMs: 30 });
    const started = t.client.start();
    await new Promise((r) => setTimeout(r, 80));
    await started;
    expect(t.client.state).toBe("waiting");
    service.hang = false;
    await t.clock.advance(1_000);
    expect(service.encKey).not.toBeNull();
  });

  test("a revoked computer stops", async () => {
    const service = new FakeService();
    service.revoked = true;
    const t = setup({ service });
    await t.client.start();
    await t.clock.advance(120_000);
    expect(t.client.state).toBe("revoked");
    expect(service.sockets).toHaveLength(0);
  });

  test("registers a routine by its key's hash, and reports a routine held elsewhere", async () => {
    const t = setup();
    const key = "k".repeat(43);
    expect(await t.client.registerRoutine("deploy", key)).toEqual({ url: `https://hooks.test/${"T".repeat(24)}/deploy` });
    const call = t.service.calls.find((c) => c.path === "/v1/routines/deploy")!;
    expect(call.body).toEqual({ keyHash: b64u(await hookKeyHash(key)), takeover: false, allowGet: false });
    expect(JSON.stringify(t.service.calls)).not.toContain(key);
    t.service.routines.set("elsewhere", { keyHash: "x", device: "desktop", allowGet: false });
    await expect(t.client.registerRoutine("elsewhere", key)).rejects.toBeInstanceOf(RoutineHeldElsewhere);
    expect(await t.client.registerRoutine("elsewhere", key, { takeover: true })).toHaveProperty("url");
  });

  test("registers by the key's hash, and asks for GET only when told to", async () => {
    const t = setup();
    const keyHash = await hookKeyHash("h".repeat(43));
    await t.client.registerRoutineHash("by-hash", keyHash, { allowGet: true });
    expect(t.service.calls.find((c) => c.path === "/v1/routines/by-hash")!.body).toEqual({ keyHash: b64u(keyHash), takeover: false, allowGet: true });
  });

  test("registers its key again, once, when the service has forgotten this computer", async () => {
    const t = setup();
    await t.client.start();
    t.service.forgotDevice = 1;
    expect(await t.client.registerRoutine("deploy", "k".repeat(43))).toHaveProperty("url");
    expect(t.service.calls.filter((c) => c.path === "/v1/devices/self")).toHaveLength(2);
    t.service.forgotDevice = 2;
    await expect(t.client.registerRoutine("again", "k".repeat(43))).rejects.toThrow("device_not_registered");
  });

  test("unregistering a routine another computer holds reports where it is", async () => {
    const t = setup();
    t.service.routines.set("moved", { keyHash: "x", device: "desktop", allowGet: false });
    await expect(t.client.unregisterRoutine("moved")).rejects.toBeInstanceOf(RoutineHeldElsewhere);
    expect(t.service.routines.get("moved")!.device).toBe("desktop");
  });
});

describe("the connection", () => {
  test("opens one socket on a fresh ticket", async () => {
    const t = setup();
    await connected(t);
    expect(t.service.sockets).toHaveLength(1);
    expect(t.service.socket.url).toBe("wss://hooks.test/v1/connect?ticket=t1");
    expect(t.service.socket.binaryType).toBe("arraybuffer");
  });

  test("pings every 30 s; an answered ping keeps the socket", async () => {
    const t = setup();
    await connected(t);
    await t.clock.advance(30_000);
    expect(t.service.socket.sent).toEqual([PING]);
    t.service.socket.receive(PONG);
    await settle();
    await t.clock.advance(15_000);
    expect(t.service.sockets).toHaveLength(1);
    expect(t.client.state).toBe("open");
  });

  test("an unanswered ping drops the socket and reconnects", async () => {
    const t = setup();
    await connected(t);
    await t.clock.advance(30_000 + 10_000);
    expect(t.service.sockets[0]!.closedBy?.code).toBe(4000);
    await t.clock.advance(1_000);
    expect(t.service.sockets).toHaveLength(2);
    t.service.socket.open();
    await settle();
    expect(t.client.state).toBe("open");
  });

  test("backs off 1 s, 2 s, 4 s while the service fails, then connects", async () => {
    const service = new FakeService();
    service.ticketFailures = 3;
    const t = setup({ service });
    await t.client.start();
    await t.clock.advance(0);
    expect(t.clock.pending()).toEqual([1_000]);
    await t.clock.advance(1_000);
    expect(t.clock.pending()).toEqual([2_000]);
    await t.clock.advance(2_000);
    expect(t.clock.pending()).toEqual([4_000]);
    await t.clock.advance(4_000);
    expect(service.sockets).toHaveLength(1);
  });

  test("reconnects after the service closes the socket, but not after a revocation or stop", async () => {
    const t = setup();
    await connected(t);
    t.service.socket.serverClose(1001); // going away (a deploy, say)
    await t.clock.advance(1_000);
    expect(t.service.sockets).toHaveLength(2);
    t.service.socket.open();
    await settle();
    t.service.socket.serverClose(4003); // revoked
    await t.clock.advance(120_000);
    expect(t.client.state).toBe("revoked");
    expect(t.service.sockets).toHaveLength(2);

    const u = setup();
    await connected(u);
    await u.client.stop();
    await u.clock.advance(120_000);
    expect(u.service.sockets).toHaveLength(1);
    expect(u.service.socket.closedBy?.code).toBe(1000);
  });
});

describe("connections the service ends", () => {
  test("connects only to its own origin, over wss", async () => {
    const service = new FakeService();
    service.ticketUrl = (n) => `wss://elsewhere.test/v1/connect?ticket=t${n}`;
    const t = setup({ service });
    await t.client.start();
    await t.clock.advance(0);
    expect(service.sockets).toHaveLength(0);
    expect(t.logs.some((l) => l.includes("outside its own origin"))).toBe(true);
    service.ticketUrl = (n) => `ws://hooks.test/v1/connect?ticket=t${n}`; // not downgraded either
    await t.clock.advance(1_000);
    expect(service.sockets).toHaveLength(0);
    service.ticketUrl = (n) => `wss://hooks.test/v1/connect?ticket=t${n}`;
    await t.clock.advance(2_000);
    expect(service.sockets).toHaveLength(1);
  });

  test("reconnects with a fresh token when the old one expired", async () => {
    const t = setup();
    await connected(t);
    t.service.socket.receive(JSON.stringify({ t: "bye", reason: "reauth" }));
    t.service.socket.serverClose(CLOSE_REAUTH);
    await settle();
    expect(t.clock.pending()).toEqual([1_000]);
    await t.clock.advance(1_000);
    expect(t.service.sockets).toHaveLength(2);
  });

  test("when another copy of this computer replaces its connection, it waits a minute, and after three stops", async () => {
    const t = setup();
    await connected(t);
    for (let round = 1; round <= 2; round++) {
      t.service.socket.receive(JSON.stringify({ t: "bye", reason: "replaced" }));
      t.service.socket.serverClose(CLOSE_REPLACED);
      await settle();
      expect(t.clock.pending()[0]).toBeGreaterThanOrEqual(60_000);
      await t.clock.advance(90_000);
      expect(t.service.sockets).toHaveLength(round + 1);
      t.service.socket.open();
      await settle();
    }
    t.service.socket.serverClose(CLOSE_REPLACED);
    await settle();
    expect(t.client.state).toBe("elsewhere");
    await t.clock.advance(3_600_000);
    expect(t.service.sockets).toHaveLength(3);
    expect(t.logs.some((l) => l.startsWith("error") && l.includes("somewhere else"))).toBe(true);
  });

  test("replacements spread over more than ten minutes do not stop it", async () => {
    const t = setup();
    await connected(t);
    for (let round = 1; round <= 4; round++) {
      t.service.socket.serverClose(CLOSE_REPLACED);
      await settle();
      await t.clock.advance(6 * 60_000);
      t.service.socket.open();
      await settle();
    }
    expect(t.client.state).toBe("open");
  });
});

describe("drops", () => {
  test("drops in the hello are logged; the routines' list reports them, as the service still holds them", async () => {
    const t = setup();
    await connected(t);
    await t.client.registerRoutine("deploy", "k".repeat(43));
    t.service.socket.receive(JSON.stringify({ t: "hello", v: 1, device: "pc", pending: 0, dropped: [{ routine: "deploy", count: 2, reason: "expired", at: 5 }] }));
    await settle();
    expect(t.logs.some((l) => l.includes("2 webhook(s) for deploy were dropped (expired)"))).toBe(true);
    t.service.routineDrops.set("deploy", { count: 2, reason: "expired", at: 5 });
    const listed = await t.client.listRoutines();
    expect(listed).toEqual([{ id: "deploy", device: "pc", held: 0, allowGet: false, dropped: { count: 2, reason: "expired", at: 5 } }]);
    expect((await t.client.listRoutines())[0]!.dropped).toBeUndefined();
  });

  test("a webhook this computer cannot open is refused as unreadable, for the service to count", async () => {
    const t = setup();
    await connected(t);
    await t.client.registerRoutine("deploy", "k".repeat(43));
    const other = await generateX25519();
    const { frame, seq } = await t.service.frame("deploy", "sealed before this key", { to: [{ kid: await keyId(other.publicKey), publicKey: other.publicKey }] });
    t.service.socket.receive(frame);
    await settle();
    const sent = t.service.socket.sent.filter((m) => m.startsWith("{")).map((m) => JSON.parse(m) as { t: string; a: [number, string][]; reason?: string });
    expect(sent).toEqual([{ t: "nack", a: [[seq, expect.any(String)]], reason: "unreadable" }]);
    expect(t.deliveries).toHaveLength(0);
  });
});

describe("delivery", () => {
  test("opens a webhook, hands it on, and acknowledges it once taken", async () => {
    const t = setup();
    await connected(t);
    const { frame, seq } = await t.service.frame("deploy", "hello", { receivedAt: 1_793_000_000_500 });
    t.service.socket.receive(frame);
    await settle();
    expect(t.deliveries).toHaveLength(1);
    const delivery = t.deliveries[0]!;
    expect(delivery.routine).toBe("deploy");
    expect(delivery.receivedAt).toBe(1_793_000_000_500);
    expect(fromUtf8(delivery.request.body)).toBe("hello");
    expect(t.service.socket.acks()).toEqual([]);
    delivery.ack();
    await settle();
    expect(t.service.socket.acks()).toEqual([[seq, delivery.id]]);
  });

  test("hands a webhook on once, and acknowledges a redelivery of one already taken", async () => {
    const t = setup();
    await connected(t);
    const { frame, seq } = await t.service.frame("deploy", "once");
    t.service.socket.receive(frame);
    t.service.socket.receive(frame);
    await settle();
    expect(t.deliveries).toHaveLength(1);
    t.deliveries[0]!.ack();
    await settle();
    // The socket drops before the acknowledgement lands; the redelivery on the next socket is re-acknowledged.
    t.service.socket.serverClose(1006);
    await t.clock.advance(1_000);
    t.service.socket.open();
    await settle();
    t.service.socket.receive(frame);
    await settle();
    expect(t.deliveries).toHaveLength(1);
    expect(t.service.socket.acks()).toEqual([[seq, t.deliveries[0]!.id]]);
  });

  test("a webhook taken while disconnected is acknowledged when it comes again", async () => {
    const t = setup();
    await connected(t);
    const { frame, seq } = await t.service.frame("deploy", "late ack");
    t.service.socket.receive(frame);
    await settle();
    t.service.socket.serverClose(1006);
    await settle();
    t.deliveries[0]!.ack(); // nothing to send it on
    await t.clock.advance(1_000);
    t.service.socket.open();
    await settle();
    expect(t.service.socket.acks()).toEqual([]);
    t.service.socket.receive(frame);
    await settle();
    expect(t.service.socket.acks()).toEqual([[seq, t.deliveries[0]!.id]]);
  });

  test("drops what it cannot open, and tells the service", async () => {
    const t = setup();
    await connected(t);
    const other = await generateX25519();
    const { frame, seq } = await t.service.frame("deploy", "not for us", { to: [{ kid: await keyId(other.publicKey), publicKey: other.publicKey }] });
    t.service.socket.receive(frame);
    await settle();
    expect(t.deliveries).toHaveLength(0);
    expect(t.service.socket.nacks().map(([s]) => s)).toEqual([seq]);
  });

  test("a released delivery is handed on again when it comes back", async () => {
    const t = setup();
    await connected(t);
    const { frame } = await t.service.frame("moving", "follow me");
    t.service.socket.receive(frame);
    await settle();
    t.deliveries[0]!.release();
    t.service.socket.receive(frame);
    await settle();
    expect(t.deliveries).toHaveLength(2);
    expect(t.deliveries[1]!.id).toBe(t.deliveries[0]!.id);
    expect(t.service.socket.acks()).toEqual([]);
    expect(t.service.socket.nacks()).toEqual([]);
  });

  test("a delivery's drop() deletes it at the service", async () => {
    const t = setup();
    await connected(t);
    const { frame, seq } = await t.service.frame("gone", "x");
    t.service.socket.receive(frame);
    await settle();
    t.deliveries[0]!.drop();
    await settle();
    expect(t.service.socket.nacks()).toEqual([[seq, t.deliveries[0]!.id]]);
  });

  test("takes binary frames as ArrayBuffer, typed array or Blob", async () => {
    const t = setup();
    await connected(t);
    const a = await t.service.frame("r", "as buffer");
    const b = await t.service.frame("r", "as view");
    const c = await t.service.frame("r", "as blob");
    t.service.socket.receive(a.frame);
    t.service.socket.receive(new Uint8Array(b.frame));
    t.service.socket.receive(new Blob([c.frame]));
    await until(() => t.deliveries.length === 3);
    expect(t.deliveries.map((d) => fromUtf8(d.request.body))).toEqual(["as buffer", "as view", "as blob"]);
  });
});

describe("a computer the service forgot", () => {
  test("registers again after repeated failed connections, and stops if it was revoked", async () => {
    const t = setup();
    await connected(t);
    t.service.revoked = true;
    // The service refuses the upgrade for a revoked computer: the socket closes without ever opening.
    t.service.socket.serverClose(1006);
    for (let i = 0; i < 4; i++) {
      await t.clock.advance(60_000);
      const socket = t.service.sockets.at(-1)!;
      if (socket.readyState === 0) socket.serverClose(1006);
      await settle();
    }
    await t.clock.advance(60_000);
    expect(t.client.state).toBe("revoked");
    const registrations = t.service.calls.filter((c) => c.path === "/v1/devices/self").length;
    expect(registrations).toBeGreaterThan(1);
  });
});
