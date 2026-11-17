// deviceProofVerifier's one rule for every program (lane RT): a proof naming a program verifies with that program's key from
// the program table alone; the device's single key serves only a proof that names no program. Found by lane MA's acceptance
// unit: on a home where only MOSS has run, the device has no single key, and MOSS's answers must still verify.
import { describe, expect, test } from "bun:test";
import { cardAnswerSigningInput, programAnswerKeyStatement, programCardAnswerSigningInput, type Card, type Program } from "@waifucave/moss-protocol";
import { deviceProofVerifier } from "../../contracts/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakeDeviceRegistry, makeFakeDevice, toBase64, type FakeDevice } from "../../contracts/fakes/device-registry";
import { ProgramKeyTable } from "../program-keys";

const enc = (s: string) => new TextEncoder().encode(s);
const card = { id: "card_aaaaaa", hash: "a".repeat(64) } as Card;

async function setup(o: { single?: boolean; programs?: Program[]; kind?: "desktop" | "phone" | "server" } = {}) {
  const { registry } = await FakeDeviceRegistry.create({ clock: new FakeClock(), name: "Studio" });
  const link = await makeFakeDevice();
  const keys = { single: await makeFakeDevice(), moss: await makeFakeDevice(), code: await makeFakeDevice(), host: await makeFakeDevice() };
  await registry.add({ id: link.id, name: "Laptop", kind: o.kind ?? "desktop", runsCore: true, publicKey: link.publicKey, ...(o.single === true ? { answerKey: { publicKey: keys.single.publicKey, held: "app-keychain" as const } } : {}) }, { via: "account", account: "acct_1" });
  const table = new ProgramKeyTable({ legacy: (d) => registry.get(d)?.answerKey, isRevoked: (d) => registry.get(d)?.revokedAt !== undefined });
  for (const program of o.programs ?? []) {
    const k = keys[program];
    const statement = programAnswerKeyStatement({ device: link.id, program, publicKey: k.publicKey, held: "app-keychain" });
    expect(await table.register({ device: link.id, program, publicKey: k.publicKey, held: "app-keychain", signature: toBase64(await k.sign(enc(statement))) })).toEqual({ applied: true });
  }
  const verify = deviceProofVerifier(registry, table);
  const signed = async (key: FakeDevice, program: Program | undefined) => {
    const input = program === undefined
      ? cardAnswerSigningInput({ id: card.id, hash: card.hash, option: "allow_once", at: 1, children: [] })
      : programCardAnswerSigningInput({ program, id: card.id, hash: card.hash, option: "allow_once", at: 1, children: [] });
    const proof = { via: "device" as const, device: link.id, at: 1, signature: toBase64(await key.sign(enc(input))), ...(program !== undefined ? { program } : {}) };
    return verify(card, { optionId: "allow_once", proof } as Parameters<typeof verify>[1], { role: "app" });
  };
  return { registry, link, keys, signed };
}

describe("deviceProofVerifier: one rule for every program", () => {
  test("a device holding ONLY a moss key answers a card signed as moss", async () => {
    const w = await setup({ programs: ["moss"] });
    expect(await w.signed(w.keys.moss, "moss")).toBe(true);
  });

  test("the same moss key's proof signed as code or host is refused", async () => {
    const w = await setup({ programs: ["moss"] });
    expect(await w.signed(w.keys.moss, "code")).toBe(false);
    expect(await w.signed(w.keys.moss, "host")).toBe(false);
    // Nor as the single key's proof (there is none, and the input differs).
    expect(await w.signed(w.keys.moss, undefined)).toBe(false);
  });

  test("a revoked device's moss proof is refused", async () => {
    const w = await setup({ programs: ["moss"] });
    await w.registry.revoke(w.link.id);
    expect(await w.signed(w.keys.moss, "moss")).toBe(false);
  });

  test("a device holding only the single key, with a proof naming no program, still answers", async () => {
    const w = await setup({ single: true });
    expect(await w.signed(w.keys.single, undefined)).toBe(true);
    // The single key never passes as a program's: moss has no key here.
    expect(await w.signed(w.keys.single, "moss")).toBe(false);
  });

  test("a device with no key at all is refused, named program or not", async () => {
    const w = await setup();
    for (const p of [undefined, "moss", "code", "host"] as const) expect(await w.signed(w.keys.moss, p)).toBe(false);
  });

  test("a phone's program key verifies; a server's never does", async () => {
    expect(await (async () => { const w = await setup({ kind: "phone", programs: ["moss"] }); return w.signed(w.keys.moss, "moss"); })()).toBe(true);
    expect(await (async () => { const w = await setup({ kind: "server", programs: ["moss"] }); return w.signed(w.keys.moss, "moss"); })()).toBe(false);
  });
});
