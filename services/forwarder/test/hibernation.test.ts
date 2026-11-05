// The WebSocket Hibernation API: a computer's socket stays open while the account's object is out of memory,
// a webhook or an acknowledgement wakes it, and keep-alives are answered without waking it.

import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { b64u, fromUtf8 } from "../../../plugins/clover/forwarder/src/wire/bytes";
import { decodeRequestRecord, openEnvelope, readEnvelopeHeader } from "../../../plugins/clover/forwarder/src/wire/envelope";
import { decodeWebhookFrame, PING, PONG } from "../../../plugins/clover/forwarder/src/wire/protocol";
import type { ForwarderDO } from "../src/forwarder-do";
import { objectOf, openSocket, postHook, registerComputer, registeredRoutine, uniqueAccount } from "./helpers";

function stub(tag: string) {
  return env.FORWARDER.getByName(objectOf(tag));
}

describe("hibernation", () => {
  it("delivers to a socket that stayed open while the object was evicted", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "sleeper");
    const socket = await openSocket(pc);
    await evictDurableObject(stub(pc.tag)); // hibernates the socket rather than closing it
    expect(socket.closed).toBeNull();

    expect((await postHook(url, key, "woke you")).status).toBe(202);
    await socket.until(() => socket.binary().length === 1, 5000, "the webhook after eviction");
    const { seq, envelope } = decodeWebhookFrame(socket.binary()[0]!);
    const opened = await openEnvelope(envelope, pc.key);
    expect(fromUtf8(decodeRequestRecord(opened.plaintext).body)).toBe("woke you");

    // The acknowledgement after another eviction still finds the socket's state and deletes the payload.
    await evictDurableObject(stub(pc.tag));
    socket.send(JSON.stringify({ t: "ack", a: [[seq, b64u(opened.header.pid)]] }));
    await new Promise((r) => setTimeout(r, 200));
    const left = await runInDurableObject(stub(pc.tag), (_i: ForwarderDO, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM held").one().n,
    );
    expect(left).toBe(0);
    socket.close();
  });

  it("keeps what each socket was sent across evictions, so nothing is sent twice", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "ordered");
    const socket = await openSocket(pc);
    await postHook(url, key, "one");
    await socket.until(() => socket.binary().length === 1, 5000, "first");
    await evictDurableObject(stub(pc.tag));
    await postHook(url, key, "two");
    await socket.until(() => socket.binary().length === 2, 5000, "second");
    await new Promise((r) => setTimeout(r, 200));
    const seqs = socket.binary().map((frame) => decodeWebhookFrame(frame).seq);
    expect(seqs.length).toBe(2);
    expect(seqs[1]!).toBeGreaterThan(seqs[0]!);
    socket.close();
  });

  it("answers keep-alives with the runtime's auto-response, without the object's handler", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const socket = await openSocket(pc);
    await evictDurableObject(stub(pc.tag));
    socket.send(PING);
    await socket.until(() => socket.text().includes(PONG), 5000, "pong");
    const stamped = await runInDurableObject(stub(pc.tag), (_i: ForwarderDO, state) => {
      const [ws] = state.getWebSockets();
      return ws ? state.getWebSocketAutoResponseTimestamp(ws) !== null : false;
    });
    expect(stamped).toBe(true);
    socket.close();
  });

  it("holds webhooks when eviction closes the socket, and delivers them on reconnect", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "dropped-line");
    const socket = await openSocket(pc);
    await evictDurableObject(stub(pc.tag), { webSockets: "close" });
    await socket.until(() => socket.closed !== null, 5000, "the close");
    expect((await postHook(url, key, "while away")).status).toBe(202);
    const again = await openSocket(pc);
    await again.until(() => again.binary().length === 1, 5000, "the held webhook");
    const { envelope } = decodeWebhookFrame(again.binary()[0]!);
    expect(readEnvelopeHeader(envelope).routineId).toBe("dropped-line");
    again.close();
  });
});
