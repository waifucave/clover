import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { b64u, sha256, utf8 } from "../../shared/encoding";
import { authorizationHeader, HandshakeError, pairStatement, requestSigningString, signText } from "../client";
import { box, client, newPairId, ORIGIN, registeredPair, signer, worker } from "./helpers";

async function rejects(promise: Promise<unknown>): Promise<HandshakeError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HandshakeError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("registration", () => {
  test("both signatures register a pair; the same again is 200, other keys 409", async () => {
    const c = client();
    const pair = newPairId();
    const [a, b, x] = [await signer(), await signer(), await signer()];
    const t = Date.now();
    const statement = pairStatement(pair, a.key, b.key, t);
    const body = { pair, keys: [a.key, b.key] as [string, string], t, sigs: [await signText(a, statement), await signText(b, statement)] as [string, string] };
    const first = await worker(new Request(`${ORIGIN}/v1/pairs`, { method: "POST", body: JSON.stringify(body), headers: { "cf-connecting-ip": "198.51.100.200" } }));
    expect(first.status).toBe(201);
    expect(await c.registerPair(body)).toMatchObject({ pair, keys: [a.key, b.key] });

    const other = pairStatement(pair, a.key, x.key, t);
    const err = await rejects(c.registerPair({ pair, keys: [a.key, x.key], t, sigs: [await signText(a, other), await signText(x, other)] }));
    expect([err.status, err.code]).toEqual([409, "conflict"]);
  });

  test("a missing or wrong signature, an old statement and twin keys are refused", async () => {
    const c = client();
    const pair = newPairId();
    const [a, b] = [await signer(), await signer()];
    const t = Date.now();
    const statement = pairStatement(pair, a.key, b.key, t);
    const sigA = await signText(a, statement);
    // B's signature over another pair's statement.
    const wrong = await signText(b, pairStatement(newPairId(), a.key, b.key, t));
    expect((await rejects(c.registerPair({ pair, keys: [a.key, b.key], t, sigs: [sigA, wrong] }))).status).toBe(401);
    expect((await rejects(c.registerPair({ pair, keys: [a.key, b.key], t, sigs: [sigA, sigA] }))).status).toBe(401);

    const old = t - 11 * 60_000;
    const oldStatement = pairStatement(pair, a.key, b.key, old);
    const err = await rejects(c.registerPair({ pair, keys: [a.key, b.key], t: old, sigs: [await signText(a, oldStatement), await signText(b, oldStatement)] }));
    expect(err.status).toBe(401);

    const twin = pairStatement(pair, a.key, a.key, t);
    expect((await rejects(c.registerPair({ pair, keys: [a.key, a.key], t, sigs: [await signText(a, twin), await signText(a, twin)] }))).status).toBe(400);
    expect((await rejects(c.registerPair({ pair, keys: [a.key, b.key], t, sigs: ["x", "y"] as [string, string] }))).code).toBe("bad_signature_form");
  });
});

describe("signed requests", () => {
  test("a member reads the pair; strangers, bad signatures and old times are refused", async () => {
    const { pair, a, b, c } = await registeredPair();
    const view = await c.pair(pair, a).get();
    expect(view).toMatchObject({ pair, keys: [a.key, b.key], peer: { online: false }, records: [] });

    const stranger = await signer();
    expect((await rejects(c.pair(pair, stranger).get())).code).toBe("not_member");
    expect((await rejects(c.pair(newPairId(), a).get())).status).toBe(404);

    // A signature by another key than the one named.
    const path = `/v1/pairs/${pair}`;
    const t = Date.now();
    const hash = b64u(await sha256(new Uint8Array(0)));
    const sig = await signText(stranger, requestSigningString("GET", path, t, hash));
    const forged = await worker(new Request(`${ORIGIN}${path}`, { headers: { authorization: authorizationHeader(a.key, t, sig) } }));
    expect(forged.status).toBe(401);

    const old = Date.now() - 121_000;
    const oldSig = await signText(a, requestSigningString("GET", path, old, hash));
    expect((await worker(new Request(`${ORIGIN}${path}`, { headers: { authorization: authorizationHeader(a.key, old, oldSig) } }))).status).toBe(401);
    expect((await worker(new Request(`${ORIGIN}${path}`))).status).toBe(401);
  });

  test("a mutation can't be replayed: its t must be newer than the member's last", async () => {
    const { pair, a } = await registeredPair();
    const path = `/v1/pairs/${pair}/inbox`;
    const t = Date.now();
    const hash = b64u(await sha256(new Uint8Array(0)));
    const authorization = authorizationHeader(a.key, t, await signText(a, requestSigningString("POST", path, t, hash)));
    const send = () => worker(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { authorization } }));
    expect((await send()).status).toBe(200);
    const again = await send();
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: "replay" });

    // The body is covered too: the same headers with another body fail.
    const body = JSON.stringify({ kind: "dial", box: box() });
    const t2 = Date.now() + 1;
    const sig = await signText(a, requestSigningString("POST", `/v1/pairs/${pair}/messages`, t2, b64u(await sha256(utf8(body)))));
    const changed = JSON.stringify({ kind: "dial", box: box() });
    const tampered = await worker(
      new Request(`${ORIGIN}/v1/pairs/${pair}/messages`, { method: "POST", body: changed, headers: { authorization: authorizationHeader(a.key, t2, sig) } }),
    );
    expect(tampered.status).toBe(401);
  });
});

describe("records", () => {
  test("the latest of each kind per sender; an older generation is stale; the peer reads it", async () => {
    const { pair, a, b, c } = await registeredPair();
    const pa = c.pair(pair, a);
    const pb = c.pair(pair, b);
    const first = box();
    await pa.putRecord("addr", { gen: 100, ttl: 600, box: first });
    expect((await rejects(pa.putRecord("addr", { gen: 100, box: box() }))).code).toBe("stale");
    const latest = box();
    await pa.putRecord("addr", { gen: 101, box: latest });

    const view = await pb.get();
    expect(view.records).toHaveLength(1);
    expect(view.records[0]).toMatchObject({ from: a.key, kind: "addr", gen: 101, box: latest });
    // A sender never gets its own record back.
    expect((await pa.get()).records).toEqual([]);
  });

  test("kinds, sizes and TTLs are checked", async () => {
    const { pair, a, c } = await registeredPair();
    const pa = c.pair(pair, a);
    expect((await rejects(pa.putRecord("dial", { gen: 1, box: box() }))).code).toBe("bad_kind");
    expect((await rejects(pa.putRecord("nope" as "addr", { gen: 1, box: box() }))).code).toBe("bad_kind");
    expect((await rejects(pa.putRecord("addr", { gen: 1, box: box(4097) }))).status).toBe(413);
    expect((await rejects(pa.putRecord("addr", { gen: 1, ttl: 3601, box: box() }))).status).toBe(400);
    expect((await rejects(pa.putRecord("addr", { gen: 0, box: box() }))).status).toBe(400);
    expect((await rejects(pa.sendMessage("signal", { box: box(8193) }))).status).toBe(413);
    expect((await rejects(pa.sendMessage("addr", { box: box() }))).code).toBe("bad_kind");
  });

  test("a record is gone after its TTL, and the alarm deletes it", async () => {
    const { pair, a, b, c } = await registeredPair();
    await c.pair(pair, a).putRecord("addr", { gen: 5, ttl: 1, box: box() });
    await new Promise((r) => setTimeout(r, 1100));
    expect((await c.pair(pair, b).get()).records).toEqual([]);
    // The alarm set for the record's expiry has run by now (or runs here): the row is gone, not just hidden.
    const stub = env.HANDSHAKE.getByName(`pair:${pair}`);
    await runDurableObjectAlarm(stub);
    const rows = await runInDurableObject(stub, (_, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM records").one().n);
    expect(rows).toBe(0);
    // A new record after expiry starts over: no stale check against a forgotten one.
    await c.pair(pair, a).putRecord("addr", { gen: 1, box: box() });
  });
});

describe("messages", () => {
  test("queued for a peer with no socket, taken once from the inbox", async () => {
    const { pair, a, b, c } = await registeredPair();
    const sent = await c.pair(pair, a).sendMessage("dial", { box: box() });
    expect(sent.delivered).toBe(false);
    const inbox = await c.pair(pair, b).inbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ id: sent.id, from: a.key, kind: "dial" });
    expect(inbox[0]!.expiresAt - inbox[0]!.at).toBe(30_000);
    expect(await c.pair(pair, b).inbox()).toEqual([]);
  });

  test("at most 16 wait per recipient; the oldest go first", async () => {
    const { pair, a, b, c } = await registeredPair();
    const pa = c.pair(pair, a);
    const ids: string[] = [];
    for (let i = 0; i < 18; i++) ids.push((await pa.sendMessage("signal", { box: box(16) })).id);
    const inbox = await c.pair(pair, b).inbox();
    expect(inbox.map((m) => m.id)).toEqual(ids.slice(2));
  });

  test("an expired message is never handed out", async () => {
    const { pair, a, b, c } = await registeredPair();
    await c.pair(pair, a).sendMessage("dial", { ttl: 1, box: box() });
    await new Promise((r) => setTimeout(r, 1100));
    expect(await c.pair(pair, b).inbox()).toEqual([]);
  });
});

describe("ending a pair", () => {
  test("either member ends it; it answers 410 after, and can't be registered again", async () => {
    const { pair, a, b, c } = await registeredPair();
    await c.pair(pair, a).putRecord("addr", { gen: 1, box: box() });
    await c.pair(pair, b).end();
    expect((await rejects(c.pair(pair, a).get())).status).toBe(410);
    expect((await rejects(c.pair(pair, b).sendMessage("dial", { box: box() }))).status).toBe(410);
    const t = Date.now();
    const statement = pairStatement(pair, a.key, b.key, t);
    const again = await rejects(c.registerPair({ pair, keys: [a.key, b.key], t, sigs: [await signText(a, statement), await signText(b, statement)] }));
    expect(again.status).toBe(410);
  });
});
