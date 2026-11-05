// The forwarder's webhook.ingress handler: the trigger pulls webhooks, and they are acknowledged to the
// service only when the trigger acks them.

import { describe, expect, test } from "bun:test";

import { RoutineHeldElsewhere, type ClientState, type Delivery } from "../src/client";
import { DEFAULT_WAIT_MS, WebhookIngress } from "../src/ingress";
import { b64u, utf8 } from "../src/wire/bytes";
import { hookKeyHash } from "../src/wire/protocol";

function delivery(id: string, routine = "deploy"): Delivery & { settled: string[] } {
  const settled: string[] = [];
  return {
    seq: 1,
    id,
    routine,
    receivedAt: 1_793_000_000_000,
    request: { method: "POST", query: "a=1", headers: [["content-type", "application/json"]], ip: "203.0.113.7", body: utf8("{}") },
    ack: () => void settled.push("ack"),
    drop: () => void settled.push("drop"),
    release: () => void settled.push("release"),
    settled,
  };
}

function fakeClient(
  overrides: Partial<{
    registerRoutine: (...a: unknown[]) => Promise<{ url: string }>;
    unregisterRoutine: (routine: string) => Promise<void>;
  }> = {},
) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      state: "open" as ClientState,
      registerRoutine:
        overrides.registerRoutine ??
        (async (routine: unknown, key: unknown, options: unknown) => {
          calls.push(`register ${routine} ${JSON.stringify(options)}`);
          return { url: `https://hooks.test/T/${routine}` };
        }),
      registerRoutineHash: async (routine: string, keyHash: Uint8Array) => {
        calls.push(`register-hash ${routine} ${b64u(keyHash)}`);
        return { url: `https://hooks.test/T/${routine}` };
      },
      unregisterRoutine:
        overrides.unregisterRoutine ??
        (async (routine: string) => {
          calls.push(`unregister ${routine}`);
        }),
      listRoutines: async () => [{ id: "deploy", device: "pc", held: 0, allowGet: false }],
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

  test("a poll without a wait ends within the plugin API's default call limit", () => {
    expect(DEFAULT_WAIT_MS).toBeLessThanOrEqual(8_000);
  });

  test("registers routines by key or by the key's hash, and refuses a short key", async () => {
    const { client, calls } = fakeClient();
    const ingress = new WebhookIngress(client);
    expect(await ingress.register({ routine: "deploy", key: "k".repeat(43), allowGet: true })).toEqual({ url: "https://hooks.test/T/deploy" });
    const keyHash = b64u(await hookKeyHash("k".repeat(43)));
    expect(await ingress.register({ routine: "nightly", keyHash })).toEqual({ url: "https://hooks.test/T/nightly" });
    expect(calls).toEqual([`register deploy {"takeover":false,"allowGet":true}`, `register-hash nightly ${keyHash}`]);
    await expect(ingress.register({ routine: "weak", key: "k".repeat(42) })).rejects.toThrow("at least 43");
    await expect(ingress.register({ routine: "weak", keyHash: "AAAA" })).rejects.toThrow("32 bytes");
  });

  test("unregistering lets its waiting webhooks go without refusing them, so they follow a move", async () => {
    const { client, calls } = fakeClient();
    const ingress = new WebhookIngress(client);
    const queued = delivery("p5", "deploy");
    const taken = delivery("p6", "deploy");
    const other = delivery("p7", "other");
    ingress.accept(taken);
    expect((await ingress.next({ waitMs: 0 })).deliveries.map((d) => d.id)).toEqual(["p6"]);
    ingress.accept(queued);
    ingress.accept(other);
    expect(await ingress.unregister({ routine: "deploy" })).toEqual({});
    expect(calls).toEqual(["unregister deploy"]);
    expect(queued.settled).toEqual(["release"]);
    expect(taken.settled).toEqual(["release"]);
    expect(other.settled).toEqual([]);
    expect((await ingress.next({ waitMs: 0 })).deliveries.map((d) => d.id)).toEqual(["p7"]);
  });

  test("unregistering a routine another computer now holds is already done", async () => {
    const { client } = fakeClient({
      unregisterRoutine: async () => {
        throw new RoutineHeldElsewhere("desktop");
      },
    });
    const ingress = new WebhookIngress(client);
    const queued = delivery("p8", "moved");
    ingress.accept(queued);
    expect(await ingress.unregister({ routine: "moved" })).toEqual({ heldElsewhere: "desktop" });
    expect(queued.settled).toEqual(["release"]);
  });

  test("reports a routine held elsewhere, and lists routines", async () => {
    const { client } = fakeClient();
    const ingress = new WebhookIngress(client);

    const held = new WebhookIngress(
      fakeClient({
        registerRoutine: async () => {
          throw new RoutineHeldElsewhere("desktop");
        },
      }).client,
    );
    expect(await held.register({ routine: "x", key: "k".repeat(43) })).toEqual({ conflict: { device: "desktop" } });
    expect(await ingress.list()).toEqual({ routines: [{ id: "deploy", device: "pc", held: 0, allowGet: false }] });
  });
});
