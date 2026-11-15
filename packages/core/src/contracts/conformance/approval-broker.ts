// The ApprovalBroker conformance suite (review S15). `runApprovalBrokerConformance(make)` registers every case against the
// implementation `make` builds; `tests/approval-broker.test.ts` runs it against FakeApprovalBroker, and the lane that writes the real
// one runs it there through a harness with the same drivers. What it pins:
// rules 1–9 of approval-broker.ts, the card's hash and
// meta, and answers by sealed frame and by a paired device's signature.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  LEVELS, TreeTransferParams, UNATTENDED_CARD_TIMEOUT_MS, callBindingInput, cardAnswerSigningInput, cardContentInput, cardHashInput, type Card,
  type CardAnswerProof, type Level, type SignedCardAnswer,
} from "@waifucave/clover-protocol";
import {
  ACTION_EFFECTS, CALL_CARD_METHODS, DECISION_RANK, acpOutcomeFor, bindsComputer, boundCardRecord, callBindingOf, cardMetaOf, deviceProofVerifier, levelDecision, strictestLevel,
  verifySignedAnswer, type CallCardRenderer,
  type AgentPermissionOption, type AnswerOrigin, type ApprovalDecision, type ApprovalEvent, type ApprovalRequest,
} from "../approval-broker";
import { type FakeApprovalBroker, MemoryAnswerLedger } from "../fakes/approval-broker";
import { FakeClock, flush } from "../fakes/clock";
import { FakeDeviceRegistry, makeFakeDevice, makeFakePhone, toBase64, type FakeDevice } from "../fakes/device-registry";
import { FakeFence } from "../fakes/fence";
import { levelRaiseCall } from "../computer-registry";
import { transferBinding, transferChange } from "../tree";

/** SHA-256 of R15's pinned call (`tree.transfer`, a move of home/Laptop1/proj to home/Studio/proj). */
const TRANSFER_VECTOR_SHA256 = "a5b927c08f4cf12445673e2d2f18a2649c7c3e751f45bf15b0b71a87bc1851f5";

/** What the suite drives: the contract and the fake's own drivers (what a test does to the world around it),
 *  as public members, so a real implementation's harness can provide them. */
export type ApprovalBrokerHarness = Pick<FakeApprovalBroker, keyof FakeApprovalBroker>;
/** Builds the implementation under test from the options the fake takes. */
export type ApprovalBrokerFactory = (...args: ConstructorParameters<typeof FakeApprovalBroker>) => ApprovalBrokerHarness;

export function runApprovalBrokerConformance(make: ApprovalBrokerFactory): void {
  const APP: AnswerOrigin = { role: "app" };
  /** A proof naming a channel no one minted: fine where the answer is refused before the proof is looked at. */
  const FRAME: CardAnswerProof = { via: "sealed-frame", frame: "frame-1", input: "click", at: 1 };
  /** A sealed frame's answer: the app has the core mint the card's channel, then the click arrives on it. */
  const viaFrame = (broker: ApprovalBrokerHarness, card: Card): CardAnswerProof => ({ via: "sealed-frame", frame: broker.frameChannel(card.id)!, input: "click", at: 1 });
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

  function bash(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
    return {
      kind: "tool", session: "s_alpha", bot: "alpha", origin: "user", computers: ["Studio"], effect: "execute",
      fields: { title: { type: "text", text: "Run a command" }, command: { type: "code", code: "git push", language: "sh" } },
      ...over,
    };
  }

  function setup(opts: { levels?: Record<string, Level>; reviewer?: "safe" | "risky" | "unavailable"; fenced?: boolean } = {}) {
    const clock = new FakeClock();
    const fence = new FakeFence({ home: "/Users/me", cloverHome: "/Users/me/.clover" });
    const broker = make({
      clock,
      levels: (c) => opts.levels?.[c] ?? "ask-risky",
      ...(opts.fenced === false ? {} : { fence: () => fence }),
      ...(opts.reviewer ? { reviewer: async () => opts.reviewer! } : {}),
    });
    const events: ApprovalEvent[] = [];
    broker.watch((e) => events.push(e));
    return { clock, broker, events };
  }

  /** Starts a request that should show a card, and returns the card and the pending decision. */
  async function carded(broker: ApprovalBrokerHarness, req: ApprovalRequest, signal?: AbortSignal): Promise<{ card: Card; decision: Promise<ApprovalDecision> }> {
    const decision = broker.request(req, signal ? { signal } : {});
    await flush();
    const card = broker.cards().at(-1);
    if (!card) throw new Error(`no card: decided ${JSON.stringify(await decision)}`);
    return { card, decision };
  }

  describe("the level table (§9.1)", () => {
    test("reads run freely at every level", () => {
      for (const level of LEVELS) for (const effect of ["read", "search", "think"] as const) expect(levelDecision(level, effect)).toBe("allow");
    });

    test("each level, effect by effect", () => {
      const row = (level: Level) => Object.fromEntries(ACTION_EFFECTS.map((e) => [e, levelDecision(level, e)]));
      expect(row("read-only")).toMatchObject({ edit: "deny", execute: "deny", delete: "deny", screen: "deny" });
      expect(row("ask")).toMatchObject({ edit: "ask", execute: "ask", fetch: "ask", delete: "ask" });
      expect(row("ask-risky")).toMatchObject({ edit: "review", execute: "review", fetch: "review", move: "review", delete: "ask", purchase: "ask", screen: "ask" });
      expect(levelDecision("ask-risky", "screen", true)).toBe("allow");
      // A contained call (an ordinary file, a page the session already saw, an admitted agent, a command its sandbox
      // holds) runs at ask-risky; a delete, a purchase and screen control outside its own windows are never contained.
      const contained = (level: Level) => Object.fromEntries(ACTION_EFFECTS.map((e) => [e, levelDecision(level, e, false, true)]));
      expect(contained("ask-risky")).toMatchObject({ edit: "allow", move: "allow", fetch: "allow", other: "allow", execute: "allow", delete: "ask", purchase: "ask", screen: "ask" });
      expect(contained("ask")).toMatchObject({ edit: "ask", fetch: "ask", other: "ask" });
      expect(contained("read-only")).toMatchObject({ edit: "deny", fetch: "deny", other: "deny" });
      // accept-edits is ask-risky plus edits and moves: a command is judged as at ask-risky.
      expect(row("accept-edits")).toMatchObject({ edit: "allow", move: "allow", execute: "review", fetch: "review", delete: "ask", purchase: "ask", screen: "ask" });
      expect(new Set(Object.values(row("automatic")))).toEqual(new Set(["allow"]));
    });

    test("the levels form a total order: each allows everything the one before it does, effect by effect", () => {
      for (let i = 1; i < LEVELS.length; i++) {
        for (const effect of ACTION_EFFECTS) {
          for (const own of [false, true]) {
            for (const contained of [false, true]) {
              const stricter = DECISION_RANK[levelDecision(LEVELS[i - 1]!, effect, own, contained)];
              const laxer = DECISION_RANK[levelDecision(LEVELS[i]!, effect, own, contained)];
              expect([LEVELS[i], effect, own, contained, laxer >= stricter]).toEqual([LEVELS[i], effect, own, contained, true]);
            }
          }
        }
      }
      // So the strictest level of a move between computers is the one that lets through least, for every effect.
      expect(strictestLevel(["ask-risky", "accept-edits"])).toBe("ask-risky");
    });

    test("read-only is absolute: no saved rule, fenced-path card or reviewer lets anything but a read through", async () => {
      const { broker } = setup({ levels: { Studio: "ask-risky", Vault: "read-only" } });
      const { card } = await carded(broker, bash({ ruleKey: "Bash(git push:*)" }));
      expect(await broker.answer(card.id, { optionId: "always", hash: card.hash, proof: viaFrame(broker, card) }, APP)).toBe("accepted");
      expect(await broker.request(bash({ ruleKey: "Bash(git push:*)" }))).toEqual({ allowed: true, by: "rule" });
      expect(await broker.request(bash({ ruleKey: "Bash(git push:*)", computers: ["Vault"] }))).toEqual({ allowed: false, by: "level", level: "read-only" });
      expect(await broker.request(bash({ effect: "edit", computers: ["Vault"], paths: ["/Users/me/.clover/settings/settings.json"] }))).toEqual({ allowed: false, by: "level", level: "read-only" });
      expect(await broker.request(bash({ effect: "read", computers: ["Vault"] }))).toEqual({ allowed: true, by: "level", level: "read-only" });
      expect(broker.cards()).toEqual([]);
    });

    test("the strictest level judges", () => {
      expect(strictestLevel(["automatic", "ask", "accept-edits"])).toBe("ask");
      expect(strictestLevel([])).toBeUndefined();
    });
  });

  describe("ApprovalBroker", () => {
    test("rule 5: a level allows or denies at once, and the reviewer judges at ask-risky", async () => {
      expect(await setup({ levels: { Studio: "automatic" } }).broker.request(bash())).toEqual({ allowed: true, by: "level", level: "automatic" });
      expect(await setup({ levels: { Studio: "read-only" } }).broker.request(bash())).toEqual({ allowed: false, by: "level", level: "read-only" });
      expect(await setup({ reviewer: "safe" }).broker.request(bash())).toEqual({ allowed: true, by: "level", level: "ask-risky" });
      const { broker } = setup({ reviewer: "risky" });
      void broker.request(bash());
      await flush();
      expect(broker.cards()).toHaveLength(1);
    });

    test("rule 5: with no reviewer model, ask-risky asks", async () => {
      const { broker } = setup();
      void broker.request(bash());
      await flush();
      expect(broker.cards()).toHaveLength(1);
    });

    test("rule 5: a move between computers takes the stricter level; a routine's own level replaces them", async () => {
      const { broker } = setup({ levels: { Studio: "automatic", Laptop1: "read-only" } });
      expect(await broker.request(bash({ computers: ["Studio", "Laptop1"], effect: "move" }))).toMatchObject({ allowed: false, level: "read-only" });
      expect(await broker.request(bash({ computers: ["Laptop1"], level: "automatic", origin: "routine" }))).toMatchObject({ allowed: true, level: "automatic" });
    });

    test("rule 1: changes, confirms, plugin OKs and elicitations are always cards, even at automatic", async () => {
      const { broker } = setup({ levels: { Studio: "automatic" } });
      void broker.request(bash({ kind: "change", change: "computer-level", effect: "other" }));
      void broker.request(bash({ kind: "confirm", pluginId: "weather", origin: "plugin", effect: "other" }));
      void broker.request(bash({ kind: "plugin-ok", pluginId: "luna", effect: "other" }));
      void broker.request(bash({
        kind: "elicitation", effect: "fetch",
        fields: { host: { type: "text", text: "accounts.example.com" }, command: { type: "code", code: "https://accounts.example.com/device?code=XYZ" } },
      }));
      await flush();
      expect(broker.cards().map((c) => c.kind)).toEqual(["change", "confirm", "plugin-ok", "elicitation"]);
    });

    test("rule 1: an always-card kind never offers always, whatever the requester passes (review minor)", async () => {
      const { broker } = setup({ levels: { Studio: "automatic" } });
      const always = { id: "always", kind: "approve" as const, label: "Always allow", remember: "always" as const };
      for (const kind of ["change", "confirm", "plugin-ok", "elicitation"] as const) {
        const { card } = await carded(broker, bash({ kind, change: "computer-level", pluginId: "luna", effect: "other", ruleKey: "anything" }));
        expect([kind, card.options.some((o) => o.remember !== undefined)]).toEqual([kind, false]);
        const passed = await carded(broker, bash({ kind, change: "computer-level", pluginId: "luna", effect: "other", options: [...card.options, always] }));
        expect([kind, passed.card.options.map((o) => o.id)]).toEqual([kind, card.options.map((o) => o.id)]);
      }
    });

    test("rule 2: the bridge's own tools on the session's bridge are allowed at once, on an exact match only", async () => {
      const { broker } = setup({ levels: { Studio: "ask" } });
      const options: AgentPermissionOption[] = [{ optionId: "a", name: "Allow", kind: "allow_once" }, { optionId: "r", name: "Reject", kind: "reject_once" }];
      const agent = (server: string, tool: string) => bash({
        kind: "agent-permission", effect: "other",
        agent: { backend: "cursor", toolCallId: "t1", toolKind: "other", title: "clover-bridge-SendMessage: SendMessage", mcp: { server, tool }, bridge: { server: "clover-bridge", tools: ["SendMessage", "Glossary"] }, options },
      });
      expect(await broker.request(agent("clover-bridge", "SendMessage"))).toEqual({ allowed: true, by: "bridge" });
      void broker.request(agent("clover-bridge-2", "SendMessage"));
      void broker.request(agent("clover-bridge", "Bash"));
      await flush();
      expect(broker.cards()).toHaveLength(2);
    });

    test("rule 3: a fenced path is always a card, at every level, and no saved rule covers it", async () => {
      const { broker } = setup({ levels: { Studio: "automatic" } });
      void broker.request(bash({ kind: "agent-permission", effect: "edit", paths: ["/Users/me/.clover/settings/settings.json"], ruleKey: "Edit(*)" }));
      await flush();
      expect(broker.cards()).toHaveLength(1);
      expect(await broker.request(bash({ effect: "edit", paths: ["/Users/me/project/a.ts"] }))).toMatchObject({ allowed: true, by: "level" });
    });

    test("rule 3: a write where a file runs later outside any sandbox is refused without a card, at every level", async () => {
      const { broker } = setup({ levels: { Studio: "automatic" } });
      expect(await broker.request(bash({ effect: "edit", paths: ["/Users/me/.zshrc"] }))).toEqual({ allowed: false, by: "fence" });
      expect(await broker.request(bash({ effect: "delete", paths: ["/Users/me/project/a.ts", "/Users/me/Library/LaunchAgents/x.plist"] }))).toEqual({ allowed: false, by: "fence" });
      expect(await broker.request(bash({ kind: "agent-permission", effect: "edit", paths: ["/Users/me/.codex/config.toml"], ruleKey: "Edit(*)" }))).toEqual({ allowed: false, by: "fence" });
      expect(broker.cards()).toHaveLength(0);
      // Next to them is free; reading one, or a command naming one (the sandbox holds its writes), is rule 3's card.
      expect(await broker.request(bash({ effect: "edit", paths: ["/Users/me/.zshrc.bak"] }))).toMatchObject({ allowed: true, by: "level" });
      void broker.request(bash({ effect: "read", paths: ["/Users/me/.zshrc"] }));
      void broker.request(bash({ effect: "execute", paths: ["/Users/me/.zshrc"] }));
      await flush();
      expect(broker.cards()).toHaveLength(2);
    });

    test("rule 4: a card's always saves Clover's own rule for those computers", async () => {
      const { broker } = setup();
      const { card, decision } = await carded(broker, bash({ ruleKey: "Bash(git push:*)" }));
      expect(card.options.map((o) => o.id)).toEqual(["approve", "always", "deny"]);
      expect(await broker.answer(card.id, { optionId: "always", hash: card.hash, proof: viaFrame(broker, card) }, APP)).toBe("accepted");
      expect(await decision).toEqual({ allowed: true, by: "card", cardId: card.id, optionId: "always", remembered: true });
      expect(broker.rules()).toMatchObject([{ ruleKey: "Bash(git push:*)", computers: ["Studio"], cardId: card.id }]);
      expect(await broker.request(bash({ ruleKey: "Bash(git push:*)" }))).toEqual({ allowed: true, by: "rule" });
      void broker.request(bash({ ruleKey: "Bash(git push:*)", computers: ["Laptop1"] }));
      await flush();
      expect(broker.cards()).toHaveLength(1);
    });

    test("rule 6: a card from a turn the user didn't start is denied 10 minutes after it was issued", async () => {
      const { clock, broker, events } = setup();
      const { card, decision } = await carded(broker, bash({ origin: "routine" }));
      expect(card.expiresAt).toBe(card.issuedAt + UNATTENDED_CARD_TIMEOUT_MS);
      clock.advance(UNATTENDED_CARD_TIMEOUT_MS - 1);
      await flush();
      expect(broker.cards()).toHaveLength(1);
      clock.advance(1);
      expect(await decision).toEqual({ allowed: false, by: "expired", cardId: card.id });
      expect(events.at(-1)).toEqual({ type: "resolved", cardId: card.id, outcome: "expired" });
      expect(await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: FRAME }, APP)).toBe("already-answered");
    });

    test("rule 6: one from the user's own turn waits; a plugin's confirm never does", async () => {
      const { clock, broker } = setup();
      const { card } = await carded(broker, bash());
      expect(card.expiresAt).toBeNull();
      clock.advance(UNATTENDED_CARD_TIMEOUT_MS * 6);
      await flush();
      expect(broker.cards()).toHaveLength(1);
      const confirm = await carded(broker, bash({ kind: "confirm", pluginId: "weather", origin: "user", effect: "other" }));
      expect(confirm.card.expiresAt).not.toBeNull();
    });

    test("rule 6: a plugin's OK never expires, however the plugin was found (review minor)", async () => {
      const { clock, broker } = setup();
      const { card } = await carded(broker, bash({ kind: "plugin-ok", pluginId: "luna", origin: "bot", effect: "other" }));
      expect(card.expiresAt).toBeNull();
      clock.advance(UNATTENDED_CARD_TIMEOUT_MS * 6);
      await flush();
      expect(broker.cards().map((c) => c.id)).toEqual([card.id]);
    });

    test("rule 7: the user's interrupt withdraws the session's cards; a stop or an abort cancels them", async () => {
      const { broker } = setup();
      const a = await carded(broker, bash());
      const b = await carded(broker, bash({ session: "s_other" }));
      expect(broker.withdrawSession("s_alpha")).toBe(1);
      expect(await a.decision).toMatchObject({ allowed: false, by: "withdrawn" });
      expect(broker.cancelSession("s_other")).toBe(1);
      expect(await b.decision).toMatchObject({ allowed: false, by: "cancelled" });
      const abort = new AbortController();
      const c = await carded(broker, bash(), abort.signal);
      abort.abort();
      expect(await c.decision).toMatchObject({ allowed: false, by: "cancelled" });
      expect(await broker.request(bash(), { signal: abort.signal })).toEqual({ allowed: false, by: "cancelled" });
    });

    test("rule 7: the first answer wins; a wrong hash, option, origin, frame or proof is refused", async () => {
      const clock = new FakeClock();
      const broker = make({ clock });
      const { card, decision } = await carded(broker, bash());
      const phone = "phone0000000000000";
      const device: CardAnswerProof = { via: "device", device: phone, at: clock.now(), signature: "AAAA" };
      expect(await broker.answer("card_unknown1", { optionId: "approve", hash: card.hash, proof: FRAME }, APP)).toBe("unknown-card");
      expect(await broker.answer(card.id, { optionId: "approve", hash: "0".repeat(64), proof: FRAME }, APP)).toBe("hash-mismatch");
      expect(await broker.answer(card.id, { optionId: "maybe", hash: card.hash, proof: FRAME }, APP)).toBe("bad-option");
      expect(await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: FRAME, children: ["luna"] }, APP)).toBe("bad-option");
      // A sealed frame counts only through the app, on the channel minted for this card.
      expect(await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: FRAME }, APP)).toBe("bad-origin");
      expect(await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: viaFrame(broker, card) }, { role: "remote", device: phone })).toBe("bad-origin");
      expect(await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: viaFrame(broker, card) }, { role: "plugin-host" })).toBe("bad-origin");
      // A device's answer may arrive by any computer (N4), but only in time, and the fake's verifier refuses by default.
      expect(await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: device }, APP)).toBe("bad-proof");
      expect(await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: device }, { role: "remote", device: "laptop000000000000" })).toBe("bad-proof");
      expect(await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: { ...device, at: 0 } }, { role: "remote", device: phone })).toBe("bad-time");
      expect(await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: device }, { role: "remote", device: phone })).toBe("bad-proof");
      expect(await broker.answer(card.id, { optionId: "deny", hash: card.hash, proof: viaFrame(broker, card) }, APP)).toBe("accepted");
      expect(await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: viaFrame(broker, card) ?? FRAME }, APP)).toBe("already-answered");
      expect(broker.frameChannel(card.id)).toBeUndefined();
      expect(await decision).toEqual({ allowed: false, by: "card", cardId: card.id, optionId: "deny" });
    });

    test("a card's hash covers everything but itself, and its meta carries no text", async () => {
      const { broker, events } = setup();
      const { card } = await carded(broker, bash());
      const { hash, ...rest } = card;
      expect(hash).toBe(createHash("sha256").update(cardHashInput(rest)).digest("hex"));
      expect(card.id).toMatch(/^card_[0-9a-f]{24}$/);
      expect(events[0]).toEqual({ type: "requested", card });
      const meta = cardMetaOf(card);
      expect(broker.pending()).toEqual([meta]);
      expect(broker.pending("Laptop1")).toEqual([]);
      const json = JSON.stringify(meta);
      for (const text of ["Run a command", "git push", "Approve", "Deny"]) expect(json).not.toContain(text);
      expect(meta.options).toEqual([{ id: "approve", kind: "approve" }, { id: "deny", kind: "deny" }]);
      // The "always" option says so in the meta, so a plugin can place its button; never its label.
      const always = await carded(broker, bash({ ruleKey: "Bash(git push:*)" }));
      expect(cardMetaOf(always.card).options).toEqual([
        { id: "approve", kind: "approve" }, { id: "always", kind: "approve", remember: "always" }, { id: "deny", kind: "deny" },
      ]);
    });

    test("get: a pending card in full, then the resolved one with its outcome, option, device and time", async () => {
      const clock = new FakeClock();
      const broker = make({ clock, verify: () => true });
      const events: ApprovalEvent[] = [];
      broker.watch((e) => events.push(e));
      const { card, decision } = await carded(broker, bash());
      expect(broker.get(card.id)).toEqual({ card });
      clock.advance(1_500);
      const proof: CardAnswerProof = { via: "device", device: "phone0000000000000", at: clock.now(), signature: "AAAA" };
      expect(await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof }, { role: "remote", device: "phone0000000000000" })).toBe("accepted");
      await decision;
      expect(broker.get(card.id)).toEqual({ card, outcome: "approved", optionId: "approve", device: "phone0000000000000", resolvedAt: clock.now() });
      expect(events.at(-1)).toEqual({ type: "resolved", cardId: card.id, outcome: "approved", optionId: "approve", device: "phone0000000000000" });
      expect(broker.cards()).toEqual([]);
      expect(broker.get("card_unknown1")).toBeUndefined();
      // A sealed frame's answer names no device; a withdrawn card keeps its fields too.
      const two = await carded(broker, bash());
      broker.withdrawSession("s_alpha");
      expect(broker.get(two.card.id)).toEqual({ card: two.card, outcome: "withdrawn", resolvedAt: clock.now() });
    });

    test("a paired device answers with its signature over the card and the children; a browser or revoked one can't", async () => {
      const clock = new FakeClock();
      const { registry } = await FakeDeviceRegistry.create({ clock, name: "Studio" });
      const phone = await makeFakePhone();
      const web = await makeFakeDevice();
      await registry.add({ id: phone.id, name: "Phone", kind: "phone", runsCore: false, publicKey: phone.publicKey, answerKey: phone.answerKey }, { via: "account", account: "acct_1" });
      await registry.add({ id: web.id, name: "Web", kind: "browser", runsCore: false, publicKey: web.publicKey }, { via: "account", account: "acct_1" });
      const broker = make({ clock, verify: deviceProofVerifier(registry) });
      const at = clock.now();
      const sign = async (who: FakeDevice, card: Card, option: string, children: string[] = []) =>
        toBase64(await who.sign(new TextEncoder().encode(cardAnswerSigningInput({ id: card.id, hash: card.hash, option, at, children }))));
      const from = (who: FakeDevice): AnswerOrigin => ({ role: "remote", device: who.id });
      const proof = async (who: FakeDevice, card: Card, option: string, children: string[] = []): Promise<CardAnswerProof> =>
        ({ via: "device", device: who.id, at, signature: await sign(who, card, option, children) });

      const one = await carded(broker, bash());
      expect(await broker.answer(one.card.id, { optionId: "approve", hash: one.card.hash, proof: await proof(phone, one.card, "deny") }, from(phone))).toBe("bad-proof");
      // A phone's link key never answers, only its answer key (no fallback, lane H's ask).
      const linkSigned = { via: "device" as const, device: phone.id, at, signature: await sign(phone.link, one.card, "approve") };
      expect(await broker.answer(one.card.id, { optionId: "approve", hash: one.card.hash, proof: linkSigned }, from(phone))).toBe("bad-proof");
      // The web companion answers no card, even with a good signature.
      expect(await broker.answer(one.card.id, { optionId: "approve", hash: one.card.hash, proof: await proof(web, one.card, "approve") }, from(web))).toBe("bad-proof");
      // A phone's answer relayed by another computer holds end to end (review N4).
      expect(await broker.answer(one.card.id, { optionId: "approve", hash: one.card.hash, proof: await proof(phone, one.card, "approve") }, { role: "peer", device: "laptop000000000000" })).toBe("accepted");
      expect(await one.decision).toMatchObject({ allowed: true, by: "card" });

      // A plugin OK's checked children are signed: a signature without them doesn't cover an answer with them.
      const ok = await carded(broker, bash({ kind: "plugin-ok", pluginId: "luna", effect: "other", children: [
        { id: "luna/deck", label: "Deck", checked: true }, { id: "luna/tarot-panel", label: "Panel", checked: true },
      ] }));
      expect(await broker.answer(ok.card.id, { optionId: "approve", hash: ok.card.hash, proof: await proof(phone, ok.card, "approve"), children: ["luna/deck"] }, from(phone))).toBe("bad-proof");
      expect(await broker.answer(ok.card.id, { optionId: "approve", hash: ok.card.hash, proof: await proof(phone, ok.card, "approve", ["luna/deck"]), children: ["luna/deck"] }, from(phone))).toBe("accepted");
      expect(broker.get(ok.card.id)?.children).toEqual(["luna/deck"]);

      const two = await carded(broker, bash());
      await registry.revoke(phone.id);
      expect(await broker.answer(two.card.id, { optionId: "approve", hash: two.card.hash, proof: await proof(phone, two.card, "approve") }, from(phone))).toBe("bad-proof");
    });

    test("a phone or a desktop's app-held key answers; a server, a desktop's link key or a browser never does (N1)", async () => {
      const clock = new FakeClock();
      const { registry } = await FakeDeviceRegistry.create({ clock, name: "Studio" });
      const server = await makeFakeDevice();
      const laptop = await makeFakeDevice();
      const laptopApp = await makeFakeDevice();
      const bare = await makeFakeDevice();
      await registry.add({ id: server.id, name: "Box", kind: "server", runsCore: true, publicKey: server.publicKey }, { via: "account", account: "acct_1" });
      await registry.add({ id: laptop.id, name: "Laptop", kind: "desktop", runsCore: true, publicKey: laptop.publicKey, answerKey: { publicKey: laptopApp.publicKey, held: "app-keychain" } }, { via: "account", account: "acct_1" });
      await registry.add({ id: bare.id, name: "Old", kind: "desktop", runsCore: true, publicKey: bare.publicKey }, { via: "account", account: "acct_1" });
      const broker = make({ clock, verify: deviceProofVerifier(registry) });
      const at = clock.now();
      const answer = async (card: Card, device: string, key: typeof server) => broker.answer(card.id, {
        optionId: "approve", hash: card.hash,
        proof: { via: "device", device, at, signature: toBase64(await key.sign(new TextEncoder().encode(cardAnswerSigningInput({ id: card.id, hash: card.hash, option: "approve", at })))) },
      }, { role: "peer", device });
      const one = await carded(broker, bash());
      // A computer that isn't a desktop signs with the core's key, which plugin code may reach: never.
      expect(await answer(one.card, server.id, server)).toBe("bad-proof");
      // A desktop's link key isn't its answer key; a desktop with no answer key answers nothing.
      expect(await answer(one.card, laptop.id, laptop)).toBe("bad-proof");
      expect(await answer(one.card, bare.id, bare)).toBe("bad-proof");
      expect(await answer(one.card, laptop.id, laptopApp)).toBe("accepted");
    });

    test("a signed answer counts as proof only for the call its card binds, on this computer, once", async () => {
      const clock = new FakeClock();
      const { registry } = await FakeDeviceRegistry.create({ clock, name: "Studio" });
      const phone = await makeFakePhone();
      const web = await makeFakeDevice();
      await registry.add({ id: phone.id, name: "Phone", kind: "phone", runsCore: false, publicKey: phone.publicKey, answerKey: phone.answerKey }, { via: "account", account: "acct_1" });
      await registry.add({ id: web.id, name: "Web", kind: "browser", runsCore: false, publicKey: web.publicKey }, { via: "account", account: "acct_1" });
      const params = { name: "Studio", level: "automatic" };
      const unhashed = {
        id: "card_00112233445566778899aabb", kind: "change" as const, change: "computer-level" as const, computer: "Studio", origin: "user" as const,
        issuedAt: clock.now(), expiresAt: null, fields: {}, options: [{ id: "approve", kind: "approve" as const, label: "Raise" }, { id: "deny", kind: "deny" as const, label: "Keep" }],
        binds: { computer: "Studio", method: "computer.setLevel", params: sha256(callBindingInput("computer.setLevel", params)) },
      };
      const card = { ...unhashed, hash: sha256(cardHashInput(unhashed as never)) } as Card;
      const signed = async (who: FakeDevice, option = "approve", over: Partial<SignedCardAnswer> = {}): Promise<SignedCardAnswer> => {
        const at = clock.now();
        return { card, option, device: who.id, at, signature: toBase64(await who.sign(new TextEncoder().encode(cardAnswerSigningInput({ id: card.id, hash: card.hash, option, at })))), ...over };
      };
      const ledger = new MemoryAnswerLedger();
      // The receiver's own card for the call, from its built-in tables.
      const render: CallCardRenderer = (call) => call.method === "computer.setLevel"
        ? { kind: "change", change: "computer-level", fields: {}, options: unhashed.options, binds: { computer: call.computer, method: call.method, params: sha256(callBindingInput(call.method, call.params)) } }
        : undefined;
      const check = (method = "computer.setLevel", p: unknown = params, self = "Studio") =>
        ({ self, method, params: p, now: clock.now(), sha256, devices: registry, ledger, render });
      const good = await signed(phone);
      expect(await verifySignedAnswer(good, check("computer.rename"))).toBe("unbound");
      expect(await verifySignedAnswer(good, check(undefined, { ...params, level: "ask" }))).toBe("unbound");
      expect(await verifySignedAnswer(good, check(undefined, undefined, "Laptop1"))).toBe("unbound");
      expect(await verifySignedAnswer({ ...good, card: { ...card, fields: { title: { type: "text", text: "x" } } } }, check())).toBe("bad-hash");
      expect(await verifySignedAnswer(await signed(phone, "deny"), check())).toBe("not-approve");
      expect(await verifySignedAnswer(await signed(web), check())).toBe("bad-device");
      expect(await verifySignedAnswer({ ...good, at: 0 }, check())).toBe("bad-time");
      expect(await verifySignedAnswer({ ...good, signature: (await signed(phone, "deny")).signature }, check())).toBe("bad-signature");
      // A card whose text says something else can't bind this call, however well it is signed (N1).
      const lie = { ...unhashed, id: "card_00112233445566778899aabc", fields: { title: { type: "text" as const, text: "Show the weather" } } };
      const lieCard = { ...lie, hash: sha256(cardHashInput(lie as never)) } as Card;
      const lieAt = clock.now();
      const lied: SignedCardAnswer = { card: lieCard, option: "approve", device: phone.id, at: lieAt, signature: toBase64(await phone.sign(new TextEncoder().encode(cardAnswerSigningInput({ id: lieCard.id, hash: lieCard.hash, option: "approve", at: lieAt })))) };
      expect(await verifySignedAnswer(lied, check())).toBe("mismatch");
      expect(await verifySignedAnswer(good, { ...check(), render: () => undefined })).toBe("mismatch");
      expect(await verifySignedAnswer(good, check())).toBe("ok");
      expect(await verifySignedAnswer(good, check())).toBe("used");
    });

    test("an approve of a bound card by a device's signature carries that proof back, so the holder takes it as a SignedCardAnswer (askUser)", async () => {
      const clock = new FakeClock();
      const { registry } = await FakeDeviceRegistry.create({ clock, name: "Studio" });
      const phone = await makeFakePhone();
      await registry.add({ id: phone.id, name: "Phone", kind: "phone", runsCore: false, publicKey: phone.publicKey, answerKey: phone.answerKey }, { via: "account", account: "acct_1" });
      const broker = make({ clock, verify: deviceProofVerifier(registry), levels: () => "automatic" });
      const params = { name: "Studio", level: "automatic" };
      const options = [{ id: "approve", kind: "approve" as const, label: "Raise" }, { id: "deny", kind: "deny" as const, label: "Keep" }];
      // The holder's own card for the call, from its tables.
      const render: CallCardRenderer = (call) => call.method === "computer.setLevel"
        ? { kind: "change", change: "computer-level", fields: { title: { type: "text", text: "Raise Studio to automatic" } }, options, binds: { computer: call.computer, method: call.method, params: sha256(callBindingInput(call.method, call.params)) } }
        : undefined;
      const holderCheck = () => ({ self: "Studio", method: "computer.setLevel", params, now: clock.now(), sha256, devices: registry, ledger: new MemoryAnswerLedger(), render });
      const rendered = render({ computer: "Studio", method: "computer.setLevel", params })!;
      const content = { ...rendered, binds: rendered.binds! };
      const req = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => bash({ kind: "change", change: "computer-level", effect: "other", computers: ["Studio"], fields: {}, ...over });
      const byPhone = async (card: Card, option = "approve"): Promise<CardAnswerProof> => {
        const at = clock.now();
        return { via: "device", device: phone.id, at, signature: toBase64(await phone.sign(new TextEncoder().encode(cardAnswerSigningInput({ id: card.id, hash: card.hash, option, at })))) };
      };
      const asSigned = (card: Card, d: ApprovalDecision): SignedCardAnswer => ({ card, option: d.optionId!, device: d.signed!.device, at: d.signed!.at, signature: d.signed!.signature });

      // The holder's card raised as it is (`boundCard`): a card even at automatic, shown exactly as it came.
      const one = await carded(broker, req({ boundCard: content }));
      expect(cardContentInput(one.card)).toBe(cardContentInput(content));
      expect(one.card.computer).toBe("Studio");
      expect(one.card.options.some((o) => o.remember !== undefined)).toBe(false);
      const proof = await byPhone(one.card);
      expect(await broker.answer(one.card.id, { optionId: "approve", hash: one.card.hash, proof }, { role: "remote", device: phone.id })).toBe("accepted");
      const d = await one.decision;
      expect(d).toMatchObject({ allowed: true, by: "card", binds: content.binds, signed: { device: phone.id, at: proof.at, signature: (proof as { signature: string }).signature } });
      // The holder rebuilds its card, compares and checks the signature: the one answer proves exactly its call, once.
      expect(await verifySignedAnswer(asSigned(broker.get(one.card.id)!.card, d), holderCheck())).toBe("ok");

      // A card the asking computer renders itself (`binds`) carries the proof back the same way.
      const own = await carded(broker, req({ fields: content.fields, options, binds: { computer: "Studio", method: "computer.setLevel", params } }));
      expect(await broker.answer(own.card.id, { optionId: "approve", hash: own.card.hash, proof: await byPhone(own.card) }, { role: "remote", device: phone.id })).toBe("accepted");
      expect(await verifySignedAnswer(asSigned(broker.get(own.card.id)!.card, await own.decision), holderCheck())).toBe("ok");

      // No signature to carry: an answer through a sealed frame, a deny, and an unbound card.
      const framed = await carded(broker, req({ boundCard: content }));
      expect(await broker.answer(framed.card.id, { optionId: "approve", hash: framed.card.hash, proof: viaFrame(broker, framed.card) }, APP)).toBe("accepted");
      expect((await framed.decision).signed).toBeUndefined();
      const denied = await carded(broker, req({ boundCard: content }));
      expect(await broker.answer(denied.card.id, { optionId: "deny", hash: denied.card.hash, proof: await byPhone(denied.card, "deny") }, { role: "remote", device: phone.id })).toBe("accepted");
      expect((await denied.decision).signed).toBeUndefined();
      const asks = make({ clock, verify: deviceProofVerifier(registry), levels: () => "ask" });
      const unbound = await carded(asks, bash());
      expect(await asks.answer(unbound.card.id, { optionId: "approve", hash: unbound.card.hash, proof: await byPhone(unbound.card) }, { role: "remote", device: phone.id })).toBe("accepted");
      expect(await unbound.decision).toMatchObject({ allowed: true, by: "card" });
      expect((await unbound.decision).signed).toBeUndefined();
    });

    test("a holder's card raised as it is: refused unless it is one bound call on a computer the request touches", async () => {
      const { broker } = setup({ levels: { Studio: "automatic" } });
      const binds = { computer: "Studio", method: "computer.setLevel", params: sha256(callBindingInput("computer.setLevel", { name: "Studio", level: "automatic" })) };
      const content = { kind: "change" as const, change: "computer-level" as const, fields: {}, options: [{ id: "approve", kind: "approve" as const, label: "Raise" }], binds };
      const req = (over: Partial<ApprovalRequest>): ApprovalRequest => bash({ kind: "change", change: "computer-level", effect: "other", fields: {}, ...over });
      // With `binds` too, another kind, an option that remembers, or a computer the request doesn't touch.
      expect(await broker.request(req({ boundCard: content, binds: { computer: "Studio", method: "computer.setLevel", params: {} } }))).toEqual({ allowed: false, by: "unbound" });
      expect(await broker.request(req({ kind: "tool", boundCard: content }))).toEqual({ allowed: false, by: "unbound" });
      expect(await broker.request(req({ boundCard: { ...content, options: [{ id: "always", kind: "approve", label: "Always", remember: "always" }] } }))).toEqual({ allowed: false, by: "unbound" });
      expect(await broker.request(req({ computers: ["Laptop1"], boundCard: content }))).toEqual({ allowed: false, by: "unbound" });
      // Exactly the binding's computers: not the holder and this one, so a holder's card can't name a third computer
      // or this one alongside.
      expect(await broker.request(req({ computers: ["Studio", "Laptop1"], boundCard: content }))).toEqual({ allowed: false, by: "unbound" });
      expect(await broker.request(req({ boundCard: { ...content, binds: { ...binds, source: "Laptop1" } } }))).toEqual({ allowed: false, by: "unbound" });
      // Read-only still refuses a tool's write first, whoever's card it is (a change card is always a card, rule 1).
      const ro = setup({ levels: { Studio: "read-only" } });
      const toolCard = { kind: "tool" as const, fields: {}, options: content.options, binds: { ...binds, method: "tool.run" } };
      expect(await ro.broker.request(bash({ effect: "edit", boundCard: toolCard }))).toMatchObject({ allowed: false, by: "level" });
    });

    test("R15: one answer for a move between computers binds both ends, and each end takes it once (#179's review, F2)", async () => {
      const clock = new FakeClock();
      const { registry } = await FakeDeviceRegistry.create({ clock, name: "Studio" });
      const phone = await makeFakePhone();
      await registry.add({ id: phone.id, name: "Phone", kind: "phone", runsCore: false, publicKey: phone.publicKey, answerKey: phone.answerKey }, { via: "account", account: "acct_1" });
      // The exact call, pinned: lane J's holders build it with `transferChange` (#177).
      const call = transferChange(true, "home/Laptop1/proj", "home/Studio/proj", "Laptop1", "Studio");
      expect(call).toEqual({ method: "tree.transfer", params: { operation: "move", from: "home/Laptop1/proj", to: "home/Studio/proj", source: "Laptop1", destination: "Studio" } });
      expect(TreeTransferParams.safeParse(call.params).success).toBe(true);
      expect(callBindingInput(call.method, call.params)).toBe(
        '{"method":"tree.transfer","params":{"destination":"Studio","from":"home/Laptop1/proj","operation":"move","source":"Laptop1","to":"home/Studio/proj"}}');
      expect(sha256(callBindingInput(call.method, call.params))).toBe(TRANSFER_VECTOR_SHA256);
      const binds = transferBinding(call.params as TreeTransferParams, sha256);
      expect(binds).toEqual({ computer: "Studio", source: "Laptop1", method: "tree.transfer", params: TRANSFER_VECTOR_SHA256 });
      const options = [{ id: "approve", kind: "approve" as const, label: "Move" }, { id: "deny", kind: "deny" as const, label: "Keep" }];
      // Each holder's own card: the title and the binding come from the params, never from which end renders it.
      const render: CallCardRenderer = (c) => {
        if (c.method !== "tree.transfer") return undefined;
        const p = c.params as TreeTransferParams;
        return { kind: "tool", fields: { title: { type: "text", text: `Move ${p.from} to ${p.to}` } }, options, binds: transferBinding(p, sha256) };
      };
      const content = render({ computer: "Laptop1", ...call })!;
      const unhashed = { id: "card_r15000000000000000000000a", computer: "Laptop1", origin: "user" as const, issuedAt: clock.now(), expiresAt: null, ...content };
      const card = { ...unhashed, hash: sha256(cardHashInput(unhashed as never)) } as Card;
      const at = clock.now();
      const one: SignedCardAnswer = { card, option: "approve", device: phone.id, at, signature: toBase64(await phone.sign(new TextEncoder().encode(cardAnswerSigningInput({ id: card.id, hash: card.hash, option: "approve", at })))) };
      const source = new MemoryAnswerLedger();
      const destination = new MemoryAnswerLedger();
      const at_ = (self: string, ledger: MemoryAnswerLedger, params: unknown = call.params) =>
        ({ self, method: call.method, params, now: clock.now(), sha256, devices: registry, ledger, render });
      expect(await verifySignedAnswer(one, at_("Studio", destination))).toBe("ok");
      expect(await verifySignedAnswer(one, at_("Laptop1", source))).toBe("ok");
      expect(await verifySignedAnswer(one, at_("Studio", destination))).toBe("used");
      expect(await verifySignedAnswer(one, at_("Laptop1", source))).toBe("used");
      // A third computer, a copy, or other ends bind nothing.
      expect(await verifySignedAnswer(one, at_("Desk", new MemoryAnswerLedger()))).toBe("unbound");
      expect(await verifySignedAnswer(one, at_("Studio", new MemoryAnswerLedger(), { ...call.params, operation: "copy" }))).toBe("unbound");
      expect(await verifySignedAnswer(one, at_("Studio", new MemoryAnswerLedger(), { ...call.params, source: "Desk" }))).toBe("unbound");
      // A binding with a source binds only a transfer; a transfer's binding without its source binds neither end.
      expect(bindsComputer({ ...binds, method: "tree.move" }, "tree.move", call.params, "Laptop1")).toBe(false);
      expect(bindsComputer({ computer: "Studio", method: "tree.transfer", params: binds.params }, "tree.transfer", call.params, "Studio")).toBe(false);
      expect(bindsComputer(binds, "tree.transfer", call.params, "Laptop1")).toBe(true);
    });
  });

  describe("rule 9: a bound call is a card, and its record proves exactly that call", () => {
    const raise = (name = "Studio", level: Level = "automatic") => ({ computer: name, ...levelRaiseCall(name, level) });

    test("always a card, at automatic, past a saved rule, the bridge and the reviewer, and never an always", async () => {
      const { broker } = setup({ levels: { Studio: "automatic", Laptop1: "ask-risky" }, reviewer: "safe" });
      // A saved rule for the very key first.
      const first = await carded(broker, bash({ computers: ["Laptop1"], effect: "delete", ruleKey: "Bash(git push:*)" }));
      expect(await broker.answer(first.card.id, { optionId: "always", hash: first.card.hash, proof: viaFrame(broker, first.card) }, APP)).toBe("accepted");
      expect(await broker.request(bash({ computers: ["Laptop1"], effect: "delete", ruleKey: "Bash(git push:*)" }))).toEqual({ allowed: true, by: "rule" });
      expect(await broker.request(bash({ computers: ["Laptop1"] }))).toMatchObject({ allowed: true, by: "level" }); // the reviewer's "safe"
      const call = { computer: "Laptop1", method: "tool.run", params: { tool: "Bash", input: { command: "git push" } } };
      const always = { id: "always", kind: "approve" as const, label: "Always allow", remember: "always" as const };
      const { card } = await carded(broker, bash({ computers: ["Laptop1"], effect: "delete", ruleKey: "Bash(git push:*)", binds: call }));
      expect(card.options.some((o) => o.remember !== undefined)).toBe(false);
      expect(card.binds).toEqual(callBindingOf(call, sha256));
      expect(card.binds!.params).toBe(sha256(callBindingInput("tool.run", call.params)));
      expect(card.computer).toBe("Laptop1");
      const passed = await carded(broker, bash({ binds: { ...call, computer: "Studio" }, options: [{ id: "approve", kind: "approve", label: "Allow" }, always] }));
      expect(passed.card.options.map((o) => o.id)).toEqual(["approve"]);
      // The bridge's own tool and a plainly safe command (the reviewer says so) are cards once bound.
      await carded(broker, bash({ kind: "agent-permission", binds: { ...call, computer: "Studio" }, agent: { backend: "codex", toolCallId: "t1", toolKind: "other", title: "x", mcp: { server: "clover", tool: "ask" }, bridge: { server: "clover", tools: ["ask"] }, options: [] } }));
      await carded(broker, bash({ computers: ["Laptop1"], effect: "execute", binds: call }));
      expect(broker.cards()).toHaveLength(4);
    });

    test("a binding naming a computer the request doesn't touch is refused before anything, with no card", async () => {
      const { broker } = setup({ levels: { Studio: "automatic", Laptop1: "read-only" } });
      const call = { computer: "Laptop1", method: "tool.run", params: { tool: "Bash", input: {} } };
      // Judged at Studio's level, carded for Laptop1: never.
      expect(await broker.request(bash({ binds: call }))).toEqual({ allowed: false, by: "unbound" });
      expect(await broker.request(bash({ kind: "change", change: "computer-level", effect: "other", binds: raise("Laptop1") }))).toEqual({ allowed: false, by: "unbound" });
      // A source outside the request too, and a transfer whose two ends are both named is a card.
      const transfer = { computer: "Studio", source: "Desk", method: "tree.transfer", params: {} };
      expect(await broker.request(bash({ effect: "move", binds: transfer }))).toEqual({ allowed: false, by: "unbound" });
      // A source on a level raise (or any call but a transfer) binds nothing: refused, though both computers are named.
      expect(await broker.request(bash({ kind: "change", change: "computer-level", effect: "other", computers: ["Studio", "Desk"], binds: { ...raise(), source: "Desk" } }))).toEqual({ allowed: false, by: "unbound" });
      expect(broker.cards()).toHaveLength(0);
      void broker.request(bash({ effect: "move", computers: ["Studio", "Desk"], binds: transfer }));
      await flush();
      expect(broker.cards().map((c) => [c.computer, c.binds?.source])).toEqual([["Studio", "Desk"]]);
    });

    test("the source rules: only a transfer has one, never its own destination, always a computer the request names", async () => {
      const { broker } = setup({ levels: { Studio: "automatic", Desk: "automatic" } });
      const both = ["Studio", "Desk"];
      const change = { kind: "change" as const, change: "computer-level" as const, effect: "other" as const };
      const transfer = (source: string, computer = "Studio") => ({ computer, source, method: "tree.transfer", params: { source, destination: computer } });
      const refused = async (req: Partial<ApprovalRequest>) => expect(await broker.request(bash(req))).toEqual({ allowed: false, by: "unbound" });
      // A level raise with a source: named or not, it binds nothing.
      await refused({ ...change, computers: both, binds: { ...raise(), source: "Desk" } });
      await refused({ ...change, computers: ["Studio"], binds: { ...raise(), source: "Desk" } });
      await refused({ computers: both, binds: { computer: "Studio", source: "Desk", method: "tool.run", params: {} } });
      // A transfer whose source is its destination, or isn't among the request's computers.
      await refused({ effect: "move", computers: both, binds: transfer("Studio") });
      await refused({ effect: "move", computers: ["Studio"], binds: transfer("Desk") });
      // Names match exactly, as the request gives them: another case is another computer here.
      await refused({ effect: "move", computers: both, binds: transfer("desk") });
      await refused({ effect: "move", computers: both, binds: transfer("Desk", "studio") });
      await refused({ ...change, computers: ["Studio"], binds: raise("studio") });
      // No computers at all: nothing a binding could name.
      await refused({ ...change, computers: [], binds: raise() });
      await refused({ effect: "move", computers: [], binds: transfer("Desk") });
      expect(broker.cards()).toHaveLength(0);
      // The one shape that holds: a transfer between two named computers.
      void broker.request(bash({ effect: "move", computers: both, binds: transfer("Desk") }));
      await flush();
      expect(broker.cards().map((c) => [c.computer, c.binds?.source])).toEqual([["Studio", "Desk"]]);
    });

    test("read-only's deny and rule 3's refusal still come first", async () => {
      const { broker } = setup({ levels: { Studio: "read-only", Laptop1: "automatic" } });
      const call = { computer: "Studio", method: "tool.run", params: { tool: "Bash", input: {} } };
      expect(await broker.request(bash({ binds: call }))).toMatchObject({ allowed: false, by: "level", level: "read-only" });
      expect(await broker.request(bash({ computers: ["Laptop1"], effect: "edit", paths: ["/Users/me/.zshrc"], binds: { ...call, computer: "Laptop1" } }))).toEqual({ allowed: false, by: "fence" });
      expect(broker.cards()).toHaveLength(0);
    });

    test("an approve carries the binding back, and boundCardRecord hands over exactly that record", async () => {
      const { broker } = setup();
      const req = bash({ kind: "change", change: "computer-level", effect: "other", binds: raise() });
      const { card, decision } = await carded(broker, req);
      expect(await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: viaFrame(broker, card) }, APP)).toBe("accepted");
      const d = await decision;
      expect(d).toEqual({ allowed: true, by: "card", cardId: card.id, optionId: "approve", binds: callBindingOf(raise(), sha256) });
      const record = boundCardRecord(broker, d)!;
      expect(record.card.id).toBe(card.id);
      expect(record.card.binds).toEqual(d.binds!);
      // A decision that says another binding than its card's, or none, hands over nothing.
      expect(boundCardRecord(broker, { ...d, binds: callBindingOf(raise("Studio", "accept-edits"), sha256) })).toBeUndefined();
      expect(boundCardRecord(broker, { ...d, binds: callBindingOf(raise("Laptop1"), sha256) })).toBeUndefined();
      const { binds: _b, ...unbound } = d;
      expect(boundCardRecord(broker, unbound)).toBeUndefined();
      // A deny carries none back, and its record proves nothing.
      const denied = await carded(broker, req);
      expect(await broker.answer(denied.card.id, { optionId: "deny", hash: denied.card.hash, proof: viaFrame(broker, denied.card) }, APP)).toBe("accepted");
      const dd = await denied.decision;
      expect(dd.binds).toBeUndefined();
      expect(boundCardRecord(broker, { ...dd, allowed: true, binds: denied.card.binds! })).toBeUndefined();
      // An unbound card's approve carries none.
      const plain = await carded(broker, bash({ kind: "change", change: "computer-level", effect: "other" }));
      expect(await broker.answer(plain.card.id, { optionId: "approve", hash: plain.card.hash, proof: viaFrame(broker, plain.card) }, APP)).toBe("accepted");
      expect((await plain.decision).binds).toBeUndefined();
    });

    test("the binding is in the card's hash: a card bound to another call is another card", async () => {
      const { broker } = setup();
      const a = await carded(broker, bash({ kind: "change", change: "computer-level", effect: "other", binds: raise() }));
      const b = await carded(broker, bash({ kind: "change", change: "computer-level", effect: "other", binds: raise("Studio", "accept-edits") }));
      expect(sha256(cardHashInput(a.card))).toBe(a.card.hash);
      expect({ ...a.card, binds: b.card.binds }.hash).toBe(a.card.hash);
      expect(sha256(cardHashInput({ ...a.card, binds: b.card.binds }))).not.toBe(a.card.hash);
    });
  });

  describe("rule 8: an agent never gets an always", () => {
    const all: AgentPermissionOption[] = [
      { optionId: "aa", name: "Always", kind: "allow_always" }, { optionId: "a", name: "Once", kind: "allow_once" },
      { optionId: "rr", name: "Never", kind: "reject_always" }, { optionId: "r", name: "No", kind: "reject_once" },
    ];
    test("allowed → allow_once; denied → reject_once; cancelled or withdrawn → cancelled", () => {
      expect(acpOutcomeFor({ allowed: true, by: "card" }, all)).toEqual({ outcome: "selected", optionId: "a" });
      expect(acpOutcomeFor({ allowed: false, by: "card" }, all)).toEqual({ outcome: "selected", optionId: "r" });
      expect(acpOutcomeFor({ allowed: false, by: "cancelled" }, all)).toEqual({ outcome: "cancelled" });
      expect(acpOutcomeFor({ allowed: false, by: "withdrawn" }, all)).toEqual({ outcome: "cancelled" });
    });
    test("no allow_once: a refusal; no reject_once either: cancelled", () => {
      const onlyAlways = all.filter((o) => o.kind.endsWith("always") || o.kind === "reject_once");
      expect(acpOutcomeFor({ allowed: true, by: "card" }, onlyAlways)).toEqual({ outcome: "selected", optionId: "r" });
      expect(acpOutcomeFor({ allowed: true, by: "card" }, all.filter((o) => o.kind.endsWith("always")))).toEqual({ outcome: "cancelled" });
    });
  });
}

/** The receiver's card tables (J-M2's review): every call another computer's signed answer may lift
 *  (`CALL_CARD_METHODS`) has its card, which binds exactly that call, so R1 and R15 never fail closed for want of one.
 *  `tests/approval-broker.test.ts` runs it against the fake's table; lane C runs it against its sealed card tables. */
export function runCallCardTableConformance(make: (sha256: (text: string) => string) => CallCardRenderer): void {
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  describe("CallCardRenderer: the card tables", () => {
    test("each call an answer may lift renders a card that binds exactly it", () => {
      const render = make(sha256);
      for (const { method, params } of CALL_CARD_METHODS) {
        const card = render({ computer: "Studio", method, params });
        expect([method, card !== undefined]).toEqual([method, true]);
        expect([method, card!.options.some((o) => o.kind === "approve")]).toEqual([method, true]);
        const self = method === "tree.transfer" ? (params as { destination: string }).destination : "Studio";
        expect([method, card!.binds !== undefined && bindsComputer(card!.binds, method, params, self)]).toEqual([method, true]);
        expect(card!.binds!.params).toBe(sha256(callBindingInput(method, params)));
      }
      expect(CALL_CARD_METHODS.map((m) => m.method)).toEqual(expect.arrayContaining(["tree.transfer", "terminal.open", "mcp.mirror", "computer.setLevel"]));
    });
  });
}
