// Webhooks end to end inside workerd: a sender posts, the account's Durable Object seals and holds, the
// routine's computer takes it over its socket, opens it with its own key, and acknowledges it.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { b64u, fromUtf8 } from "../../../plugins/clover/forwarder/src/wire/bytes";
import { decodeRequestRecord, openEnvelope, readEnvelopeHeader } from "../../../plugins/clover/forwarder/src/wire/envelope";
import { decodeWebhookFrame } from "../../../plugins/clover/forwarder/src/wire/protocol";
import type { ForwarderDO } from "../src/forwarder-do";
import { openSocket, postHook, registerComputer, registeredRoutine, uniqueAccount, worker } from "./helpers";

function heldCount(tag: string): Promise<number> {
  const stub = env.FORWARDER.getByName(tag);
  return runInDurableObject(stub, (_instance: ForwarderDO, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM held").one().n);
}

describe("delivery", () => {
  it("holds a webhook while the computer is away and delivers it when it connects", async () => {
    const laptop = await registerComputer(uniqueAccount(), "laptop");
    const { key, url } = await registeredRoutine(laptop, "deploy-alert");
    expect(url).toBe(`https://hooks.test/${laptop.tag}/deploy-alert`);

    const posted = await postHook(`${url}?source=ci`, key, JSON.stringify({ build: 42 }), {
      headers: { "content-type": "application/json", "x-github-event": "push", cookie: "session=secret" },
    });
    expect(posted.status).toBe(202);
    const { id } = (await posted.json()) as { id: string };
    expect(await heldCount(laptop.tag)).toBe(1);

    const socket = await openSocket(laptop);
    await socket.until(() => socket.binary().length === 1, 5000, "the held webhook");
    const { seq, envelope } = decodeWebhookFrame(socket.binary()[0]!);
    const header = readEnvelopeHeader(envelope);
    expect(header.routineId).toBe("deploy-alert");
    expect(b64u(header.pid)).toBe(id);

    const { plaintext } = await openEnvelope(envelope, laptop.key);
    const request = decodeRequestRecord(plaintext);
    expect(request.method).toBe("POST");
    expect(request.query).toBe("source=ci");
    expect(fromUtf8(request.body)).toBe('{"build":42}');
    const headers = new Map(request.headers);
    expect(headers.get("x-github-event")).toBe("push");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);

    socket.send(JSON.stringify({ t: "ack", a: [[seq, id]] }));
    await socket.until(() => false, 300).catch(() => {});
    expect(await heldCount(laptop.tag)).toBe(0);
    socket.close();
  });

  it("sends a webhook at once to a connected computer", async () => {
    const desktop = await registerComputer(uniqueAccount(), "desktop");
    const { key, url } = await registeredRoutine(desktop, "nightly");
    const socket = await openSocket(desktop);
    const posted = await postHook(url, key, "hello", { keyIn: "query" });
    expect(posted.status).toBe(202);
    await socket.until(() => socket.binary().length === 1, 5000, "the webhook");
    const { envelope } = decodeWebhookFrame(socket.binary()[0]!);
    const { plaintext } = await openEnvelope(envelope, desktop.key);
    const request = decodeRequestRecord(plaintext);
    expect(fromUtf8(request.body)).toBe("hello");
    expect(request.query).toBe(""); // the key never travels on
    socket.close();
  });

  it("never stores a payload in plaintext", async () => {
    const laptop = await registerComputer(uniqueAccount(), "laptop");
    const { key, url } = await registeredRoutine(laptop, "secrets");
    const marker = "plaintext-marker-7f3a9c";
    expect((await postHook(url, key, marker)).status).toBe(202);
    const stub = env.FORWARDER.getByName(laptop.tag);
    const stored = await runInDurableObject(stub, (_i: ForwarderDO, state) => {
      const rows = state.storage.sql.exec<{ env: ArrayBuffer }>("SELECT env FROM held").toArray();
      return rows.map((row) => new Uint8Array(row.env));
    });
    expect(stored).toHaveLength(1);
    const asText = new TextDecoder("latin1").decode(stored[0]!);
    expect(asText.includes(marker)).toBe(false);
    expect(asText.includes(key)).toBe(false);
  });

  it("answers health checks for unknown paths without touching an object", async () => {
    expect((await worker("/")).status).toBe(404);
    expect((await worker("/not-a-tag/routine", { method: "POST" })).status).toBe(404);
  });
});
