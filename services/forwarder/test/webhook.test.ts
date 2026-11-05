// What a sender gets: the key in a header or the query, the limits on size and rate, and what is forwarded.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { b64u, fromUtf8 } from "../../../plugins/clover/forwarder/src/wire/bytes";
import { decodeRequestRecord, openEnvelope } from "../../../plugins/clover/forwarder/src/wire/envelope";
import { decodeWebhookFrame, hookKeyHash } from "../../../plugins/clover/forwarder/src/wire/protocol";
import type { ForwarderDO } from "../src/forwarder-do";
import { apiCall, objectOf, openSocket, postHook, registerComputer, registeredRoutine, routineKey, uniqueAccount } from "./helpers";

async function heldCount(tag: string): Promise<number> {
  return runInDurableObject(env.FORWARDER.getByName(objectOf(tag)), (_i: ForwarderDO, state) =>
    state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM held").one().n,
  );
}

describe("webhook ingress", () => {
  it("takes the key as a bearer header or a ?key= parameter", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "both-ways");
    expect((await postHook(url, key, "a", { keyIn: "header" })).status).toBe(202);
    expect((await postHook(url, key, "b", { keyIn: "query" })).status).toBe(202);
    expect(await heldCount(pc.tag)).toBe(2);
  });

  it("answers 401 for a missing or wrong key, and for an unknown routine, alike", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "guarded");
    expect((await postHook(url, null, "x")).status).toBe(401);
    expect((await postHook(url, routineKey(), "x")).status).toBe(401);
    expect((await postHook(url.replace("guarded", "no-such-routine"), key, "x")).status).toBe(401);
    // A sender's own Authorization header is not taken for the key.
    expect((await postHook(url, null, "x", { headers: { authorization: "Basic dXNlcjpwYXNz" } })).status).toBe(401);
    expect(await heldCount(pc.tag)).toBe(0);
  });

  it("refuses methods that carry no webhook, and GET unless the routine asked for it", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "methods");
    for (const method of ["OPTIONS", "TRACE"]) {
      expect((await postHook(url, key, null, { method })).status).toBe(405);
    }
    // A link previewer or mail scanner fetching a pasted ?key= URL must not fire the routine.
    expect((await postHook(url, key, null, { method: "GET", keyIn: "query" })).status).toBe(405);
    expect((await postHook(url, key, "x", { method: "PUT" })).status).toBe(202);
    const optedIn = routineKey();
    const response = await apiCall(pc.token, "PUT", "/v1/routines/polled", { keyHash: b64u(await hookKeyHash(optedIn)), allowGet: true });
    const { url: polled } = (await response.json()) as { url: string };
    expect((await postHook(polled, optedIn, null, { method: "GET", keyIn: "query" })).status).toBe(202);
  });

  it("refuses a body over the limit, declared or streamed", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "big");
    const limit = Number(env.MAX_BODY_BYTES);
    expect((await postHook(url, key, new Uint8Array(limit))).status).toBe(202);
    expect((await postHook(url, key, new Uint8Array(limit + 1))).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 4; i++) controller.enqueue(new Uint8Array(limit / 2));
        controller.close();
      },
    });
    expect((await postHook(url, key, stream)).status).toBe(413);
    expect(await heldCount(pc.tag)).toBe(1);
  });

  it("refuses headers over their budget", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "headers");
    const response = await postHook(url, key, "x", { headers: { "x-big": "y".repeat(Number(env.MAX_HEADER_BYTES)) } });
    expect(response.status).toBe(431);
  });

  it("forwards the query less the key, the sender's headers less credentials and the edge's own", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "forwarded");
    const socket = await openSocket(pc);
    const response = await postHook(`${url}?a=1&key=${key}&b=two&key=again`, null, "{}", {
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=abc",
        "cf-connecting-ip": "203.0.113.7",
        "cf-ray": "123",
        "x-forwarded-for": "198.51.100.1",
        cookie: "a=b",
        authorization: `Bearer ${key}`,
      },
    });
    expect(response.status).toBe(202);
    await socket.until(() => socket.binary().length === 1, 5000, "the webhook");
    const { envelope } = decodeWebhookFrame(socket.binary()[0]!);
    const request = decodeRequestRecord((await openEnvelope(envelope, pc.key)).plaintext);
    expect(request.query).toBe("a=1&b=two");
    expect(request.ip).toBe("203.0.113.7");
    const names = request.headers.map(([name]) => name);
    expect(names).toContain("x-hub-signature-256");
    expect(names).toContain("content-type");
    for (const dropped of ["cookie", "authorization", "cf-ray", "cf-connecting-ip", "x-forwarded-for", "host"]) {
      expect(names).not.toContain(dropped);
    }
    expect(fromUtf8(request.body)).toBe("{}");
    socket.close();
  });

  it("rate-limits an account's webhooks at the edge", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "flood");
    const statuses: number[] = [];
    for (let i = 0; i < 125; i++) statuses.push((await postHook(url, key, "x")).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    const limited = await postHook(url, key, "x");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });
});
