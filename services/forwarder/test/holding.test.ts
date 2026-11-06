// The holding rule and its limits: caps (oldest dropped first), expiry by one coarse alarm, the delivery
// window, and the cost of a payload (rows written) not growing with how long it is held.

import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { b64u, fromUtf8 } from "../../../plugins/clover/plugins/forwarder/src/wire/bytes";
import { decodeRequestRecord, openEnvelope, readEnvelopeHeader } from "../../../plugins/clover/plugins/forwarder/src/wire/envelope";
import { decodeWebhookFrame } from "../../../plugins/clover/plugins/forwarder/src/wire/protocol";
import type { ForwarderDO } from "../src/forwarder-do";
import { limitsFrom } from "../src/env";
import { objectOf, openSocket, postHook, registerComputer, registeredRoutine, type Socket, uniqueAccount } from "./helpers";

const limits = limitsFrom(env);
const DAY = 24 * 3600 * 1000;

function stub(tag: string) {
  return env.FORWARDER.getByName(objectOf(tag));
}

async function held(tag: string): Promise<{ seq: number; received: number; size: number }[]> {
  return runInDurableObject(stub(tag), (_i: ForwarderDO, state) =>
    state.storage.sql.exec<{ seq: number; received: number; size: number }>("SELECT seq, received, size FROM held ORDER BY seq").toArray(),
  );
}

async function bodies(socket: Socket, key: Parameters<typeof openEnvelope>[1]): Promise<string[]> {
  const out: string[] = [];
  for (const frame of socket.binary()) {
    const { envelope } = decodeWebhookFrame(frame);
    out.push(fromUtf8(decodeRequestRecord((await openEnvelope(envelope, key)).plaintext).body));
  }
  return out;
}

describe("caps", () => {
  it("drops the oldest payload past the count cap", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "counted");
    for (let i = 0; i < limits.maxHeld + 3; i++) expect((await postHook(url, key, `n${i}`)).status).toBe(202);
    expect((await held(pc.tag)).length).toBe(limits.maxHeld);
    const socket = await openSocket(pc);
    // The window lets a few through at a time; acknowledge as they come until all have arrived.
    const seen: string[] = [];
    while (seen.length < limits.maxHeld) {
      await socket.until(() => socket.binary().length > 0, 5000, "frames");
      const frames = socket.binary();
      socket.messages.length = 0;
      const acks = [];
      for (const frame of frames) {
        const { seq, envelope } = decodeWebhookFrame(frame);
        const opened = await openEnvelope(envelope, pc.key);
        seen.push(fromUtf8(decodeRequestRecord(opened.plaintext).body));
        acks.push([seq, b64u(opened.header.pid)]);
      }
      socket.send(JSON.stringify({ t: "ack", a: acks }));
    }
    expect(seen).toEqual(Array.from({ length: limits.maxHeld }, (_, i) => `n${i + 3}`));
    socket.close();
  });

  it("drops the oldest payloads past the byte cap", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "weighed");
    const big = new Uint8Array(limits.maxBodyBytes); // about a quarter of the account's byte cap
    for (let i = 0; i < 6; i++) expect((await postHook(url, key, big)).status).toBe(202);
    const rows = await held(pc.tag);
    const bytes = rows.reduce((sum, row) => sum + row.size, 0);
    expect(bytes).toBeLessThanOrEqual(limits.maxHeldBytes);
    expect(rows.length).toBeLessThan(6);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("expiry", () => {
  it("sets one alarm about a week out, not one per payload", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "expiring");
    const before = Date.now();
    for (let i = 0; i < 3; i++) await postHook(url, key, `x${i}`);
    const alarm = await runInDurableObject(stub(pc.tag), (_i: ForwarderDO, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    // At least one gap before a week has passed, so nothing is ever held past the week.
    expect(alarm!).toBeGreaterThanOrEqual(before + limits.holdMs - limits.expiryGapMs - 1000);
    expect(alarm!).toBeLessThanOrEqual(Date.now() + limits.holdMs - limits.expiryGapMs);
  });

  it("drops payloads a week old, keeps the rest, and moves the alarm at most one gap at a time", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "aged");
    for (let i = 0; i < 3; i++) await postHook(url, key, `x${i}`);
    const now = Date.now();
    // Age two of them: one past the week, one a little under the week (within the gap), one fresh. Sequence
    // numbers follow the clock in microseconds, and expiry reads them (on the primary key).
    await runInDurableObject(stub(pc.tag), (_i: ForwarderDO, state) => {
      const rows = state.storage.sql.exec<{ seq: number }>("SELECT seq FROM held ORDER BY seq").toArray();
      state.storage.sql.exec("UPDATE held SET seq = ? WHERE seq = ?", (now - 8 * DAY) * 1000, rows[0]!.seq);
      state.storage.sql.exec("UPDATE held SET seq = ? WHERE seq = ?", (now - limits.holdMs + limits.expiryGapMs / 2) * 1000, rows[1]!.seq);
    });
    expect(await runDurableObjectAlarm(stub(pc.tag))).toBe(true);
    const rows = await held(pc.tag);
    expect(rows.length).toBe(1);
    expect(rows[0]!.received).toBeGreaterThan(now - DAY);
    const next = await runInDurableObject(stub(pc.tag), (_i: ForwarderDO, state) => state.storage.getAlarm());
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThanOrEqual(Date.now() + limits.expiryGapMs - 1000);
  });

  it("an alarm on an empty account sets no new alarm", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "drained");
    await postHook(url, key, "x");
    await runInDurableObject(stub(pc.tag), (_i: ForwarderDO, state) => {
      state.storage.sql.exec("UPDATE held SET seq = ?", (Date.now() - 8 * DAY) * 1000);
    });
    expect(await runDurableObjectAlarm(stub(pc.tag))).toBe(true);
    expect((await held(pc.tag)).length).toBe(0);
    expect(await runInDurableObject(stub(pc.tag), (_i: ForwarderDO, state) => state.storage.getAlarm())).toBeNull();
  });
});

describe("the cost of holding", () => {
  /**
   * Counts what the account's object writes (SQL rows, which are billed per row, and alarm sets, billed as
   * one row each) from now on, by wrapping its storage. The wrapper lives as long as the object stays in memory.
   */
  async function meterWrites(tag: string): Promise<() => Promise<{ rows: number; alarms: number }>> {
    await runInDurableObject(stub(tag), (_i: ForwarderDO, state) => {
      const meter = { rows: 0, alarms: 0 };
      (globalThis as { __meter?: typeof meter }).__meter = meter;
      const sql = state.storage.sql;
      const exec = sql.exec.bind(sql);
      (sql as { exec: unknown }).exec = (query: string, ...bindings: unknown[]) => {
        const cursor = exec(query, ...bindings);
        const rows = cursor.toArray();
        meter.rows += cursor.rowsWritten;
        return { toArray: () => rows, one: () => rows[0], rowsWritten: cursor.rowsWritten, rowsRead: cursor.rowsRead };
      };
      const setAlarm = state.storage.setAlarm.bind(state.storage);
      state.storage.setAlarm = (...args: Parameters<typeof setAlarm>) => {
        meter.alarms += 1;
        return setAlarm(...args);
      };
    });
    return () =>
      runInDurableObject(stub(tag), () => {
        const meter = (globalThis as { __meter?: { rows: number; alarms: number } }).__meter!;
        return { rows: meter.rows, alarms: meter.alarms };
      });
  }

  async function deliverAndAck(socket: Socket, count: number): Promise<void> {
    await socket.until(() => socket.binary().length >= count, 5000, "frames");
    const acks = socket.binary().map((frame) => {
      const { seq, envelope } = decodeWebhookFrame(frame);
      return [seq, b64u(readEnvelopeHeader(envelope).pid)];
    });
    socket.messages.length = 0;
    socket.send(JSON.stringify({ t: "ack", a: acks }));
    await new Promise((r) => setTimeout(r, 200));
  }

  it("a webhook costs two rows written, whether it is taken at once or after the computer comes back", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "costed");
    // The first webhook also sets the account's one expiry alarm; meter after it.
    let socket = await openSocket(pc);
    await postHook(url, key, "warm-up");
    await deliverAndAck(socket, 1);
    const read = await meterWrites(pc.tag);

    // Taken at once.
    await postHook(url, key, "now");
    await deliverAndAck(socket, 1);
    expect(await read()).toEqual({ rows: 2, alarms: 0 });

    // Held while the computer is away, then taken when it reconnects: two more rows for the webhook, and one
    // for the new connection's ticket (deleted at a later connection once it has expired), not per payload.
    socket.close();
    await new Promise((r) => setTimeout(r, 100));
    await postHook(url, key, "later");
    socket = await openSocket(pc);
    await deliverAndAck(socket, 1);
    expect(await read()).toEqual({ rows: 2 + 2 + 1, alarms: 0 });
    socket.close();
  });

  it("a webhook held across an expiry alarm writes nothing more: the alarm moves once, for the whole account", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "waiting");
    expect((await postHook(url, key, "held while away")).status).toBe(202); // its insert, and the account's alarm
    const read = await meterWrites(pc.tag);
    expect(await runDurableObjectAlarm(stub(pc.tag))).toBe(true);
    expect(await read()).toEqual({ rows: 0, alarms: 1 });
    // Taken when the computer comes back: the connection's ticket row, and the webhook's delete.
    const socket = await openSocket(pc);
    await deliverAndAck(socket, 1);
    expect(await read()).toEqual({ rows: 2, alarms: 1 });
    socket.close();
  });
});

describe("the delivery window", () => {
  it("sends at most the window in flight, and more as acknowledgements come", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "windowed");
    for (let i = 0; i < 5; i++) await postHook(url, key, `w${i}`);
    const socket = await openSocket(pc);
    await socket.until(() => socket.binary().length >= limits.windowFrames, 5000, "a full window");
    await new Promise((r) => setTimeout(r, 200));
    expect(socket.binary().length).toBe(limits.windowFrames);
    expect(await bodies(socket, pc.key)).toEqual(["w0", "w1", "w2"]);
    const first = decodeWebhookFrame(socket.binary()[0]!);
    socket.send(JSON.stringify({ t: "ack", a: [[first.seq, b64u(readEnvelopeHeader(first.envelope).pid)]] }));
    await socket.until(() => socket.binary().length === limits.windowFrames + 1, 5000, "one more frame");
    expect((await bodies(socket, pc.key)).at(-1)).toBe("w3");
    socket.close();
  });

  it("an acknowledgement with the wrong payload id deletes nothing", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "guarded-acks");
    await postHook(url, key, "x");
    const socket = await openSocket(pc);
    await socket.until(() => socket.binary().length === 1, 5000, "the frame");
    const { seq } = decodeWebhookFrame(socket.binary()[0]!);
    socket.send(JSON.stringify({ t: "ack", a: [[seq, b64u(new Uint8Array(16))]] }));
    await new Promise((r) => setTimeout(r, 200));
    expect((await held(pc.tag)).length).toBe(1);
    socket.close();
  });

  it("a malformed frame closes the socket and keeps what is held", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "malformed");
    await postHook(url, key, "x");
    const socket = await openSocket(pc);
    socket.send("{not json");
    await socket.until(() => socket.closed !== null, 5000, "the close");
    expect(socket.closed!.code).toBe(4008);
    expect((await held(pc.tag)).length).toBe(1);
  });
});
