// The forwarder plugin's own client (plugins/clover/plugins/forwarder/src/client.ts) against the real Worker and
// Durable Object, inside workerd: registration, its socket, delivery, acknowledgement, holding while it is
// stopped, keep-alives answered by the auto-response, and delivery across an eviction.

import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { ForwarderClient, type Delivery, type WebSocketLike } from "../../../plugins/clover/plugins/forwarder/src/client";
import { memoryKeys, type ForwarderKeys } from "../../../plugins/clover/plugins/forwarder/src/keys";
import { fromUtf8 } from "../../../plugins/clover/plugins/forwarder/src/wire/bytes";
import type { ForwarderDO } from "../src/forwarder-do";
import { accountToken, objectOf, ORIGIN, postHook, routineKey, uniqueAccount } from "./helpers";

type Listener = (event: { data?: unknown; code?: number }) => void;

/** A WebSocket the way a client opens one, over the Worker's fetch: it opens once the upgrade is accepted. */
class UpgradedSocket implements WebSocketLike {
  binaryType = "blob";
  readyState = 0;
  private ws: WebSocket | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    const target = new URL(url);
    void exports.default
      .fetch(new Request(`${ORIGIN}${target.pathname}${target.search}`, { headers: { upgrade: "websocket" } }))
      .then((response) => {
        const ws = response.webSocket;
        if (response.status !== 101 || !ws) {
          this.readyState = 3;
          this.emit("close", { code: 1006 });
          return;
        }
        ws.accept();
        ws.binaryType = "arraybuffer";
        this.ws = ws;
        ws.addEventListener("message", (event) => this.emit("message", { data: event.data }));
        ws.addEventListener("close", (event) => {
          this.readyState = 3;
          this.emit("close", { code: event.code });
        });
        this.readyState = 1;
        this.emit("open", {});
      });
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    if (!this.ws || this.readyState !== 1) throw new Error("not open");
    this.ws.send(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.ws?.close(code ?? 1000, reason ?? "");
  }

  private emit(type: string, event: { data?: unknown; code?: number }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function computer(account: string, device: string, keys: Promise<ForwarderKeys> = memoryKeys()) {
  const deliveries: Delivery[] = [];
  let token: Promise<string> | null = null;
  const client = new ForwarderClient({
    origin: ORIGIN,
    // Stands in for the core's keyed fetch, which adds the computer's account token.
    fetch: async (url, init = {}) => {
      token ??= accountToken({ account, device });
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${await token}`);
      return exports.default.fetch(new Request(url, { ...init, headers }));
    },
    // The core's key store, in memory.
    keys: { publicKey: async () => (await keys).publicKey(), open: async (input) => (await keys).open(input) },
    connect: (url) => new UpgradedSocket(url),
    onDelivery: (d) => deliveries.push(d),
    pingIntervalMs: 50,
    pongTimeoutMs: 1_000,
  });
  return { client, deliveries };
}

async function until(predicate: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function heldFor(tag: string): Promise<number> {
  return runInDurableObject(env.FORWARDER.getByName(objectOf(tag)), (_i: ForwarderDO, state) =>
    state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM held").one().n,
  );
}

describe("the forwarder plugin's client, against the Worker", () => {
  it("registers, connects, takes a webhook and acknowledges it", async () => {
    const { client, deliveries } = computer(uniqueAccount(), "laptop");
    await client.start();
    await until(() => client.state === "open", "the connection");
    expect(client.tag).not.toBeNull();
    const key = routineKey();
    const { url } = await client.registerRoutine("on-push", key);

    expect((await postHook(url, key, "first", { headers: { "x-github-event": "push" } })).status).toBe(202);
    await until(() => deliveries.length === 1, "the delivery");
    const delivery = deliveries[0]!;
    expect(delivery.routine).toBe("on-push");
    expect(fromUtf8(delivery.request.body)).toBe("first");
    expect(new Map(delivery.request.headers).get("x-github-event")).toBe("push");
    expect(await heldFor(client.tag!)).toBe(1);
    delivery.ack();
    await until(() => false, "", 200).catch(() => {});
    expect(await heldFor(client.tag!)).toBe(0);
    await client.stop();
  });

  it("keeps the socket alive on the free auto-response", async () => {
    const { client } = computer(uniqueAccount(), "pc");
    await client.start();
    await until(() => client.state === "open", "the connection");
    await new Promise((r) => setTimeout(r, 400)); // several pings at 50 ms, each answered
    expect(client.state).toBe("open");
    await client.stop();
  });

  it("holds webhooks while the computer is stopped and hands them over when it starts again", async () => {
    const account = uniqueAccount();
    const keys = memoryKeys();
    const first = computer(account, "desktop", keys);
    await first.client.start();
    await until(() => first.client.state === "open", "the connection");
    const key = routineKey();
    const { url } = await first.client.registerRoutine("nightly", key);
    const tag = first.client.tag!;
    await first.client.stop();

    for (const body of ["one", "two"]) expect((await postHook(url, key, body)).status).toBe(202);
    expect(await heldFor(tag)).toBe(2);

    const again = computer(account, "desktop", keys); // same computer, same key, after a restart
    await again.client.start();
    await until(() => again.deliveries.length === 2, "the held webhooks");
    expect(again.deliveries.map((d) => fromUtf8(d.request.body))).toEqual(["one", "two"]);
    for (const d of again.deliveries) d.ack();
    await until(() => false, "", 200).catch(() => {});
    expect(await heldFor(tag)).toBe(0);
    await again.client.stop();
  });

  it("is reached through a hibernated socket after the object is evicted", async () => {
    const { client, deliveries } = computer(uniqueAccount(), "pc");
    await client.start();
    await until(() => client.state === "open", "the connection");
    const key = routineKey();
    const { url } = await client.registerRoutine("woken", key);
    await evictDurableObject(env.FORWARDER.getByName(objectOf(client.tag!)));
    expect((await postHook(url, key, "after eviction")).status).toBe(202);
    await until(() => deliveries.length === 1, "the delivery after eviction");
    expect(fromUtf8(deliveries[0]!.request.body)).toBe("after eviction");
    await client.stop();
  });
});
