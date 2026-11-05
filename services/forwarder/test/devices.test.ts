// Computers and routines: one connection per computer, revocation, moving a routine, conflicts and caps.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { b64u, fromUtf8 } from "../../../plugins/clover/forwarder/src/wire/bytes";
import { decodeRequestRecord, openEnvelope, readEnvelopeHeader } from "../../../plugins/clover/forwarder/src/wire/envelope";
import { generateX25519 } from "../../../plugins/clover/forwarder/src/wire/hpke";
import { decodeWebhookFrame, type DeviceInfo, type RoutineInfo } from "../../../plugins/clover/forwarder/src/wire/protocol";
import type { ForwarderDO } from "../src/forwarder-do";
import { limitsFrom } from "../src/env";
import { ownerHash } from "../src/identity";
import { accountToken, apiCall, objectOf, openSocket, postHook, registerComputer, registeredRoutine, registerRoutine, routineKey, uniqueAccount } from "./helpers";

const limits = limitsFrom(env);

describe("computers", () => {
  it("a second connection from the same computer replaces the first", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const first = await openSocket(pc);
    const second = await openSocket(pc);
    await first.until(() => first.closed !== null, 5000, "the old socket to close");
    expect(first.closed!.code).toBe(4000);
    expect(first.text().some((m) => m.includes('"replaced"'))).toBe(true);
    expect(second.closed).toBeNull();
    second.close();
  });

  it("re-registering an unchanged key writes nothing; a new key replaces the old", async () => {
    const account = uniqueAccount();
    const pc = await registerComputer(account, "pc");
    const again = await apiCall(pc.token, "PUT", "/v1/devices/self", { encKey: b64u(pc.key.publicKey), name: "pc" });
    expect(again.status).toBe(200);
    const fresh = await generateX25519();
    expect((await apiCall(pc.token, "PUT", "/v1/devices/self", { encKey: b64u(fresh.publicKey), name: "pc" })).status).toBe(200);
    const list = (await (await apiCall(pc.token, "GET", "/v1/devices")).json()) as { devices: DeviceInfo[] };
    expect(list.devices).toHaveLength(1);
  });

  it("caps the computers per account", async () => {
    const account = uniqueAccount();
    for (let i = 0; i < limits.maxDevices; i++) await registerComputer(account, `pc${i}`);
    const token = await accountToken({ account, device: "one-too-many" });
    const key = await generateX25519();
    const response = await apiCall(token, "PUT", "/v1/devices/self", { encKey: b64u(key.publicKey) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "too_many_devices" });
  });

  it("revoking a computer closes its link, drops its routines and their webhooks, and keeps it out", async () => {
    const account = uniqueAccount();
    const laptop = await registerComputer(account, "laptop");
    const desktop = await registerComputer(account, "desktop");
    const { key, url } = await registeredRoutine(laptop, "laptop-routine");
    await postHook(url, key, "held");
    const socket = await openSocket(laptop);
    await socket.until(() => socket.binary().length === 1, 5000, "the held webhook");

    expect((await apiCall(desktop.token, "DELETE", "/v1/devices/laptop")).status).toBe(204);
    await socket.until(() => socket.closed !== null, 5000, "the revoked socket to close");
    expect(socket.closed!.code).toBe(4003);

    expect((await postHook(url, key, "after")).status).toBe(401);
    const again = await apiCall(laptop.token, "PUT", "/v1/devices/self", { encKey: b64u(laptop.key.publicKey) });
    expect(again.status).toBe(403);
    expect(await again.json()).toEqual({ error: "revoked" });
    const routines = (await (await apiCall(desktop.token, "GET", "/v1/routines")).json()) as { routines: RoutineInfo[] };
    expect(routines.routines).toEqual([]);
    const held = await runInDurableObject(env.FORWARDER.getByName(objectOf(desktop.tag)), (_i: ForwarderDO, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM held").one().n,
    );
    expect(held).toBe(0);
  });

  it("an account's object refuses calls made for another account", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const result = await runInDurableObject(env.FORWARDER.getByName(objectOf(pc.tag)), async (instance: ForwarderDO) =>
      instance.listRoutines({ owner: await ownerHash("someone-else"), device: "pc" }),
    );
    expect(result).toMatchObject({ ok: false, status: 403, error: "wrong_account" });
  });

  it("new webhooks are sealed for every computer of the account", async () => {
    const account = uniqueAccount();
    const laptop = await registerComputer(account, "laptop");
    const desktop = await registerComputer(account, "desktop");
    const { key, url } = await registeredRoutine(laptop, "shared");
    await postHook(url, key, "for both");
    const socket = await openSocket(laptop);
    await socket.until(() => socket.binary().length === 1, 5000, "the webhook");
    const { envelope } = decodeWebhookFrame(socket.binary()[0]!);
    expect(readEnvelopeHeader(envelope).kids.map(b64u).sort()).toEqual([b64u(laptop.key.kid), b64u(desktop.key.kid)].sort());
    expect(fromUtf8(decodeRequestRecord((await openEnvelope(envelope, desktop.key)).plaintext).body)).toBe("for both");
    socket.close();
  });
});

describe("routines", () => {
  it("lists, re-keys and deletes a routine; re-keying drops the old key's webhooks, deleting keeps the rest", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const first = await registeredRoutine(pc, "rekeyed");
    expect((await postHook(first.url, first.key, "x")).status).toBe(202);
    const newKey = routineKey();
    expect((await registerRoutine(pc, "rekeyed", newKey)).status).toBe(200);
    expect((await postHook(first.url, first.key, "old key")).status).toBe(401);
    expect((await postHook(first.url, newKey, "new key")).status).toBe(202);
    let list = (await (await apiCall(pc.token, "GET", "/v1/routines")).json()) as { routines: RoutineInfo[] };
    expect(list.routines).toEqual([
      { id: "rekeyed", device: "pc", held: 1, allowGet: false, dropped: { count: 1, reason: "rekeyed", at: expect.any(Number) } },
    ]);
    expect((await apiCall(pc.token, "DELETE", "/v1/routines/rekeyed")).status).toBe(204);
    list = (await (await apiCall(pc.token, "GET", "/v1/routines")).json()) as { routines: RoutineInfo[] };
    expect(list.routines).toEqual([]);
    expect((await postHook(first.url, newKey, "gone")).status).toBe(401);
    expect((await apiCall(pc.token, "DELETE", "/v1/routines/rekeyed")).status).toBe(204); // already gone: done
    const held = await runInDurableObject(env.FORWARDER.getByName(objectOf(pc.tag)), (_i: ForwarderDO, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM held WHERE routine = 'rekeyed'").one().n,
    );
    expect(held).toBe(1);
  });

  it("a second computer cannot take a routine without takeover; with it, the held webhooks follow", async () => {
    const account = uniqueAccount();
    const laptop = await registerComputer(account, "laptop");
    const desktop = await registerComputer(account, "desktop");
    const { key, url } = await registeredRoutine(laptop, "moving");
    await postHook(url, key, "before the move");

    const conflict = await registerRoutine(desktop, "moving", key);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "held_elsewhere", device: "laptop" });

    const socket = await openSocket(desktop);
    expect((await registerRoutine(desktop, "moving", key, true)).status).toBe(200);
    await socket.until(() => socket.binary().length === 1, 5000, "the held webhook on the new computer");
    const { envelope } = decodeWebhookFrame(socket.binary()[0]!);
    expect(fromUtf8(decodeRequestRecord((await openEnvelope(envelope, desktop.key)).plaintext).body)).toBe("before the move");
    socket.close();
  });

  it("caps the routines per account", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    for (let i = 0; i < limits.maxRoutines; i++) await registeredRoutine(pc, `r${i}`);
    const response = await registerRoutine(pc, "one-too-many", routineKey());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "too_many_routines" });
  });

  it("a computer that has not registered its key cannot register a routine", async () => {
    const token = await accountToken({ account: uniqueAccount(), device: "keyless" });
    const response = await apiCall(token, "PUT", "/v1/routines/early", { keyHash: b64u(new Uint8Array(32)) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "device_not_registered" });
  });
});
