// Replacing this desktop's answer key: the current key's hand-over and the user's yes on a sealed card bound to exactly
// that hand-over, answered by anything but the key it replaces. Temp homes and an in-memory secret store only.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardAnswerSigningInput, type Card } from "@waifucave/clover-protocol";
import { ANSWER_KEY_ROTATE, ANSWER_KEY_ROTATE_MAX_SKEW_MS, rotateOwnAnswerKey, type AnswerKeyRotationAsk } from "../../src/approvals/answer-key-rotation";
import { CloverApprovalBroker } from "../../src/approvals/broker";
import { CoreComputerRegistry } from "../../src/computers/registry";
import { deviceProofVerifier } from "../../src/contracts/approval-broker";
import { isContractError } from "../../src/contracts/common";
import { FakeClock, flush } from "../../src/contracts/fakes/clock";
import { MemorySecretStore } from "../../src/contracts/fakes/secret-store";
import { answerKeyRotateStatement, answerKeyStatement, FileDeviceRegistry } from "../../src/devices/registry";
import { toBase64 } from "../../src/identity/bytes";
import { DeviceKey } from "../../src/identity/device-key";
import { generateEd25519 } from "../../src/identity/keys";

async function world() {
  const clock = new FakeClock();
  const key = await DeviceKey.loadOrCreate(new MemorySecretStore());
  const devices = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "lane-c-akr-")), key, clock, self: { name: "Studio", os: "macos" } });
  const broker = new CloverApprovalBroker({ clock, verify: deviceProofVerifier(devices), localComputer: "Studio" });
  const current = generateEd25519();
  const currentPub = toBase64(current.publicKey);
  await devices.setOwnAnswerKey(currentPub, "app-keychain", current.sign(answerKeyStatement(key.id, currentPub, "app-keychain")));
  const next = generateEd25519();
  const nextPub = toBase64(next.publicKey);
  const ask = (over: Partial<AnswerKeyRotationAsk> = {}): AnswerKeyRotationAsk => {
    const at = clock.now();
    return {
      publicKey: nextPub, held: "app-keychain",
      registration: next.sign(answerKeyStatement(key.id, nextPub, "app-keychain")),
      rotation: { from: currentPub, at, signature: current.sign(answerKeyRotateStatement(key.id, currentPub, nextPub, at)) },
      origin: "user", ...over,
    };
  };
  const frame = (card: Card) => ({ via: "sealed-frame" as const, frame: broker.frameChannel(card.id)!, input: "click" as const, at: 1 });
  /** Starts a rotation, waits for its card, and returns both. */
  const started = async (a: AnswerKeyRotationAsk) => {
    let shown: string | undefined;
    const outcome = rotateOwnAnswerKey({ broker, devices, computer: "Studio", now: () => clock.now(), onCard: (id) => { shown = id; } }, a);
    await flush();
    const card = broker.cards().at(-1)!;
    expect(shown).toBe(card.id);
    return { card, outcome };
  };
  return { clock, key, devices, broker, current, currentPub, next, nextPub, ask, frame, started };
}

describe("answer-key rotation", () => {
  test("a hand-over that doesn't verify, or from another key, is refused before any card shows", async () => {
    const w = await world();
    const at = w.clock.now();
    const forged = { from: w.currentPub, at, signature: w.next.sign(answerKeyRotateStatement(w.key.id, w.currentPub, w.nextPub, at)) };
    const opts = { broker: w.broker, devices: w.devices, computer: "Studio", now: () => w.clock.now() };
    expect(await rotateOwnAnswerKey(opts, w.ask({ rotation: forged }))).toEqual({ ok: false, why: "bad-signature" });
    expect(await rotateOwnAnswerKey(opts, w.ask({ registration: w.current.sign(answerKeyStatement(w.key.id, w.nextPub, "app-keychain")) }))).toEqual({ ok: false, why: "bad-signature" });
    expect(await rotateOwnAnswerKey(opts, w.ask({ rotation: { ...w.ask().rotation, from: w.nextPub } }))).toEqual({ ok: false, why: "not-current" });
    expect(await rotateOwnAnswerKey(opts, w.ask({ publicKey: w.currentPub }))).toEqual({ ok: false, why: "same-key" });
    // A hand-over signed long ago (or far ahead) is a replay: refused, though its signature holds.
    const old = w.ask();
    w.clock.advance(ANSWER_KEY_ROTATE_MAX_SKEW_MS + 1);
    expect(await rotateOwnAnswerKey(opts, old)).toEqual({ ok: false, why: "stale" });
    const ahead = w.clock.now() + ANSWER_KEY_ROTATE_MAX_SKEW_MS + 1;
    expect(await rotateOwnAnswerKey(opts, w.ask({ rotation: { from: w.currentPub, at: ahead, signature: w.current.sign(answerKeyRotateStatement(w.key.id, w.currentPub, w.nextPub, ahead)) } }))).toEqual({ ok: false, why: "stale" });
    expect(w.broker.cards()).toHaveLength(0);
    expect(w.devices.self().answerKey?.publicKey).toBe(w.currentPub);
    w.devices.clearOwnAnswerKey();
    expect(await rotateOwnAnswerKey(opts, w.ask())).toEqual({ ok: false, why: "no-current-key" });
  });

  test("the card is a change bound to exactly this hand-over, with no always; a no keeps the current key", async () => {
    const w = await world();
    const { card, outcome } = await w.started(w.ask());
    expect(card.kind).toBe("change");
    expect(card.change).toBe("answer-key-rotate");
    expect(card.binds?.method).toBe(ANSWER_KEY_ROTATE);
    expect(card.binds?.computer).toBe("Studio");
    expect(card.options.map((o) => o.kind)).toEqual(["approve", "deny"]);
    expect(card.options.some((o) => o.remember !== undefined)).toBe(false);
    expect(card.expiresAt).toBeNull(); // the user's own act in the app waits for them
    expect(await w.broker.answer(card.id, { optionId: "deny", hash: card.hash, proof: w.frame(card) }, { role: "app" })).toBe("accepted");
    expect(await outcome).toEqual({ ok: false, why: "not-approved" });
    expect(w.devices.self().answerKey?.publicKey).toBe(w.currentPub);
  });

  test("the key it replaces can't answer its own card", async () => {
    const w = await world();
    const { card, outcome } = await w.started(w.ask());
    const at = w.clock.now();
    const signature = toBase64(w.current.sign(new TextEncoder().encode(cardAnswerSigningInput({ id: card.id, hash: card.hash, option: "approve", at }))));
    expect(await w.broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: { via: "device", device: w.key.id, at, signature } }, { role: "app" })).toBe("accepted");
    expect(await outcome).toEqual({ ok: false, why: "own-key-answered" });
    expect(w.devices.self().answerKey?.publicKey).toBe(w.currentPub);
  });

  test("a yes on the sealed frame replaces the key, and the card proves nothing else", async () => {
    const w = await world();
    const { card, outcome } = await w.started(w.ask());
    expect(await w.broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: w.frame(card) }, { role: "app" })).toBe("accepted");
    const done = await outcome;
    expect(done.ok).toBe(true);
    expect(w.devices.self().answerKey?.publicKey).toBe(w.nextPub);
    expect(w.devices.ownAnswerKeyProof()?.rotations.at(-1)).toMatchObject({ from: w.currentPub, to: w.nextPub });
    // The approved rotation card is no level raise.
    const studio = new CoreComputerRegistry({ clock: w.clock, cards: (id) => w.broker.get(id), self: { name: "Studio", device: "studio00000000000000" } });
    await studio.setLevel("Studio", "ask");
    const rejected = await studio.setLevel("Studio", "automatic", { via: "card", record: w.broker.get(card.id)! }).then(() => undefined, (e: unknown) => e);
    expect(isContractError(rejected, "refused")).toBe(true);
  });
});
