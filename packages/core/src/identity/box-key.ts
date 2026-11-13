// This device's X25519 key for the handshake's account-scope boxes (services/handshake/PROTOCOL.md, "Boxes": HPKE
// base mode, single shot, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, the forwarder's suite). Every
// account device lists its public half with the account service, and the registry keeps the others'
// (`FileDeviceRegistry.boxKey`). The private scalar is a device item: it never syncs.
//
// HPKE here is RFC 9180's base mode on node:crypto; tests check it against the forwarder plugin's WebCrypto one.
import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, type KeyObject } from "node:crypto";
import { ContractError } from "../contracts/common";
import type { SecretRef, SecretStore } from "../contracts/secret-store";
import { type Bytes, concat, fromBase64, fromBase64Url, own, toBase64, toBase64Url, utf8 } from "./bytes";
import { isStrictX25519PublicKey } from "./x25519-strict";

export const BOX_KEY_REF: SecretRef = { owner: { kind: "device" }, name: "device:box-key" };
export const HANDSHAKE_BOX_INFO = "clover handshake v1 box";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export class BoxKey {
  readonly publicKey: Bytes;
  readonly #private: KeyObject;

  private constructor(priv: KeyObject) {
    this.#private = priv;
    const spki = createPublicKey(priv).export({ format: "der", type: "spki" }) as Buffer;
    this.publicKey = own(spki.subarray(SPKI_PREFIX.length));
  }

  static async loadOrCreate(store: Pick<SecretStore, "get" | "set">): Promise<BoxKey> {
    const stored = await store.get(BOX_KEY_REF);
    if (stored) {
      const raw = fromBase64(stored.value.reveal());
      if (!raw || raw.length !== 32) throw new ContractError("invalid", "the stored box key isn't an X25519 key");
      return new BoxKey(createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" }));
    }
    const { privateKey } = generateKeyPairSync("x25519");
    const raw = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(PKCS8_PREFIX.length);
    await store.set(BOX_KEY_REF, toBase64(raw), { synced: false });
    return new BoxKey(privateKey);
  }

  static generate(): BoxKey {
    return new BoxKey(generateKeyPairSync("x25519").privateKey);
  }

  get publicKeyBase64Url(): string {
    return toBase64Url(this.publicKey);
  }

  /** OpenBase, single shot. Undefined for a box that doesn't open. */
  open(box: string, aad: Uint8Array, info = HANDSHAKE_BOX_INFO): Bytes | undefined {
    const bytes = fromBase64Url(box);
    if (!bytes || bytes.length < 32 + 16) return undefined;
    try {
      const enc = bytes.subarray(0, 32);
      if (!isStrictX25519PublicKey(enc)) return undefined;
      const dh = diffieHellman({ privateKey: this.#private, publicKey: x25519Public(enc) });
      if (dh.every((b) => b === 0)) return undefined;
      const shared = extractAndExpand(dh, concat(enc, this.publicKey));
      const { key, nonce } = keySchedule(shared, utf8(info));
      return aesGcm(false, key, nonce, aad, bytes.subarray(32));
    } catch {
      return undefined;
    }
  }

  toJSON(): string {
    return "[x25519 key]";
  }
}

/** SealBase, single shot, to a device's X25519 public key: base64url of `enc (32) || ciphertext`. */
export function sealToBoxKey(recipient: Uint8Array, aad: Uint8Array, plaintext: Uint8Array, info = HANDSHAKE_BOX_INFO): string {
  if (recipient.length !== 32) throw new ContractError("invalid", "an X25519 key is 32 bytes");
  if (!isStrictX25519PublicKey(recipient)) throw new ContractError("invalid", "not a usable X25519 key");
  const eph = generateKeyPairSync("x25519");
  const enc = own((createPublicKey(eph.privateKey).export({ format: "der", type: "spki" }) as Buffer).subarray(SPKI_PREFIX.length));
  const dh = diffieHellman({ privateKey: eph.privateKey, publicKey: x25519Public(recipient) });
  if (dh.every((b) => b === 0)) throw new ContractError("invalid", "not a usable X25519 key");
  const shared = extractAndExpand(dh, concat(enc, recipient));
  const { key, nonce } = keySchedule(shared, utf8(info));
  return toBase64Url(concat(enc, aesGcm(true, key, nonce, aad, plaintext)));
}

function x25519Public(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw)]), format: "der", type: "spki" });
}

// ---- RFC 9180, suite 0x0020 / 0x0001 / 0x0002 ----

const HPKE_V1 = utf8("HPKE-v1");
const KEM_SUITE = concat(utf8("KEM"), Uint8Array.of(0x00, 0x20));
const HPKE_SUITE = concat(utf8("HPKE"), Uint8Array.of(0x00, 0x20, 0x00, 0x01, 0x00, 0x02));

function hmac(key: Uint8Array, data: Uint8Array): Bytes {
  return own(new Uint8Array(createHmac("sha256", key.length === 0 ? new Uint8Array(32) : key).update(data).digest()));
}

function expand(prk: Uint8Array, info: Uint8Array, length: number): Bytes {
  const out = new Uint8Array(length);
  let prev: Uint8Array = new Uint8Array(0);
  for (let i = 1, at = 0; at < length; i++, at += 32) {
    prev = hmac(prk, concat(prev, info, Uint8Array.of(i)));
    out.set(prev.subarray(0, Math.min(32, length - at)), at);
  }
  return own(out);
}

const labeledExtract = (suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) => hmac(salt, concat(HPKE_V1, suite, utf8(label), ikm));
const labeledExpand = (suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number) =>
  expand(prk, concat(Uint8Array.of(length >> 8, length & 0xff), HPKE_V1, suite, utf8(label), info), length);

function extractAndExpand(dh: Uint8Array, kemContext: Uint8Array): Bytes {
  return labeledExpand(KEM_SUITE, labeledExtract(KEM_SUITE, new Uint8Array(0), "eae_prk", dh), "shared_secret", kemContext, 32);
}

function keySchedule(shared: Uint8Array, info: Uint8Array): { key: Bytes; nonce: Bytes } {
  const empty = new Uint8Array(0);
  const context = concat(Uint8Array.of(0), labeledExtract(HPKE_SUITE, empty, "psk_id_hash", empty), labeledExtract(HPKE_SUITE, empty, "info_hash", info));
  const secret = labeledExtract(HPKE_SUITE, shared, "secret", empty);
  return { key: labeledExpand(HPKE_SUITE, secret, "key", context, 32), nonce: labeledExpand(HPKE_SUITE, secret, "base_nonce", context, 12) };
}

function aesGcm(seal: boolean, key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, data: Uint8Array): Bytes {
  if (seal) {
    const c = createCipheriv("aes-256-gcm", key, nonce);
    c.setAAD(aad);
    return concat(c.update(data), c.final(), c.getAuthTag());
  }
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(aad);
  d.setAuthTag(data.subarray(data.length - 16));
  return concat(d.update(data.subarray(0, data.length - 16)), d.final());
}
