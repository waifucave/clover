// A short pairing code's rendezvous slot (PROTOCOL.md, "Rendezvous"): the host puts its sealed box, the joiner finds
// it, only the host's token removes it, and nothing outlives its ttl.

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { b64u } from "../../shared/encoding";
import { StepLimiter } from "../../shared/testing/step-limiter";
import { HandshakeError, HandshakeRendezvous, LIMITS, SLOT_RE } from "../client";
import type { RendezvousDO } from "../src/rendezvous-do";
import { box, client, freshAddress, ORIGIN, withLimiters, worker } from "./helpers";

/** A slot as lane H's pairing makes one: the code's first 5 bytes, base64url. */
const newSlot = () => b64u(crypto.getRandomValues(new Uint8Array(5)));
const newToken = () => b64u(crypto.getRandomValues(new Uint8Array(24)));

function call(
  method: string,
  slot: string,
  options: { body?: unknown; token?: string; address?: string; via?: (request: Request) => Promise<Response> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": options.address ?? freshAddress() };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  return (options.via ?? worker)(new Request(`${ORIGIN}/v1/rendezvous/${slot}`, init));
}

async function stored(slot: string): Promise<{ slot: unknown; alarm: number | null }> {
  return runInDurableObject(env.RENDEZVOUS.getByName(slot), async (_o: RendezvousDO, state) => ({
    slot: await state.storage.get("slot"),
    alarm: await state.storage.getAlarm(),
  }));
}

describe("rendezvous", () => {
  test("the host puts its sealed box, the joiner finds it, and the host removes it", async () => {
    const host = new HandshakeRendezvous(client());
    const joiner = new HandshakeRendezvous(client());
    const slot = newSlot();
    const sealed = box(300);
    expect(await joiner.lookup(slot)).toBeUndefined();
    await host.publish(slot, sealed, 600);
    // A retry (an answer lost on the way back) is the same PUT; another box isn't.
    await host.publish(slot, sealed, 600);
    expect(await host.publish(slot, box(300), 600).catch((e: unknown) => (e as HandshakeError).status)).toBe(409);
    expect(await joiner.lookup(slot)).toBe(sealed);
    // Only the publisher holds the token: the joiner's remove leaves the slot alone.
    await joiner.remove(slot);
    expect(await joiner.lookup(slot)).toBe(sealed);
    await host.remove(slot);
    expect(await joiner.lookup(slot)).toBeUndefined();
    expect((await stored(slot)).slot).toBeUndefined();
    // Removing twice is fine.
    await host.remove(slot);
  });

  test("a slot is create-only: its box never changes once claimed, and a retry of the same PUT is safe", async () => {
    const slot = newSlot();
    const token = newToken();
    const first = await call("PUT", slot, { body: { box: box(40), ttl: 300, token } });
    expect(first.status).toBe(201);
    const { expiresAt } = (await first.json()) as { slot: string; expiresAt: number };
    expect(expiresAt).toBeGreaterThan(Date.now() + 290_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 300_000);

    const other = await call("PUT", slot, { body: { box: box(40), ttl: 300, token: newToken() } });
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ error: "taken" });

    const sealed = (await (await call("GET", slot)).json()) as { box: string };
    // Not even the holder's token replaces the box, or moves the slot's end.
    expect((await call("PUT", slot, { body: { box: box(50), ttl: 300, token } })).status).toBe(409);
    expect((await call("PUT", slot, { body: { box: sealed.box, ttl: 600, token } })).status).toBe(200);
    const retried = await call("PUT", slot, { body: { box: sealed.box, ttl: 300, token } });
    expect([retried.status, await retried.json()]).toEqual([200, { slot, expiresAt }]);
    expect(await (await call("GET", slot)).json()).toEqual({ box: sealed.box, expiresAt });

    // The client says so too, so the host can pick a new code.
    const err = await new HandshakeRendezvous(client()).publish(slot, box(10), 60).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HandshakeError);
    expect((err as HandshakeError).status).toBe(409);
  });

  test("only the token removes a slot", async () => {
    const slot = newSlot();
    const token = newToken();
    await call("PUT", slot, { body: { box: box(), token } });
    expect((await call("DELETE", slot)).status).toBe(401);
    expect((await call("DELETE", slot, { token: "short" })).status).toBe(401);
    expect((await call("DELETE", slot, { token: newToken() })).status).toBe(403);
    expect((await call("GET", slot)).status).toBe(200);
    expect((await call("DELETE", slot, { token })).status).toBe(204);
    expect((await call("DELETE", slot, { token })).status).toBe(404);
    expect((await call("GET", slot)).status).toBe(404);
  });

  test("a slot ends at its ttl: lookups miss it, and its alarm leaves nothing behind", async () => {
    const slot = newSlot();
    const token = newToken();
    const put = (await (await call("PUT", slot, { body: { box: box(), ttl: 120, token } })).json()) as { expiresAt: number };
    expect((await stored(slot)).alarm).toBe(put.expiresAt);
    // Moves the slot's end into the past, as two minutes passing would.
    await runInDurableObject(env.RENDEZVOUS.getByName(slot), async (_o: RendezvousDO, state) => {
      const held = (await state.storage.get("slot")) as { expiresAt: number };
      await state.storage.put("slot", { ...held, expiresAt: Date.now() - 1 });
    });
    expect(await runDurableObjectAlarm(env.RENDEZVOUS.getByName(slot))).toBe(true);
    expect(await stored(slot)).toEqual({ slot: undefined, alarm: null });
    expect((await call("GET", slot)).status).toBe(404);
    // An ended slot is free for a new code.
    expect((await call("PUT", slot, { body: { box: box(), token: newToken() } })).status).toBe(201);
  });

  test("an expired slot is refused even before its alarm runs", async () => {
    const slot = newSlot();
    await call("PUT", slot, { body: { box: box(), ttl: 60, token: newToken() } });
    await runInDurableObject(env.RENDEZVOUS.getByName(slot), async (_o: RendezvousDO, state) => {
      const held = (await state.storage.get("slot")) as { expiresAt: number };
      await state.storage.put("slot", { ...held, expiresAt: Date.now() - 1 });
    });
    expect((await call("GET", slot)).status).toBe(404);
    expect((await stored(slot)).slot).toBeUndefined();
  });

  test("refuses malformed slots, boxes, ttls and tokens", async () => {
    const slot = newSlot();
    const token = newToken();
    // Not a canonical 5-byte base64url slot.
    for (const bad of ["AAAAAAB", "AAAAAAR", "AAAAAA", "AAAAAAAA", "AAAAAA+", "AAAA%3DA"]) {
      expect((await call("GET", bad)).status).toBe(404);
      expect((await call("PUT", bad, { body: { box: box(), token } })).status).toBe(404);
    }
    expect((await call("PUT", slot, { body: { box: box(LIMITS.rendezvous.maxBox + 1), token } })).status).toBe(413);
    expect((await call("PUT", slot, { body: { box: "", token } })).status).toBe(400);
    expect((await call("PUT", slot, { body: { box: "not base64url!", token } })).status).toBe(400);
    expect((await call("PUT", slot, { body: { token } })).status).toBe(400);
    expect((await call("PUT", slot, { body: { box: box(), ttl: 601, token } })).status).toBe(400);
    expect((await call("PUT", slot, { body: { box: box(), ttl: 0, token } })).status).toBe(400);
    expect((await call("PUT", slot, { body: { box: box(), ttl: 1.5, token } })).status).toBe(400);
    expect((await call("PUT", slot, { body: { box: box(), token: "short" } })).status).toBe(400);
    expect((await call("PUT", slot, { body: { box: box() } })).status).toBe(400);
    expect((await call("POST", slot, { body: { box: box(), token } })).status).toBe(405);
    // None of those took the slot.
    expect((await call("GET", slot)).status).toBe(404);
    expect((await call("PUT", slot, { body: { box: box(LIMITS.rendezvous.maxBox), token } })).status).toBe(201);
  });

  test("every slot lane H's pairing can make is one the service takes", () => {
    for (let i = 0; i < 500; i++) expect(newSlot()).toMatch(SLOT_RE);
  });

  // On StepLimiters in place of the runtime's bindings, as in limits.test.ts.
  test("a PUT is limited like a registration, a GET or DELETE like a signed call, per address", async () => {
    const register = new StepLimiter(2);
    const address = new StepLimiter(3);
    const via = withLimiters({ REGISTER_RATE: register, ADDRESS_RATE: address });
    const from = "203.0.113.77";
    const token = newToken();
    const slot = newSlot();
    const sealed = box();
    const puts: number[] = [];
    for (let i = 0; i < 3; i++) puts.push((await call("PUT", slot, { body: { box: sealed, token }, address: from, via })).status);
    expect(puts).toEqual([201, 200, 429]);
    expect(register.count(from)).toBe(3);
    const reads: number[] = [];
    for (let i = 0; i < 3; i++) reads.push((await call("GET", slot, { address: from, via })).status);
    reads.push((await call("DELETE", slot, { token, address: from, via })).status);
    expect(reads).toEqual([200, 200, 200, 429]);
    // Another address has its own budget.
    expect((await call("DELETE", slot, { token, address: "203.0.113.78", via })).status).toBe(204);
    register.nextWindow();
    expect((await call("PUT", newSlot(), { body: { box: box(), token }, address: from, via })).status).toBe(201);
  });
});
