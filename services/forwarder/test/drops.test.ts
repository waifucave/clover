// Webhooks dropped before their routine's computer took them are counted per routine, with the latest reason,
// and reported to that computer once: in its hello when it connects, or in its routine list, whichever comes
// first. Without this, the missed-run rule could not tell "nothing came" from "it was dropped".

import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { b64u } from "../../../plugins/clover/plugins/forwarder/src/wire/bytes";
import { openEnvelope, readEnvelopeHeader } from "../../../plugins/clover/plugins/forwarder/src/wire/envelope";
import { decodeWebhookFrame, type RoutineInfo, type ServiceFrame } from "../../../plugins/clover/plugins/forwarder/src/wire/protocol";
import type { ForwarderDO } from "../src/forwarder-do";
import { limitsFrom } from "../src/env";
import { apiCall, objectOf, openSocket, postHook, registerComputer, registeredRoutine, registerRoutine, uniqueAccount, type Computer } from "./helpers";

const limits = limitsFrom(env);
const DAY = 24 * 3600 * 1000;

async function listed(computer: Computer): Promise<RoutineInfo[]> {
  return ((await (await apiCall(computer.token, "GET", "/v1/routines")).json()) as { routines: RoutineInfo[] }).routines;
}

describe("drops", () => {
  it("expiry is counted, reported once in the holder's list, and not cleared by another computer's list", async () => {
    const account = uniqueAccount();
    const pc = await registerComputer(account, "pc");
    const other = await registerComputer(account, "other");
    const { key, url } = await registeredRoutine(pc, "aged");
    expect((await postHook(url, key, "old")).status).toBe(202);
    const object = env.FORWARDER.getByName(objectOf(pc.tag));
    await runInDurableObject(object, (_i: ForwarderDO, state) => {
      state.storage.sql.exec("UPDATE held SET seq = ?", (Date.now() - 8 * DAY) * 1000);
    });
    expect(await runDurableObjectAlarm(object)).toBe(true);

    const seenByOther = (await listed(other)).find((r) => r.id === "aged")!;
    expect(seenByOther.dropped).toMatchObject({ count: 1, reason: "expired" });
    const first = (await listed(pc)).find((r) => r.id === "aged")!;
    expect(first.held).toBe(0);
    expect(first.dropped).toMatchObject({ count: 1, reason: "expired" });
    expect((await listed(pc)).find((r) => r.id === "aged")!.dropped).toBeUndefined();
  });

  it("drops at the cap are in every hello until the computer lists its routines, which clears them", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const { key, url } = await registeredRoutine(pc, "flooded");
    for (let i = 0; i < limits.maxHeld + 2; i++) expect((await postHook(url, key, `x${i}`)).status).toBe(202);
    const helloOf = async () => {
      const socket = await openSocket(pc);
      const hello = JSON.parse(socket.text().find((m) => m.includes('"hello"'))!) as Extract<ServiceFrame, { t: "hello" }>;
      socket.close();
      await new Promise((r) => setTimeout(r, 100));
      return hello;
    };
    const report = [{ routine: "flooded", count: 2, reason: "cap", at: expect.any(Number) }];
    expect((await helloOf()).dropped).toEqual(report);
    // A computer that restarts before listing still learns of them.
    expect((await helloOf()).dropped).toEqual(report);
    expect((await listed(pc))[0]!.dropped).toMatchObject({ count: 2, reason: "cap" });
    expect((await listed(pc))[0]!.dropped).toBeUndefined();
    expect((await helloOf()).dropped).toBeUndefined();
  });

  it("a computer added after a webhook was sealed cannot open it, refuses it as unreadable, and is told so", async () => {
    const account = uniqueAccount();
    const laptop = await registerComputer(account, "laptop");
    const { key, url } = await registeredRoutine(laptop, "early");
    expect((await postHook(url, key, "sealed for the laptop only")).status).toBe(202);

    const desktop = await registerComputer(account, "desktop");
    expect((await registerRoutine(desktop, "early", key, true)).status).toBe(200);
    const socket = await openSocket(desktop);
    await socket.until(() => socket.binary().length === 1, 5000, "the early webhook");
    const { seq, envelope } = decodeWebhookFrame(socket.binary()[0]!);
    await expect(openEnvelope(envelope, desktop.key)).rejects.toThrow("not sealed for this key");
    socket.send(JSON.stringify({ t: "nack", a: [[seq, b64u(readEnvelopeHeader(envelope).pid)]], reason: "unreadable" }));
    await new Promise((r) => setTimeout(r, 200));
    const report = (await listed(desktop)).find((r) => r.id === "early")!;
    expect(report.held).toBe(0);
    expect(report.dropped).toMatchObject({ count: 1, reason: "unreadable" });
    // A webhook that arrives now is sealed for both computers.
    expect((await postHook(url, key, "sealed for both")).status).toBe(202);
    await socket.until(() => socket.binary().length === 2, 5000, "the new webhook");
    await openEnvelope(decodeWebhookFrame(socket.binary()[1]!).envelope, desktop.key);
    socket.close();
  });
});
