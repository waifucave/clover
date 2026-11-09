// Contract: DeviceRegistry (spec §8.1 "Identity and accounts", §5.5 "Only sealed buttons answer", §9.1 computers).
// Owner: lane H.
//
// Every installation has its own Ed25519 key in the OS secret store. With a waifucave account, signing in is enough to
// add a device (the account is the root of trust); without one, devices pair by code or QR plus the 4-word check.
// Adding or revoking a device is a sensitive change: a sealed card, unless the user does it in their own terminal.
// Revoking a device cuts its links at once and starts a guided rotation of the keys already synced to it.
//
// The registry is also where signatures are checked: `verify` checks a device's link key, and `verifyAnswer` its app's
// answer key, and both refuse a revoked device.
//
// Who may answer another computer's card (the owner's decision on review N1): a phone, with its own answer key, or any
// desktop, with a key its app holds apart from the core's link key, so plugin code can't sign with it where the OS
// allows (a Keychain item limited to the signed app on macOS, a TPM-backed key on Windows; no holder ever prompts,
// `ANSWER_KEY_HOLDERS`). Answers verify only against the answer key, never a link key: no fallback. Where the OS
// can't (Linux, and Windows without a TPM), the owner accepted the risk: "any desktop may answer; a
// compromised plugin on a Windows or Linux computer could approve actions on other computers". A server, a cloud
// computer and a browser never sign: their only key is the core's, or they may answer no card (`mayAnswerCards`).
import type { AnswerKeyAlg, AnswerKeyHolder, DeviceKind, DeviceOs } from "@waifucave/clover-protocol";
import { isStrictEd25519Point, isStrictEd25519Signature } from "../identity/ed25519-strict";
import type { Unsubscribe } from "./common";

export interface DeviceRecord {
  id: string;
  name: string;
  kind: DeviceKind;
  /** A computer's OS, or a phone's `ios`. */
  os?: DeviceOs;
  /** Runs clover-core: a computer in the tree that can take over (§6.4, §9.1). */
  runsCore: boolean;
  /** Its folder-tree name, for a device that runs clover-core. */
  computer?: string;
  hasDisplay?: boolean;
  /** Its Ed25519 public key, raw 32 bytes, base64: the core's link key on a computer. */
  publicKey: string;
  /** A desktop's answer key: its app's key, apart from the core's, how the OS holds it, and its algorithm (`alg`,
   *  `ed25519` when absent): `p256` for a key in the Secure Enclave, the Android Keystore or a TPM (raw uncompressed point,
   *  65 bytes, base64), `ed25519` for one in software. Verification picks the algorithm from here, and the statement
   *  the app signs to register the key covers `alg` as it covers `held`, so a record can't be relabelled. A phone
   *  names its answer key here too: it never answers with its link key (`publicKey`), so a phone without one answers
   *  no card. */
  answerKey?: { publicKey: string; held: AnswerKeyHolder; alg?: AnswerKeyAlg };
  /** Its X25519 box key, raw 32 bytes as base64url (H-M1's ask), which account-scope boxes are sealed to (lane I's);
   *  absent until the device has published one. A revoked device's is never used. */
  boxKey?: string;
  addedAt: number;
  /** How it was added, from the core's own record. */
  addedBy: PairingProof["via"];
  revokedAt?: number;
  lastSeenAt?: number;
}

/** How a device was introduced. */
export type PairingProof =
  /** The waifucave account's handshake: signing in is enough (§8.1). */
  | { via: "account"; account: string }
  /** No account: a code or QR, confirmed by the 4-word check, then the user's sealed card. */
  | { via: "code"; card: string }
  /** The user added it in their own terminal (§5.1: no card). */
  | { via: "terminal" }
  /** This device itself, at install. */
  | { via: "self" };

export type DeviceChange = { type: "added" | "changed"; device: DeviceRecord } | { type: "revoked"; id: string; reason?: string };

export interface DeviceRegistry {
  self(): DeviceRecord;
  /** Devices still paired, this one included. */
  list(): DeviceRecord[];
  /** Revoked devices too, with `revokedAt`. */
  get(id: string): DeviceRecord | undefined;
  add(device: Omit<DeviceRecord, "addedAt" | "addedBy" | "revokedAt">, proof: PairingProof): Promise<DeviceRecord>;
  /** Cuts its links at once (§8.1). Refused for this device itself. */
  revoke(id: string, reason?: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  /** Whether `signature` is the device's Ed25519 signature over `data` with its link key; false for an unknown or
   *  revoked device. */
  verify(id: string, data: Uint8Array, signature: Uint8Array): Promise<boolean>;
  /** Whether `signature` is the device's card-answer signature over `data` (`answerKeyOf`); false for a device that
   *  may answer no card (`mayAnswerCards`). */
  verifyAnswer(id: string, data: Uint8Array, signature: Uint8Array): Promise<boolean>;
  watch(fn: (change: DeviceChange) => void): Unsubscribe;
}

/** The key a device signs card answers with: a phone's or a desktop's answer key, never its link key (no fallback),
 *  and none for anything else, a phone or desktop with no answer key, or a revoked device. */
export function answerKeyOf(d: Pick<DeviceRecord, "kind" | "publicKey" | "answerKey" | "revokedAt">): string | undefined {
  if (d.revokedAt !== undefined) return undefined;
  if (d.kind === "phone" || d.kind === "desktop") return d.answerKey?.publicKey;
  return undefined;
}

/** The one algorithm a holder's keys can have, where it has only one: the Secure Enclave makes only P-256 keys, so a
 *  record saying `secure-enclave` with an Ed25519 key is a mislabel and is refused (`invalid`, lane H's reviewer). */
export const HOLDER_ALGS: Readonly<Partial<Record<AnswerKeyHolder, AnswerKeyAlg>>> = { "secure-enclave": "p256" };

/** Whether an answer key's holder can hold a key of its algorithm (`alg` absent is `ed25519`). */
export function holderFitsAlg(held: AnswerKeyHolder, alg: AnswerKeyAlg | undefined): boolean {
  const only = HOLDER_ALGS[held];
  return only === undefined || only === (alg ?? "ed25519");
}

/** The algorithm of the key `answerKeyOf` gives: the answer key's (`ed25519` when absent). */
export function answerKeyAlgOf(d: Pick<DeviceRecord, "answerKey">): AnswerKeyAlg {
  return d.answerKey?.alg ?? "ed25519";
}

/** Checks a card-answer signature with the key's own algorithm (lanes H and I): Ed25519, or ECDSA P-256 over SHA-256
 *  with an `r‖s` signature. False for anything that doesn't verify or won't import. */
export async function verifyKeySignature(alg: AnswerKeyAlg, publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const raw = publicKey as Uint8Array<ArrayBuffer>;
    const sig = signature as Uint8Array<ArrayBuffer>;
    const msg = data as Uint8Array<ArrayBuffer>;
    if (alg === "p256") {
      const k = await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, sig, msg);
    }
    // Strict, as identity/keys.ts's: canonical points outside the small-order subgroup, S below the group order.
    if (!isStrictEd25519Point(raw) || !isStrictEd25519Signature(sig)) return false;
    const k = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, k, sig, msg);
  } catch {
    return false;
  }
}

/** Whether a device may answer another computer's card with a signature (the owner's decision on N1). */
export function mayAnswerCards(d: Pick<DeviceRecord, "kind" | "publicKey" | "answerKey" | "revokedAt">): boolean {
  return answerKeyOf(d) !== undefined;
}

/** A device id: lowercase base32 of the first 20 bytes of SHA-256 over its public key; lane H may choose another
 *  encoding within `DeviceId`'s `^[a-z0-9]{16,64}$`. */
export async function deviceIdFor(publicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey as Uint8Array<ArrayBuffer>)).slice(0, 20);
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
