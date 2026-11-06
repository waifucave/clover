// Lane D's relay over the link: the desktop's app signs a user's message with its answer key, its computer relays it to
// the computer running the bot, and that computer checks it with B's `verifyUserMessage` against what it learned of
// the sender over the link. A changed message, or another key's signature, doesn't hold.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContractError } from "../../contracts/common";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { verifyUserMessage } from "../../contracts/session-host";
import type { Secret } from "../../contracts/secret-store";
import { SystemClock } from "../../clock/system-clock";
import { AnswerKey } from "../../identity/answer-key";
import { fromBase64 } from "../../identity/bytes";
import { MemoryNetwork } from "../memory-wire";
import { type DeviceLinks, startDeviceLinks } from "../node";
import { mountUserMessageRelay, relayUserMessage } from "../relay";

const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");

async function daemon(net: MemoryNetwork, name: string) {
  const links = await startDeviceLinks({ home: mkdtempSync(join(tmpdir(), "clover-h-relay-")), store: new MemorySecretStore(), clock, self: { name, os: "macos" }, wire: (key) => net.endpoint(key.publicKey) });
  stops.push(() => links.close());
  return links;
}

async function pair(a: DeviceLinks, b: DeviceLinks) {
  const view = await a.pairing.begin();
  const joined = await b.pairing.join(view.qr!);
  await waitFor(() => a.pairing.get(view.pairingId)?.status === "words");
  await Promise.all([a.pairing.confirm(view.pairingId, joined.words!, { terminal: true }), b.pairing.confirm(view.pairingId, joined.words!, { terminal: true })]);
  await waitFor(() => a.registry.get(b.key.id) !== undefined && b.registry.get(a.key.id) !== undefined);
}

describe("the user-message relay", () => {
  test("a message signed by the app's answer key, relayed over the link, holds at the bot's computer", async () => {
    const net = new MemoryNetwork();
    const studio = await daemon(net, "Studio");
    const server = await daemon(net, "Server");
    await pair(studio, server);
    // The Studio's app holds its answer key and hands it to its core.
    let seed: Secret | null = null;
    const app = await AnswerKey.loadOrCreate({ load: async () => seed, save: async (s) => void (seed = s) }, "app-keychain");
    const reg = app.registration(studio.key.id);
    await studio.registry.setOwnAnswerKey(reg.publicKey, reg.held, fromBase64(reg.signature)!);
    // The server learns it over the link.
    await waitFor(() => server.registry.get(studio.key.id)?.answerKey?.publicKey === app.publicKey);

    const got: { signed: boolean; from: string }[] = [];
    stops.push(mountUserMessageRelay(server.transport, server.registry, async (p, from) => {
      const signed = await verifyUserMessage({ session: p.id, device: p.device, message: p.message }, { now: Date.now(), sha256, devices: server.registry });
      got.push({ signed, from });
      return { seq: got.length };
    }));

    const sentAt = Date.now();
    const message = { text: "make the build green", clientMessageId: "m-1", sentAt };
    const signature = app.signUserMessage({ session: "ses_abcdef12", ...message });
    expect(await relayUserMessage(studio.transport, server.key.id, { id: "ses_abcdef12", message: { ...message, signature }, device: studio.key.id, sentAt })).toEqual({ seq: 1 });
    expect(got[0]).toEqual({ signed: true, from: studio.key.id });

    // Changed on the way, or signed by the link key instead of the app's: it arrives, but doesn't hold.
    await relayUserMessage(studio.transport, server.key.id, { id: "ses_abcdef12", message: { ...message, text: "delete everything", signature }, device: studio.key.id, sentAt });
    const linkSig = Buffer.from(studio.key.sign(new TextEncoder().encode("x"))).toString("base64");
    await relayUserMessage(studio.transport, server.key.id, { id: "ses_abcdef12", message: { ...message, signature: linkSig }, device: studio.key.id, sentAt });
    expect(got.map((g) => g.signed)).toEqual([true, false, false]);
  });

  test("only a paired computer relays, and bad params are refused before D's host sees them", async () => {
    const net = new MemoryNetwork();
    const a = await daemon(net, "Studio");
    const b = await daemon(net, "Server");
    await pair(a, b);
    let calls = 0;
    stops.push(mountUserMessageRelay(b.transport, b.registry, async () => ({ seq: ++calls })));
    const link = await a.transport.connect(b.key.id);
    expect(isContractError(await link.request("peer.session.send", { id: "nope" }).catch((e: unknown) => e), "invalid")).toBe(true);
    expect(calls).toBe(0);
  });
});

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}
