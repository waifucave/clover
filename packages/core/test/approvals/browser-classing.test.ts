// The bundled Browser tool through a bot's approval check: looking verbs are reads (no card at any level), acting verbs
// (click, type, key, select) are screen control that cards once per bot and site, are remembered per bot and site,
// card every call at "ask", run at automatic, and are refused at read-only.
import { expect, test } from "bun:test";
import type { Card, Level } from "@waifucave/clover-protocol";
import { botApprovalCheck, BROWSER_ACTING_VERBS, BROWSER_LOOKING_VERBS } from "../../src/approvals/bot-check";
import { CloverApprovalBroker } from "../../src/approvals/broker";
import { bundledToolKind } from "../../src/approvals/bundled-tools";
import type { BotSessionContext } from "../../src/bots/service";
import { FakeClock } from "../../src/contracts/fakes/clock";

const ctxOf = (bot: string) => ({ botId: bot, sessionId: `s-${bot}`, kind: "bot", computer: "Studio", paths: { scratch: "/tmp" }, caller: { kind: "session", sessionId: `s-${bot}`, sessionKind: "bot", bot } }) as unknown as BotSessionContext;
const run = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };
const TOOL = "mcp__browser__Browser";

function answerNext(b: CloverApprovalBroker, optionId: string): Promise<Card> {
  return new Promise((resolve) => {
    const off = b.watch((e) => {
      if (e.type !== "requested") return;
      off();
      void b.answer(e.card.id, { optionId, hash: e.card.hash, proof: { via: "sealed-frame", frame: b.frameChannel(e.card.id)!, input: "click", at: 1 } }, { role: "app" }).then(() => resolve(e.card));
    });
  });
}

function setup(level: () => Level, site: () => string | undefined = () => "example.com") {
  const broker = new CloverApprovalBroker({ clock: new FakeClock(), levels: level, localComputer: "Studio" });
  const check = botApprovalCheck(broker, { bundledTool: (_c, tool) => (tool === TOOL ? "browser" : undefined), browserHost: async () => site(), levelOf: () => level() });
  return { broker, check };
}

test("the verbs are split into looking and acting, with none in both", () => {
  expect([...BROWSER_ACTING_VERBS].sort()).toEqual(["click", "key", "select", "type"]);
  for (const v of BROWSER_ACTING_VERBS) expect(BROWSER_LOOKING_VERBS.has(v)).toBe(false);
});

test("only the staged bundled browser plugin's Browser tool is the browser kind", () => {
  const lookup = { servers: [{ server: "browser", plugin: "clover/browser", tools: [{ name: "Browser" }, { name: "Other" }] }, { server: "evil", plugin: "acme/browser", tools: [{ name: "Browser" }] }], record: () => undefined, staged: undefined };
  expect(bundledToolKind(lookup, TOOL)).toBeUndefined(); // no staged copy: judged as any tool
  expect(bundledToolKind(lookup, "mcp__evil__Browser")).toBeUndefined();
});

test("looking verbs raise no card at any level, read-only included", async () => {
  for (const level of ["read-only", "ask", "ask-risky", "accept-edits", "automatic"] as const) {
    const { broker, check } = setup(() => level);
    for (const verb of BROWSER_LOOKING_VERBS) expect([level, verb, (await check(ctxOf("alpha"), () => "user")(TOOL, { verb }, run))?.behavior]).toEqual([level, verb, "allow"]);
    expect(broker.cards()).toHaveLength(0);
  }
});

test("an acting verb is refused at read-only, runs at automatic, and cards at the levels between", async () => {
  const ro = setup(() => "read-only");
  expect((await ro.check(ctxOf("alpha"), () => "user")(TOOL, { verb: "click", ref: "e1" }, run))?.behavior).toBe("deny");
  const auto = setup(() => "automatic");
  expect((await auto.check(ctxOf("alpha"), () => "user")(TOOL, { verb: "type", ref: "e1", text: "hi" }, run))?.behavior).toBe("allow");
  expect(auto.broker.cards()).toHaveLength(0);
});

test("the card names the bot and the site; Approve is remembered for that bot and site only; Deny refuses the call and asks again", async () => {
  let site = "example.com";
  const { broker, check } = setup(() => "ask-risky", () => site);
  const click = (bot: string) => check(ctxOf(bot), () => "user")(TOOL, { verb: "click", ref: "e1" }, run);
  const denied = answerNext(broker, "deny");
  expect((await click("alpha"))?.behavior).toBe("deny");
  const card = await denied;
  expect(JSON.stringify(card.fields)).toContain("Browser: click and type on example.com");
  // Asks again after a Deny.
  const approved = answerNext(broker, "always");
  expect((await click("alpha"))?.behavior).toBe("allow");
  await approved;
  expect(broker.rules()).toHaveLength(1);
  // Remembered: the same bot on the same site, any acting verb, no card.
  for (const verb of ["click", "type", "key", "select"]) expect((await check(ctxOf("alpha"), () => "user")(TOOL, { verb }, run))?.behavior).toBe("allow");
  expect(broker.cards()).toHaveLength(0);
  // Another site, or another bot, asks again.
  site = "other.example";
  const other = answerNext(broker, "deny");
  expect((await click("alpha"))?.behavior).toBe("deny");
  await other;
  site = "example.com";
  const sol = answerNext(broker, "deny");
  expect((await click("sol"))?.behavior).toBe("deny");
  await sol;
  // Revoked with the bot's other kept answers: the rule goes, the card returns.
  expect(broker.rules()).toHaveLength(1);
});

test("at ask every acting call is a card, a kept answer or not; and with no tab to name a site, too", async () => {
  const { broker, check } = setup(() => "ask");
  for (let i = 0; i < 2; i++) {
    const asked = answerNext(broker, "approve");
    expect((await check(ctxOf("alpha"), () => "user")(TOOL, { verb: "click", ref: "e1" }, run))?.behavior).toBe("allow");
    const card = await asked;
    expect(card.options.map((o) => o.id)).toEqual(["approve", "deny"]);
  }
  const noTab = setup(() => "ask-risky", () => undefined);
  const asked = answerNext(noTab.broker, "deny");
  expect((await noTab.check(ctxOf("alpha"), () => "user")(TOOL, { verb: "key", key: "Enter" }, run))?.behavior).toBe("deny");
  expect(JSON.stringify((await asked).fields)).toContain("in its browser tab");
});

// The user's own coding session (lane B's bridge) has no bot: its context carries `botId: undefined`.
const codingCtx = () => ({ ...ctxOf("code"), botId: undefined, kind: "bot", caller: { kind: "session", sessionId: "s-code", sessionKind: "coding" } }) as unknown as BotSessionContext;

test("a coding session with no bot: looking verbs no card, the acting card says it covers the user's coding sessions, the kept rule holds, read-only refuses", async () => {
  for (const verb of BROWSER_LOOKING_VERBS) {
    const { broker, check } = setup(() => "ask-risky");
    expect([verb, (await check(codingCtx(), () => "user")(TOOL, { verb }, run))?.behavior]).toEqual([verb, "allow"]);
    expect(broker.cards()).toHaveLength(0);
  }
  const { broker, check } = setup(() => "ask-risky");
  const click = () => check(codingCtx(), () => "user")(TOOL, { verb: "click", ref: "e1" }, run);
  const asked = answerNext(broker, "always");
  expect((await click())?.behavior).toBe("allow");
  expect(JSON.stringify((await asked).fields)).toContain("Browser: click and type on example.com");
  expect(broker.rules()).toHaveLength(1);
  expect((await click())?.behavior).toBe("allow");
  expect(broker.cards()).toHaveLength(0);
  // A bot on the same site does not borrow the coding session's rule.
  const bot = answerNext(broker, "deny");
  expect((await check(ctxOf("alpha"), () => "user")(TOOL, { verb: "click", ref: "e1" }, run))?.behavior).toBe("deny");
  await bot;
  const ro = setup(() => "read-only");
  expect((await ro.check(codingCtx(), () => "user")(TOOL, { verb: "type", ref: "e1", text: "x" }, run))?.behavior).toBe("deny");
});

test("a bot's delegated agent has no Always of its own: it falls under its bot's kept rule, and without one it asks as the bot would", async () => {
  const agentCtx = () => ({ ...ctxOf("alpha"), sessionId: "s-alpha-agent", caller: { kind: "session", sessionId: "s-alpha-agent", sessionKind: "agent", bot: "alpha" } }) as unknown as BotSessionContext;
  const { broker, check } = setup(() => "ask-risky");
  // No kept rule yet: the agent's click is a card for the bot ("Browser: click and type on ..."), and its Always is the bot's rule.
  const asked = answerNext(broker, "always");
  expect((await check(agentCtx(), () => "user")(TOOL, { verb: "click", ref: "e1" }, run))?.behavior).toBe("allow");
  expect(JSON.stringify((await asked).fields)).toContain("Browser: click and type on example.com");
  expect(broker.rules()).toHaveLength(1);
  // The bot's own session now runs with no card on that rule, and a second agent of the bot too.
  expect((await check(ctxOf("alpha"), () => "user")(TOOL, { verb: "click", ref: "e1" }, run))?.behavior).toBe("allow");
  expect((await check(agentCtx(), () => "user")(TOOL, { verb: "type", ref: "e1", text: "x" }, run))?.behavior).toBe("allow");
  expect(broker.cards()).toHaveLength(0);
  expect(broker.rules()).toHaveLength(1);
  // Another bot's agent does not borrow it.
  const sol = answerNext(broker, "deny");
  expect((await check({ ...agentCtx(), botId: "sol" } as BotSessionContext, () => "user")(TOOL, { verb: "click", ref: "e1" }, run))?.behavior).toBe("deny");
  await sol;
});


test("the card's act is words from the session's last read, never a bare ref; a secure field's text is not shown", async () => {
  const broker = new CloverApprovalBroker({ clock: new FakeClock(), levels: () => "ask", localComputer: "Studio" });
  const elements = new Map([["e12", { role: "button", name: "Say hello", secure: false }], ["e3", { role: "textbox", name: "Password", secure: true }], ["e4", { role: "textbox", name: "Email", secure: false }]]);
  const check = botApprovalCheck(broker, { bundledTool: (_c, tool) => (tool === TOOL ? "browser" : undefined), browserHost: async () => "example.com", browserElement: (_c, ref) => elements.get(ref), levelOf: () => "ask" });
  const commandOf = async (input: Record<string, unknown>): Promise<string> => {
    const asked = answerNext(broker, "deny");
    await check(ctxOf("alpha"), () => "user")(TOOL, input, run);
    const card = await asked;
    expect(card.fields.what).toEqual({ type: "code", code: "Browser: click and type on example.com" });
    return (card.fields.command as { code: string }).code;
  };
  expect(await commandOf({ verb: "click", ref: "e12" })).toBe('Click the button "Say hello"');
  expect(await commandOf({ verb: "type", ref: "e4", text: "me@example.com" })).toBe('Type "me@example.com" into the field "Email"');
  expect(await commandOf({ verb: "type", ref: "e3", text: "hunter2" })).toBe('Type into the field "Password"');
  expect(await commandOf({ verb: "type", ref: "e99", text: "hunter2" })).toBe("Type into an element the page showed");
  expect(await commandOf({ verb: "key", key: "Enter" })).toBe("Press Enter");
});
