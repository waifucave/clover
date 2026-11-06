// What the page and the computer share, checked in Bun: invites, the pairing derivations, and the link over data
// channels (node-datachannel on both ends, joined in-process).

import { afterAll, describe, expect, test } from "bun:test";
import { cleanup } from "node-datachannel";
import { RTCPeerConnection } from "node-datachannel/polyfill";

import { generateSigner, signText, verifyText } from "@waifucave/clover-service-handshake/client";
import {
  deviceIdFor,
  EFF_SHORT_WORDLIST,
  generateX25519,
  inviteUrl,
  inviteSigner,
  invitePairSecret,
  lastingPairStatement,
  holdMessages,
  LinkError,
  pairingResult,
  readInvite,
  RtcLink,
  wordsFrom,
} from "../protocol";
import type { ChannelLike } from "../protocol/rtc-link";

afterAll(() => cleanup());

const invite = {
  pair: "AAAAAAAAAAAAAAAAAAAAAA",
  computerKey: "B".repeat(43),
  secret: new Uint8Array(32).fill(7),
  code: "481516",
  expiresAt: 1_800_000_000_000,
  name: "Studio",
};

describe("invites", () => {
  test("round-trip through the URL fragment; malformed ones are refused", () => {
    const url = inviteUrl("https://clover.waifucave.com/", invite);
    expect(url.startsWith("https://clover.waifucave.com/#pair=")).toBe(true);
    const back = readInvite(new URL(url).hash);
    expect(back).toEqual(invite);
    expect(readInvite("")).toBeNull();
    expect(readInvite("#pair=!!!")).toBeNull();
    expect(readInvite(`#pair=${btoa(JSON.stringify({ v: 2 }))}`)).toBeNull();
    const short = inviteUrl("https://x", { ...invite, secret: new Uint8Array(16) });
    expect(readInvite(new URL(short).hash)).toBeNull();
  });

  test("the invite key and P1's secret come from S0 alone, the same on both ends", async () => {
    const a = await inviteSigner(invite);
    const b = await inviteSigner({ pair: invite.pair, secret: new Uint8Array(invite.secret) });
    expect(a.key).toBe(b.key);
    const sig = await signText(a, "hello");
    expect(await verifyText(b.key, sig, "hello")).toBe(true);
    expect(await invitePairSecret(invite)).toEqual(await invitePairSecret(invite));
    expect(await invitePairSecret(invite)).not.toEqual(await invitePairSecret({ ...invite, pair: "AQAAAAAAAAAAAAAAAAAAAA" }));
  });
});

describe("the pairing exchange", () => {
  test("both ends reach the same secret and words; another transcript gives others", async () => {
    const computer = await generateX25519();
    const page = await generateX25519();
    const transcript = {
      invitePair: invite.pair,
      pair: "CCCCCCCCCCCCCCCCCCCCCC",
      computerKey: invite.computerKey,
      browserKey: "D".repeat(43),
      computerX25519: computer.publicKey,
      browserX25519: page.publicKey,
      code: invite.code,
    };
    const atComputer = await pairingResult(computer.privateKey, page.publicKey, transcript, invite.secret);
    const atPage = await pairingResult(page.privateKey, computer.publicKey, transcript, invite.secret);
    expect(atComputer.secret).toEqual(atPage.secret);
    expect(atComputer.words).toEqual(atPage.words);
    expect(atComputer.words.every((w) => EFF_SHORT_WORDLIST.includes(w))).toBe(true);
    const other = await pairingResult(page.privateKey, computer.publicKey, { ...transcript, code: "000000" }, invite.secret);
    expect(other.words).not.toEqual(atPage.words);
    expect(other.secret).not.toEqual(atPage.secret);
  });

  test("words are four base-1296 digits of the first five bytes, most significant first", () => {
    expect(EFF_SHORT_WORDLIST).toHaveLength(1296);
    expect(wordsFrom(new Uint8Array(32))).toEqual(["acid", "acid", "acid", "acid"]);
    // 1295 * 1296^0 = 0x00_0000_050f: the last digit only.
    expect(wordsFrom(new Uint8Array([0, 0, 0, 0x05, 0x0f, 0xff]))).toEqual(["acid", "acid", "acid", EFF_SHORT_WORDLIST[1295]!]);
  });

  test("the browser's statement signature checks out against the lasting pair statement", async () => {
    const { signer } = await generateSigner();
    const t = Date.now();
    const sig = await signText(signer, lastingPairStatement("CCCCCCCCCCCCCCCCCCCCCC", invite.computerKey, signer.key, t));
    expect(await verifyText(signer.key, sig, lastingPairStatement("CCCCCCCCCCCCCCCCCCCCCC", invite.computerKey, signer.key, t))).toBe(true);
    expect(await verifyText(signer.key, sig, lastingPairStatement("CCCCCCCCCCCCCCCCCCCCCC", invite.computerKey, signer.key, t + 1))).toBe(false);
  });

  test("device ids are lane B's: lowercase base32 of SHA-256's first 20 bytes", async () => {
    const id = await deviceIdFor(new Uint8Array(32));
    expect(id).toMatch(/^[a-z2-7]{32}$/);
    expect(await deviceIdFor(new Uint8Array(32))).toBe(id);
  });
});

/** Two node-datachannel peers joined in-process, and a link on each end. */
async function linkedPair(options: { computerFirst?: (computer: RtcLink) => void } = {}): Promise<{ page: RtcLink; computer: RtcLink }> {
  const a = new RTCPeerConnection({ iceServers: [] });
  const b = new RTCPeerConnection({ iceServers: [] });
  a.onicecandidate = (e) => void (e.candidate && b.addIceCandidate(e.candidate));
  b.onicecandidate = (e) => void (e.candidate && a.addIceCandidate(e.candidate));
  const control = a.createDataChannel("control") as unknown as ChannelLike;
  const tokens = a.createDataChannel("tokens") as unknown as ChannelLike;
  holdMessages(control);
  holdMessages(tokens);
  const remote = new Map<string, ChannelLike>();
  let computer: RtcLink | null = null;
  const both = new Promise<void>((resolve) => {
    b.ondatachannel = (e) => {
      const ch = e.channel as unknown as ChannelLike;
      if (computer) return computer.adoptChannel(ch);
      remote.set(ch.label, ch);
      if (remote.size === 2) resolve();
    };
  });
  const opened = (ch: ChannelLike) => new Promise<void>((resolve) => (ch.readyState === "open" ? resolve() : (ch.onopen = () => resolve())));
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription!);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription!);
  await Promise.all([opened(control), opened(tokens), both]);
  const makeComputer = () => new RtcLink({ peer: "page", pc: b as never, control: remote.get("control")!, tokens: remote.get("tokens")!, requestTimeoutMs: 2000 });
  if (options.computerFirst) {
    computer = makeComputer();
    options.computerFirst(computer);
    await Bun.sleep(100);
  }
  const page = new RtcLink({ peer: "computer", pc: a as never, control, tokens, requestTimeoutMs: 2000 });
  a.ondatachannel = (e) => page.adoptChannel(e.channel as unknown as ChannelLike);
  computer ??= makeComputer();
  return { page, computer };
}

describe("the link over data channels", () => {
  test("requests and answers, errors with their codes, notifications, at both priorities", async () => {
    const { page, computer } = await linkedPair();
    computer.handle("echo", (params) => params);
    computer.handle("refuse", () => {
      throw new LinkError("refused", "not from the web");
    });
    expect(await page.request<unknown>("echo", { a: 1 })).toEqual({ a: 1 });
    expect(page.view()).toMatchObject({ peer: "computer", up: true, path: "direct" });
    expect(await page.request<unknown>("echo", { b: 2 }, { priority: "tokens" })).toEqual({ b: 2 });
    await expect(page.request("refuse", {})).rejects.toMatchObject({ code: "refused", message: "not from the web" });
    await expect(page.request("missing", {})).rejects.toMatchObject({ code: "not_found" });

    const notes: unknown[] = [];
    page.onNotify("event", (p) => notes.push(p));
    computer.notify("event", { n: 1 });
    computer.notify("event", { n: 2 }, { priority: "tokens" });
    for (let i = 0; i < 100 && notes.length < 2; i++) await Bun.sleep(5);
    expect(notes).toEqual([{ n: 1 }, { n: 2 }]);
    page.close();
    computer.close();
  });

  test("streams carry chunks in order, with their metadata; aborts reach the other end", async () => {
    const { page, computer } = await linkedPair();
    const got = new Promise<{ meta: unknown; bytes: number; first: number; last: number }>((resolve) => {
      page.onStream("screenshot", (stream, meta) => {
        const chunks: Uint8Array[] = [];
        stream.onData((c) => chunks.push(c));
        stream.onEnd(() => {
          const all = chunks.reduce((n, c) => n + c.length, 0);
          resolve({ meta, bytes: all, first: chunks[0]![0]!, last: chunks.at(-1)!.at(-1)! });
        });
      });
    });
    const out = computer.openStream("screenshot", "screenshots", { width: 1280 });
    for (let i = 0; i < 8; i++) await out.write(new Uint8Array(300 * 1024).fill(i));
    out.end();
    expect(await got).toEqual({ meta: { width: 1280 }, bytes: 8 * 300 * 1024, first: 0, last: 7 });

    const aborted = new Promise<Error | undefined>((resolve) => page.onStream("file", (stream) => stream.onEnd(resolve)));
    const file = computer.openStream("file", "files");
    await file.write(new Uint8Array(10));
    file.abort("cancelled by the user");
    expect((await aborted)?.message).toBe("cancelled by the user");
    page.close();
    computer.close();
  });

  test("what arrives before this end's link exists waits for it, in order", async () => {
    let early: Promise<unknown> | null = null;
    const { page, computer } = await linkedPair({
      computerFirst: (c) => {
        early = c.request("hello", { from: "computer" });
        c.notify("event", { n: 1 });
      },
    });
    // Registered in the turn the link was made, as `adopt` does: the held request and notification reach them.
    page.handle("hello", (p) => ({ echo: p }));
    const notes: unknown[] = [];
    page.onNotify("event", (p) => notes.push(p));
    computer.notify("event", { n: 2 });
    expect(await early!).toEqual({ echo: { from: "computer" } });
    for (let i = 0; i < 100 && notes.length < 2; i++) await Bun.sleep(5);
    expect(notes).toEqual([{ n: 1 }, { n: 2 }]);
    page.close();
    computer.close();
  });

  test("a request in flight fails `offline` when the link closes, never hangs; a slow one times out", async () => {
    const { page, computer } = await linkedPair();
    computer.handle("slow", () => new Promise(() => undefined));
    await expect(page.request("slow", {}, { timeoutMs: 100 })).rejects.toMatchObject({ code: "timeout" });
    const pending = page.request("slow", {});
    page.close("gone");
    await expect(pending).rejects.toMatchObject({ code: "offline" });
    await expect(page.request("slow", {})).rejects.toMatchObject({ code: "offline" });
    computer.close();
  });
});
