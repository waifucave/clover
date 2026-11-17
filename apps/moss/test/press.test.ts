// MOSS's press path (press.ts) end to end against the fake engine, whose `card.answer` checks the answer's Ed25519
// signature against the key MOSS registered for the `moss` program (FakeProgramAnswerKeys) and the router's placement:
// a press counts only with the fresh visibility reading, MOSS's own press record (main saw the press and the sealed
// frame's own trusted pointerdown named that frame), the stacking rule (placed in this window, the window in front), no
// the engine's own refusal while computer use acts said as it came, and MOSS's key registered. Each refusal is checked alone.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { programAnswerKeyStatement, programCardAnswerSigningInput } from "@waifucave/moss-protocol";
import { daemonEndpoint, dial, type DaemonClient } from "../src/main/client";
import { memoryVault, ProgramAnswerKey } from "../src/main/answer-key";
import { MossEngine } from "../src/main/engine";
import { mossHello } from "../src/main/connection";
import { PresenceReporter } from "../src/main/presence";
import { answerPress, cardHeight, CARD_MAX_HEIGHT, refusalWords, PressRecord, stackingRule, type PressDeps } from "../src/main/press";
import { OWN_ELEMENT, SealedFrames } from "../src/main/sealed";
import { FAKE_DEVICE, startFakeEngine, type FakeEngine } from "./fake-engine/engine";

const homes: string[] = [];
const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const until = async (what: () => boolean, ms = 2_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const WIN = 7;
const FRAME = "11:22";
const PARENT = { processId: 3, routingId: 4 };
const SENDER = "p:3:4";

interface Rig {
  e: FakeEngine;
  client: DaemonClient;
  sealed: SealedFrames;
  engine: MossEngine;
  key: ProgramAnswerKey;
  record: PressRecord;
  front: { focused: boolean };
  deps: PressDeps;
  /** A minted `own` frame for a card, with a fresh reading and a press that landed in it. */
  press(card: string, opts?: { fresh?: boolean | "none"; pressed?: boolean; frame?: string }): string;
}

async function rig(opts: { register?: boolean; surface?: "moss" | "code" } = {}): Promise<Rig> {
  const h = mkdtempSync(join(tmpdir(), "ma-"));
  homes.push(h);
  const e = await startFakeEngine({ home: h });
  closers.push(() => e.close());
  const client = (await dial(daemonEndpoint(h)))!;
  closers.push(() => client.close());
  await client.request("protocol.prove", { nonce: "n" });
  await client.request("protocol.hello", { ...mossHello(e.token, "0.124.0", 1), surface: opts.surface ?? "moss" });
  const sealed = new SealedFrames("moss");
  const engine = new MossEngine(sealed);
  client.onNotification((m, p) => engine.notification(m, p));
  engine.setConnection("connected");
  await engine.attach(client);
  const presence = new PresenceReporter(() => {}, 60_000);
  closers.push(() => presence.stop());
  presence.connected(client);
  presence.update({ focused: true, visible: true, showing: { kind: "bot", id: "juniper" } });
  await until(() => engine.view().cards.length === 2);
  const key = new ProgramAnswerKey(memoryVault());
  if (opts.register !== false) expect(await key.register(client, FAKE_DEVICE, () => true)).toEqual({ kind: "registered" });
  const record = new PressRecord();
  const front = { focused: true };
  const deps: PressDeps = {
    sealed, record, log: () => {},
    placementOf: (id) => engine.placementOf(id),
    standing: (w) => (w === WIN ? { window: "main", visible: true, focused: front.focused, minimized: false } : undefined),
    keyReady: (ms) => key.ready(ms),
    signer: key,
    device: () => FAKE_DEVICE,
    answer: (a) => client.request("card.answer", a),
  };
  return {
    e, client, sealed, engine, key, record, front, deps,
    press: (card, p = {}) => {
      const made = sealed.mint(card, OWN_ELEMENT, { parent: PARENT }, WIN)!;
      if (p.fresh !== "none") sealed.noteFresh(made.token, p.fresh ?? true);
      if (p.pressed !== false) {
        record.mouseDown(WIN);
        record.frameSaw(WIN, p.frame ?? FRAME);
      }
      return made.token;
    },
  };
}

const go = (r: Rig, token: string, option = "allow_once", frame = FRAME) => answerPress(r.deps, { token, option, senderKey: SENDER, frame, windowId: WIN });

describe("MOSS's answer key", () => {
  test("registers as the moss program, proved by its own signature", async () => {
    const r = await rig();
    expect(r.e.keys.keyOf(FAKE_DEVICE, "moss")?.publicKey).toBe(r.key.publicKey());
    expect(r.e.keys.keyOf(FAKE_DEVICE, "code")).toBeUndefined();
    const reg = r.e.calls().find((c) => c.method === "device.programKey.set")?.params as Record<string, unknown>;
    expect(reg).toMatchObject({ publicKey: r.key.publicKey(), held: "none", alg: "ed25519" });
    expect(programAnswerKeyStatement({ device: FAKE_DEVICE, program: "moss", publicKey: r.key.publicKey(), held: "none", alg: "ed25519" })).toStartWith("moss/program-answer-key/1\n");
  });
});

describe("a press on a card MOSS draws", () => {
  test("taken: the engine checks MOSS's signature and the card resolves", async () => {
    const r = await rig();
    expect(await go(r, r.press("card_juniper_book"))).toEqual({ accepted: true });
    const sent = r.e.calls().find((c) => c.method === "card.answer")?.params as { proof: Record<string, unknown> };
    expect(sent.proof).toMatchObject({ via: "device", device: FAKE_DEVICE, program: "moss" });
    expect(r.e.answered()).toEqual([{ id: "card_juniper_book", option: "allow_once", program: "moss" }]);
    await until(() => !r.engine.view().cards.some((c) => c.id === "card_juniper_book"));
  });

  test("the strip's card answers too: it is placed in this window", async () => {
    const r = await rig();
    expect(await go(r, r.press("card_kite_delete"), "deny")).toEqual({ accepted: true });
    expect(r.e.answered()[0]).toMatchObject({ id: "card_kite_delete", option: "deny" });
  });

  test("refused without the fresh visibility reading, or when it said covered", async () => {
    const r = await rig();
    expect(await go(r, r.press("card_juniper_book", { fresh: "none" }))).toMatchObject({ accepted: false });
    expect(await go(r, r.press("card_juniper_book", { fresh: false }))).toMatchObject({ accepted: false, reason: "the button wasn't fully showing when it was pressed" });
    expect(r.e.answered()).toEqual([]);
  });

  test("refused without MOSS's own press record of a press that landed in that frame", async () => {
    const r = await rig();
    expect(await go(r, r.press("card_juniper_book", { pressed: false }))).toMatchObject({ accepted: false, reason: "the press didn't come to this button" });
    // A press main saw land in another frame (the window's page, another card) is not this button's.
    expect(await go(r, r.press("card_juniper_book", { frame: "99:1" }))).toMatchObject({ accepted: false, reason: "the press didn't come to this button" });
    expect(r.e.answered()).toEqual([]);
  });

  test("one press answers once", async () => {
    const r = await rig();
    const token = r.press("card_juniper_book");
    // The same press, spent by a first answer that something else refused: no second answer rides it.
    r.e.setActing(true);
    expect(await go(r, token)).toMatchObject({ accepted: false, reason: "computer use is acting right now" });
    r.e.setActing(false);
    r.sealed.noteFresh(token, true);
    expect(await go(r, token)).toMatchObject({ accepted: false, reason: "the press didn't come to this button" });
  });

  test("refused when MOSS's window isn't in front, or the router placed the card elsewhere", async () => {
    const r = await rig();
    r.front.focused = false;
    expect(await go(r, r.press("card_juniper_book"))).toMatchObject({ accepted: false });
    r.front.focused = true;
    expect(stackingRule({ kind: "island" }, { window: "main", visible: true, focused: true, minimized: false })).toBe("the card is placed on the island");
    expect(stackingRule({ kind: "strip", program: "code", window: "main" }, { window: "main", visible: true, focused: true, minimized: false })).toBe("the card is placed in another window");
    expect(stackingRule({ kind: "conversation", program: "moss", window: "main" }, { window: "main", visible: true, focused: true, minimized: false })).toBeUndefined();
  });

  test("while computer use acts the engine refuses the answer, and MOSS says its refusal plainly; MOSS asks no computer.acting of its own", async () => {
    const r = await rig();
    const lines: string[] = [];
    r.e.setActing(true);
    const token = r.press("card_juniper_book");
    expect(await answerPress({ ...r.deps, log: (l) => lines.push(l) }, { token, option: "allow_once", senderKey: SENDER, frame: FRAME, windowId: WIN })).toEqual({ accepted: false, reason: "computer use is acting right now" });
    expect(lines.some((l) => l.includes("the engine refused the answer (computer use is acting right now)"))).toBe(true);
    // The card waits on, and the next press once it stops answers it.
    r.e.setActing(false);
    expect(await go(r, r.press("card_juniper_book"))).toEqual({ accepted: true });
    expect(r.e.calls().some((c) => c.method === "computer.acting")).toBe(false);
  });

  test("refused when one of our programs' windows lies over the click's own point (the overlap check); a key press isn't checked there", async () => {
    const r = await rig();
    const seen: { x: number; y: number }[] = [];
    const cover = (_w: number, point: { x: number; y: number } | undefined) => { if (point !== undefined) seen.push(point); return point === undefined ? undefined : "another MOSS program's window (layer 3)"; };
    const token = r.sealed.mint("card_juniper_book", OWN_ELEMENT, { parent: PARENT }, WIN)!.token;
    r.sealed.noteFresh(token, true);
    r.record.mouseDown(WIN, { x: 40, y: 60 });
    r.record.frameSaw(WIN, FRAME);
    const covered = await answerPress({ ...r.deps, cover }, { token, option: "allow_once", senderKey: SENDER, frame: FRAME, windowId: WIN });
    expect(covered).toEqual({ accepted: false, reason: "another MOSS window lies over the button: move it away and press again", covered: true });
    // What the person reads beside the card: what covers the button and what to do.
    if (covered.accepted) throw new Error("taken");
    expect(refusalWords(covered)).toBe("Another MOSS window lies over the button: move it away and press again.");
    expect(refusalWords({ reason: "computer use is acting right now" })).toBe("Computer use is acting right now.");
    expect(seen).toEqual([{ x: 40, y: 60 }]);
    expect(r.e.answered()).toEqual([]);
    // A key press: no point, so nothing over a point to find; it answers.
    const keyed = r.sealed.mint("card_juniper_book", OWN_ELEMENT, { parent: PARENT }, WIN)!.token;
    r.sealed.noteFresh(keyed, true);
    r.record.keyDown(WIN, FRAME);
    expect(await answerPress({ ...r.deps, cover }, { token: keyed, option: "allow_once", senderKey: SENDER, frame: FRAME, windowId: WIN })).toEqual({ accepted: true });
  });

  test("refused while MOSS's key isn't registered", async () => {
    const r = await rig({ register: false });
    expect(await go(r, r.press("card_juniper_book"))).toMatchObject({ accepted: false, reason: "this computer's answer key for MOSS isn't registered yet" });
  });

  test("a sender on another binding answers nothing", async () => {
    const r = await rig();
    const token = r.press("card_juniper_book");
    expect(await answerPress(r.deps, { token, option: "allow_once", senderKey: "p:9:9", frame: FRAME, windowId: WIN })).toMatchObject({ accepted: false, reason: "no such sealed button" });
  });

  test("the engine refuses an answer signed for another program", async () => {
    const r = await rig();
    const card = r.sealed.get("card_juniper_book")!;
    const at = Date.now();
    const asCode = r.key.sign(new TextEncoder().encode(programCardAnswerSigningInput({ program: "code", id: card.id, hash: card.hash, option: "allow_once", at })));
    const sig = Buffer.from(asCode).toString("base64");
    // Named as moss but signed over code's input: the signature fails.
    expect(await r.client.request("card.answer", { id: card.id, hash: card.hash, option: "allow_once", proof: { via: "device", device: FAKE_DEVICE, at, signature: sig, program: "moss" } })).toEqual({ accepted: false, reason: "the signature isn't this program's" });
    // Named as another program than the connection's, or not named: refused.
    expect(await r.client.request("card.answer", { id: card.id, hash: card.hash, option: "allow_once", proof: { via: "device", device: FAKE_DEVICE, at, signature: sig, program: "code" } })).toEqual({ accepted: false, reason: "the proof doesn't name this program" });
    expect(await r.client.request("card.answer", { id: card.id, hash: card.hash, option: "allow_once", proof: { via: "device", device: FAKE_DEVICE, at, signature: sig } })).toEqual({ accepted: false, reason: "the proof doesn't name this program" });
  });
});

describe("a card's frame height", () => {
  test("grows to its page's whole height, up to the cap; a report that only follows the frame (rounding) leaves it", () => {
    expect(cardHeight(undefined, 512.4)).toBe(512);
    expect(cardHeight(220, 1_340)).toBe(1_340);
    // The page fills its frame: it reports the frame's own height, or a pixel over. No creep.
    let h = 600;
    for (let i = 0; i < 50; i++) h = cardHeight(h, h + 1) ?? h;
    expect(h).toBe(600);
    expect(cardHeight(600, 600)).toBeUndefined();
    expect(cardHeight(600, 20_000)).toBe(CARD_MAX_HEIGHT);
    expect(cardHeight(undefined, 10)).toBe(60);
  });
});
