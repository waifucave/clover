// One answer key per (device, program) (spec revision 19, §5.5 "Only sealed buttons answer", §8.1; ruling C, item 91;
// contract `contracts/program-keys.ts`). Lane RT.
//
// MOSS, MOSS Code and the background host each hold their own answer key in their own protected storage and register
// it here (`device.programKey.set`). The program is the registering connection's (`EngineSurfaceDoor.programOf`: its
// signed identity on macOS, its surface on Windows and Linux), never a word in the call. An answer's proof names its
// program (`programCardAnswerSigningInput`, `moss/card-answer/3`) and verifies only against that program's key: no
// press is forwarded from one program to another.
//
// * A key registers only with its own signature over `programAnswerKeyStatement`. The first key of a program, and the
//   same key again, apply at once. Another key in place of a held one is the sensitive change it is for the one key
//   today (`device.answerKey.set`): `register` answers `{ applied: false, card: true }` and changes nothing; the
//   server then checks the held key's hand-over (`checkHandOver`) and asks the user on a sealed card, and only on its
//   yes calls `replace`, which checks everything again. Nothing replaces a key without that card.
// * `code` is today's app: its key is the device's single answer key (`legacy`, the device registry's
//   `answerKey`, set by `device.answerKey.set`), which stays valid. A `code` key registered here counts only on a device
//   that has no single key.
// * A revoked device's keys count for nothing, and are dropped.
//
// Kept in `<home>/devices/program-keys.json` (public keys and their registrations only; never a secret).
import { programAnswerKeyRotateStatement, programAnswerKeyStatement, MOSS_PROGRAMS, type AnswerKeyAlg, type AnswerKeyHolder, type Program } from "@waifucave/moss-protocol";
import { ContractError, fromBase64, Listeners, type Unsubscribe } from "../contracts/common";
import { holderFitsAlg, verifyKeySignature } from "../contracts/device-registry";
import type { ProgramAnswerKeys, ProgramKey, ProgramKeyResult } from "../contracts/program-keys";
import { readJsonFile, writeJsonFile } from "../devices/json-file";

/** How far a hand-over's `at` may be from now (as for the single key's, `ANSWER_KEY_ROTATE_MAX_SKEW_MS`). */
export const PROGRAM_KEY_HAND_OVER_SKEW_MS = 5 * 60 * 1000;

export interface ProgramKeyInput {
  device: string;
  program: Program;
  publicKey: string;
  held: AnswerKeyHolder;
  alg?: AnswerKeyAlg;
  /** The key's own signature over `programAnswerKeyStatement`, base64. */
  signature: string;
}

/** The held key's hand-over to the new one: its signature over `programAnswerKeyRotateStatement`, base64. */
export interface ProgramKeyHandOver {
  from: string;
  at: number;
  signature: string;
}

export type HandOverRefusal = "no-current-key" | "same-key" | "not-current" | "stale" | "bad-signature";

interface Stored extends ProgramKey {
  registration: string;
}

interface FileShape {
  v: 1;
  keys: Record<string, Partial<Record<Program, Stored>>>;
  revoked: string[];
}

export interface ProgramKeyTableOptions {
  /** Where the table is kept; in memory only without one. */
  file?: string;
  /** A device's single answer key from before the split, which is its `code` program's (the device registry). */
  legacy?: (device: string) => { publicKey: string; held: AnswerKeyHolder; alg?: AnswerKeyAlg } | undefined;
  /** Whether the device registry has revoked a device. */
  isRevoked?: (device: string) => boolean;
  now?: () => number;
}

const enc = (s: string) => new TextEncoder().encode(s);

export class ProgramKeyTable implements ProgramAnswerKeys {
  readonly #file: string | undefined;
  readonly #legacy: ProgramKeyTableOptions["legacy"];
  readonly #isRevoked: ProgramKeyTableOptions["isRevoked"];
  readonly #now: () => number;
  readonly #listeners = new Listeners<{ device: string; key: ProgramKey }>();
  #state: FileShape;

  constructor(opts: ProgramKeyTableOptions = {}) {
    this.#file = opts.file;
    this.#legacy = opts.legacy;
    this.#isRevoked = opts.isRevoked;
    this.#now = opts.now ?? Date.now;
    const read = opts.file === undefined ? undefined : readJsonFile<FileShape>(opts.file);
    this.#state = read !== undefined && read.v === 1 && typeof read.keys === "object" && Array.isArray(read.revoked) ? read : { v: 1, keys: {}, revoked: [] };
  }

  #save(): void {
    if (this.#file !== undefined) writeJsonFile(this.#file, this.#state);
  }

  #gone(device: string): boolean {
    return this.#state.revoked.includes(device) || this.#isRevoked?.(device) === true;
  }

  async #provesItself(input: ProgramKeyInput): Promise<void> {
    const key = fromBase64(input.publicKey);
    const sig = fromBase64(input.signature);
    if (!key || !sig || this.#gone(input.device) || !holderFitsAlg(input.held, input.alg) || !(MOSS_PROGRAMS as readonly string[]).includes(input.program)) {
      throw new ContractError("invalid", "not a key this device may register");
    }
    if (!(await verifyKeySignature(input.alg ?? "ed25519", key, enc(programAnswerKeyStatement(input)), sig))) {
      throw new ContractError("invalid", "the key's own signature over its statement doesn't verify");
    }
  }

  #set(input: ProgramKeyInput): void {
    const record: Stored = { program: input.program, publicKey: input.publicKey, held: input.held, ...(input.alg !== undefined ? { alg: input.alg } : {}), registration: input.signature };
    const keys = (this.#state.keys[input.device] ??= {});
    keys[input.program] = record;
    this.#save();
    this.#listeners.emit({ device: input.device, key: strip(record) });
  }

  async register(input: ProgramKeyInput): Promise<ProgramKeyResult> {
    await this.#provesItself(input);
    const held = this.keyOf(input.device, input.program);
    if (held !== undefined && held.publicKey !== input.publicKey) return { applied: false, card: true };
    // The same key again, or the device's single key named again as `code`'s: nothing to keep twice.
    if (held !== undefined && input.program === "code" && this.#legacy?.(input.device) !== undefined) return { applied: true };
    if (held === undefined || held.held !== input.held || (held.alg ?? "ed25519") !== (input.alg ?? "ed25519")) this.#set(input);
    return { applied: true };
  }

  /** Whether `handOver` is the held key's own signature handing this program over to `input`'s key, made just now. Checked
   *  before any card shows: a hand-over that doesn't verify is refused without asking anyone. */
  async checkHandOver(input: ProgramKeyInput, handOver: ProgramKeyHandOver): Promise<HandOverRefusal | "ok"> {
    const held = this.keyOf(input.device, input.program);
    if (held === undefined) return "no-current-key";
    if (held.publicKey === input.publicKey) return "same-key";
    if (handOver.from !== held.publicKey) return "not-current";
    if (!Number.isFinite(handOver.at) || Math.abs(this.#now() - handOver.at) > PROGRAM_KEY_HAND_OVER_SKEW_MS) return "stale";
    const from = fromBase64(held.publicKey);
    const sig = fromBase64(handOver.signature);
    const statement = programAnswerKeyRotateStatement({ device: input.device, program: input.program, from: held.publicKey, to: input.publicKey, at: handOver.at });
    if (!from || !sig || !(await verifyKeySignature(held.alg ?? "ed25519", from, enc(statement), sig))) return "bad-signature";
    return "ok";
  }

  /** The replacement, after the user's yes on its card: every check again (the key and the hand-over), then the key. A
   *  `code` key replaced here belongs to a device with no single key; the single key is replaced by
   *  `device.answerKey.set`'s own card. */
  async replace(input: ProgramKeyInput, handOver: ProgramKeyHandOver): Promise<void> {
    await this.#provesItself(input);
    const why = await this.checkHandOver(input, handOver);
    if (why !== "ok") throw new ContractError("refused", `the hand-over doesn't hold (${why})`);
    if (input.program === "code" && this.#legacy?.(input.device) !== undefined) throw new ContractError("refused", "MOSS Code's key is this device's single answer key: device.answerKey.set replaces it");
    this.#set(input);
  }

  /** Whether MOSS Code's key on `device` is the device's single answer key (which `device.answerKey.set` replaces). */
  codeIsSingleKey(device: string): boolean {
    return this.#legacy?.(device) !== undefined;
  }

  keyOf(device: string, program: Program): ProgramKey | undefined {
    if (this.#gone(device)) return undefined;
    if (program === "code") {
      const one = this.#legacy?.(device);
      if (one !== undefined) return { program: "code", publicKey: one.publicKey, held: one.held, ...(one.alg !== undefined ? { alg: one.alg } : {}) };
    }
    const k = this.#state.keys[device]?.[program];
    return k === undefined ? undefined : strip(k);
  }

  list(device: string): ProgramKey[] {
    if (this.#gone(device)) return [];
    return MOSS_PROGRAMS.map((p) => this.keyOf(device, p)).filter((k): k is ProgramKey => k !== undefined);
  }

  async verify(device: string, program: Program, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    const k = this.keyOf(device, program);
    const raw = k ? fromBase64(k.publicKey) : null;
    return k !== undefined && raw !== null && verifyKeySignature(k.alg ?? "ed25519", raw, data, signature);
  }

  revoked(device: string): void {
    if (!this.#state.revoked.includes(device)) this.#state.revoked.push(device);
    delete this.#state.keys[device];
    this.#save();
  }

  watch(fn: (change: { device: string; key: ProgramKey }) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }
}

function strip(k: Stored): ProgramKey {
  return { program: k.program, publicKey: k.publicKey, held: k.held, ...(k.alg !== undefined ? { alg: k.alg } : {}) };
}
