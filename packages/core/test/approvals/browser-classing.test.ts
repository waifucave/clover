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
  expect(JSON.stringify(card.fields)).toContain("Let Alpha click and type on example.com");
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
