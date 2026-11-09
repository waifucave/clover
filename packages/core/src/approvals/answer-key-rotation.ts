// Replacing this desktop's answer key (`answer-key-rotate`; #179's review, check 2): other computers trust the key with
// their cards, so a new one takes two things, in this order:
//   1. the current key's hand-over signature over the new one (`answerKeyRotateStatement`), and the new key's own
//      registration (`answerKeyStatement`), both checked before any card shows: a hand-over that doesn't verify is
//      refused without asking anyone;
//   2. the user's yes on a sealed `change` card bound to exactly this hand-over (rule 9: `device.answerKey.rotate` with
//      the device, both keys, the time and the algorithm), answered by anything but the key it replaces: a sealed
//      frame here, or another device's own answer key. Code holding the current key could sign the hand-over and a
//      card answer alike, so this device's own signed answer never counts for it.
// Then the device registry takes the key (`setOwnAnswerKey`, which checks both signatures again). The first key, and
// a key the registry already holds, never come here.
//
// What the card says comes from this table; the keys show as short fingerprints in a code field.
import { createHash } from "node:crypto";
import type { AnswerKeyHolder, TurnOrigin } from "@waifucave/clover-protocol";
import { boundCardRecord, callBindingOf, type ApprovalBroker, type CallRequestBinding } from "../contracts/approval-broker";
import type { DeviceRecord } from "../contracts/device-registry";
import { answerKeyRotateStatement, answerKeyStatement, type FileDeviceRegistry } from "../devices/registry";
import { type AnswerKeyAlg, answerKeyBytes, verifyKeySignature } from "../identity/keys";

/** The call the card binds. A binding only, never a method on the wire. */
export const ANSWER_KEY_ROTATE = "device.answerKey.rotate";

export const ANSWER_KEY_ROTATE_TEXT = {
  title: "Replace this computer's answer key",
  what: "Replace the key this computer answers cards with? Other computers take its answers with the new key from now on. Approve only if you asked for this here.",
  yes: "Replace the key",
  no: "Keep the current key",
} as const;

/** What the app hands over: the new key, where it is kept, its registration, and the current key's hand-over. */
export interface AnswerKeyRotationAsk {
  publicKey: string;
  held: AnswerKeyHolder;
  alg?: AnswerKeyAlg;
  /** The new key's signature over `answerKeyStatement`. */
  registration: Uint8Array;
  /** The current key's signature over `answerKeyRotateStatement(device, from, publicKey, at)`. */
  rotation: { from: string; at: number; signature: Uint8Array };
  /** Where the card came from: the user's own act in the app is `user`. */
  origin: TurnOrigin;
}

export type AnswerKeyRotationOutcome =
  | { ok: true; device: DeviceRecord }
  | { ok: false; why: AnswerKeyRotationRefusal };

export type AnswerKeyRotationRefusal =
  /** This device holds no answer key: the first one isn't a rotation (`setOwnAnswerKey` alone). */
  | "no-current-key"
  /** The new key is the one held. */
  | "same-key"
  /** `rotation.from` isn't the key held. */
  | "not-current"
  /** The hand-over or the registration doesn't verify. */
  | "bad-signature"
  /** The user said no, or the card expired, was withdrawn or cancelled. */
  | "not-approved"
  /** The card was answered with the very key it replaces. */
  | "own-key-answered"
  /** The registry refused it after the card (it changed meanwhile). */
  | "refused";

export interface AnswerKeyRotationOptions {
  broker: Pick<ApprovalBroker, "request" | "get" | "watch">;
  devices: Pick<FileDeviceRegistry, "self" | "setOwnAnswerKey">;
  /** This computer's name: the card is its. */
  computer: string;
  signal?: AbortSignal;
  /** Told the card's id once it shows, so a caller can answer `{ applied: false, card }` and wait for the rest. */
  onCard?: (cardId: string) => void;
}

const algOf = (k: object | undefined): AnswerKeyAlg => (k as { alg?: AnswerKeyAlg } | undefined)?.alg ?? "ed25519";

/** A key's short fingerprint: the first 16 bytes of SHA-256 over its bytes, in groups of four hex digits. */
export function answerKeyFingerprint(alg: AnswerKeyAlg, publicKey: string): string {
  const raw = answerKeyBytes(alg, publicKey);
  const hex = createHash("sha256").update(raw ?? publicKey).digest("hex").slice(0, 32);
  return hex.match(/.{4}/g)!.join(" ");
}

/** The binding the card seals: exactly this hand-over. */
export function answerKeyRotationBinding(computer: string, device: string, from: string, ask: Pick<AnswerKeyRotationAsk, "publicKey" | "held" | "alg" | "rotation">, fromAlg: AnswerKeyAlg): CallRequestBinding {
  return {
    computer, method: ANSWER_KEY_ROTATE,
    params: { device, from, fromAlg, to: ask.publicKey, toAlg: ask.alg ?? "ed25519", held: ask.held, at: ask.rotation.at },
  };
}

export async function rotateOwnAnswerKey(o: AnswerKeyRotationOptions, ask: AnswerKeyRotationAsk): Promise<AnswerKeyRotationOutcome> {
  const self = o.devices.self();
  const held = self.answerKey;
  if (!held) return { ok: false, why: "no-current-key" };
  if (held.publicKey === ask.publicKey) return { ok: false, why: "same-key" };
  if (ask.rotation.from !== held.publicKey) return { ok: false, why: "not-current" };
  const fromAlg = algOf(held);
  const toAlg = ask.alg ?? "ed25519";
  const current = answerKeyBytes(fromAlg, held.publicKey);
  const next = answerKeyBytes(toAlg, ask.publicKey);
  if (!current || !next) return { ok: false, why: "bad-signature" };
  if (!verifyKeySignature(fromAlg, current, answerKeyRotateStatement(self.id, held.publicKey, ask.publicKey, ask.rotation.at), ask.rotation.signature)) return { ok: false, why: "bad-signature" };
  if (!verifyKeySignature(toAlg, next, answerKeyStatement(self.id, ask.publicKey, ask.held, toAlg), ask.registration)) return { ok: false, why: "bad-signature" };

  const t = ANSWER_KEY_ROTATE_TEXT;
  const binds = answerKeyRotationBinding(o.computer, self.id, held.publicKey, ask, fromAlg);
  const sealed = callBindingOf(binds, (text) => createHash("sha256").update(text).digest("hex"));
  // Its card, as soon as the broker shows it (a change is always a card, rule 1).
  const off = o.onCard ? o.broker.watch((e) => {
    if (e.type !== "requested" || e.card.binds?.method !== sealed.method || e.card.binds.params !== sealed.params) return;
    off?.();
    o.onCard!(e.card.id);
  }) : undefined;
  const asked = o.broker.request({
    kind: "change", change: "answer-key-rotate", origin: ask.origin, computers: [o.computer], effect: "other",
    binds,
    fields: {
      title: { type: "text", text: t.title },
      what: { type: "text", text: t.what },
      detail: {
        type: "rows", rows: [
          { label: "Current key", value: answerKeyFingerprint(fromAlg, held.publicKey) },
          { label: "New key", value: answerKeyFingerprint(toAlg, ask.publicKey) },
          { label: "Kept in", value: ask.held },
        ],
      },
    },
    options: [{ id: "approve", kind: "approve", label: t.yes }, { id: "deny", kind: "deny", label: t.no }],
  }, o.signal ? { signal: o.signal } : {});
  const decision = await asked.finally(() => off?.());
  const record = boundCardRecord(o.broker, decision);
  if (!record || record.card.change !== "answer-key-rotate") return { ok: false, why: "not-approved" };
  // The key being replaced can't vouch for its own replacement.
  if (record.device === self.id) return { ok: false, why: "own-key-answered" };
  try {
    const device = await o.devices.setOwnAnswerKey(ask.publicKey, ask.held, ask.registration, ask.rotation, toAlg);
    return { ok: true, device };
  } catch {
    return { ok: false, why: "refused" };
  }
}
