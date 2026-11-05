// The web companion end to end, on this machine: the page's logic (services/web/src/app.ts, as a browser runs it)
// and this plugin's WebLinkHost, through the handshake Worker on wrangler's local runtime, over WebRTC data channels
// (node-datachannel on both ends here; the CI browser test puts a real Chrome on the page's end). Every key is made
// here for the run, in memory. The only network is 127.0.0.1.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanup } from "node-datachannel";
import { RTCPeerConnection } from "node-datachannel/polyfill";

import { HandshakeClient } from "@waifucave/clover-service-handshake/client";
import { harnessReady, type HandshakeHarness, startHandshake } from "@waifucave/clover-service-handshake/harness";
import { Companion, MemoryStore, PairingError, type PairRecord } from "@waifucave/clover-service-web/app";
import { readInvite, type RtcEnvironment, type RtcLink } from "@waifucave/clover-service-web/protocol";

import { type DeviceChange, type DeviceInput, MemoryPairStore, type PairingProof } from "../src/contracts";
import { WebLinkHost } from "../src/web-host";

const ready = harnessReady();
const rtc: RtcEnvironment = {
  createPeerConnection: (config) => new RTCPeerConnection(config) as unknown as ReturnType<RtcEnvironment["createPeerConnection"]>,
  iceServers: [],
};

class FakeRegistry {
  readonly added: { device: DeviceInput; proof: PairingProof }[] = [];
  private readonly watchers = new Set<(change: DeviceChange) => void>();
  async add(device: DeviceInput, proof: PairingProof): Promise<unknown> {
    this.added.push({ device, proof });
    return device;
  }
  watch(fn: (change: DeviceChange) => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }
  revoke(id: string): void {
    for (const fn of this.watchers) fn({ type: "revoked", id });
  }
}

let harness: HandshakeHarness;
let addresses = 0;

beforeAll(async () => {
  if (ready) harness = await startHandshake();
}, 60_000);

afterAll(async () => {
  await harness?.stop();
  cleanup();
});

interface Computer {
  host: WebLinkHost;
  registry: FakeRegistry;
  store: MemoryPairStore;
  links: RtcLink[];
  shown: string[][];
}

function computer(options: { confirm?: boolean; store?: MemoryPairStore; registry?: FakeRegistry } = {}): Computer {
  const registry = options.registry ?? new FakeRegistry();
  const store = options.store ?? new MemoryPairStore();
  const links: RtcLink[] = [];
  const shown: string[][] = [];
  // Each computer at its own address: pairings count against the handshake's registration limit per address.
  const address = `198.51.100.${++addresses}`;
  const host = new WebLinkHost({
    client: new HandshakeClient({
      origin: harness.url,
      fetch: (request) => {
        const headers = new Headers(request.headers);
        headers.set("cf-connecting-ip", address);
        return fetch(new Request(request, { headers }));
      },
    }),
    webOrigin: "https://clover.test",
    inviteHandshake: harness.url,
    computerName: "Studio",
    rtc,
    store,
    registry,
    confirm: async ({ words }) => {
      shown.push(words);
      return { confirmed: options.confirm ?? true, card: "card-1" };
    },
    adopt: (link) => {
      // The core's side, played here: the `web` call list's bot.list, and live events as notifications.
      link.handle("bot.list", () => ({ bots: [{ id: "alpha", name: "Alpha", mainSession: "s_alpha" }] }));
      link.handle("session.send", (params) => {
        link.notify("event", { type: "user_message", sessionId: (params as { id: string }).id, text: (params as { message: { text: string } }).message.text });
        return { seq: 1 };
      });
      links.push(link);
    },
  });
  return { host, registry, store, links, shown };
}

function browser(store = new MemoryStore()): Companion {
  return new Companion({ store, rtc, handshake: "https://handshake.invalid", allowedHandshakes: [harness.url], name: "Test browser" });
}

async function invite(c: Computer, code = "481516") {
  const url = await c.host.createInvite({ code, expiresAt: Date.now() + 10 * 60_000 });
  expect(url.startsWith("https://clover.test/#pair=")).toBe(true);
  return readInvite(new URL(url).hash)!;
}

async function pairUp(c: Computer, b = browser()): Promise<{ record: PairRecord; words: string[]; b: Companion }> {
  let words: string[] = [];
  const record = await b.pair(await invite(c), { onWords: (w) => (words = w) });
  return { record, words, b };
}

describe.skipIf(!ready)("the web companion", () => {
  test("a browser pairs once: both ends show the same four words, and the computer registers it", async () => {
    const c = computer();
    await c.host.start();
    const { record, words } = await pairUp(c);
    expect(words).toHaveLength(4);
    expect(c.shown).toEqual([words]);
    expect(record.computerName).toBe("Studio");
    expect(c.registry.added).toHaveLength(1);
    expect(c.registry.added[0]!.device).toMatchObject({ id: record.device, name: "Test browser", kind: "browser", runsCore: false });
    expect(c.registry.added[0]!.proof).toEqual({ via: "code", card: "card-1" });
    expect((await c.store.list()).map((p) => p.pair)).toEqual([record.pair]);
    c.host.stop();
  }, 30_000);

  test("then connects over WebRTC: requests, notifications and streams both ways", async () => {
    const c = computer();
    await c.host.start();
    const { record, b } = await pairUp(c);
    const connection = await b.connect(record);
    expect(await connection.link.request<unknown>("bot.list", {})).toEqual({ bots: [{ id: "alpha", name: "Alpha", mainSession: "s_alpha" }] });

    const events: unknown[] = [];
    connection.link.onNotify("event", (e) => events.push(e));
    await connection.link.request("session.send", { id: "s_alpha", message: { text: "hello from the web", clientMessageId: "m1" } });
    for (let i = 0; i < 100 && events.length === 0; i++) await Bun.sleep(10);
    expect(events).toEqual([{ type: "user_message", sessionId: "s_alpha", text: "hello from the web" }]);

    // A stream from the page: 1 MB in chunks, received whole on the computer.
    const computerLink = c.links.at(-1)!;
    const received = new Promise<number>((resolve) => {
      computerLink.onStream("upload", (stream) => {
        let total = 0;
        stream.onData((chunk) => (total += chunk.length));
        stream.onEnd(() => resolve(total));
      });
    });
    const upload = connection.link.openStream("upload", "files", { name: "notes.txt" });
    for (let i = 0; i < 16; i++) await upload.write(new Uint8Array(64 * 1024).fill(i));
    upload.end();
    expect(await received).toBe(16 * 64 * 1024);

    await expect(connection.link.request("nope", {})).rejects.toMatchObject({ code: "not_found" });
    connection.close();
    c.host.stop();
  }, 30_000);

  test("a refusal on the computer refuses the browser; nothing is kept", async () => {
    const c = computer({ confirm: false });
    await c.host.start();
    const err = await pairUp(c).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PairingError);
    expect((err as PairingError).code).toBe("refused");
    expect(c.registry.added).toEqual([]);
    expect(await c.store.list()).toEqual([]);
    c.host.stop();
  }, 30_000);

  test("an invite works once; a wrong code is refused", async () => {
    const c = computer();
    await c.host.start();
    const first = await invite(c);
    await browser().pair(first, { onWords: () => undefined });
    const again = await browser()
      .pair(first, { onWords: () => undefined, timeoutMs: 5000 })
      .catch((e: unknown) => e);
    expect(again).toBeInstanceOf(Error);

    const tampered = { ...(await invite(c)), code: "000000" };
    const wrong = await browser()
      .pair(tampered, { onWords: () => undefined })
      .catch((e: unknown) => e);
    expect((wrong as PairingError).code).toBe("code");
    c.host.stop();
  }, 30_000);

  test("a restarted computer answers the browsers it already paired", async () => {
    const store = new MemoryPairStore();
    const first = computer({ store });
    await first.host.start();
    const { record, b } = await pairUp(first);
    first.host.stop();
    const second = computer({ store });
    await second.host.start();
    const connection = await b.connect(record);
    expect(await connection.link.request<unknown>("bot.list", {})).toMatchObject({ bots: [{ id: "alpha" }] });
    connection.close();
    second.host.stop();
  }, 30_000);

  test("revoking the browser ends its pairing on both ends; forgetting on the page ends it on the computer", async () => {
    const c = computer();
    await c.host.start();
    const { record, b } = await pairUp(c);
    const connection = await b.connect(record);
    const closed = new Promise((resolve) => connection.link.onClose(resolve));
    c.registry.revoke(record.device);
    await closed;
    for (let i = 0; i < 100 && (await c.store.list()).length > 0; i++) await Bun.sleep(10);
    expect(await c.store.list()).toEqual([]);
    await expect(b.connect(record, { timeoutMs: 3000 })).rejects.toBeInstanceOf(PairingError);

    const other = await pairUp(c);
    await other.b.forget(other.record);
    for (let i = 0; i < 200 && (await c.store.list()).length > 0; i++) await Bun.sleep(10);
    expect(await c.store.list()).toEqual([]);
    expect(await other.b.paired()).toEqual([]);
    connection.close();
    c.host.stop();
  }, 30_000);
});
