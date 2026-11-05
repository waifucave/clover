// Which computer holds a routine decides who may delete it and refuse its webhooks (spec §7: moving a routine
// file moves the routine). A move must survive either order of the old computer's DELETE and the new one's
// registration, and a second copy must not be able to break the original.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { b64u, fromUtf8 } from "../../../plugins/clover/forwarder/src/wire/bytes";
import { decodeRequestRecord, openEnvelope, readEnvelopeHeader } from "../../../plugins/clover/forwarder/src/wire/envelope";
import { decodeWebhookFrame, type RoutineConflict, type RoutineInfo } from "../../../plugins/clover/forwarder/src/wire/protocol";
import type { ForwarderDO } from "../src/forwarder-do";
import {
  apiCall,
  objectOf,
  openSocket,
  postHook,
  registerComputer,
  registeredRoutine,
  registerRoutine,
  routineKey,
  uniqueAccount,
  type Computer,
  type Socket,
} from "./helpers";

async function heldCount(tag: string, routine: string): Promise<number> {
  return runInDurableObject(env.FORWARDER.getByName(objectOf(tag)), (_i: ForwarderDO, state) =>
    state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM held WHERE routine = ?", routine).one().n,
  );
}

async function routines(computer: Computer): Promise<RoutineInfo[]> {
  return ((await (await apiCall(computer.token, "GET", "/v1/routines")).json()) as { routines: RoutineInfo[] }).routines;
}

/** The bodies of the webhooks on a socket, opened with the computer's key. */
async function bodies(socket: Socket, computer: Computer): Promise<string[]> {
  const out: string[] = [];
  for (const frame of socket.binary()) {
    const { envelope } = decodeWebhookFrame(frame);
    out.push(fromUtf8(decodeRequestRecord((await openEnvelope(envelope, computer.key)).plaintext).body));
  }
  return out;
}

async function twoComputers() {
  const account = uniqueAccount();
  const laptop = await registerComputer(account, "laptop");
  const desktop = await registerComputer(account, "desktop");
  return { laptop, desktop };
}

describe("moving a routine", () => {
  it("the old computer's DELETE first: its held webhooks wait for the new computer's registration", async () => {
    const { laptop, desktop } = await twoComputers();
    const { key, url } = await registeredRoutine(laptop, "moving");
    for (const body of ["one", "two"]) expect((await postHook(url, key, body)).status).toBe(202);
    expect((await apiCall(laptop.token, "DELETE", "/v1/routines/moving")).status).toBe(204);
    expect(await heldCount(laptop.tag, "moving")).toBe(2);

    const socket = await openSocket(desktop);
    expect((await registerRoutine(desktop, "moving", key)).status).toBe(200);
    await socket.until(() => socket.binary().length === 2, 5000, "the kept webhooks");
    expect(await bodies(socket, desktop)).toEqual(["one", "two"]);
    expect((await postHook(url, key, "three")).status).toBe(202);
    await socket.until(() => socket.binary().length === 3, 5000, "a new webhook");
    socket.close();
  });

  it("the new computer's takeover first: the old computer's DELETE is refused and changes nothing", async () => {
    const { laptop, desktop } = await twoComputers();
    const { key, url } = await registeredRoutine(laptop, "moved");
    expect((await postHook(url, key, "held")).status).toBe(202);
    expect((await registerRoutine(desktop, "moved", key, true)).status).toBe(200);

    const refused = await apiCall(laptop.token, "DELETE", "/v1/routines/moved");
    expect(refused.status).toBe(409);
    expect((await refused.json()) as RoutineConflict).toEqual({ error: "held_elsewhere", device: "desktop" });
    expect(await routines(desktop)).toEqual([{ id: "moved", device: "desktop", held: 1, allowGet: false }]);
    expect((await postHook(url, key, "after")).status).toBe(202);
    expect(await heldCount(laptop.tag, "moved")).toBe(2);
  });
});

describe("a second copy", () => {
  it("cannot register, and deleting the copy leaves the original alone", async () => {
    const { laptop, desktop } = await twoComputers();
    const { key, url } = await registeredRoutine(laptop, "original");
    expect((await registerRoutine(desktop, "original", key)).status).toBe(409);
    expect((await apiCall(desktop.token, "DELETE", "/v1/routines/original")).status).toBe(409);
    expect((await postHook(url, key, "still mine")).status).toBe(202);
    expect(await routines(laptop)).toEqual([{ id: "original", device: "laptop", held: 1, allowGet: false }]);
  });
});

describe("refusing webhooks", () => {
  it("only the routine's computer can refuse its webhooks; any of the account's computers can acknowledge one", async () => {
    const { laptop, desktop } = await twoComputers();
    const { key, url } = await registeredRoutine(laptop, "mine");
    expect((await postHook(url, key, "first")).status).toBe(202);
    expect((await postHook(url, key, "second")).status).toBe(202);
    const pids = await runInDurableObject(env.FORWARDER.getByName(objectOf(laptop.tag)), (_i: ForwarderDO, state) =>
      state.storage.sql.exec<{ seq: number; pid: ArrayBuffer }>("SELECT seq, pid FROM held ORDER BY seq").toArray(),
    );
    const refs = pids.map((row) => [row.seq, b64u(new Uint8Array(row.pid))] as const);

    const other = await openSocket(desktop);
    other.send(JSON.stringify({ t: "nack", a: [refs[0]] }));
    other.send(JSON.stringify({ t: "nack", a: [refs[0]], reason: "unreadable" }));
    await new Promise((r) => setTimeout(r, 200));
    expect(await heldCount(laptop.tag, "mine")).toBe(2);

    other.send(JSON.stringify({ t: "ack", a: [refs[1]] }));
    await new Promise((r) => setTimeout(r, 200));
    expect(await heldCount(laptop.tag, "mine")).toBe(1);
    other.close();

    const own = await openSocket(laptop);
    await own.until(() => own.binary().length === 1, 5000, "the remaining webhook");
    const frame = decodeWebhookFrame(own.binary()[0]!);
    own.send(JSON.stringify({ t: "nack", a: [[frame.seq, b64u(readEnvelopeHeader(frame.envelope).pid)]] }));
    await new Promise((r) => setTimeout(r, 200));
    expect(await heldCount(laptop.tag, "mine")).toBe(0);
    own.close();
  });
});

describe("a new key", () => {
  it("re-creating a routine under a new key drops what the old key queued, as rekeyed", async () => {
    const { laptop } = await twoComputers();
    const first = await registeredRoutine(laptop, "leaked");
    for (const body of ["queued by a leaked key", "and another"]) expect((await postHook(first.url, first.key, body)).status).toBe(202);
    expect((await apiCall(laptop.token, "DELETE", "/v1/routines/leaked")).status).toBe(204);
    const fresh = await registeredRoutine(laptop, "leaked");
    expect(await heldCount(laptop.tag, "leaked")).toBe(0);
    expect((await routines(laptop))[0]!.dropped).toMatchObject({ count: 2, reason: "rekeyed" });
    expect((await postHook(first.url, first.key, "the old key")).status).toBe(401);
    const socket = await openSocket(laptop);
    expect((await postHook(fresh.url, fresh.key, "the new key")).status).toBe(202);
    await socket.until(() => socket.binary().length === 1, 5000, "the new key's webhook");
    expect(await bodies(socket, laptop)).toEqual(["the new key"]);
    socket.close();
  });

  it("re-keying in place drops what the old key queued", async () => {
    const { laptop } = await twoComputers();
    const first = await registeredRoutine(laptop, "rotated");
    expect((await postHook(first.url, first.key, "old")).status).toBe(202);
    const second = await registeredRoutine(laptop, "rotated");
    expect((await postHook(second.url, second.key, "new")).status).toBe(202);
    expect(await heldCount(laptop.tag, "rotated")).toBe(1);
    expect((await routines(laptop))[0]!.dropped).toMatchObject({ count: 1, reason: "rekeyed" });
  });

  it("a takeover under a new key drops what the old key queued; under the same key it keeps them", async () => {
    const { laptop, desktop } = await twoComputers();
    const same = await registeredRoutine(laptop, "same-key");
    const changed = await registeredRoutine(laptop, "new-key");
    expect((await postHook(same.url, same.key, "kept")).status).toBe(202);
    expect((await postHook(changed.url, changed.key, "dropped")).status).toBe(202);
    expect((await registerRoutine(desktop, "same-key", same.key, true)).status).toBe(200);
    expect((await registerRoutine(desktop, "new-key", routineKey(), true)).status).toBe(200);
    expect(await heldCount(laptop.tag, "same-key")).toBe(1);
    expect(await heldCount(laptop.tag, "new-key")).toBe(0);
    const listed = await routines(desktop);
    expect(listed.find((r) => r.id === "new-key")!.dropped).toMatchObject({ count: 1, reason: "rekeyed" });
    expect(listed.find((r) => r.id === "same-key")!.dropped).toBeUndefined();
  });
});
