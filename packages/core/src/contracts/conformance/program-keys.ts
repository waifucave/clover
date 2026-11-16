// The ProgramAnswerKeys conformance suite (spec revision 19, ruling C). `runProgramAnswerKeysConformance(make)` registers
// every case against the implementation `make` builds; `tests/program-keys.test.ts` runs it against FakeProgramAnswerKeys,
// and lane RT runs it against the engine's registry. What it pins: a key per program proved by its own signature, a
// replacement as a card, an answer verified only with its own program's key, the old single key as `code`'s, revocation.
import { describe, expect, test } from "bun:test";
import { programAnswerKeyStatement, programCardAnswerSigningInput, type Program } from "@waifucave/moss-protocol";
import { isContractError } from "../common";
import type { FakeProgramAnswerKeys } from "../fakes/program-keys";

export type ProgramAnswerKeysHarness = Pick<FakeProgramAnswerKeys, keyof FakeProgramAnswerKeys>;
export type ProgramAnswerKeysFactory = () => ProgramAnswerKeysHarness;

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))));

async function makeKey() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = b64(await crypto.subtle.exportKey("raw", pair.publicKey));
  const sign = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, data as Uint8Array<ArrayBuffer>));
  return { publicKey, sign };
}

const DEVICE = "studiodevice0001";
const enc = (s: string) => new TextEncoder().encode(s);

export function runProgramAnswerKeysConformance(make: ProgramAnswerKeysFactory): void {
  async function registration(program: Program, key: Awaited<ReturnType<typeof makeKey>>) {
    const statement = programAnswerKeyStatement({ device: DEVICE, program, publicKey: key.publicKey, held: "app-keychain" });
    return { device: DEVICE, program, publicKey: key.publicKey, held: "app-keychain" as const, signature: b64(await key.sign(enc(statement))) };
  }

  describe("ProgramAnswerKeys", () => {
    test("each program registers its own key with the key's own signature over its statement", async () => {
      const keys = make();
      const moss = await makeKey();
      const host = await makeKey();
      expect(await keys.register(await registration("moss", moss))).toEqual({ applied: true });
      expect(await keys.register(await registration("host", host))).toEqual({ applied: true });
      expect(keys.list(DEVICE).map((k) => k.program).sort()).toEqual(["host", "moss"]);
      expect(keys.keyOf(DEVICE, "moss")?.publicKey).toBe(moss.publicKey);
      // A signature over another program's statement doesn't register it.
      const forged = { ...(await registration("moss", moss)), program: "code" as const };
      expect(isContractError(await keys.register(forged).catch((e: unknown) => e), "invalid")).toBe(true);
      expect(keys.keyOf(DEVICE, "code")).toBeUndefined();
    });

    test("replacing a program's key is a card; the same key again applies", async () => {
      const keys = make();
      const a = await makeKey();
      const b = await makeKey();
      await keys.register(await registration("code", a));
      expect(await keys.register(await registration("code", a))).toEqual({ applied: true });
      expect(await keys.register(await registration("code", b))).toEqual({ applied: false, card: true });
      expect(keys.keyOf(DEVICE, "code")?.publicKey).toBe(a.publicKey);
    });

    test("an answer verifies only with the key of the program it names: never forwarded from one program to another", async () => {
      const keys = make();
      const moss = await makeKey();
      const host = await makeKey();
      await keys.register(await registration("moss", moss));
      await keys.register(await registration("host", host));
      const answer = enc(programCardAnswerSigningInput({ program: "host", id: "card_abcdef", hash: "00", option: "approve", at: 5 }));
      const sig = await host.sign(answer);
      expect(await keys.verify(DEVICE, "host", answer, sig)).toBe(true);
      expect(await keys.verify(DEVICE, "moss", answer, sig)).toBe(false);
      expect(await keys.verify(DEVICE, "host", enc("other"), sig)).toBe(false);
      expect(await keys.verify("otherdevice00001", "host", answer, sig)).toBe(false);
      // The proof names its program: a moss answer's bytes differ from a host answer's for the same card.
      expect(programCardAnswerSigningInput({ program: "moss", id: "card_abcdef", hash: "00", option: "approve", at: 5 })).not.toBe(new TextDecoder().decode(answer));
    });

    test("today's single key is the code program's; a revoked device's keys count for nothing", async () => {
      const keys = make();
      const old = await makeKey();
      keys.legacyKey(DEVICE, { publicKey: old.publicKey, held: "app-keychain" });
      const answer = enc(programCardAnswerSigningInput({ program: "code", id: "card_abcdef", hash: "00", option: "deny", at: 9 }));
      expect(await keys.verify(DEVICE, "code", answer, await old.sign(answer))).toBe(true);
      keys.revoked(DEVICE);
      expect(await keys.verify(DEVICE, "code", answer, await old.sign(answer))).toBe(false);
      expect(keys.list(DEVICE)).toEqual([]);
    });
  });
}
