// What a stranger, a leaked URL or a broken computer can do to an account: senders without the key spend
// only their own address's check limit and never get a body read; a noisy routine is limited on its own and
// pays for the cap itself; a key nothing can be sealed to is refused; revocation only takes registered ids.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { b64u, fromUtf8 } from "../../../plugins/clover/forwarder/src/wire/bytes";
import { decodeRequestRecord, keyId, openEnvelope } from "../../../plugins/clover/forwarder/src/wire/envelope";
import { generateX25519 } from "../../../plugins/clover/forwarder/src/wire/hpke";
import { decodeWebhookFrame, hookKeyHash, type RoutineInfo } from "../../../plugins/clover/forwarder/src/wire/protocol";
import { REVOCATION_KEEP_MS, type ForwarderDO } from "../src/forwarder-do";
import { limitsFrom } from "../src/env";
import {
  accountToken,
  apiCall,
  objectOf,
  openSocket,
  postHook,
  registerComputer,
  registeredRoutine,
  routineKey,
  uniqueAccount,
  withLimiters,
} from "./helpers";
import { StepLimiter } from "../../shared/testing/step-limiter";

const limits = limitsFrom(env);

function from(address: string): RequestInit {
  return { headers: { "cf-connecting-ip": address } };
}

describe("senders without the key", () => {
  it("spend only their own address's check limit; the routine's real sender is unaffected", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "guarded");
    const check = new StepLimiter(4);
    const via = withLimiters({ CHECK_RATE: check, HOOK_RATE: new StepLimiter(100), TAG_RATE: new StepLimiter(100) });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await postHook(url, routineKey(), "guess", { ...from("198.51.100.9"), via })).status);
    expect(statuses).toEqual([401, 401, 401, 401, 429, 429]);
    // No key at all costs nothing but a 401, and does not count either.
    const counted = check.keys().map((k) => check.count(k));
    expect((await postHook(url, null, "no key", { ...from("198.51.100.9"), via })).status).toBe(401);
    expect(check.keys().map((k) => check.count(k))).toEqual(counted);
    for (let i = 0; i < 5; i++) expect((await postHook(url, key, `real ${i}`, { ...from("192.0.2.1"), via })).status).toBe(202);
    // The guesser's next window starts over.
    check.nextWindow();
    expect((await postHook(url, routineKey(), "guess", { ...from("198.51.100.9"), via })).status).toBe(401);
  });

  it("never get a body read: a wrong key with an oversized body is refused for the key", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "unread");
    const big = new Uint8Array(limits.maxBodyBytes + 1);
    expect((await postHook(url, routineKey(), big)).status).toBe(401);
    expect((await postHook(url, key, big)).status).toBe(413);
  });
});

describe("a noisy routine", () => {
  it("is rate-limited on its own: the account's other routines still get through", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const noisy = await registeredRoutine(pc, "noisy");
    const quiet = await registeredRoutine(pc, "quiet");
    const hook = new StepLimiter(3);
    const via = withLimiters({ HOOK_RATE: hook, TAG_RATE: new StepLimiter(100), CHECK_RATE: new StepLimiter(100) });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await postHook(noisy.url, noisy.key, `n${i}`, { via })).status);
    expect(statuses).toEqual([202, 202, 202, 429, 429]);
    expect((await postHook(quiet.url, quiet.key, "still here", { via })).status).toBe(202);
    hook.nextWindow();
    expect((await postHook(noisy.url, noisy.key, "next minute", { via })).status).toBe(202);
  });

  it("is limited across the account too: every routine together", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const a = await registeredRoutine(pc, "a");
    const b = await registeredRoutine(pc, "b");
    const via = withLimiters({ HOOK_RATE: new StepLimiter(100), TAG_RATE: new StepLimiter(3), CHECK_RATE: new StepLimiter(100) });
    const statuses = [
      (await postHook(a.url, a.key, "1", { via })).status,
      (await postHook(b.url, b.key, "2", { via })).status,
      (await postHook(a.url, a.key, "3", { via })).status,
      (await postHook(b.url, b.key, "4", { via })).status,
    ];
    expect(statuses).toEqual([202, 202, 202, 429]);
  });

  it("pays for the cap itself: its oldest webhooks are dropped, not another routine's", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const quiet = await registeredRoutine(pc, "quiet");
    const noisy = await registeredRoutine(pc, "noisy");
    expect((await postHook(quiet.url, quiet.key, "keep me")).status).toBe(202);
    for (let i = 0; i < limits.maxHeld + 2; i++) expect((await postHook(noisy.url, noisy.key, `n${i}`)).status).toBe(202);
    const held = await runInDurableObject(env.FORWARDER.getByName(objectOf(pc.tag)), (_i: ForwarderDO, state) =>
      state.storage.sql.exec<{ routine: string; n: number }>("SELECT routine, COUNT(*) AS n FROM held GROUP BY routine ORDER BY routine").toArray(),
    );
    expect(held).toEqual([
      { routine: "noisy", n: limits.maxHeld - 1 },
      { routine: "quiet", n: 1 },
    ]);
    const listed = ((await (await apiCall(pc.token, "GET", "/v1/routines")).json()) as { routines: RoutineInfo[] }).routines;
    expect(listed.find((r) => r.id === "noisy")!.dropped).toMatchObject({ count: 3, reason: "cap" });
    expect(listed.find((r) => r.id === "quiet")!.dropped).toBeUndefined();
  });
});

describe("computer keys", () => {
  it("refuses a key nothing can be sealed to", async () => {
    const account = uniqueAccount();
    const pc = await registerComputer(account, "pc");
    const lowOrder = [new Uint8Array(32), Uint8Array.of(1, ...new Uint8Array(31))];
    for (const encKey of lowOrder) {
      const response = await apiCall(pc.token, "PUT", "/v1/devices/self", { encKey: b64u(encKey) });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_key" });
    }
  });

  it("a bad key that got in anyway is left out, and the other computers still get the webhook", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "sealed");
    await runInDurableObject(env.FORWARDER.getByName(objectOf(pc.tag)), async (_i: ForwarderDO, state) => {
      const bad = new Uint8Array(32);
      state.storage.sql.exec(
        "INSERT INTO devices (id, kid, pub, name, added) VALUES ('broken', ?, ?, NULL, ?)",
        (await keyId(bad)).buffer,
        bad.buffer,
        Date.now(),
      );
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const socket = await openSocket(pc);
    expect((await postHook(url, key, "for the good one")).status).toBe(202);
    await socket.until(() => socket.binary().length === 1, 5000, "the webhook");
    const { envelope } = decodeWebhookFrame(socket.binary()[0]!);
    expect(fromUtf8(decodeRequestRecord((await openEnvelope(envelope, pc.key)).plaintext).body)).toBe("for the good one");
    expect(warn.mock.calls.flat().join(" ")).toContain("1 computer key(s) could not be sealed to");
    warn.mockRestore();
    socket.close();
  });
});

describe("revocation", () => {
  it("takes any device id: one revoked before it registered can neither register nor take over a routine", async () => {
    const account = uniqueAccount();
    const pc = await registerComputer(account, "pc");
    const { key } = await registeredRoutine(pc, "kept");
    expect((await apiCall(pc.token, "DELETE", "/v1/devices/late-laptop")).status).toBe(204);
    const late = await accountToken({ account, device: "late-laptop" });
    const pair = await generateX25519();
    const registering = await apiCall(late, "PUT", "/v1/devices/self", { encKey: b64u(pair.publicKey) });
    expect(registering.status).toBe(403);
    expect(await registering.json()).toEqual({ error: "revoked" });
    const takeover = await apiCall(late, "PUT", "/v1/routines/kept", { keyHash: b64u(await hookKeyHash(key)), takeover: true });
    expect(takeover.status).toBe(403);
    expect((await apiCall(pc.token, "DELETE", "/v1/devices/late-laptop")).status).toBe(204); // again: still done
  });

  it("prunes revocations by age, once every token issued before them has expired, not by count", async () => {
    const account = uniqueAccount();
    const pc = await registerComputer(account, "pc");
    const object = env.FORWARDER.getByName(objectOf(pc.tag));
    const now = Date.now();
    await runInDurableObject(object, (_i: ForwarderDO, state) => {
      state.storage.sql.exec("INSERT INTO revoked (id, at) VALUES ('long-ago', ?), ('lately', ?)", now - REVOCATION_KEEP_MS - 1, now - 3600_000);
    });
    // A revocation past its window no longer holds: any token from before it has expired.
    const back = await accountToken({ account, device: "long-ago" });
    expect((await apiCall(back, "GET", "/v1/routines")).status).toBe(200);
    const recent = await accountToken({ account, device: "lately" });
    expect((await apiCall(recent, "GET", "/v1/routines")).status).toBe(403);

    expect((await apiCall(pc.token, "DELETE", "/v1/devices/fresh")).status).toBe(204);
    const left = await runInDurableObject(object, (_i: ForwarderDO, state) =>
      state.storage.sql.exec<{ id: string }>("SELECT id FROM revoked ORDER BY id").toArray().map((row) => row.id),
    );
    expect(left).toEqual(["fresh", "lately"]);
  });
});
