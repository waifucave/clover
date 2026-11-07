import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Card, TurnOrigin } from "@waifucave/clover-protocol";
import { CloverApprovalBroker, RESOLVED_KEEP_MS } from "../../src/approvals/broker";
import { botApprovalCheck, botToolRequest, effectOf, ruleKeyOf } from "../../src/approvals/bot-check";
import { fileRuleStore, savedRulesPath } from "../../src/approvals/rule-store";
import { runApprovalBrokerConformance } from "../../src/contracts/conformance/approval-broker";
import { FakeClock } from "../../src/contracts/fakes/clock";
import type { ApprovalRequest } from "../../src/contracts/approval-broker";
import type { BotSessionContext } from "../../src/bots/service";

// B's suite: every rule of the contract, against the real broker.
runApprovalBrokerConformance((opts) => new CloverApprovalBroker(opts));

const home = () => mkdtempSync(join(tmpdir(), "clover-approvals-"));
const clockAt = () => new FakeClock();
const bash = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  kind: "tool", session: "s1", bot: "luna", origin: "user", computers: ["Studio"], effect: "execute", ruleKey: "Bash(git push)",
  fields: { title: { type: "text", text: "Run a command" }, command: { type: "code", code: "git push", language: "sh" } }, ...over,
});

/** Answers the next card through the app's sealed frame, as the app's main process does. */
function answerNext(b: CloverApprovalBroker, optionId: string): Promise<Card> {
  return new Promise((resolve) => {
    const off = b.watch((e) => {
      if (e.type !== "requested") return;
      off();
      void b.answer(e.card.id, { optionId, hash: e.card.hash, proof: { via: "sealed-frame", frame: b.frameChannel(e.card.id)!, input: "click", at: 1 } }, { role: "app" }).then(() => resolve(e.card));
    });
  });
}

describe("the real broker's saved rules and records", () => {
  test("an \"always\" is saved owner-only in the fenced rules folder and holds after a restart", async () => {
    const h = home(), clock = clockAt();
    const first = new CloverApprovalBroker({ clock, rules: fileRuleStore(h) });
    const answered = answerNext(first, "always");
    expect(await first.request(bash())).toMatchObject({ allowed: true, by: "card", remembered: true });
    await answered;
    expect(JSON.parse(readFileSync(savedRulesPath(h), "utf8"))).toMatchObject({ version: 1, rules: [{ ruleKey: "Bash(git push)", computers: ["Studio"] }] });
    if (process.platform !== "win32") expect(statSync(savedRulesPath(h)).mode & 0o777).toBe(0o600);
    const again = new CloverApprovalBroker({ clock, rules: fileRuleStore(h) });
    expect(await again.request(bash())).toEqual({ allowed: true, by: "rule" });
    // Not on another computer, and not another command.
    const other = answerNext(again, "deny");
    expect(await again.request(bash({ computers: ["Laptop"] }))).toMatchObject({ allowed: false, by: "card" });
    await other;
  });

  test("a damaged rules file loads as no rules (every call asks again), and says so", async () => {
    const h = home();
    mkdirSync(join(h, "rules"), { recursive: true });
    writeFileSync(savedRulesPath(h), JSON.stringify({ version: 1, rules: [{ ruleKey: "Bash(rm -rf /)" }] }));
    const lines: string[] = [];
    const b = new CloverApprovalBroker({ clock: clockAt(), rules: fileRuleStore(h), log: (l) => lines.push(l) });
    expect(b.rules()).toEqual([]);
    expect(lines.join("\n")).toMatch(/saved rules unreadable/);
  });

  test("resolved cards stay readable for a day, then go", async () => {
    const clock = clockAt();
    const b = new CloverApprovalBroker({ clock });
    const card = answerNext(b, "deny");
    await b.request(bash());
    const id = (await card).id;
    expect(b.get(id)).toMatchObject({ outcome: "denied" });
    clock.advance(RESOLVED_KEEP_MS + 1);
    const next = answerNext(b, "deny"); // a later resolve prunes
    await b.request(bash());
    await next;
    expect(b.get(id)).toBeUndefined();
  });
});

describe("a bot's tool calls through the broker", () => {
  const ctx = { botId: "luna", sessionId: "s1", computer: "Studio" } as unknown as BotSessionContext;
  const call = (b: CloverApprovalBroker, tool: string, input: Record<string, unknown>, origin?: TurnOrigin, signal = new AbortController().signal) =>
    botApprovalCheck(b)(ctx, () => origin)(tool, input, { signal, toolUseID: "t1", requestId: "r1" });

  test("what each tool does, its paths and its rule key, from Clover's own table", () => {
    expect([effectOf("Read"), effectOf("Grep"), effectOf("Edit"), effectOf("Bash"), effectOf("WebFetch"), effectOf("mcp__blender__Render")]).toEqual(["read", "search", "edit", "execute", "fetch", "other"]);
    expect(ruleKeyOf("Bash", { command: "git push" })).toBe("Bash(git push)");
    expect(ruleKeyOf("Edit", { file_path: "/p/a.ts" })).toBe("Edit(/p/a.ts)");
    const r = botToolRequest(ctx, "user", "Edit", { file_path: "/p/a.ts", old_string: "x", new_string: "y" });
    expect(r).toMatchObject({ kind: "tool", session: "s1", bot: "luna", computers: ["Studio"], effect: "edit", paths: ["/p/a.ts"] });
    expect(r.fields.title).toEqual({ type: "text", text: "Change files" });
    expect(r.fields.paths).toEqual({ type: "list", items: ["/p/a.ts"] });
  });

  test("a read runs at once at the default level; a command waits for the card and runs only on approve", async () => {
    const b = new CloverApprovalBroker({ clock: clockAt() });
    expect(await call(b, "Read", { file_path: "/p/a.ts" }, "user")).toEqual({ behavior: "allow", updatedInput: { file_path: "/p/a.ts" } });
    const shown = answerNext(b, "approve");
    expect(await call(b, "Bash", { command: "git push" }, "user")).toEqual({ behavior: "allow", updatedInput: { command: "git push" } });
    expect((await shown).fields.command).toEqual({ type: "code", code: "git push", language: "sh" });
    const denied = answerNext(b, "deny");
    expect(await call(b, "Bash", { command: "rm -rf build" }, "user")).toEqual({ behavior: "deny", message: "Bash was refused: the person declined it." });
    await denied;
  });

  test("a turn of unknown origin is not the user's: its card expires; a stopped turn's call is refused", async () => {
    const clock = clockAt();
    const b = new CloverApprovalBroker({ clock });
    let card: Card | undefined;
    b.watch((e) => { if (e.type === "requested") card = e.card; });
    const pending = call(b, "Bash", { command: "make" });
    await Bun.sleep(0);
    expect(card?.expiresAt).not.toBeNull();
    clock.advance(10 * 60 * 1000);
    expect(await pending).toEqual({ behavior: "deny", message: "Bash was refused: no one answered its card in time." });
    const ac = new AbortController();
    const stopped = call(b, "Bash", { command: "make" }, "user", ac.signal);
    await Bun.sleep(0);
    ac.abort();
    expect(await stopped).toEqual({ behavior: "deny", message: "Bash was refused: the turn was stopped." });
  });
});
