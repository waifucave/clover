// The forwarder's wire code: HPKE against RFC 9180's test vectors, the sealed envelope, the request record,
// the frames and the strict base64url they rely on.

import { describe, expect, test } from "bun:test";

import { b64u, concat, fromB64u, fromHex, fromUtf8, hex, readU64, u64, utf8 } from "../src/wire/bytes";
import {
  decodeRequestRecord,
  encodeRequestRecord,
  keyId,
  openEnvelope,
  readEnvelopeHeader,
  sealEnvelope,
  type DeviceKey,
} from "../src/wire/envelope";
import {
  AEAD_AES_128_GCM,
  aeadOpen,
  aeadSeal,
  decap,
  encap,
  generateX25519,
  keySchedule,
  nonceFor,
  x25519PublicKey,
} from "../src/wire/hpke";
import { decodeWebhookFrame, encodeWebhookFrame, hookKeyHash } from "../src/wire/protocol";

// RFC 9180, Appendix A.1.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode.
const A11 = {
  info: "4f6465206f6e2061204772656369616e2055726e",
  skEm: "52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736",
  pkEm: "37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431",
  skRm: "4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8",
  pkRm: "3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d",
  sharedSecret: "fe0e18c9f024ce43799ae393c7e8fe8fce9d218875e8227b0187c04e7d2ea1fc",
  key: "4531685d41d65f03dc48f6b8302c05b0",
  baseNonce: "56d890e5accaaf011cff4b7d",
  encryptions: [
    {
      seq: 0,
      aad: "436f756e742d30",
      nonce: "56d890e5accaaf011cff4b7d",
      ct: "f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a",
    },
    {
      seq: 1,
      aad: "436f756e742d31",
      nonce: "56d890e5accaaf011cff4b7c",
      ct: "af2d7e9ac9ae7e270f46ba1f975be53c09f8d875bdc8535458c2494e8a6eab251c03d0c22a56b8ca42c2063b84",
    },
    {
      seq: 255,
      aad: "436f756e742d323535",
      nonce: "56d890e5accaaf011cff4b82",
      ct: "7175db9717964058640a3a11fb9007941a5d1757fda1a6935c805c21af32505bf106deefec4a49ac38d71c9e0a",
    },
  ],
  pt: "4265617574792069732074727574682c20747275746820626561757479",
};

describe("HPKE (RFC 9180 A.1.1)", () => {
  test("derives the recipient's public key", async () => {
    expect(hex(await x25519PublicKey(fromHex(A11.skRm)))).toBe(A11.pkRm);
  });

  test("encapsulates to the vector's enc and shared secret", async () => {
    const { enc, sharedSecret } = await encap(fromHex(A11.pkRm), fromHex(A11.skEm));
    expect(hex(enc)).toBe(A11.pkEm);
    expect(hex(sharedSecret)).toBe(A11.sharedSecret);
  });

  test("decapsulates with the recipient's key", async () => {
    const shared = await decap(fromHex(A11.pkEm), { privateKey: fromHex(A11.skRm), publicKey: fromHex(A11.pkRm) });
    expect(hex(shared)).toBe(A11.sharedSecret);
  });

  test("runs the key schedule and seals the vector's messages", async () => {
    const ctx = await keySchedule(AEAD_AES_128_GCM, fromHex(A11.sharedSecret), fromHex(A11.info));
    expect(hex(ctx.key)).toBe(A11.key);
    expect(hex(ctx.baseNonce)).toBe(A11.baseNonce);
    for (const e of A11.encryptions) {
      const nonce = nonceFor(ctx, e.seq);
      expect(hex(nonce)).toBe(e.nonce);
      expect(hex(await aeadSeal(ctx.key, nonce, fromHex(e.aad), fromHex(A11.pt)))).toBe(e.ct);
      expect(hex(await aeadOpen(ctx.key, nonce, fromHex(e.aad), fromHex(e.ct)))).toBe(A11.pt);
    }
  });

  test("refuses an all-zero (small-order) public key", async () => {
    await expect(encap(new Uint8Array(32))).rejects.toThrow();
  });
});

async function deviceKey(): Promise<DeviceKey> {
  const pair = await generateX25519();
  return { ...pair, kid: await keyId(pair.publicKey) };
}

describe("the sealed envelope", () => {
  test("opens for each recipient and carries its clear header", async () => {
    const laptop = await deviceKey();
    const desktop = await deviceKey();
    const plaintext = utf8("the webhook");
    const envelope = await sealEnvelope({
      routineId: "deploy-alert",
      receivedAt: 1_793_000_000_123,
      recipients: [
        { kid: laptop.kid, publicKey: laptop.publicKey },
        { kid: desktop.kid, publicKey: desktop.publicKey },
      ],
      plaintext,
    });
    const header = readEnvelopeHeader(envelope);
    expect(header.routineId).toBe("deploy-alert");
    expect(header.receivedAt).toBe(1_793_000_000_123);
    expect(header.kids.map(hex)).toEqual([hex(laptop.kid), hex(desktop.kid)]);
    for (const key of [laptop, desktop]) {
      const opened = await openEnvelope(envelope, key);
      expect(fromUtf8(opened.plaintext)).toBe("the webhook");
      expect(hex(opened.header.pid)).toBe(hex(header.pid));
    }
  });

  test("does not open for a key it was not sealed to", async () => {
    const laptop = await deviceKey();
    const stranger = await deviceKey();
    const envelope = await sealEnvelope({ routineId: "r", receivedAt: 1, recipients: [laptop], plaintext: utf8("x") });
    await expect(openEnvelope(envelope, stranger)).rejects.toThrow("not sealed for this key");
    // Claiming the recipient's key id without its private key fails too.
    await expect(openEnvelope(envelope, { ...stranger, kid: laptop.kid })).rejects.toThrow();
  });

  test("any changed byte, in the header or the ciphertext, stops it opening", async () => {
    const laptop = await deviceKey();
    const envelope = await sealEnvelope({ routineId: "routine-1", receivedAt: 42, recipients: [laptop], plaintext: utf8("payload") });
    // Positions: the routine id, the arrival time, the pid, the recipient's wrapped key, the nonce, the ciphertext.
    const idStart = 2;
    const receivedAt = idStart + "routine-1".length + 7;
    const pid = receivedAt + 5;
    const wrapped = pid + 16 + 1 + 8 + 32 + 4;
    for (const position of [idStart, receivedAt, pid, wrapped, envelope.length - 20, envelope.length - 1]) {
      const tampered = envelope.slice();
      tampered[position]! ^= 0x01;
      await expect(openEnvelope(tampered, laptop)).rejects.toThrow();
    }
  });

  test("refuses bad routine ids, recipient counts and versions", async () => {
    const laptop = await deviceKey();
    await expect(sealEnvelope({ routineId: "has space", receivedAt: 1, recipients: [laptop], plaintext: utf8("x") })).rejects.toThrow();
    await expect(sealEnvelope({ routineId: "r", receivedAt: 1, recipients: [], plaintext: utf8("x") })).rejects.toThrow();
    const envelope = await sealEnvelope({ routineId: "r", receivedAt: 1, recipients: [laptop], plaintext: utf8("x") });
    const future = envelope.slice();
    future[0] = 2;
    expect(() => readEnvelopeHeader(future)).toThrow("unknown version");
    expect(() => readEnvelopeHeader(envelope.subarray(0, 20))).toThrow("truncated");
  });

  test("seals large and empty payloads", async () => {
    const laptop = await deviceKey();
    for (const size of [0, 1, 1024 * 1024]) {
      const plaintext = new Uint8Array(size).map((_, i) => i % 251);
      const envelope = await sealEnvelope({ routineId: "r", receivedAt: 1, recipients: [laptop], plaintext });
      const opened = await openEnvelope(envelope, laptop);
      expect(opened.plaintext.length).toBe(size);
      expect(hex(opened.plaintext.subarray(0, 16))).toBe(hex(plaintext.subarray(0, 16)));
    }
  });
});

describe("the request record", () => {
  test("round-trips a webhook request", () => {
    const record = encodeRequestRecord({
      method: "POST",
      query: "a=1&b=two",
      headers: [
        ["content-type", "application/json"],
        ["x-github-event", "push"],
      ],
      ip: "203.0.113.7",
      body: utf8('{"ok":true}'),
    });
    const back = decodeRequestRecord(record);
    expect(back).toEqual({
      method: "POST",
      query: "a=1&b=two",
      headers: [
        ["content-type", "application/json"],
        ["x-github-event", "push"],
      ],
      ip: "203.0.113.7",
      body: utf8('{"ok":true}'),
    });
  });

  test("refuses malformed records", () => {
    expect(() => decodeRequestRecord(new Uint8Array(2))).toThrow();
    expect(() => decodeRequestRecord(concat(u64(0).subarray(4), utf8("")))).toThrow();
    const bad = utf8(JSON.stringify({ v: 1, m: "POST", q: "", h: [["only-name"]] }));
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, bad.length);
    expect(() => decodeRequestRecord(concat(length, bad))).toThrow("bad header");
  });
});

describe("frames and encodings", () => {
  test("a webhook frame carries its sequence number and envelope", () => {
    const frame = encodeWebhookFrame(1_793_000_000_123_456, utf8("envelope"));
    const { seq, envelope } = decodeWebhookFrame(frame);
    expect(seq).toBe(1_793_000_000_123_456);
    expect(fromUtf8(envelope)).toBe("envelope");
    expect(() => decodeWebhookFrame(utf8("not a frame"))).toThrow();
  });

  test("u64 keeps sequence numbers exact up to 2^53", () => {
    for (const n of [0, 1, 255, 256, 2 ** 32 + 5, Number.MAX_SAFE_INTEGER]) expect(readU64(u64(n), 0)).toBe(n);
    expect(() => u64(-1)).toThrow();
  });

  test("base64url is strict", () => {
    expect(b64u(utf8("hi?"))).toBe("aGk_");
    expect(fromUtf8(fromB64u("aGk_"))).toBe("hi?");
    for (const bad of ["aGk/", "aGk=", "a", "aGk_ ", "aGl"]) expect(() => fromB64u(bad)).toThrow();
  });

  test("a routine's key hash is domain-separated SHA-256", async () => {
    const hash = await hookKeyHash("k".repeat(43));
    expect(hash.length).toBe(32);
    expect(hex(hash)).not.toBe(hex(await hookKeyHash("k".repeat(42))));
  });
});
