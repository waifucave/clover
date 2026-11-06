// The page's logic where it needs no handshake: refusals before anything is sent, and giving up in time.

import { describe, expect, test } from "bun:test";

import { generateSigner } from "@waifucave/clover-service-handshake/client";
import { Companion, MemoryStore, PairingError, type PairRecord } from "../src/app";
import type { Invite, RtcEnvironment } from "../protocol";

const rtc: RtcEnvironment = {
  createPeerConnection: () => {
    throw new Error("no WebRTC in this test");
  },
  iceServers: [],
};

const invite: Invite = {
  pair: "AAAAAAAAAAAAAAAAAAAAAA",
  computerKey: "B".repeat(43),
  secret: new Uint8Array(32).fill(1),
  code: "123456",
  expiresAt: Date.now() + 60_000,
};

describe("the page's companion", () => {
  test("an expired invite, or one naming another handshake, is refused before anything is sent", async () => {
    let sent = 0;
    const companion = new Companion({
      store: new MemoryStore(),
      rtc,
      handshake: "https://handshake.waifucave.com",
      name: "Test",
      fetch: async () => {
        sent++;
        return new Response("{}");
      },
    });
    const expired = await companion.pair({ ...invite, expiresAt: Date.now() - 1 }, { onWords: () => undefined }).catch((e: unknown) => e);
    expect((expired as PairingError).code).toBe("expired");
    const elsewhere = await companion.pair({ ...invite, handshake: "https://evil.example" }, { onWords: () => undefined }).catch((e: unknown) => e);
    expect((elsewhere as PairingError).code).toBe("handshake");
    expect(sent).toBe(0);
  });

  test("connecting gives up in time when the handshake can't be reached", async () => {
    const { pair } = await generateSigner();
    const record: PairRecord = {
      pair: "CCCCCCCCCCCCCCCCCCCCCC",
      computerKey: "D".repeat(43),
      computerName: "Studio",
      device: "browser1",
      signer: pair,
      boxKey: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
      handshake: "http://127.0.0.1:1",
      pairedAt: Date.now(),
    };
    const companion = new Companion({ store: new MemoryStore(), rtc, handshake: "http://127.0.0.1:1", name: "Test" });
    const started = Date.now();
    const err = await companion.connect(record, { timeoutMs: 500 }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("offline");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
