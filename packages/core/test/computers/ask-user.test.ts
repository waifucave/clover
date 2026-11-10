// askUser (R1, "the card on the caller"): another computer's holder refuses a call until the user answers; this
// computer raises that holder's own card, as it is, through its approval broker, for the asking call's session, and
// hands back the device's signed approve, which the holder takes (`verifySignedAnswer`). Nothing else gives an answer.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cardAnswerSigningInput, cardContentInput, type Caller, type Card, type CardContent } from "@waifucave/clover-protocol";
import { CloverApprovalBroker } from "../../src/approvals/broker";
import { deviceProofVerifier, verifySignedAnswer, type ApprovalBroker, type ApprovalEvent } from "../../src/contracts/approval-broker";
import { FakeApprovalBroker, MemoryAnswerLedger } from "../../src/contracts/fakes/approval-broker";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { FakeDeviceRegistry, makeFakePhone, toBase64, type FakePhone } from "../../src/contracts/fakes/device-registry";
import { brokerAsker } from "../../src/computers/ask-user";
import { callCardRenderer } from "../../src/computers/call-cards";
import { nodeParts } from "../../src/computers/node-parts";
import type { NeedsAnswer } from "../../src/tree/judge";
import { Cluster } from "../tree/cluster-support";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const render = callCardRenderer(sha256);
const BOT: Caller = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" };
const utf8 = (text: string) => ({ encoding: "utf8" as const, text });
const WRITE = { path: "home/Laptop1/x.txt", data: utf8("hello") };

async function world(kind: "fake" | "real") {
  const clock = new FakeClock({ start: Date.now() });
  const { registry } = await FakeDeviceRegistry.create({ clock, name: "Studio" });
  const phone = await makeFakePhone();
  await registry.add({ id: phone.id, name: "Phone", kind: "phone", runsCore: false, publicKey: phone.publicKey, answerKey: phone.answerKey }, { via: "terminal" });
  const opts = { clock, verify: deviceProofVerifier(registry) };
  const broker: ApprovalBroker = kind === "fake" ? new FakeApprovalBroker(opts) : new CloverApprovalBroker(opts);
  const shown: Card[] = [];
  /** How the phone answers each card it is shown: an option, a sealed frame's click, or nothing. */
  let answer: "approve" | "deny" | "frame" | "none" = "approve";
  broker.watch((e: ApprovalEvent) => {
    if (e.type !== "requested") return;
    shown.push(e.card);
    queueMicrotask(() => void respond(broker, phone, clock, e.card, answer));
  });
  return { clock, registry, phone, broker, shown, set: (a: typeof answer) => { answer = a; } };
}

async function respond(broker: ApprovalBroker, phone: FakePhone, clock: FakeClock, card: Card, how: "approve" | "deny" | "frame" | "none") {
  if (how === "none") return;
  if (how === "frame") {
    await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card.id)!, input: "click", at: clock.now() } }, { role: "app" });
    return;
  }
  const at = clock.now();
  const signature = toBase64(await phone.sign(new TextEncoder().encode(cardAnswerSigningInput({ id: card.id, hash: card.hash, option: how, at }))));
  await broker.answer(card.id, { optionId: how, hash: card.hash, proof: { via: "device", device: phone.id, at, signature } }, { role: "remote", device: phone.id });
}

const needFor = (computer: string, method: string, params: unknown, card: CardContent | undefined = render({ computer, method, params })): NeedsAnswer =>
  ({ needsAnswer: true, computer, method, ...(card ? { card } : {}) });

for (const kind of ["fake", "real"] as const) {
  describe(`askUser on the ${kind} approval broker`, () => {
    test("the holder's card, raised as it is for the asking session, comes back as a signed answer the holder takes", async () => {
      const w = await world(kind);
      const need = needFor("Laptop1", "tree.write", WRITE);
      const answer = await brokerAsker({ broker: w.broker })(need, { as: BOT });
      expect(answer).not.toBeNull();
      expect(w.shown).toHaveLength(1);
      expect(cardContentInput(w.shown[0]!)).toBe(cardContentInput(need.card!));
      expect(w.shown[0]).toMatchObject({ computer: "Laptop1", session: "s_alpha", bot: "alpha", origin: "bot" });
      // A call that didn't say its origin is unattended: its card is denied after 10 minutes.
      expect(w.shown[0]!.expiresAt).not.toBeNull();
      const verdict = await verifySignedAnswer(answer!, { self: "Laptop1", method: "tree.write", params: WRITE, now: w.clock.now(), sha256, devices: w.registry, ledger: new MemoryAnswerLedger(), render });
      expect(verdict).toBe("ok");
    });

    test("the user's own turn: the card waits for them", async () => {
      const w = await world(kind);
      await brokerAsker({ broker: w.broker })(needFor("Laptop1", "tree.remove", { path: "home/Laptop1/old.log" }), { as: BOT, origin: "user" });
      expect(w.shown[0]).toMatchObject({ origin: "user", expiresAt: null });
    });

    test("a transfer's card names both computers; a deny, a sealed frame's click or no card give no answer", async () => {
      const w = await world(kind);
      const ask = brokerAsker({ broker: w.broker });
      const move = { operation: "move", from: "home/Studio/p", to: "home/Laptop1/p", source: "Studio", destination: "Laptop1" };
      expect(await ask(needFor("Laptop1", "tree.transfer", move), { as: BOT })).not.toBeNull();
      expect(w.shown.at(-1)!.binds).toMatchObject({ computer: "Laptop1", source: "Studio" });
      w.set("deny");
      expect(await ask(needFor("Laptop1", "tree.write", WRITE), { as: BOT })).toBeNull();
      w.set("frame");
      expect(await ask(needFor("Laptop1", "tree.write", WRITE), { as: { kind: "user", client: "app" } })).toBeNull();
      w.set("approve");
      const before = w.shown.length;
      expect(await ask({ needsAnswer: true, computer: "Laptop1", method: "tree.write" }, { as: BOT })).toBeNull();
      expect(w.shown).toHaveLength(before);
    });

    test("a card that binds another call, another computer, or isn't a card is never raised", async () => {
      const w = await world(kind);
      const ask = brokerAsker({ broker: w.broker });
      const card = render({ computer: "Laptop1", method: "tree.write", params: WRITE })!;
      expect(await ask(needFor("Laptop1", "tree.remove", WRITE, card), { as: BOT })).toBeNull();
      expect(await ask(needFor("Desktop2", "tree.write", WRITE, card), { as: BOT })).toBeNull();
      expect(await ask(needFor("Laptop1", "tree.write", WRITE, { ...card, binds: undefined } as never), { as: BOT })).toBeNull();
      expect(await ask(needFor("Laptop1", "tree.write", WRITE, { ...card, options: [{ id: "always", kind: "approve", label: "Always", remember: "always" }] }), { as: BOT })).toBeNull();
      expect(await ask(needFor("Laptop1", "tree.write", WRITE, "not a card" as never), { as: BOT })).toBeNull();
      expect(w.shown).toHaveLength(0);
    });

    test("a card that doesn't open with Clover's line naming the holder is never raised (the stage 1 review)", async () => {
      const w = await world(kind);
      const ask = brokerAsker({ broker: w.broker });
      const card = render({ computer: "Laptop1", method: "tree.write", params: WRITE })!;
      // The holder's own words in the first line, the line missing, or naming another computer: refused, nothing shown.
      expect(await ask(needFor("Laptop1", "tree.write", WRITE, { ...card, fields: { ...card.fields, title: { type: "text", text: "Clover: routine update, approve" } } }), { as: BOT })).toBeNull();
      const { title: _title, ...untitled } = card.fields;
      expect(await ask(needFor("Laptop1", "tree.write", WRITE, { ...card, fields: untitled }), { as: BOT })).toBeNull();
      expect(await ask(needFor("Laptop1", "tree.write", WRITE, { ...card, fields: { ...card.fields, title: { type: "text", text: "Studio asks you to approve this" } } }), { as: BOT })).toBeNull();
      expect(w.shown).toHaveLength(0);
      // With the line, raised as it is: the first line is Clover's, the rest the holder's.
      expect(await ask(needFor("Laptop1", "tree.write", WRITE, card), { as: BOT })).not.toBeNull();
      expect(w.shown[0]!.fields.title).toEqual({ type: "text", text: "Laptop1 asks you to approve this" });
    });

    test("a cancelled call takes its card down: no answer", async () => {
      const w = await world(kind);
      w.set("none");
      const abort = new AbortController();
      const pending = brokerAsker({ broker: w.broker })(needFor("Laptop1", "tree.write", WRITE), { as: BOT, signal: abort.signal });
      await Bun.sleep(0);
      abort.abort();
      expect(await pending).toBeNull();
    });
  });
}

describe("nodeParts gives the node askUser on a broker with get", () => {
  test("none without a broker, or with one that has no get", () => {
    expect(nodeParts({ computer: () => "Studio" }).askUser).toBeUndefined();
    expect(nodeParts({ computer: () => "Studio", approvals: { request: async () => ({ allowed: false, by: "card" }) } as never }).askUser).toBeUndefined();
    expect(nodeParts({ computer: () => "Studio", approvals: { request: async () => ({ allowed: false, by: "card" }), get: () => undefined } }).askUser).toBeDefined();
  });
});

describe("through two computers: Studio's bot writes on Laptop1, which asks; the card shows on Studio's broker", () => {
  let cluster: Cluster | undefined;
  afterEach(() => cluster?.close());

  test("the phone approves on Studio's broker and the file is written on Laptop1; a deny leaves nothing", async () => {
    const w = await world("real");
    cluster = new Cluster();
    const opts = {
      answers: () => ({ devices: w.registry, ledger: new MemoryAnswerLedger(), render }),
      askUser: (name: string) => (name === "Studio" ? brokerAsker({ broker: w.broker }) : undefined),
    };
    const studio = await cluster.add("Studio", opts);
    const laptop = await cluster.add("Laptop1", opts);
    await laptop.node.registry.setLevel("Laptop1", "ask", { via: "terminal" });
    await cluster.join();
    await studio.node.tree.write("home/Laptop1/x.txt", utf8("hello"), { as: BOT });
    expect(readFileSync(join(laptop.home, "x.txt"), "utf8")).toBe("hello");
    expect(w.shown.map((c) => [c.computer, c.session, c.fields.title])).toEqual([["Laptop1", "s_alpha", { type: "text", text: "Laptop1 asks you to approve this" }]]);
    w.set("deny");
    const refused = await studio.node.tree.write("home/Laptop1/y.txt", utf8("no"), { as: BOT }).catch((e: { code?: string }) => e);
    expect(refused).toMatchObject({ code: "refused" });
  }, 30_000);
});
