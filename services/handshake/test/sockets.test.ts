import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { CLOSE, HandshakeError, type ServiceFrame } from "../client";
import { box, Frames, rawSocket, registeredPair, sleep, worker } from "./helpers";

const isHello = (f: ServiceFrame) => f.t === "hello";
const isPresence = (online: boolean) => (f: ServiceFrame) => f.t === "presence" && f.online === online;

describe("tickets", () => {
  test("a ticket opens one socket, once, for a member", async () => {
    const { pair, a, c } = await registeredPair();
    const ticket = await c.pair(pair, a).ticket();
    expect(ticket.url).toMatch(/^wss:\/\/handshake\.test\/v1\/socket\?ticket=/);
    expect(ticket.expiresAt - Date.now()).toBeLessThanOrEqual(60_000);
    const { frames } = await rawSocket(ticket.url);
    expect(await frames.until(isHello)).toEqual({ t: "hello", v: 1, scope: "pair", peer: { online: false } });

    const reused = await worker(new Request(ticket.url.replace(/^ws/, "http"), { headers: { upgrade: "websocket" } }));
    expect(reused.status).toBe(409);
    const forged = await worker(new Request(`${ticket.url.replace(/^ws/, "http")}x`, { headers: { upgrade: "websocket" } }));
    expect(forged.status).toBe(401);
    const plain = await worker(new Request(ticket.url.replace(/^ws/, "http")));
    expect(plain.status).toBe(426);
  });
});

describe("pushes", () => {
  test("presence, records and messages reach the peer's socket at once", async () => {
    const { pair, a, b, c } = await registeredPair();
    const sa = await rawSocket((await c.pair(pair, a).ticket()).url);
    await sa.frames.until(isHello);
    const sb = await rawSocket((await c.pair(pair, b).ticket()).url);
    expect(await sb.frames.until(isHello)).toMatchObject({ peer: { online: true } });
    await sa.frames.until(isPresence(true));

    const sealed = box();
    await c.pair(pair, b).putRecord("addr", { gen: 7, box: sealed });
    expect(await sa.frames.until((f) => f.t === "record")).toMatchObject({ from: b.key, kind: "addr", gen: 7, box: sealed });

    const sent = await c.pair(pair, a).sendMessage("dial", { box: sealed });
    expect(sent.delivered).toBe(true);
    expect(await sb.frames.until((f) => f.t === "message")).toMatchObject({ id: sent.id, from: a.key, kind: "dial", box: sealed });
    // Delivered means not kept.
    expect(await c.pair(pair, b).inbox()).toEqual([]);

    sb.ws.close(1000, "bye");
    await sa.frames.until(isPresence(false));
    expect((await c.pair(pair, a).get()).peer.online).toBe(false);
  });

  test("a socket opened later gets the queued messages and the peer's records first", async () => {
    const { pair, a, b, c } = await registeredPair();
    const record = box();
    await c.pair(pair, a).putRecord("addr", { gen: 3, box: record });
    const queued = await c.pair(pair, a).sendMessage("signal", { box: box() });
    expect(queued.delivered).toBe(false);
    const sb = await rawSocket((await c.pair(pair, b).ticket()).url);
    await sb.frames.until((f) => f.t === "message" && f.id === queued.id);
    await sb.frames.until((f) => f.t === "record" && f.box === record);
    expect(sb.frames.frames[0]?.t).toBe("hello");
    expect(await c.pair(pair, b).inbox()).toEqual([]);
  });

  test("a second socket for the same member replaces the first", async () => {
    const { pair, a, b, c } = await registeredPair();
    const peer = await rawSocket((await c.pair(pair, b).ticket()).url);
    await peer.frames.until(isHello);
    const first = await rawSocket((await c.pair(pair, a).ticket()).url);
    await first.frames.until(isHello);
    await peer.frames.until(isPresence(true));
    const second = await rawSocket((await c.pair(pair, a).ticket()).url);
    await second.frames.until(isHello);
    expect(await first.frames.until((f) => f.t === "bye")).toEqual({ t: "bye", reason: "replaced" });
    expect(await first.frames.closed()).toBe(CLOSE.replaced);
    // The peer never saw the member go away.
    await sleep(100);
    expect(peer.frames.frames.filter(isPresence(false))).toEqual([]);
  });

  test("ending the pair closes both sockets with 4003", async () => {
    const { pair, a, b, c } = await registeredPair();
    const sa = await rawSocket((await c.pair(pair, a).ticket()).url);
    const sb = await rawSocket((await c.pair(pair, b).ticket()).url);
    await c.pair(pair, a).end();
    expect(await sa.frames.closed()).toBe(CLOSE.ended);
    expect(await sb.frames.closed()).toBe(CLOSE.ended);
    expect(sb.frames.frames.at(-1)).toEqual({ t: "bye", reason: "ended" });
  });

  test("anything but a ping from a client closes it with 4008; pings are answered", async () => {
    const { pair, a, c } = await registeredPair();
    const { ws, frames } = await rawSocket((await c.pair(pair, a).ticket()).url);
    await frames.until(isHello);
    const pong = new Promise<string>((resolve) => ws.addEventListener("message", (e) => e.data === "pong" && resolve("pong")));
    ws.send("ping");
    expect(await pong).toBe("pong");
    ws.send(JSON.stringify({ t: "hello" }));
    expect(await frames.closed()).toBe(CLOSE.protocol);
  });

  test("sockets survive the object's eviction (hibernation)", async () => {
    const { pair, a, b, c } = await registeredPair();
    const sb = await rawSocket((await c.pair(pair, b).ticket()).url);
    await sb.frames.until(isHello);
    await evictDurableObject(env.HANDSHAKE.getByName(`pair:${pair}`), { webSockets: "hibernate" });
    const sent = await c.pair(pair, a).sendMessage("dial", { box: box() });
    expect(sent.delivered).toBe(true);
    await sb.frames.until((f) => f.t === "message" && f.id === sent.id);
  });
});

describe("the client's socket", () => {
  test("ScopeSocket re-opens after a drop and stops for good when the pair ends", async () => {
    const { pair, a, b, c } = await registeredPair();
    const frames = new Frames();
    let opens = 0;
    const socket = c
      .pair(pair, a)
      .socket({ onFrame: frames.onFrame, onOpen: () => opens++, onClose: (code, final) => final && frames.onClose(code) }, { minBackoffMs: 20, maxBackoffMs: 50 })
      .start();
    await frames.until(isHello);
    // Another socket for the same member takes over only when it asks; a drop from the service's side re-dials.
    await evictDurableObject(env.HANDSHAKE.getByName(`pair:${pair}`), { webSockets: "close" });
    for (let i = 0; i < 100 && opens < 2; i++) await sleep(20);
    expect(opens).toBeGreaterThanOrEqual(2);
    await c.pair(pair, b).end();
    expect(await frames.closed()).toBe(CLOSE.ended);
    socket.stop();
  });

  test("a ticket for an ended pair is refused", async () => {
    const { pair, a, c } = await registeredPair();
    await c.pair(pair, a).end();
    await expect(c.pair(pair, a).ticket()).rejects.toBeInstanceOf(HandshakeError);
  });
});
