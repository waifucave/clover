// The card's `rule` rows say exactly what an "always" on it would store (broker.ts `ruleFieldOf`, written from the same
// record `#saveRule` saves and the match in `#decide` compares): the kind and the thing, the bot, the computers. And the
// words match the behaviour: an "always" pressed for one bot's call answers that bot's same call, never another bot's,
// and not the same call on another computer.
import { describe, expect, test } from "bun:test";
import type { Card } from "@waifucave/clover-protocol";
import { CloverApprovalBroker, type CloverApprovalRequest } from "../../src/approvals/broker";
import { ruleShapeOf } from "../../src/approvals/bot-check";
import { FakeClock } from "../../src/contracts/fakes/clock";

const req = (over: Partial<CloverApprovalRequest> = {}): CloverApprovalRequest => ({
  kind: "tool", session: "s1", bot: "alpha", origin: "user", computers: ["Studio"], effect: "execute",
  ruleKey: "builtin:Bash(ls build)", fields: { title: { type: "text", text: "Run a command" } }, ...over,
});
const broker = () => new CloverApprovalBroker({ clock: new FakeClock(), levels: () => "ask-risky", localComputer: "Studio" });
function answerNext(b: CloverApprovalBroker, optionId: string): Promise<Card> {
  return new Promise((resolve) => {
    const off = b.watch((e) => {
      if (e.type !== "requested") return;
      off();
      void b.answer(e.card.id, { optionId, hash: e.card.hash, proof: { via: "sealed-frame", frame: b.frameChannel(e.card.id)!, input: "click", at: 1 } }, { role: "app" }).then(() => resolve(e.card));
    });
  });
}
const rows = (card: Card) => {
  const v = card.fields.rule;
  expect(v?.type).toBe("rows");
  return Object.fromEntries((v as { rows: { label: string; value: string }[] }).rows.map((r) => [r.label, r.value]));
};

describe("a rule key's shape", () => {
  test("each key ruleKeyOf makes reads back as its kind and its thing", () => {
    expect(ruleShapeOf("builtin:Bash(git status)")).toEqual({ kind: "command", target: "git status" });
    expect(ruleShapeOf("builtin:PowerShell(dir)")).toEqual({ kind: "command", target: "dir" });
    expect(ruleShapeOf("builtin:Edit(/Users/k/a.md)")).toEqual({ kind: "file", target: "/Users/k/a.md" });
    expect(ruleShapeOf("builtin:WebFetch")).toEqual({ kind: "tool", target: "WebFetch" });
    expect(ruleShapeOf("tool:mcp__x__thing")).toEqual({ kind: "plugin-tool", target: "mcp__x__thing" });
    expect(ruleShapeOf("something-else")).toEqual({ kind: "other", target: "something-else" });
  });
});

describe("the card's rule rows", () => {
  test("a card that offers an always carries the rule's kind, thing, bot and computers", async () => {
    const cases: [string, string, string][] = [
      ["builtin:Bash(ls build)", "command", "ls build"], ["builtin:Edit(/Users/k/a.md)", "file", "/Users/k/a.md"],
      ["builtin:WebFetch", "tool", "WebFetch"], ["tool:mcp__x__thing", "plugin-tool", "mcp__x__thing"],
    ];
    for (const [ruleKey, kind, target] of cases) {
      const b = broker();
      const card = answerNext(b, "deny");
      await b.request(req({ ruleKey, computers: ["Studio", "Desk"] }));
      const shown = await card;
      expect(shown.options.some((o) => o.remember === "always")).toBe(true);
      expect(rows(shown)).toEqual({ kind, target, bot: "alpha", computers: "Studio\nDesk" });
    }
  });
  test("a request naming no bot says so (empty bot), and the requester can't write the rule rows itself", async () => {
    const b = broker();
    const card = answerNext(b, "deny");
    await b.request(req({ bot: undefined, fields: { title: { type: "text", text: "T" }, rule: { type: "rows", rows: [{ label: "bot", value: "everyone" }] } } as never }));
    expect(rows(await card).bot).toBe("");
  });
  test("a card that offers no always carries no rule rows", async () => {
    const b = broker();
    const card = answerNext(b, "deny");
    await b.request(req({ ruleKey: undefined }));
    expect((await card).fields.rule).toBeUndefined();
  });
});

describe("the words match the stored rule", () => {
  test("an always for one bot answers that bot's same call, not another bot's, and not the same call on another computer", async () => {
    const b = broker();
    const first = answerNext(b, "always");
    expect(await b.request(req())).toMatchObject({ allowed: true, remembered: true });
    const shown = await first;
    expect(rows(shown)).toMatchObject({ bot: "alpha", computers: "Studio" });
    // The same bot, the same call, the same computer: the rule answers.
    expect(await b.request(req())).toEqual({ allowed: true, by: "rule" });
    // Another bot's same call: a card, as the sentence says ("for Alpha").
    const other = answerNext(b, "deny");
    expect(await b.request(req({ bot: "luna" }))).toMatchObject({ allowed: false, by: "card" });
    await other;
    // The same call on another computer: a card ("on Studio only").
    const elsewhere = answerNext(b, "deny");
    expect(await b.request(req({ computers: ["Desk"] }))).toMatchObject({ allowed: false, by: "card" });
    await elsewhere;
    // Another command is another rule.
    const another = answerNext(b, "deny");
    expect(await b.request(req({ ruleKey: "builtin:Bash(ls other)" }))).toMatchObject({ allowed: false, by: "card" });
    await another;
  });
});
