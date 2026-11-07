// The sealed frames' pure store (`sealed.ts`): a card with its sealed fields in, its frames' single-use channels bound
// to their own frames, and one answer per button — a `{via:"device", device, at, signature}` proof, marks resolved at
// the core's own answer (spec §5.5).
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
const TIMED_CARD: SealedCard = { ...CARD, id: "card_timed", origin: "routine", expiresAt: 300_000 };

const signer: AnswerSigner = { sign: (m) => new Uint8Array([9, m.length & 0xff]) };
const doc: { processId: number; routingId: number } = { processId: 100, routingId: 200 };
const parent = { parent: doc };
const main0 = { main: { processId: 1, routingId: 2 } };

describe("the sealed frames' store", () => {
  test("a card in, its elements' channels minted and looked up, one each; a mint replaces the element's older token", () => {
    const store = new SealedFrames();
    store.fromCore(CARD);
    expect(store.size).toMatchObject({ cards: 1, channels: 0 });
    const first = store.mint(CARD.id, "button:allow_once", parent)!.token;
    const again = store.mint(CARD.id, "button:allow_once", parent)!.token;
    expect(first).toMatch(/^se_[0-9a-f]{40}$/);
    expect(store.buildAnswer(first, "allow_once", undefined, "p:100:200", signer, "dev_a")).toMatchObject({ error: "no such sealed button" });
    expect(store.buildAnswer(again, "allow_once", undefined, "p:100:200", signer, "dev_a")).not.toMatchObject({ error: expect.anything() });
  });

  test("a store rejects what a card is not", () => {
    const store = new SealedFrames();
    store.fromCore({ id: "card_x", hash: "b".repeat(64) });
    expect(store.get("card_x")).toBeUndefined();
    store.fromCore({ id: "card_y", hash: "c".repeat(64), options: [{ id: "deny", kind: "deny", label: "Deny" }] });
    expect(store.get("card_y")?.options).toHaveLength(1);
  });

  test("the answer: the {via:'device'} proof, signed over lane B's input, wrong sender refused entirely", () => {
    const store = new SealedFrames();
    store.fromCore(CARD);
    const made = store.mint(CARD.id, "button:deny", parent)!;
    // Another frame's sender: refused (B4), even with the card's own option.
    expect(store.buildAnswer(made.token, "deny", undefined, "p:999:999", signer, "dev_a")).toMatchObject({ error: "no such sealed button" });
    const out = store.buildAnswer(made.token, "deny", undefined, "p:100:200", signer, "dev_aaaatestdev01");
    expect(out).not.toMatchObject({ error: expect.anything() });
    const { proof, card, kids } = out as { proof: { via: string; device: string; at: number; signature: string }; card: SealedCard; kids?: string[] };
    expect(proof).toEqual({ via: "device", device: "dev_aaaatestdev01", at: expect.any(Number), signature: expect.any(String) });
    const sig = Buffer.from(proof.signature, "base64");
    expect([...sig]).toEqual([9, Buffer.byteLength(cardAnswerSigningInput({ id: CARD.id, hash: CARD.hash, option: "deny", at: proof.at, children: undefined }))]);
    expect(card.fields).toEqual(CARD.fields);
    expect(kids).toBeUndefined();
    // The core's own answer closes it: answered already, its next channel's gone.
    store.confirmedAnswer(CARD.id, true);
    expect(store.mint(CARD.id, "button:allow_once", parent)).toBeUndefined();
    expect(store.get(CARD.id)?.hash).toBe(CARD.hash);
  });

  test("the core refused: the card can answer again from this desktop (S6)", () => {
    const store = new SealedFrames();
    store.fromCore(CARD);
    const made = store.mint(CARD.id, "button:deny", parent)!;
    expect(store.buildAnswer(made.token, "deny", undefined, "p:100:200", signer, "dev_a")).not.toMatchObject({ error: expect.anything() });
    store.confirmedAnswer(CARD.id, false);
    const again = store.mint(CARD.id, "button:allow_once", parent);
    expect(again).not.toBeUndefined();
  });

  test("a button answers its own option: named and minted independently", () => {
    const store = new SealedFrames();
    store.fromCore(CARD);
    const made = store.mint(CARD.id, "button:allow_once", parent)!;
    expect(store.buildAnswer(made.token, "deny", undefined, "p:100:200", signer, "dev_a")).toMatchObject({ error: "a button answers its own option" });
  });

  test("a field's frame answers nothing", () => {
    const store = new SealedFrames();
    store.fromCore(CARD);
    const made = store.mint(CARD.id, "field:title", parent)!;
    expect(store.buildAnswer(made.token, "allow_once", undefined, "p:100:200", signer, "dev_a")).toMatchObject({ error: "a field's frame answers nothing" });
  });

  test("the serving: once per token, on an iframe's load, and the ttl is the serve's alone (S5)", () => {
    const store = new SealedFrames();
    store.fromCore(CARD);
    const made = store.mint(CARD.id, "field:title", parent)!;
    expect(store.serve(made.token)?.element).toBe("field:title");
    expect(store.serve(made.token)).toBeUndefined();
  });

  test("a reader takes their time: the answer's own band runs an hour from the mint, the serve's from the serve", () => {
    let now = 1_000;
    const store = new SealedFrames(() => now);
    store.fromCore(CARD);
    const made = store.mint(CARD.id, "button:deny", parent)!;
    expect(store.serve(made.token)).toBeDefined();
    now += 61_000; // past the serve's ttl, inside the answer's hour: the page's own answer stands.
    expect(store.serve(made.token)).toBeUndefined();
    expect(store.buildAnswer(made.token, "deny", undefined, "p:100:200", signer, "dev_a")).not.toMatchObject({ error: expect.anything() });
    expect(store.serve(made.token)).toBeUndefined();
  });

  test("an expired channel answers nothing", () => {
    let now = 1_000;
    const store = new SealedFrames(() => now);
    store.fromCore(CARD);
    const made = store.mint(CARD.id, "button:deny", parent)!;
    now += 62 * 60_000;
    expect(store.buildAnswer(made.token, "deny", undefined, "p:100:200", signer, "dev_a")).toMatchObject({ error: "no such sealed button" });
  });

  test("a card the core withdrew loses all its channels at once", () => {
    const store = new SealedFrames();
    store.fromCore(CARD);
    const a = store.mint(CARD.id, "button:deny", parent)!;
    const b = store.mint(CARD.id, "field:command", parent)!;
    store.cancelled(CARD.id);
    expect(store.buildAnswer(a.token, "deny", undefined, "p:100:200", signer, "dev_a")).toMatchObject({ error: "no such sealed button" });
    expect(store.buildAnswer(b.token, "allow_once", undefined, "p:100:200", signer, "dev_a")).toMatchObject({ error: "no such sealed button" });
    expect(store.get(CARD.id)).toBeUndefined();
  });

  test("a card past a non-user turn's expiry mints none; the user's own waits", () => {
    const store = new SealedFrames();
    store.fromCore(TIMED_CARD);
    store.fromCore(CARD);
    let now = 400_000;
    expect(store.mint(TIMED_CARD.id, "button:deny", parent)).toBeUndefined();
    now = 500_000;
    expect(store.mint(CARD.id, "button:deny", parent)).not.toBeUndefined();
  });

  test("the app's own fallback card's channel: one token for the whole page, bound to its window's main frame, the pick checked like any button's", () => {
    const store = new SealedFrames();
    store.fromCore(CARD);
    expect(store.mint(CARD.id, "own", main0)).not.toBeUndefined();
    // The sender must be the window's own main frame (B4).
    const made = store.mint(CARD.id, "own", main0)!;
    expect(store.buildAnswer(made.token, "deny", undefined, "p:100:200", signer, "dev_a")).toMatchObject({ error: "no such sealed button" });
    const out = store.buildAnswer(made.token, "allow_once", undefined, "m:1:2", signer, "dev_aaaatestdev01");
    expect(out).not.toMatchObject({ error: expect.anything() });
  });
});
