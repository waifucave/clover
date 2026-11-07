// A desktop's answer key (item 91; the owner's decision on review N1): the key a desktop signs card answers for other
// computers with, held by the app apart from the core's link key, so plugin code (which runs beside the core, never in
// the app's main process) can't sign with it where the OS allows:
// * macOS: a Keychain item only the signed app can read (`app-keychain`; Electron's safeStorage key is one), or else a
//   plain Keychain item (`keychain`);
// * Windows: a TPM key (`tpm`), or else a DPAPI blob in the current user's scope (`dpapi`);
// * Linux: an item in the Secret Service (`secret-service`);
// * otherwise the key is kept as well as the OS lets the app, and is marked `none`.
// The owner accepted that a compromised plugin on Windows or Linux could approve actions on other computers.
//
// Nothing here ever asks for Face ID, Touch ID, Windows Hello, a passcode or any other presence check (the owner's
// decision): a key is protected by where it is stored, and using it never prompts (no `userPresence`, biometry or
// passcode access control, no DPAPI prompt flag, no user-auth policy on the TPM key). `held` says where it is stored.
//
// This module is for the app's main process (lane E): it makes or loads the key through storage the app provides,
// proves it to the core (`registration`, which `FileDeviceRegistry.setOwnAnswerKey` checks), and signs answers.
// Receivers rebuild the card and compare hashes before they check the signature (`verifySignedAnswer`).
import type { AnswerKeyHolder, Os } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import type { Secret } from "../contracts/secret-store";
import { cardAnswerSigningInput, userMessageHashInput, userMessageSigningInput } from "@waifucave/clover-protocol";
import { createHash } from "node:crypto";
import { fromBase64, toBase64, utf8 } from "./bytes";
import { type Ed25519Key, ed25519FromSeed, generateEd25519 } from "./keys";

/** What the OS offers the app to keep a key from other code on the same computer. */
export interface AnswerKeyProtections {
  /** macOS: a Keychain item whose access list names only the signed app. */
  appKeychain?: boolean;
  /** macOS: a Keychain item, with no `userPresence` access control. */
  keychain?: boolean;
  /** Windows: the TPM can hold it, with no user-auth policy. */
  tpm?: boolean;
  /** Windows: DPAPI in the current user's scope, without the prompt flag. */
  dpapi?: boolean;
  /** Linux: the session's Secret Service, unlocked. */
  secretService?: boolean;
}

/** How the key will be held, from the OS and what it offers; `none` when nothing keeps plugin code from it. */
export function answerKeyHolder(os: Os, can: AnswerKeyProtections): AnswerKeyHolder {
  if (os === "macos" && can.appKeychain) return "app-keychain";
  if (os === "macos" && can.keychain) return "keychain";
  // Never `hello`: a Windows Hello credential prompts, and nothing in Clover prompts (the owner's decision).
  if (os === "windows" && can.tpm) return "tpm";
  if (os === "windows" && can.dpapi) return "dpapi";
  if (os === "linux" && can.secretService) return "secret-service";
  return "none";
}

/** Where the app keeps the key's seed: its Keychain item, its TPM- or DPAPI-wrapped blob, its Secret Service item, or (for `none`) a file the
 *  app alone writes. The seed passes through here only as a `Secret`. */
export interface AnswerKeyStorage {
  load(): Promise<Secret | null>;
  save(seed: Secret): Promise<void>;
}

export class AnswerKey {
  readonly held: AnswerKeyHolder;
  readonly #key: Ed25519Key;

  private constructor(key: Ed25519Key, held: AnswerKeyHolder) {
    this.#key = key;
    this.held = held;
  }

  static async loadOrCreate(storage: AnswerKeyStorage, held: AnswerKeyHolder): Promise<AnswerKey> {
    const stored = await storage.load();
    if (stored) {
      const seed = fromBase64(stored.reveal());
      if (!seed || seed.length !== 32) throw new ContractError("invalid", "the stored answer key isn't an Ed25519 seed");
      return new AnswerKey(ed25519FromSeed(seed), held);
    }
    const key = generateEd25519();
    await storage.save(key.seed());
    return new AnswerKey(key, held);
  }

  get publicKey(): string {
    return toBase64(this.#key.publicKey);
  }

  /** What the app hands the core so it takes the key: the public half, how it is held, and the proof. */
  registration(deviceId: string): { publicKey: string; held: AnswerKeyHolder; signature: string } {
    const statement = utf8(`clover/answer-key/1\n${deviceId}\n${this.publicKey}\n${this.held}`);
    return { publicKey: this.publicKey, held: this.held, signature: toBase64(this.#key.sign(statement)) };
  }

  /** Hands this device's answering over to `next` (a new key, a new holder): this key signs the hand-over, which the
   *  core and every peer need before they take `next` (`answerKeyRotateStatement`). */
  handOverTo(next: AnswerKey, deviceId: string, at: number): { from: string; at: number; signature: string } {
    const statement = utf8(`clover/answer-key-rotate/1\n${deviceId}\n${this.publicKey}\n${next.publicKey}\n${at}`);
    return { from: this.publicKey, at, signature: toBase64(this.#key.sign(statement)) };
  }

  /** Signs the user's answer to a card, for any computer to verify (`cardAnswerSigningInput`). */
  signAnswer(a: { id: string; hash: string; option: string; at: number; children?: readonly string[] }): string {
    return toBase64(this.#key.sign(utf8(cardAnswerSigningInput(a))));
  }

  /** Signs a user's message for a relay to the computer running its bot (`userMessageSigningInput`, review N3). */
  signUserMessage(m: { session: string; clientMessageId: string; text: string; images?: { n: number; path: string }[]; files?: { n: number; path: string }[]; sentAt: number }): string {
    const hash = createHash("sha256").update(userMessageHashInput(m)).digest("hex");
    return toBase64(this.#key.sign(utf8(userMessageSigningInput({ session: m.session, clientMessageId: m.clientMessageId, hash, sentAt: m.sentAt }))));
  }

  toJSON(): string {
    return "[answer key]";
  }
}

