// The pairing ceremony's crypto (spec §8.1: "a code or QR, plus the inherited 4-word check"). The inherited phone
// pairing did the same under its own domains; Clover's domains are its own, so no value from one can
// stand for the other.
//
// * The transcript binds everything the two devices agree on: the pairing, both link keys, both device records, both
//   per-pair signing keys, the registration time, the group and both sides' nonces. It is deterministic CBOR
//   (links/codec.ts).
// * Both sides' choices are fixed before either sees the other's in full (S2 of H-M1's review): the joiner sends a
//   commitment to its nonce in its hello, the host sends its nonce in the welcome, and only then does the joiner reveal
//   its nonce. The words and the pair secret cover both nonces, so whoever holds the pairing secret (a code seen over a
//   shoulder) can't grind its own keys until both legs of a relay show the same words, and the pair secret has the
//   nonces' 2 × 256 bits behind it, not only the short code's 80.
// * Each side proves it holds the pairing secret with an HMAC over the transcript, under its own domain, so the
//   joiner's proof can't be reflected back as the host's.
// * The four words are a third HMAC, under its own domain: the first 5 bytes, big-endian, read as four base-1296
//   digits into the EFF short wordlist (as the inherited pairing did). A device in the middle would have to make both legs' words
//   match without the secret, which a 40-bit check makes impractical in the minutes a pairing lives.
// * The pair secret S the handshake service's boxes are sealed with (services/handshake/PROTOCOL.md, "Boxes") and the
//   pair id are derived from the pairing secret and the transcript; neither ever reaches the service.
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { type Bytes, concat, constantTimeEqual, own, utf8 } from "./bytes";
import { encode } from "../links/codec";
import { EFF_SHORT_WORDLIST } from "./wordlist";

export const PAIR_PROOF_JOINER = "clover/pair-proof/joiner/1";
export const PAIR_PROOF_HOST = "clover/pair-proof/host/1";
export const PAIR_SAS = "clover/pair-sas/1";
const PAIR_SECRET_INFO = "clover/pair-secret/1";
const PAIR_ID_INFO = "clover/pair-id/1";

/** One side's part of the transcript, as it sent it. */
export interface PairSide {
  /** The device's link key, raw. */
  key: Uint8Array;
  /** Its device record, canonical (`canonicalRecord`). */
  record: Uint8Array;
  /** Its signing key for this pair, raw (item 81). */
  pairKey: Uint8Array;
  /** Its signing key for the group, raw. */
  groupKey: Uint8Array;
}

export const PAIR_NONCE_BYTES = 32;

/** The joiner's commitment to its nonce. */
export function nonceCommitment(nonce: Uint8Array): Bytes {
  return own(new Uint8Array(createHash("sha256").update(concat(utf8("clover/pair-commit/1"), nonce)).digest()));
}

/** What the joiner's proof covers: what the joiner knows before the host answers, its nonce's commitment included. */
export function joinerTranscript(pairingId: string, hostKey: Uint8Array, joiner: PairSide, commit: Uint8Array): Bytes {
  return own(encode(["clover/pair-transcript/joiner/2", pairingId, own(hostKey), sideArray(joiner), own(commit)]));
}

/** What the host's proof covers: the exchange up to the welcome, the host's nonce included. */
export function fullTranscript(joinerPart: Uint8Array, host: PairSide, extra: { t: number; group: string; nonce: Uint8Array }): Bytes {
  return own(encode(["clover/pair-transcript/2", own(joinerPart), sideArray(host), extra.t, extra.group, own(extra.nonce)]));
}

/** What the words and the pair secret cover: the whole exchange, with the joiner's revealed nonce. */
export function finalTranscript(full: Uint8Array, joinerNonce: Uint8Array): Bytes {
  return own(encode(["clover/pair-transcript/final/1", own(full), own(joinerNonce)]));
}

function sideArray(s: PairSide): unknown[] {
  return [own(s.key), own(s.record), own(s.pairKey), own(s.groupKey)];
}

export function pairProof(secret: Uint8Array, domain: string, transcript: Uint8Array): Bytes {
  return own(new Uint8Array(createHmac("sha256", secret).update(concat(utf8(domain), transcript)).digest()));
}

export function verifyPairProof(secret: Uint8Array, domain: string, transcript: Uint8Array, proof: Uint8Array): boolean {
  return constantTimeEqual(pairProof(secret, domain, transcript), proof);
}

/** The four words both devices show. */
export function sasWords(secret: Uint8Array, transcript: Uint8Array): string[] {
  const mac = pairProof(secret, PAIR_SAS, transcript);
  let value = 0n;
  for (let i = 0; i < 5; i++) value = (value << 8n) | BigInt(mac[i]!);
  const words: string[] = [];
  for (let i = 0; i < 4; i++) {
    words.push(EFF_SHORT_WORDLIST[Number(value % 1296n)]!);
    value /= 1296n;
  }
  return words;
}

/** The pair secret S for the handshake service's boxes: 32 bytes, from the pairing secret and the transcript. */
export function derivePairSecret(secret: Uint8Array, transcript: Uint8Array): Bytes {
  return own(new Uint8Array(hkdfSync("sha256", secret, createHash("sha256").update(transcript).digest(), utf8(PAIR_SECRET_INFO), 32)));
}

/** The pair's id at the handshake service: 16 bytes both devices derive alike. */
export function derivePairId(pairSecret: Uint8Array): Bytes {
  return own(new Uint8Array(hkdfSync("sha256", pairSecret, new Uint8Array(0), utf8(PAIR_ID_INFO), 16)));
}

/** A device record in the one form both sides hash. */
export function canonicalRecord(r: { id: string; name: string; kind: string; os?: string; runsCore: boolean; computer?: string; hasDisplay?: boolean; publicKey: string }): Bytes {
  return own(encode([r.id, r.name, r.kind, r.os ?? null, r.runsCore, r.computer ?? null, r.hasDisplay ?? null, r.publicKey]));
}
