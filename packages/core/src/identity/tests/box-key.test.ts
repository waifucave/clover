// The account-scope box (HPKE base mode, X25519 / HKDF-SHA256 / AES-256-GCM) against the forwarder plugin's WebCrypto
// HPKE, which checks itself against RFC 9180's vectors: each opens what the other sealed.
import { describe, expect, test } from "bun:test";
import { AEAD_AES_256_GCM, generateX25519, openBase, sealBase } from "../../../../../plugins/clover/plugins/forwarder/src/wire/hpke";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { BOX_KEY_REF, BoxKey, HANDSHAKE_BOX_INFO, sealToBoxKey } from "../box-key";
import { concat, fromBase64Url, toBase64Url, utf8 } from "../bytes";

describe("box key", () => {
  test("is a device item that survives a reload", async () => {
    const store = new MemorySecretStore();
    const a = await BoxKey.loadOrCreate(store);
    const b = await BoxKey.loadOrCreate(store);
    expect(b.publicKeyBase64Url).toBe(a.publicKeyBase64Url);
    expect((await store.list()).find((m) => m.ref.name === BOX_KEY_REF.name)?.synced).toBe(false);
    expect(JSON.stringify(a)).toBe('"[x25519 key]"');
  });

  test("opens what the forwarder's HPKE sealed, and the other way", async () => {
    const mine = BoxKey.generate();
    const aad = utf8("clover-handshake-v1 box\nsub\ndevA\ndevB\naddr\n7");
    const theirs = await sealBase(AEAD_AES_256_GCM, mine.publicKey, utf8(HANDSHAKE_BOX_INFO), aad, utf8("from webcrypto"));
    expect(new TextDecoder().decode(mine.open(toBase64Url(concat(theirs.enc, theirs.ciphertext)), aad)!)).toBe("from webcrypto");

    const recipient = await generateX25519();
    const box = fromBase64Url(sealToBoxKey(recipient.publicKey, aad, utf8("from node")))!;
    const plain = await openBase(AEAD_AES_256_GCM, recipient, box.subarray(0, 32), utf8(HANDSHAKE_BOX_INFO), aad, box.subarray(32));
    expect(new TextDecoder().decode(plain)).toBe("from node");
  });
});
