// The forwarder's webhook.ingress handler: the trigger pulls webhooks, and they are acknowledged to the
// service only when the trigger acks them.

import { describe, expect, test } from "bun:test";

import { RoutineHeldElsewhere, type ClientState, type Delivery } from "../src/client";
import { WebhookIngress } from "../src/ingress";
import { utf8 } from "../src/wire/bytes";

function delivery(id: string, routine = "deploy"): Delivery & { settled: string[] } {
  const settled: string[] = [];
  return {
    seq: 1,
    id,
    routine,
    receivedAt: 1_793_000_000_000,
    request: { method: "POST", query: "a=1", headers: [["content-type", "application/json"]], ip: "203.0.113.7", body: utf8("{}") },
    ack: () => settled.push("ack"),
    drop: () => settled.push("drop"),
    settled,
  };
}

function fakeClient(overrides: Partial<{ registerRoutine: (...a: unknown[]) => Promise<{ url: string }> }> = {}) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      state: "open" as ClientState,
      registerRoutine: overrides.registerRoutine ?? (async (routine: unknown) => {
        calls.push(`register ${routine}`);
        return { url: `https://hooks.test/T/${routine}` };
      }),
      unregisterRoutine: async (routine: string) => {
        calls.push(`unregister ${routine}`);
      },
      listRoutines: async () => [{ id: "deploy", device: "pc", held: 0 }],
    },
  };
}

describe("webhook.ingress", () => {
  test("hands out a webhook marked untrusted, and acks it to the service only when the trigger acks", async () => {
    const { client } = fakeClient();
    const ingress = new WebhookIngress(client);
    const d = delivery("p1");
    ingress.accept(d);
    const { deliveries } = await ingress.next({ waitMs: 0 });
    expect(deliveries).toEqual([
      {
        id: "p1",
        routine: "deploy",
        receivedAt: 1_793_000_000_000,
        method: "POST",
        query: "a=1",
        headers: [["content-type", "application/json"]],
        ip: "203.0.113.7",
        body: utf8("{}"),
        untrusted: true,
      },
    ]);
    expect(d.settled).toEqual([]);
    await ingress.ack({ ids: ["p1"] });
    expect(d.settled).toEqual(["ack"]);
    await ingress.ack({ ids: ["p1"] }); // a repeat does nothing
    expect(d.settled).toEqual(["ack"]);
  });

  test("a long poll returns as soon as a webhook arrives", async () => {
    const { client } = fakeClient();
    const ingress = new WebhookIngress(client);
    const started = Date.now();
    const poll = ingress.next({ waitMs: 5_000 });
    setTimeout(() => ingress.accept(delivery("p2")), 20);
    const { deliveries } = await poll;
    expect(deliveries.map((d) => d.id)).toEqual(["p2"]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("an empty poll ends after its wait", async () => {
    const { client } = fakeClient();
    const ingress = new WebhookIngress(client);
    expect(await ingress.next({ waitMs: 10 })).toEqual({ deliveries: [] });
  });

  test("offers a webhook again when the trigger took it and never answered", async () => {
    let now = 0;
    const { client } = fakeClient();
    const ingress = new WebhookIngress(client, { now: () => now, reofferAfterMs: 1_000 });
    ingress.accept(delivery("p3"));
    expect((await ingress.next({ waitMs: 0 })).deliveries).toHaveLength(1);
    expect((await ingress.next({ waitMs: 0 })).deliveries).toHaveLength(0);
    now = 1_500;
    expect((await ingress.next({ waitMs: 0 })).deliveries.map((d) => d.id)).toEqual(["p3"]);
  });

  test("ignores a delivery it already holds", async () => {
    const { client } = fakeClient();
    const ingress = new WebhookIngress(client);
    ingress.accept(delivery("p4"));
    ingress.accept(delivery("p4"));
    expect((await ingress.next({ waitMs: 0 })).deliveries).toHaveLength(1);
    ingress.accept(delivery("p4"));
    expect((await ingress.next({ waitMs: 0 })).deliveries).toHaveLength(0);
  });

  test("registers routines, reports a routine held elsewhere, and unregistering drops its queued webhooks", async () => {
    const { client, calls } = fakeClient();
    const ingress = new WebhookIngress(client);
    expect(await ingress.register({ routine: "deploy", key: "k".repeat(43) })).toEqual({ url: "https://hooks.test/T/deploy" });
    const queued = delivery("p5", "deploy");
    ingress.accept(queued);
    await ingress.unregister({ routine: "deploy" });
    expect(calls).toEqual(["register deploy", "unregister deploy"]);
    expect(queued.settled).toEqual(["drop"]);
    expect((await ingress.next({ waitMs: 0 })).deliveries).toHaveLength(0);

    const held = new WebhookIngress(
      fakeClient({
        registerRoutine: async () => {
          throw new RoutineHeldElsewhere("desktop");
        },
      }).client,
    );
    expect(await held.register({ routine: "x", key: "k".repeat(43) })).toEqual({ conflict: { device: "desktop" } });
    expect(await ingress.list()).toEqual({ routines: [{ id: "deploy", device: "pc", held: 0 }] });
  });
});
