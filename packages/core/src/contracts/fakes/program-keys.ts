// FakeProgramAnswerKeys: the per-program key table in memory, with real Ed25519 checks (`verifyKeySignature`).
// `legacyKey` seeds a device's existing single key as its `code` program's.
import { programAnswerKeyStatement, type AnswerKeyAlg, type AnswerKeyHolder, type Program } from "@waifucave/moss-protocol";
import { ContractError, fromBase64, Listeners, type Unsubscribe } from "../common";
import { holderFitsAlg, verifyKeySignature } from "../device-registry";
import type { ProgramAnswerKeys, ProgramKey, ProgramKeyResult } from "../program-keys";

export class FakeProgramAnswerKeys implements ProgramAnswerKeys {
  readonly #keys = new Map<string, Map<Program, ProgramKey>>();
  readonly #revoked = new Set<string>();
  readonly #listeners = new Listeners<{ device: string; key: ProgramKey }>();

  /** A device's single key from before the split: its `code` program's (MOSS Code is today's app). */
  legacyKey(device: string, key: { publicKey: string; held: AnswerKeyHolder; alg?: AnswerKeyAlg }): void {
    this.#of(device).set("code", { program: "code", ...key });
  }

  #of(device: string): Map<Program, ProgramKey> {
    let m = this.#keys.get(device);
    if (!m) this.#keys.set(device, (m = new Map()));
    return m;
  }

  async register(input: { device: string; program: Program; publicKey: string; held: AnswerKeyHolder; alg?: AnswerKeyAlg; signature: string }): Promise<ProgramKeyResult> {
    const key = fromBase64(input.publicKey);
    const sig = fromBase64(input.signature);
    if (!key || !sig || this.#revoked.has(input.device) || !holderFitsAlg(input.held, input.alg)) throw new ContractError("invalid", "not a key this device may register");
    const statement = new TextEncoder().encode(programAnswerKeyStatement(input));
    if (!(await verifyKeySignature(input.alg ?? "ed25519", key, statement, sig))) throw new ContractError("invalid", "the key's own signature over its statement doesn't verify");
    const held = this.#of(input.device).get(input.program);
    if (held && held.publicKey !== input.publicKey) return { applied: false, card: true };
    const record: ProgramKey = { program: input.program, publicKey: input.publicKey, held: input.held, ...(input.alg !== undefined ? { alg: input.alg } : {}) };
    this.#of(input.device).set(input.program, record);
    this.#listeners.emit({ device: input.device, key: record });
    return { applied: true };
  }

  keyOf(device: string, program: Program): ProgramKey | undefined {
    if (this.#revoked.has(device)) return undefined;
    return this.#keys.get(device)?.get(program);
  }

  list(device: string): ProgramKey[] {
    if (this.#revoked.has(device)) return [];
    return [...(this.#keys.get(device)?.values() ?? [])];
  }

  async verify(device: string, program: Program, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    const k = this.keyOf(device, program);
    const raw = k ? fromBase64(k.publicKey) : null;
    return k !== undefined && raw !== null && verifyKeySignature(k.alg ?? "ed25519", raw, data, signature);
  }

  revoked(device: string): void {
    this.#revoked.add(device);
  }

  watch(fn: (change: { device: string; key: ProgramKey }) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }
}
