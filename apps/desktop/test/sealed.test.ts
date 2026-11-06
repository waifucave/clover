// The sealed frames' pure store (`sealed.ts`): a card with its sealed fields in, its frames' single-use channels, and
// one answer per button over the answer key's signature (spec §5.5).
import { describe, expect, test } from "bun:test";
import { cardAnswerSigningInput } from "@waifucave/clover-protocol";
import { SealedFrames, type AnswerSigner, type SealedCard } from "../src/main/sealed";

const CARD: SealedCard = {
  id: "card_0a1b2c3d",
  kind: "tool",
  computer: "Studio",
  origin: "user",
  issuedAt: 0,
  expiresAt: null,
  hash: "a".repeat(64),
  fields: { title: { type: "text", text: "Run a command?" } },
  options: [
    { id: "allow_once", kind: "approve", label: "Allow" },
    { id: "deny", kind: "deny", label: "Deny" },
  ],
};

/** The card whose turn wasn't the user's: it rides its expiry (§5.5). */
const TIMED_CARD: SealedCard = { ...CARD, origin: "routine", expiresAt: 300_000 };

const signer: AnswerSigner = { sign: (m) => new Uint8Array([9, m.length & 0xff]) };

describe("the sealed frames' store", () => {
  test("a card in, its elements' channels minted and looked up, one each; a mint replaces the element's older token", () => {
    let now = 1_000;
    const store = new SealedFrames(() => now);
    store.fromCore(CARD);
    expect(store.size).toMatchObject({ cards: 1, channels: 0 });
    const first = store.mint(CARD.id, "button:allow_once")!.token;
    const seen = store.look(first);
    expect(seen?.card.id).toBe(CARD.id);
    expect(seen?.element).toBe("button:allow_once");
    expect(store.look("no-such-token")).toBeUndefined();
    const again = store.mint(CARD.id, "button:allow_once")!.token;
    expect(store.look(first)).toBeUndefined();
    expect(store.look(again)?.element).toBe("button:allow_once");
  });

  test("a store rejects what a card is not", () => {
    const store = new SealedFrames();
    store.fromCore({ id: "card_x", hash: "b".repeat(64) });
    expect(store.get("card_x")).toBeUndefined();
    store.fromCore({ id: "card_y", hash: "c".repeat(64), options: [{ id: "deny", kind: "deny", label: "Deny" }] });
    expect(store.get("card_y")?.options).toHaveLength(1);
  });

  test("the answer: signed over lane B's input, used once, only a button's own option; the element's other channel stays", () => {
    let now = 1_000;
    const store = new SealedFrames(() => now);
    store.fromCore(CARD);
    const made = store.mint(CARD.id, "button:deny")!;
    const out = store.buildAnswer(made.token, "deny", undefined, signer, "dev_aaaatestdev01");
    expect(out).not.toMatchObject({ error: expect.anything() });
    const { proof, card } = out as { proof: Record<string, unknown>; card: SealedCard };
    const sig = Buffer.from(proof.signature as string, "base64");
    expect([...sig]).toEqual([9, Buffer.byteLength(cardAnswerSigningInput({ id: CARD.id, hash: CARD.hash, option: "deny", at: 1_000, children: undefined }))]);
    expect(proof).toMatchObject({ option: "deny", device: "dev_aaaatestdev01", at: 1_000 });
    expect((proof.card as { id: string }).id).toBe(CARD.id);
    expect(card.fields).toEqual(CARD.fields);
    expect(store.buildAnswer(made.token, "deny", undefined, signer, "dev_02")).toMatchObject({ error: expect.anything() });
    expect(store.size).toMatchObject({ channels: 0 }); // the deny's channel went, and none else exists in this store.
  });

  test("a button answers its own option: named and minted independently", () => {
    const store = new SealedFrames();
    store.fromCore(CARD);
    const made = store.mint(CARD.id, "button:allow_once")!;
    expect(store.buildAnswer(made.token, "deny", undefined, signer, "dev_03")).toMatchObject({ error: "a button answers its own option" });
  });

  test("a field's frame answers nothing", () => {
    const store = new SealedFrames();
    store.fromCore(CARD);
    const made = store.mint(CARD.id, "field:title")!;
    expect(store.buildAnswer(made.token, "allow_once", undefined, signer, "dev_04")).toMatchObject({ error: "no such sealed button" });
  });

  test("a resolved card's frames end: the look and the mint give none, and an answer out of time says so (the core took the first)", () => {
    const store = new SealedFrames();
    store.fromCore(CARD);
    const made = store.mint(CARD.id, "button:allow_once")!;
    store.resolvedOutcome(CARD.id, "approved");
    expect(store.mint(CARD.id, "button:deny")).toBeUndefined();
    expect(store.look(made.token)).toBeUndefined();
    expect(store.buildAnswer(made.token, "allow_once", undefined, signer, "dev_05")).toMatchObject({ error: "no such sealed button" });
    expect(store.size).toMatchObject({ channels: 0 });
    // The resolved card's own copy is still there, for a display that still shows it (`card.get`).
    expect(store.get(CARD.id)?.hash).toBe(CARD.hash);
  });

  test("an expired channel answers nothing: the ttl is the answer's own, and a build out of it says so", () => {
    let now = 1_000;
    const store = new SealedFrames(() => now);
    store.fromCore(CARD);
    const made = store.mint(CARD.id, "button:deny")!;
    now += 70_000;
    expect(store.look(made.token)).toBeUndefined();
    expect(store.buildAnswer(made.token, "deny", undefined, signer, "dev_06")).toMatchObject({ error: "no such sealed button" });
    expect(store.size).toMatchObject({ channels: 1 }); // the expired channel stays until the next mint of the same element washes it.
  });

  test("a card the core withdrew loses all its channels at once", () => {
    const store = new SealedFrames();
    store.fromCore(CARD);
    const a = store.mint(CARD.id, "button:deny")!;
    const b = store.mint(CARD.id, "field:command")!;
    store.cancelled(CARD.id);
    expect(store.look(a.token)).toBeUndefined();
    expect(store.look(b.token)).toBeUndefined();
    expect(store.get(CARD.id)).toBeUndefined();
  });

  test("a card whose turn the user did not start rides its expiry; the user's own waits (the core's own clock holds it)", () => {
    // The store keeps the card's expiry; the app's fallback card and the display read `expiresAt` from it.
    let now = 400_000;
    const store = new SealedFrames(() => now);
    store.fromCore(TIMED_CARD);
    now = 500_000;
    expect(store.mint(TIMED_CARD.id, "button:deny")).toBeUndefined();
    store.fromCore(CARD);
    expect(store.mint(CARD.id, "button:deny")).not.toBeUndefined();
  });
});
