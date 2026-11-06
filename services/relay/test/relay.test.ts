import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { b64u, fromB64u } from "../../shared/encoding";
import { mintRoomTicket } from "../src/auth";

const ORIGIN = "https://relay.test";
let address = 0;
const fresh = () => `192.0.2.${++address % 250}`;

function call(path: string, init: RequestInit & { key?: string | null } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const key = init.key === undefined ? env.RELAY_KEY : init.key;
  if (key) headers.set("authorization", `Bearer ${key}`);
  headers.set("cf-connecting-ip", fresh());
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }));
}

async function ticketUrl(): Promise<string> {
  const response = await call("/v1/tickets", { method: "POST" });
  expect(response.status).toBe(200);
  return ((await response.json()) as { url: string }).url;
}

interface Peer {
  ws: WebSocket;
  texts: Record<string, unknown>[];
  binaries: Uint8Array[];
  closes: number[];
  wait(pred: () => boolean): Promise<void>;
}

async function join(url: string, room: string, peer: string): Promise<Peer | Response> {
  const response = await exports.default.fetch(
    new Request(`${url.replace(/^ws/, "http")}&room=${room}&peer=${peer}`, { headers: { upgrade: "websocket", "cf-connecting-ip": fresh() } }),
  );
  if (!response.webSocket) return response;
  const ws = response.webSocket;
  ws.accept();
  let pending = 0;
  const p: Peer = {
    ws,
    texts: [],
    binaries: [],
    closes: [],
    async wait(pred) {
      for (let i = 0; i < 200 && (pending > 0 || !pred()); i++) await new Promise((r) => setTimeout(r, 10));
      if (!pred()) throw new Error(`timed out: ${JSON.stringify(p.texts)}`);
    },
  };
  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string") {
      if (e.data !== "pong") p.texts.push(JSON.parse(e.data) as Record<string, unknown>);
    } else {
      // workerd hands a test's own socket binary frames as Blobs; keep their order while reading them.
      const index = p.binaries.length;
      p.binaries.push(new Uint8Array(0));
      pending++;
      void (e.data as Blob).arrayBuffer().then((buffer) => {
        p.binaries[index] = new Uint8Array(buffer);
        pending--;
      });
    }
  });
  ws.addEventListener("close", (e) => p.closes.push(e.code));
  return p;
}

const newRoom = () => b64u(crypto.getRandomValues(new Uint8Array(16)));

describe("access", () => {
  test("API calls need the relay key; room sockets a valid ticket", async () => {
    expect((await call("/v1/tickets", { method: "POST", key: null })).status).toBe(401);
    expect((await call("/v1/tickets", { method: "POST", key: b64u(crypto.getRandomValues(new Uint8Array(32))) })).status).toBe(401);
    const url = await ticketUrl();
    expect(url).toMatch(/^wss:\/\/relay\.test\/v1\/rooms\?ticket=v1\.\d+\.[A-Za-z0-9_-]{22}$/);
    const forged = await join(url.replace(/.$/, (c) => (c === "A" ? "B" : "A")), newRoom(), "a");
    expect((forged as Response).status).toBe(401);
    const expired = await join(`wss://relay.test/v1/rooms?ticket=${await mintRoomTicket(env.RELAY_KEY, Date.now() - 1)}`, newRoom(), "a");
    expect((expired as Response).status).toBe(401);
    const badRoom = await join(url, "short", "a");
    expect((badRoom as Response).status).toBe(400);
  });
});

describe("rooms", () => {
  test("two peers: frames cross as they are, in order; presence both ways", async () => {
    const url = await ticketUrl();
    const room = newRoom();
    const a = (await join(url, room, "laptop")) as Peer;
    await a.wait(() => a.texts.length > 0);
    expect(a.texts[0]).toEqual({ t: "hello", v: 1, peer: { online: false } });
    const b = (await join(url, room, "studio")) as Peer;
    await b.wait(() => b.texts.length > 0);
    expect(b.texts[0]).toEqual({ t: "hello", v: 1, peer: { online: true } });
    await a.wait(() => a.texts.some((t) => t.t === "presence" && t.online === true));

    for (let i = 0; i < 5; i++) a.ws.send(new Uint8Array([i, 1, 2, 3]));
    b.ws.send(new Uint8Array(64 * 1024).fill(7));
    await b.wait(() => b.binaries.length === 5);
    expect(b.binaries.map((f) => f[0])).toEqual([0, 1, 2, 3, 4]);
    await a.wait(() => a.binaries.length === 1);
    expect(a.binaries[0]!.length).toBe(64 * 1024);

    b.ws.close(1000, "bye");
    await a.wait(() => a.texts.some((t) => t.t === "presence" && t.online === false));
  });

  test("a third peer is refused; a peer's second socket replaces its first", async () => {
    const url = await ticketUrl();
    const room = newRoom();
    const a = (await join(url, room, "a")) as Peer;
    const b = (await join(url, room, "b")) as Peer;
    const c = await join(url, room, "c");
    expect((c as Response).status).toBe(409);
    const a2 = (await join(url, room, "a")) as Peer;
    await a.wait(() => a.closes.length > 0);
    expect(a.closes[0]).toBe(4000);
    expect(a.texts.at(-1)).toEqual({ t: "bye", reason: "replaced" });
    b.ws.send(new Uint8Array([9]));
    await a2.wait(() => a2.binaries.length === 1);
    // The replacement isn't announced as the peer leaving.
    expect(b.texts.filter((t) => t.t === "presence" && t.online === false)).toEqual([]);
  });

  test("text other than ping closes the socket; ping is answered; hibernation keeps the room", async () => {
    const url = await ticketUrl();
    const room = newRoom();
    const a = (await join(url, room, "a")) as Peer;
    const b = (await join(url, room, "b")) as Peer;
    await evictDurableObject(env.ROOMS.getByName(room), { webSockets: "hibernate" });
    a.ws.send(new Uint8Array([1]));
    await b.wait(() => b.binaries.length === 1);
    const pong = new Promise((resolve) => a.ws.addEventListener("message", (e) => e.data === "pong" && resolve(true)));
    a.ws.send("ping");
    expect(await pong).toBe(true);
    a.ws.send("hello");
    await a.wait(() => a.closes.length > 0);
    expect(a.closes[0]).toBe(4008);
  });
});

describe("mail", () => {
  test("put, take (oldest first, stays until acked), ack", async () => {
    const device = `dev${Date.now()}`;
    const expires = String(Date.now() + 60_000);
    const one = crypto.getRandomValues(new Uint8Array(100));
    expect((await call(`/v1/mail/${device}/m1`, { method: "PUT", body: one, headers: { "x-expires-at": expires } })).status).toBe(201);
    expect((await call(`/v1/mail/${device}/m1`, { method: "PUT", body: new Uint8Array([1]), headers: { "x-expires-at": expires } })).status).toBe(200);
    expect((await call(`/v1/mail/${device}/m2`, { method: "PUT", body: new Uint8Array([2, 2]), headers: { "x-expires-at": expires } })).status).toBe(201);

    const take = async () => ((await (await call(`/v1/mail/${device}?max=8`)).json()) as { mail: { id: string; sealed: string }[] }).mail;
    const first = await take();
    expect(first.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(fromB64u(first[0]!.sealed)).toEqual(one);
    expect((await take()).length).toBe(2);
    expect((await call(`/v1/mail/${device}/ack`, { method: "POST", body: JSON.stringify({ ids: ["m1"] }) })).status).toBe(204);
    expect((await take()).map((m) => m.id)).toEqual(["m2"]);
  });

  test("limits: size, expiry window, the mailbox's count; expired mail goes", async () => {
    const device = `lim${Date.now()}`;
    const soon = String(Date.now() + 60_000);
    expect((await call(`/v1/mail/${device}/big`, { method: "PUT", body: new Uint8Array(1024 * 1024 + 1), headers: { "x-expires-at": soon } })).status).toBe(413);
    expect((await call(`/v1/mail/${device}/far`, { method: "PUT", body: new Uint8Array(1), headers: { "x-expires-at": String(Date.now() + 31 * 24 * 3600_000) } })).status).toBe(400);
    expect((await call(`/v1/mail/${device}/past`, { method: "PUT", body: new Uint8Array(1), headers: { "x-expires-at": String(Date.now() - 1) } })).status).toBe(400);
    for (let i = 0; i < 256; i++) await call(`/v1/mail/${device}/n${i}`, { method: "PUT", body: new Uint8Array([i % 256]), headers: { "x-expires-at": soon } });
    const full = await call(`/v1/mail/${device}/n256`, { method: "PUT", body: new Uint8Array(1), headers: { "x-expires-at": soon } });
    expect([full.status, await full.json()]).toEqual([409, { error: "full" }]);

    const brief = `brief${Date.now()}`;
    await call(`/v1/mail/${brief}/x`, { method: "PUT", body: new Uint8Array(1), headers: { "x-expires-at": String(Date.now() + 200) } });
    await new Promise((r) => setTimeout(r, 300));
    const stub = env.MAIL.getByName(brief);
    await runDurableObjectAlarm(stub);
    expect(await runInDurableObject(stub, (_, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM mail").one().n)).toBe(0);
  });

  test("bad ids, devices and max are refused", async () => {
    expect((await call("/v1/mail/has.dot/x", { method: "PUT", body: new Uint8Array(1), headers: { "x-expires-at": String(Date.now() + 1000) } })).status).toBe(404);
    expect((await call("/v1/mail/d/x?max=0")).status).toBe(404);
    expect((await call("/v1/mail/d?max=65")).status).toBe(400);
    expect((await call("/v1/mail/d/ack", { method: "POST", body: JSON.stringify({ ids: ["a b"] }) })).status).toBe(400);
  });
});
