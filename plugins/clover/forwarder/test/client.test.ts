// The forwarder client against a fake hooks.waifucave.com: registering its key, its one connection,
// keep-alives, reconnecting with backoff, delivery and acknowledgement, and revocation.

import { describe, expect, test } from "bun:test";

import { ForwarderClient, RoutineHeldElsewhere, type ClientState, type Delivery } from "../src/client";
import { b64u, fromUtf8 } from "../src/wire/bytes";
import { keyId } from "../src/wire/envelope";
import { generateX25519, x25519PublicKey } from "../src/wire/hpke";
import { hookKeyHash, PING, PONG } from "../src/wire/protocol";
import { FakeClock, FakeService, settle } from "./fakes";

function setup(options: { stored?: string; service?: FakeService } = {}) {
  const service = options.service ?? new FakeService();
  const clock = new FakeClock();
  let stored: string | null = options.stored ?? null;
  const saved: string[] = [];
  const deliveries: Delivery[] = [];
  const states: ClientState[] = [];
  const logs: string[] = [];
  const client = new ForwarderClient({
    origin: "https://hooks.test",
    fetch: service.fetch,
    secret: {
      get: async () => stored,
      set: async (value) => {
        stored = value;
        saved.push(value);
      },
    },
    connect: service.connect,
    onDelivery: (d) => deliveries.push(d),
    onState: (s) => states.push(s),
    log: (level, message) => logs.push(`${level}: ${message}`),
    clock,
    random: () => 1,
    deviceName: "Laptop",
  });
  return { service, clock, client, deliveries, states, logs, saved, stored: () => stored };
}

async function connected(t: ReturnType<typeof setup>) {
  await t.client.start();
  await t.clock.advance(0);
  t.service.socket.open();
  await settle();
  expect(t.client.state).toBe("open");
}

describe("registration", () => {
  test("makes a key on first start, keeps it as a secret, and registers its public half", async () => {
    const t = setup();
    await t.client.start();
    expect(t.saved).toHaveLength(1);
    const privateKey = t.stored()!;
    const publicKey = await x25519PublicKey(Uint8Array.from(atob(privateKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
    expect(b64u(t.service.encKey!)).toBe(b64u(publicKey));
    expect(t.service.calls[0]).toEqual({ method: "PUT", path: "/v1/devices/self", body: { encKey: b64u(publicKey), name: "Laptop" } });
    expect(t.client.tag).toBe("T".repeat(24));
  });

  test("reuses a stored key", async () => {
    const pair = await generateX25519();
    const t = setup({ stored: b64u(pair.privateKey) });
    await t.client.start();
    expect(t.saved).toHaveLength(0);
    expect(b64u(t.service.encKey!)).toBe(b64u(pair.publicKey));
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
    expect(call.body).toEqual({ keyHash: b64u(await hookKeyHash(key)), takeover: false });
    expect(JSON.stringify(t.service.calls)).not.toContain(key);
    t.service.routines.set("elsewhere", { keyHash: "x", device: "desktop" });
    await expect(t.client.registerRoutine("elsewhere", key)).rejects.toBeInstanceOf(RoutineHeldElsewhere);
    expect(await t.client.registerRoutine("elsewhere", key, { takeover: true })).toHaveProperty("url");
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
    t.service.socket.serverClose(4000); // replaced
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
    await settle();
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
