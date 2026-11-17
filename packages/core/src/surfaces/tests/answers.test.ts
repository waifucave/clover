// The three contracts together, as `card.answer` uses them on this computer's own app connections (lane RT): the door
// says which program a connection is, the router where each card is drawn, the program-key table which key an answer
// verifies with; the broker is the real one. What it pins (the reviewer's cross-contract case):
// * an answer whose proof names program P, sent on a connection of program Q, is refused; one signed with another
//   program's key is refused as that program's;
// * a right-key answer for a card placed in another program's window, or on the island, is refused;
// * the island's drawer takes a press only for a card placed there; computer use acting refuses every app answer.
import { describe, expect, test } from "bun:test";
import { programAnswerKeyStatement, programCardAnswerSigningInput, cardAnswerSigningInput, type Card, type Caller, type Program } from "@waifucave/moss-protocol";
import { MossApprovalBroker } from "../../approvals/broker";
import { cardMethods } from "../../approvals/card-methods";
import { deviceProofVerifier, type ApprovalRequest } from "../../contracts/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakeDeviceRegistry, makeFakeDevice, toBase64, type FakeDevice } from "../../contracts/fakes/device-registry";
import type { MossConn } from "../../ipc/moss";
import { EngineCardRouter } from "../card-router";
import { EngineSurfaceDoor } from "../door";
import { ProgramKeyTable } from "../program-keys";
import { cardPressGate, routeBrokerCards } from "../routing";

const enc = (s: string) => new TextEncoder().encode(s);

function conn(connId: number, program: Program): MossConn {
  const caller: Caller = { kind: "user", client: "app" };
  return { connId, role: "app", caller, features: [], clientName: `test-${program}`, surface: program, program, areas: new Set(), send: () => "x", notify: () => {}, follows: new Map() };
}

async function world(o: { singleKey?: boolean } = {}) {
  const clock = new FakeClock();
  const { registry } = await FakeDeviceRegistry.create({ clock, name: "Studio" });
  // This desktop: its link key, MOSS Code's single answer key, and MOSS's and the host's own keys.
  const link = await makeFakeDevice();
  const codeKey = await makeFakeDevice();
  const mossKey = await makeFakeDevice();
  const hostKey = await makeFakeDevice();
  // With `singleKey: false` the desktop has no single answer key: MOSS Code's key is held in the program table alone.
  const single = o.singleKey !== false;
  await registry.add({ id: link.id, name: "Laptop", kind: "desktop", runsCore: true, publicKey: link.publicKey, ...(single ? { answerKey: { publicKey: codeKey.publicKey, held: "app-keychain" as const } } : {}) }, { via: "account", account: "acct_1" });
  const table = new ProgramKeyTable({ legacy: (d) => registry.get(d)?.answerKey });
  for (const [program, key] of [["moss", mossKey], ["host", hostKey], ...(single ? [] : [["code", codeKey]] as const)] as const) {
    const statement = programAnswerKeyStatement({ device: link.id, program, publicKey: key.publicKey, held: "app-keychain" });
    expect(await table.register({ device: link.id, program, publicKey: key.publicKey, held: "app-keychain", signature: toBase64(await key.sign(enc(statement))) })).toEqual({ applied: true });
  }
  const broker = new MossApprovalBroker({ clock, levels: () => "ask", verify: deviceProofVerifier(registry, table), localComputer: "Studio" });
  const door = new EngineSurfaceDoor();
  const router = new EngineCardRouter({ clock, hostLive: false });
  door.watch(() => router.hostLive(door.islandLive()));
  routeBrokerCards(broker, router);
  let acting = false;
  const methods = cardMethods(() => broker, () => undefined, { press: (c, id) => cardPressGate({ door, router }, c.connId, id), acting: () => acting });
  // Today's app (MOSS Code's window, which draws the island until the host is built) and MOSS's window.
  const code = conn(1, "code");
  const moss = conn(2, "moss");
  const host = conn(3, "host");
  door.admit({ connId: 1, role: "app", surface: "code", signed: "code" });
  door.admit({ connId: 2, role: "app", surface: "moss", signed: "moss" });
  door.admit({ connId: 3, role: "app", surface: "host", signed: "host" });
  const raise = async (bot: string): Promise<Card> => {
    const req: ApprovalRequest = { kind: "tool", session: `s_${bot}`, bot, origin: "user", computers: ["Studio"], effect: "execute", fields: { title: { type: "text", text: "Run a command" }, command: { type: "code", code: "git push", language: "sh" } } };
    // The card this request shows, by its own id (no tick counting: the broker's card is made asynchronously).
    const id = await new Promise<string>((resolve) => { void broker.request(req, { onCard: resolve }); });
    return broker.cards().find((c) => c.id === id)!;
  };
  const answer = async (from: MossConn, card: Card, signer: FakeDevice, named: Program | undefined) => {
    const at = clock.now();
    const input = named === undefined ? cardAnswerSigningInput({ id: card.id, hash: card.hash, option: "approve", at, children: [] }) : programCardAnswerSigningInput({ program: named, id: card.id, hash: card.hash, option: "approve", at });
    const proof = { via: "device" as const, device: link.id, at, signature: toBase64(await signer.sign(enc(input))), ...(named !== undefined ? { program: named } : {}) };
    return methods["card.answer"]!(from, { id: card.id, hash: card.hash, option: "approve", proof }) as Promise<{ accepted: boolean; reason?: string }>;
  };
  return { router, code, moss, host, raise, answer, keys: { codeKey, mossKey, hostKey }, setActing: (on: boolean) => { acting = on; } };
}

describe("card.answer across the door, the router and the program keys", () => {
  test("MOSS's window focused on bot A: bot B's card is in its strip, and MOSS's own Approve, signed with MOSS's key, is taken", async () => {
    const w = await world();
    w.router.report({ connId: 2, program: "moss" }, { windows: [{ window: "moss", focused: true, visible: true, showing: { kind: "bot", id: "bot-a" } }] });
    const card = await w.raise("bot-b");
    expect(w.router.placementOf(card.id)).toEqual({ kind: "strip", program: "moss", window: "moss" });
    // The proof names the host on MOSS's connection: refused. MOSS's name over the host's key: refused as MOSS's.
    expect(await w.answer(w.moss, card, w.keys.hostKey, "host")).toMatchObject({ accepted: false });
    expect(await w.answer(w.moss, card, w.keys.hostKey, "moss")).toEqual({ accepted: false, reason: "the answer's signature didn't check out" });
    // The device's single key (MOSS Code's) on MOSS's connection: refused.
    expect(await w.answer(w.moss, card, w.keys.codeKey, undefined)).toMatchObject({ accepted: false });
    // MOSS Code's right key, but the card is drawn in MOSS's window: never forwarded.
    expect(await w.answer(w.code, card, w.keys.codeKey, undefined)).toEqual({ accepted: false, reason: "this card is drawn in another program's window now" });
    expect(await w.answer(w.moss, card, w.keys.mossKey, "moss")).toEqual({ accepted: true });
  });

  test("no window focused: the island draws it and takes the press; a window's right key does not", async () => {
    const w = await world();
    w.router.report({ connId: 2, program: "moss" }, { windows: [{ window: "moss", focused: false, visible: true, showing: { kind: "bot", id: "bot-a" } }] });
    const card = await w.raise("bot-a");
    // Visible but not focused: the island, whose drawer today is MOSS Code's window program.
    expect(w.router.placementOf(card.id)).toEqual({ kind: "island" });
    expect(await w.answer(w.moss, card, w.keys.mossKey, "moss")).toEqual({ accepted: false, reason: "this card is on the island now" });
    expect(await w.answer(w.code, card, w.keys.codeKey, undefined)).toEqual({ accepted: true });
  });

  test("a card in one window of a program: only that window's connection takes it; computer use acting refuses all", async () => {
    const w = await world();
    w.router.report({ connId: 1, program: "code" }, { windows: [{ window: "main", focused: true, visible: true, showing: { kind: "session", id: "s_bot-a" } }] });
    const card = await w.raise("bot-a");
    expect(w.router.placementOf(card.id)).toEqual({ kind: "conversation", program: "code", window: "main" });
    w.setActing(true);
    expect(await w.answer(w.code, card, w.keys.codeKey, undefined)).toEqual({ accepted: false, reason: "computer use is acting right now" });
    w.setActing(false);
    // MOSS Code's key named as `code` (the program form) verifies too: its key is the device's single key.
    expect(await w.answer(w.code, card, w.keys.codeKey, "code")).toEqual({ accepted: true });
  });
});

describe("computer use and MOSS Code's key in the program table", () => {
  test("while computer use acts on this computer, card.answer from every program is refused with that reason, whatever its place or key", async () => {
    const w = await world();
    w.router.report({ connId: 2, program: "moss" }, { windows: [{ window: "moss", focused: true, visible: true, showing: { kind: "bot", id: "bot-a" } }] });
    const card = await w.raise("bot-a");
    w.setActing(true);
    const acting = { accepted: false, reason: "computer use is acting right now" };
    expect(await w.answer(w.moss, card, w.keys.mossKey, "moss")).toEqual(acting);
    expect(await w.answer(w.code, card, w.keys.codeKey, undefined)).toEqual(acting);
    expect(await w.answer(w.host, card, w.keys.hostKey, "host")).toEqual(acting);
    // The card still waits: once computer use stops, the program it is placed with answers it.
    w.setActing(false);
    expect(await w.answer(w.moss, card, w.keys.mossKey, "moss")).toEqual({ accepted: true });
  });

  test("a desktop with no single key: MOSS Code's key in the program table verifies only when the proof names program code", async () => {
    const w = await world({ singleKey: false });
    const card = await w.raise("bot-a");
    // No window reports: the island, drawn by MOSS Code's window program today.
    expect(w.router.placementOf(card.id)).toEqual({ kind: "island" });
    expect(await w.answer(w.code, card, w.keys.codeKey, undefined)).toMatchObject({ accepted: false });
    expect(await w.answer(w.code, card, w.keys.codeKey, "code")).toEqual({ accepted: true });
  });
});

describe("device.programKey.set", () => {
  test("a program's first key applies; another in its place takes the held key's hand-over and the user's yes on a card, and only then applies", async () => {
    const { programKeyMethods } = await import("../rpc");
    const { programAnswerKeyRotateStatement } = await import("@waifucave/moss-protocol");
    const clock = new FakeClock();
    const device = "studiodevice0001";
    const table = new ProgramKeyTable({ now: () => clock.now() });
    const broker = new MossApprovalBroker({ clock, localComputer: "Studio" });
    const set = programKeyMethods({ table: () => table, device: () => device, rotation: () => ({ broker, computer: "Studio" }) })["device.programKey.set"]!;
    const a = await makeFakeDevice();
    const b = await makeFakeDevice();
    const reg = async (k: FakeDevice) => ({ publicKey: k.publicKey, held: "app-keychain" as const, signature: toBase64(await k.sign(enc(programAnswerKeyStatement({ device, program: "moss", publicKey: k.publicKey, held: "app-keychain" })))) });
    const moss = conn(2, "moss");
    expect(await set(moss, await reg(a))).toEqual({ applied: true });
    expect(table.keyOf(device, "moss")?.publicKey).toBe(a.publicKey);
    // The program is the connection's: MOSS Code's connection registering the same key makes it MOSS Code's, not MOSS's.
    await expect(Promise.resolve(set(conn(1, "code"), await reg(a)))).rejects.toThrow(/signature/);
    // Another key, no hand-over: refused; with one: a card, and the key holds until the yes.
    await expect(set(moss, await reg(b)) as Promise<unknown>).rejects.toThrow(/hand-over/);
    const at = clock.now();
    const rotation = { from: a.publicKey, at, signature: toBase64(await a.sign(enc(programAnswerKeyRotateStatement({ device, program: "moss", from: a.publicKey, to: b.publicKey, at })))) };
    const r = (await set(moss, { ...(await reg(b)), rotation })) as { applied: false; card: string };
    expect(r.applied).toBe(false);
    expect(table.keyOf(device, "moss")?.publicKey).toBe(a.publicKey);
    const card = broker.get(r.card)!.card;
    expect(card.change).toBe("answer-key-rotate");
    // The replacement after the yes is asynchronous (the table checks both signatures again): the test waits for the table's
    // own word that it took the key, never a count of ticks (two ticks fell short under load on a CI shard).
    const replaced = new Promise<string>((resolve) => { const off = table.watch((c) => { if (c.device === device && c.key.program === "moss") { off(); resolve(c.key.publicKey); } }); });
    expect(await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card.id)!, input: "click", at } }, { role: "app" })).toBe("accepted");
    expect(await replaced).toBe(b.publicKey);
    expect(table.keyOf(device, "moss")?.publicKey).toBe(b.publicKey);
  });
});
