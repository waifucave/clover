// Pins the ApprovalBroker contract through FakeApprovalBroker: rules 1–8 of approval-broker.ts, the card's hash and
// meta, and answers by sealed frame and by a paired device's signature.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { LEVELS, UNATTENDED_CARD_TIMEOUT_MS, cardAnswerSigningInput, cardHashInput, type Card, type CardAnswerProof, type Level } from "@waifucave/clover-protocol";
import {
  ACTION_EFFECTS, acpOutcomeFor, cardMetaOf, deviceProofVerifier, levelDecision, strictestLevel,
  type AgentPermissionOption, type ApprovalDecision, type ApprovalEvent, type ApprovalRequest,
} from "../approval-broker";
import { FakeApprovalBroker } from "../fakes/approval-broker";
import { FakeClock, flush } from "../fakes/clock";
import { FakeDeviceRegistry, makeFakeDevice, toBase64 } from "../fakes/device-registry";
import { FakeFence } from "../fakes/fence";

const FRAME: CardAnswerProof = { via: "sealed-frame", frame: "frame-1", input: "click", at: 1 };

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
  const broker = new FakeApprovalBroker({
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
async function carded(broker: FakeApprovalBroker, req: ApprovalRequest, signal?: AbortSignal): Promise<{ card: Card; decision: Promise<ApprovalDecision> }> {
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
    expect(row("accept-edits")).toMatchObject({ edit: "allow", move: "allow", execute: "ask", delete: "ask" });
    expect(new Set(Object.values(row("automatic")))).toEqual(new Set(["allow"]));
  });

  test("the strictest level judges", () => {
    expect(strictestLevel(["automatic", "ask", "accept-edits"])).toBe("ask");
    expect(strictestLevel([])).toBeUndefined();
  });
});

describe("FakeApprovalBroker", () => {
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

  test("rule 1: changes, confirms and plugin OKs are always cards, even at automatic", async () => {
    const { broker } = setup({ levels: { Studio: "automatic" } });
    void broker.request(bash({ kind: "change", change: "computer-level", effect: "other" }));
    void broker.request(bash({ kind: "confirm", pluginId: "weather", origin: "plugin", effect: "other" }));
    void broker.request(bash({ kind: "plugin-ok", pluginId: "luna", effect: "other" }));
    await flush();
    expect(broker.cards().map((c) => c.kind)).toEqual(["change", "confirm", "plugin-ok"]);
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

  test("rule 4: a card's always saves Clover's own rule for those computers", async () => {
    const { broker } = setup();
    const { card, decision } = await carded(broker, bash({ ruleKey: "Bash(git push:*)" }));
    expect(card.options.map((o) => o.id)).toEqual(["approve", "always", "deny"]);
    expect(await broker.answer(card.id, { optionId: "always", hash: card.hash, proof: FRAME })).toBe("accepted");
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
    expect(await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: FRAME })).toBe("already-answered");
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

  test("rule 7: the first answer wins; a wrong hash, option or proof is refused", async () => {
    const clock = new FakeClock();
    const broker = new FakeApprovalBroker({ clock, verify: (_c, _o, proof) => proof.via === "sealed-frame" });
    const { card, decision } = await carded(broker, bash());
    expect(await broker.answer("card_unknown1", { optionId: "approve", hash: card.hash, proof: FRAME })).toBe("unknown-card");
    expect(await broker.answer(card.id, { optionId: "approve", hash: "0".repeat(64), proof: FRAME })).toBe("hash-mismatch");
    expect(await broker.answer(card.id, { optionId: "maybe", hash: card.hash, proof: FRAME })).toBe("bad-option");
    expect(await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: { via: "device", device: "phone0000000000000", at: 1, signature: "AAAA" } })).toBe("bad-proof");
    expect(await broker.answer(card.id, { optionId: "deny", hash: card.hash, proof: FRAME })).toBe("accepted");
    expect(await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: FRAME })).toBe("already-answered");
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
  });

  test("a paired device answers with its signature over the card; a revoked one can't", async () => {
    const clock = new FakeClock();
    const { registry } = await FakeDeviceRegistry.create({ clock, name: "Studio" });
    const phone = await makeFakeDevice();
    await registry.add({ id: phone.id, name: "Phone", kind: "phone", runsCore: false, publicKey: phone.publicKey }, { via: "account", account: "acct_1" });
    const broker = new FakeApprovalBroker({ clock, verify: deviceProofVerifier(registry) });
    const sign = async (card: Card, option: string) => toBase64(await phone.sign(new TextEncoder().encode(cardAnswerSigningInput({ id: card.id, hash: card.hash, option, at: 5 }))));

    const one = await carded(broker, bash());
    const forDeny = await sign(one.card, "deny");
    expect(await broker.answer(one.card.id, { optionId: "approve", hash: one.card.hash, proof: { via: "device", device: phone.id, at: 5, signature: forDeny } })).toBe("bad-proof");
    expect(await broker.answer(one.card.id, { optionId: "approve", hash: one.card.hash, proof: { via: "device", device: phone.id, at: 5, signature: await sign(one.card, "approve") } })).toBe("accepted");
    expect(await one.decision).toMatchObject({ allowed: true, by: "card" });

    const two = await carded(broker, bash());
    await registry.revoke(phone.id);
    expect(await broker.answer(two.card.id, { optionId: "approve", hash: two.card.hash, proof: { via: "device", device: phone.id, at: 5, signature: await sign(two.card, "approve") } })).toBe("bad-proof");
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
