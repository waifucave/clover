// `device.answerKey.set` (devices/rpc.ts): this desktop's app registers the key it answers cards with, on every
// connection. The registry takes it only with the app's signature; the first key and the same key again apply; another
// key in place of a held one takes the current key's hand-over and the user's yes on lane C's change card; a small-order
// key never is taken; only the app's user may set it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOVER_ERR, ERR, type Caller } from "@waifucave/clover-protocol";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { DeviceKey } from "../../identity/device-key";
import { toBase64 } from "../../identity/bytes";
import { generateEd25519 } from "../../identity/keys";
import { CloverApprovalBroker } from "../../approvals/broker";
import { answerKeyRotateStatement, answerKeyStatement, FileDeviceRegistry } from "../registry";
import { ANSWER_KEY_ROTATION_CARD_MS, devicesMethods, type DevicesMethodsDeps } from "../rpc";

const app: Caller = { kind: "user", client: "app" };

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

async function make() {
  const key = await DeviceKey.loadOrCreate(new MemorySecretStore());
  const clock = new FakeClock();
  const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-h-ak-")), key, clock, self: { name: "Studio", os: "macos" } });
  const broker = new CloverApprovalBroker({ clock });
  let rotation: DevicesMethodsDeps["answerKeyRotation"] = () => ({ broker, computer: "Studio" });
  const m = devicesMethods({ registry, clock, answerKeyRotation: () => rotation?.() } as unknown as DevicesMethodsDeps);
  /** The app's call replacing `from` with `to`: `to`'s registration, and `handOver`'s signature over the rotation. */
  const replace = (from: ReturnType<typeof generateEd25519>, to: ReturnType<typeof generateEd25519>, o: { at?: number; handOver?: ReturnType<typeof generateEd25519>; rotation?: false } = {}) => {
    const publicKey = toBase64(to.publicKey);
    const at = o.at ?? clock.now();
    const fromKey = toBase64(from.publicKey);
    return m["device.answerKey.set"]!({
      publicKey, held: "app-keychain", signature: toBase64(to.sign(answerKeyStatement(key.id, publicKey, "app-keychain"))),
      ...(o.rotation === false ? {} : { rotation: { from: fromKey, at, signature: toBase64((o.handOver ?? from).sign(answerKeyRotateStatement(key.id, fromKey, publicKey, at))) } }),
    }, { caller: app });
  };
  /** Answers a card through the app's sealed frame, as the app's main process does. */
  const answer = (card: string, optionId: "approve" | "deny") => {
    const c = broker.get(card)!.card;
    return broker.answer(card, { optionId, hash: c.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card)!, input: "click", at: clock.now() } }, { role: "app" });
  };
  const set = (k: ReturnType<typeof generateEd25519>, caller: Caller = app, signer = k) => {
    const publicKey = toBase64(k.publicKey);
    return m["device.answerKey.set"]!({ publicKey, held: "app-keychain", signature: toBase64(signer.sign(answerKeyStatement(key.id, publicKey, "app-keychain"))) }, { caller });
  };
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e as { code?: number }).code);
  return { registry, set, code, m, replace, answer, broker, clock, setRotation: (r: DevicesMethodsDeps["answerKeyRotation"]) => void (rotation = r) };
}

describe("device.answerKey.set", () => {
  test("the first key applies, and the same key again (every connection) applies", async () => {
    const { registry, set } = await make();
    const k = generateEd25519();
    expect(await set(k)).toEqual({ applied: true });
    expect(registry.self().answerKey).toEqual({ publicKey: toBase64(k.publicKey), held: "app-keychain" });
    expect(await set(k)).toEqual({ applied: true });
  });

  test("a key the app didn't sign is refused, and nothing is taken", async () => {
    const { registry, set, code } = await make();
    expect(await code(set(generateEd25519(), app, generateEd25519()))).not.toBe("ok");
    expect(registry.self().answerKey).toBeUndefined();
  });

  test("another key in place of a held one without the current key's hand-over is refused, never applied", async () => {
    const { registry, set, code, replace } = await make();
    const first = generateEd25519();
    await set(first);
    expect(await code(set(generateEd25519()))).toBe(ERR.INVALID_REQUEST);
    expect(await code(replace(first, generateEd25519(), { rotation: false }))).toBe(ERR.INVALID_REQUEST);
    expect(registry.self().answerKey?.publicKey).toBe(toBase64(first.publicKey));
  });

  test("with the current key's hand-over it shows the change card, and the user's yes replaces the key", async () => {
    const { registry, set, replace, answer, broker } = await make();
    const first = generateEd25519();
    const next = generateEd25519();
    await set(first);
    const r = (await replace(first, next)) as { applied: false; card: string };
    expect(r).toEqual({ applied: false, card: expect.any(String) });
    expect(broker.get(r.card)!.card).toMatchObject({ kind: "change", change: "answer-key-rotate" });
    // Not yet: the key changes only on the yes.
    expect(registry.self().answerKey?.publicKey).toBe(toBase64(first.publicKey));
    expect(await answer(r.card, "approve")).toBe("accepted");
    await waitFor(() => registry.self().answerKey?.publicKey === toBase64(next.publicKey));
    // And the new key registers again on the next connection, at once.
    expect(await set(next)).toEqual({ applied: true });
  });

  test("a no keeps the current key", async () => {
    const { registry, set, replace, answer } = await make();
    const first = generateEd25519();
    await set(first);
    const r = (await replace(first, generateEd25519())) as { applied: false; card: string };
    expect(await answer(r.card, "deny")).toBe("accepted");
    await Bun.sleep(20);
    expect(registry.self().answerKey?.publicKey).toBe(toBase64(first.publicKey));
  });

  test("a hand-over that isn't the current key's, or is stale, is refused before any card shows", async () => {
    const { registry, set, replace, code, broker, clock } = await make();
    const first = generateEd25519();
    await set(first);
    const next = generateEd25519();
    // Signed by the new key itself (code holding only the new key), or by a stranger: no card.
    expect(await code(replace(first, next, { handOver: next }))).toBe(ERR.INVALID_REQUEST);
    expect(await code(replace(first, next, { handOver: generateEd25519() }))).toBe(ERR.INVALID_REQUEST);
    // "From" a key this desktop doesn't hold.
    expect(await code(replace(generateEd25519(), next))).toBe(ERR.INVALID_REQUEST);
    // Signed long ago.
    expect(await code(replace(first, next, { at: clock.now() - 60 * 60 * 1000 }))).toBe(ERR.INVALID_REQUEST);
    expect(broker.cards()).toEqual([]);
    expect(registry.self().answerKey?.publicKey).toBe(toBase64(first.publicKey));
  });

  test("one card at a time: a new hand-over withdraws the card before; each hand-over counts once", async () => {
    const { registry, set, replace, answer, broker, code, m, clock } = await make();
    const first = generateEd25519();
    await set(first);
    const a = (await replace(first, generateEd25519())) as { card: string };
    const next = generateEd25519();
    const b = (await replace(first, next)) as { card: string };
    expect(b.card).not.toBe(a.card);
    await waitFor(() => broker.get(a.card)?.outcome !== undefined);
    expect(broker.get(a.card)?.outcome).toBe("cancelled");
    expect(broker.cards().map((c) => c.id)).toEqual([b.card]);
    // The same hand-over again (a replay of b's call, byte for byte: Ed25519 signs deterministically) is refused.
    const publicKey = toBase64(next.publicKey);
    const at = clock.now();
    const params = {
      publicKey, held: "app-keychain", signature: toBase64(next.sign(answerKeyStatement(registry.self().id, publicKey, "app-keychain"))),
      rotation: { from: toBase64(first.publicKey), at, signature: toBase64(first.sign(answerKeyRotateStatement(registry.self().id, toBase64(first.publicKey), publicKey, at))) },
    };
    expect(await code(m["device.answerKey.set"]!(params, { caller: app }) as Promise<unknown>)).toBe(ERR.INVALID_REQUEST);
    // b's card still waits: the replay withdrew nothing.
    expect(broker.cards().map((c) => c.id)).toEqual([b.card]);
    void answer;
  });

  test("a card nobody answers is cancelled after 10 minutes, and the key stays", async () => {
    const { registry, set, replace, broker, clock } = await make();
    const first = generateEd25519();
    await set(first);
    const r = (await replace(first, generateEd25519())) as { card: string };
    clock.advance(ANSWER_KEY_ROTATION_CARD_MS - 1);
    await Bun.sleep(5);
    expect(broker.get(r.card)?.outcome).toBeUndefined();
    clock.advance(1);
    await waitFor(() => broker.get(r.card)?.outcome !== undefined);
    expect(broker.get(r.card)?.outcome).toBe("cancelled");
    expect(registry.self().answerKey?.publicKey).toBe(toBase64(first.publicKey));
  });

  test("before the approvals are up, a replacement is told to try again", async () => {
    const { set, replace, code, setRotation } = await make();
    const first = generateEd25519();
    await set(first);
    setRotation(undefined);
    expect(await code(replace(first, generateEd25519()))).toBe(ERR.RETRY);
    setRotation(() => undefined);
    expect(await code(replace(first, generateEd25519()))).toBe(ERR.RETRY);
  });

  test("a small-order key (the all-zero one among them) is refused, signature or not, and nothing is taken", async () => {
    const { registry, m, code } = await make();
    for (const hex of ["0000000000000000000000000000000000000000000000000000000000000000", "0100000000000000000000000000000000000000000000000000000000000000", "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"]) {
      const publicKey = Buffer.from(hex, "hex").toString("base64");
      expect(await code(m["device.answerKey.set"]!({ publicKey, held: "app-keychain", signature: toBase64(new Uint8Array(64)) }, { caller: app }))).not.toBe("ok");
    }
    expect(registry.self().answerKey).toBeUndefined();
  });

  test("only the app's user sets it: not the terminal, not a session", async () => {
    const { registry, set, code } = await make();
    expect(await code(set(generateEd25519(), { kind: "user", client: "cli" }))).toBe(CLOVER_ERR.NOT_THE_USER);
    expect(await code(set(generateEd25519(), { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "alpha" }))).toBe(CLOVER_ERR.NOT_THE_USER);
    expect(registry.self().answerKey).toBeUndefined();
  });

  test("a signature that isn't base64 is refused as invalid params", async () => {
    const { m, code } = await make();
    expect(await code(m["device.answerKey.set"]!({ publicKey: toBase64(generateEd25519().publicKey), held: "app-keychain", signature: "abc" }, { caller: app }))).not.toBe("ok");
  });
});
