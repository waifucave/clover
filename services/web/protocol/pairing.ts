// How a browser pairs with a computer once, without an account (spec §8.1, §8.4), through the waifucave handshake.
// Both ends use this file: the page (services/web/src) and the computer (clover/companion-web).
//
// 1. The computer makes an invite: a pair P1 registered with its own key A and an invite key B0 derived from a fresh
//    32-byte secret S0, and a URL whose fragment carries P1, A, S0 and the core's pairing code. The fragment never
//    reaches a server, so the handshake never learns S0.
// 2. The page derives B0 and P1's box secret from S0, makes its own non-extractable key B and an X25519 key, picks
//    the lasting pair's id P2, and asks over P1: `pair-request` {P2, B, its X25519 key, its signature over P2's pair
//    statement with A, the code}.
// 3. The computer answers `pair-words` with its X25519 key. Both now hold the same transcript and ECDH secret, and
//    show the same four words; the person compares them, and confirms on the computer (a sealed card).
// 4. The computer registers P2 = [A, B] with both signatures, answers `paired`, and ends P1. P2's pair secret comes
//    from the ECDH secret and S0, so a copy of the URL alone can't read P2's boxes.
//
// What crosses P1 is sealed with P1's box key (the handshake's pair-scope boxes), so the service sees only sizes.

import { b64u, concatBytes, fromB64u, sha256, utf8 } from "../../shared/encoding";
import { pairStatement, signerFromSeed, type Signer } from "@waifucave/clover-service-handshake/client";
import { isStrictX25519PublicKey } from "../../shared/x25519-strict";
import { EFF_SHORT_WORDLIST } from "./words";

// ---- invites ----

export interface Invite {
  /** The invite pair P1. */
  pair: string;
  /** The computer's pair key A, which it keeps for the lasting pair too. */
  computerKey: string;
  /** S0: 32 bytes. */
  secret: Uint8Array;
  /** The core's pairing code, which the computer checks. */
  code: string;
  expiresAt: number;
  /** The computer's name, to show while pairing. */
  name?: string;
  /** The handshake's origin, when it isn't the page's default (local emulators). */
  handshake?: string;
}

export const INVITE_PARAM = "pair";

export function inviteUrl(webOrigin: string, invite: Invite): string {
  const payload = {
    v: 1,
    p: invite.pair,
    k: invite.computerKey,
    s: b64u(invite.secret),
    c: invite.code,
    e: invite.expiresAt,
    ...(invite.name ? { n: invite.name } : {}),
    ...(invite.handshake ? { h: invite.handshake } : {}),
  };
  return `${webOrigin.replace(/\/$/, "")}/#${INVITE_PARAM}=${b64u(utf8(JSON.stringify(payload)))}`;
}

/** The invite in a page URL's fragment, or null when there is none or it is malformed. */
export function readInvite(hash: string): Invite | null {
  const match = new RegExp(`(?:^#|&)${INVITE_PARAM}=([A-Za-z0-9_-]{1,2048})(?:&|$)`).exec(hash);
  if (!match) return null;
  try {
    const raw = JSON.parse(new TextDecoder().decode(fromB64u(match[1]!))) as Record<string, unknown>;
    if (raw.v !== 1) return null;
    const { p, k, s, c, e, n, h } = raw;
    if (typeof p !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(p)) return null;
    if (typeof k !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(k)) return null;
    if (typeof s !== "string" || typeof c !== "string" || c.length === 0 || c.length > 128 || typeof e !== "number") return null;
    const secret = fromB64u(s);
    if (secret.length !== 32) return null;
    return {
      pair: p,
      computerKey: k,
      secret,
      code: c,
      expiresAt: e,
      ...(typeof n === "string" && n.length <= 63 ? { name: n } : {}),
      ...(typeof h === "string" && h.length <= 256 ? { handshake: h } : {}),
    };
  } catch {
    return null;
  }
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, length = 32): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, info: utf8(info) }, key, length * 8));
}

/** The invite key B0, which both ends can sign with (the computer when it registers P1, the page on P1). */
export async function inviteSigner(invite: Pick<Invite, "pair" | "secret">): Promise<Signer> {
  return signerFromSeed(await hkdf(invite.secret, fromB64u(invite.pair), "clover web invite key"));
}

/** P1's pair secret, for its boxes. */
export function invitePairSecret(invite: Pick<Invite, "pair" | "secret">): Promise<Uint8Array> {
  return hkdf(invite.secret, fromB64u(invite.pair), "clover web invite secret");
}

// ---- the exchange ----

export interface PairRequest {
  v: 1;
  at: number;
  type: "pair-request";
  /** P2. */
  pair: string;
  /** The browser's lasting key B. */
  key: string;
  /** The browser's X25519 public key, raw, base64url. */
  x25519: string;
  /** B's signature over pairStatement(P2, A, B, t). */
  t: number;
  sig: string;
  code: string;
  /** What the browser calls itself ("Firefox on Linux"). */
  name: string;
}

export interface PairWords {
  v: 1;
  at: number;
  type: "pair-words";
  x25519: string;
}

export interface Paired {
  v: 1;
  at: number;
  type: "paired";
  pair: string;
  /** The computer's name. */
  name: string;
  /** The browser's device id at the computer (deviceIdFor B). */
  device: string;
}

export interface PairRefused {
  v: 1;
  at: number;
  type: "pair-refused";
  reason: "denied" | "expired" | "code" | "failed";
}

export type PairingMessage = PairRequest | PairWords | Paired | PairRefused;

export function isPairingMessage(value: Record<string, unknown>): value is PairingMessage & Record<string, unknown> {
  return value.v === 1 && typeof value.type === "string" && ["pair-request", "pair-words", "paired", "pair-refused"].includes(value.type);
}

export interface Transcript {
  invitePair: string;
  pair: string;
  computerKey: string;
  browserKey: string;
  computerX25519: string;
  browserX25519: string;
  code: string;
}

function transcriptBytes(t: Transcript): Uint8Array {
  return utf8(["clover web pairing v1", t.invitePair, t.pair, t.computerKey, t.browserKey, t.computerX25519, t.browserX25519, t.code].join("\n"));
}

export async function generateX25519(): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  return { publicKey: b64u(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)), privateKey: pair.privateKey };
}

/**
 * The lasting pair's secret and the four words, from this end's X25519 private key and the other end's public key.
 * Both ends get the same values from the same transcript.
 */
export async function pairingResult(
  own: CryptoKey,
  theirs: string,
  transcript: Transcript,
  inviteSecret: Uint8Array,
): Promise<{ secret: Uint8Array; words: string[] }> {
  const raw = fromB64u(theirs);
  if (!isStrictX25519PublicKey(raw)) throw new Error("not a usable X25519 key");
  const peer = await crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "X25519" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peer } as unknown as AlgorithmIdentifier, own, 256));
  if (shared.every((b) => b === 0)) throw new Error("not a usable X25519 key");
  const bytes = transcriptBytes(transcript);
  const digest = await sha256(bytes);
  const secret = await hkdf(concatBytes(shared, inviteSecret), digest, "clover web pair secret");
  shared.fill(0);
  const macKey = await crypto.subtle.importKey("raw", secret as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", macKey, concatBytes(utf8("clover web words v1"), bytes)));
  return { secret, words: wordsFrom(mac) };
}

/** Four words from the first 5 bytes, as base-1296 digits, most significant first (as the iOS app's pairing words). */
export function wordsFrom(mac: Uint8Array): string[] {
  let value = 0n;
  for (const byte of mac.subarray(0, 5)) value = (value << 8n) | BigInt(byte);
  const out: string[] = [];
  for (let i = 3; i >= 0; i--) out.push(EFF_SHORT_WORDLIST[Number((value / 1296n ** BigInt(i)) % 1296n)]!);
  return out;
}

/** What B signs, and A signs when it registers P2. */
export function lastingPairStatement(pair: string, computerKey: string, browserKey: string, t: number): string {
  return pairStatement(pair, computerKey, browserKey, t);
}

// ---- device ids ----

/** A device id: lowercase base32 of the first 20 bytes of SHA-256 over the public key (lane B's `deviceIdFor`). */
export async function deviceIdFor(publicKey: Uint8Array): Promise<string> {
  const digest = (await sha256(publicKey)).slice(0, 20);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
