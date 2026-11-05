// DurableSessionHost (../durable-host.ts): first the SessionHost contract's own scenarios, run against B's fake and the
// durable host alike, so the two route the same way; then what only a host with a log on disk does: survive a restart,
// repair a torn log, remember resends, hand notes and routine results to the next turn, count what needs the user.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalDecision } from "../../contracts/approval-broker";
import { isContractError } from "../../contracts/common";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { FakeSessionDriver, FakeSessionHost } from "../../contracts/fakes/session-host";
import type { DeliveredInput, SessionHost, SessionRecord, UserInput } from "../../contracts/session-host";
import { DurableSessionHost, INTERRUPT_GRACE_MS } from "../durable-host";
import { sessionLogPath, sessionMetaPath } from "../ids";

const homes: string[] = [];
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "clover-d-sessions-"));
  homes.push(home);
  return home;
}
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const user = (text: string, sentAt = 1, id = `m-${text}`): Omit<UserInput, "from"> => ({ text, device: "phone0000000000000", sentAt, clientMessageId: id });
const fromBot: DeliveredInput = { from: "bot", bot: "pack/luna", session: "s_luna", text: "The deploy finished." };
const inputs = (records: SessionRecord[]) => records.filter((r) => r.type === "input").map((r) => (r.type === "input" ? [r.input.from, r.disposition] : []));

type AnyHost = SessionHost & { setAsleep(id: string, asleep: boolean): void };
type MakeHost = (deps: { clock: FakeClock; approvals: FakeApprovalBroker; epoch: () => number }) => AnyHost;

const HOSTS: [string, MakeHost][] = [
  ["the fake", (deps) => new FakeSessionHost(deps)],
  ["the durable host", (deps) => new DurableSessionHost({ home: tempHome(), ...deps })],
];

describe.each(HOSTS)("the SessionHost contract: %s", (_name, make) => {
  function setup() {
    const clock = new FakeClock();
    const approvals = new FakeApprovalBroker({ clock });
    let epoch = 3;
    const host = make({ clock, approvals, epoch: () => epoch });
    const botDriver = new FakeSessionDriver({ canFold: true });
    host.open({ id: "s_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, botDriver);
    return { clock, approvals, host, botDriver, setEpoch: (e: number) => (epoch = e) };
  }

  function openAgent(host: AnyHost) {
    const driver = new FakeSessionDriver({ canFold: false });
    host.open({ id: "s_agent", kind: "agent", bot: "alpha", parent: "s_alpha", computer: "Desktop1", backend: "claude-code", root: "home/Desktop1/project1" }, driver);
    return driver;
  }

  test("the user's message starts a turn in an idle bot", async () => {
    const { host, botDriver } = setup();
    expect(host.get("s_alpha")?.status).toBe("ready");
    expect(await host.sendUser("s_alpha", user("hi"))).toMatchObject({ disposition: "turn" });
    await flush();
    expect(botDriver.turns).toMatchObject([{ input: { from: "user", text: "hi" }, origin: "user" }]);
    expect(host.get("s_alpha")?.status).toBe("prompting");
    botDriver.end({ text: "Hello!" });
    await flush();
    expect(host.get("s_alpha")?.status).toBe("idle");
  });

  test("the user's message interrupts a running step: the turn ends, its cards are withdrawn, a new step starts", async () => {
    const { host, botDriver, approvals } = setup();
    await host.deliver("s_alpha", fromBot);
    await flush();
    const card: Promise<ApprovalDecision> = approvals.request({ kind: "tool", session: "s_alpha", origin: "bot", computers: ["Studio"], effect: "delete", fields: {} });
    await flush();
    expect(approvals.cards()).toHaveLength(1);
    expect(await host.sendUser("s_alpha", user("stop, wrong folder"))).toMatchObject({ disposition: "interrupted" });
    await flush();
    expect(botDriver.interrupts).toBe(1);
    expect(await card).toMatchObject({ allowed: false, by: "withdrawn" });
    expect(botDriver.turns.map((t) => [t.input.from, t.origin])).toEqual([["bot", "bot"], ["user", "user"]]);
    expect(host.history("s_alpha").filter((r) => r.type === "turn_ended")).toMatchObject([{ end: { reason: "interrupted" } }]);
  });

  test("two quick messages from the user keep their order", async () => {
    const { host, botDriver } = setup();
    await host.deliver("s_alpha", fromBot);
    await flush();
    const first = host.sendUser("s_alpha", user("one"));
    const second = host.sendUser("s_alpha", user("two"));
    expect([(await first).disposition, (await second).disposition]).toEqual(["interrupted", "interrupted"]);
    await flush();
    botDriver.end();
    await flush();
    expect(botDriver.turns.map((t) => (t.input.from === "user" ? t.input.text : t.input.from))).toEqual(["bot", "one", "two"]);
  });

  test("messages from bots, agents and routines fold into a running bot turn after its next tool call", async () => {
    const { host, botDriver } = setup();
    await host.sendUser("s_alpha", user("deploy it"));
    await flush();
    expect(await host.deliver("s_alpha", fromBot)).toMatchObject({ disposition: "folded" });
    expect(await host.deliver("s_alpha", { from: "routine", routine: "r_1", name: "Morning", sideThread: "s_side", text: "3 issues" })).toMatchObject({ disposition: "folded" });
    expect(botDriver.turns[0]!.folded.map((i) => i.from)).toEqual(["bot", "routine"]);
    expect(botDriver.interrupts).toBe(0);
  });

  test("an idle session starts a turn for a delivered message, with that message's origin", async () => {
    const { host, botDriver } = setup();
    expect(await host.deliver("s_alpha", { from: "plugin", pluginId: "weather", text: "Rain after 4" })).toMatchObject({ disposition: "turn" });
    await flush();
    expect(botDriver.turns[0]!.origin).toBe("plugin");
  });

  test("a note never starts a turn", async () => {
    const { host, botDriver } = setup();
    expect(await host.deliver("s_alpha", { from: "note", label: "Forecast", text: "Rain", by: { kind: "plugin", pluginId: "weather" } })).toMatchObject({ disposition: "note" });
    await flush();
    expect(botDriver.turns).toEqual([]);
  });

  test("an agent can't fold: the user's and the bot's messages queue as its next prompts, without interrupting", async () => {
    const { host } = setup();
    const agent = openAgent(host);
    await host.deliver("s_agent", { from: "bot", bot: "alpha", session: "s_alpha", text: "Fix the login bug" });
    await flush();
    expect(await host.sendUser("s_agent", user("also update the docs"))).toMatchObject({ disposition: "queued" });
    expect(await host.deliver("s_agent", { from: "bot", bot: "alpha", session: "s_alpha", text: "and run the tests" })).toMatchObject({ disposition: "queued" });
    expect(agent.interrupts).toBe(0);
    agent.end();
    await flush();
    expect(agent.turns.map((t) => (t.input.from === "user" || t.input.from === "bot" ? t.input.text : ""))).toEqual(["Fix the login bug", "also update the docs"]);
    agent.end();
    await flush();
    expect(agent.turns).toHaveLength(3);
  });

  test("when an agent's turn ends with nothing queued, its bot gets the task notification with the final text unchanged", async () => {
    const { host, botDriver } = setup();
    const agent = openAgent(host);
    await host.deliver("s_agent", { from: "bot", bot: "alpha", session: "s_alpha", text: "Fix it" });
    await flush();
    agent.end({ text: "Fixed the login bug; PR #12.", usage: { inputTokens: 100, outputTokens: 20 } });
    await flush();
    expect(botDriver.turns[0]).toMatchObject({
      origin: "task-notification",
      input: { from: "task-notification", agent: "s_agent", backend: "claude-code", stopReason: "end_turn", text: "Fixed the login bug; PR #12.", transcript: "bots/alpha/agents/s_agent/acp.ndjson", usage: { inputTokens: 100, outputTokens: 20 } },
    });
  });

  test("a stopped agent's cards are cancelled, and its bot hears it stopped; a busy bot folds the notification in", async () => {
    const { host, botDriver, approvals } = setup();
    const agent = openAgent(host);
    await host.sendUser("s_alpha", user("start the deploy"));
    await host.deliver("s_agent", { from: "bot", bot: "alpha", session: "s_alpha", text: "Deploy" });
    await flush();
    const card = approvals.request({ kind: "agent-permission", session: "s_agent", origin: "agent", computers: ["Desktop1"], effect: "execute", fields: {} });
    await flush();
    await host.stop("s_agent");
    await flush();
    expect(await card).toMatchObject({ by: "cancelled" });
    expect(agent.stopped).toBe(true);
    expect(host.get("s_agent")?.status).toBe("stopped");
    expect(botDriver.turns[0]!.folded).toMatchObject([{ from: "task-notification", stopReason: "stopped" }]);
    expect(isContractError(await host.sendUser("s_agent", user("hello?")).catch((e: unknown) => e), "closed")).toBe(true);
  });

  test("an agent that fails tells its bot why", async () => {
    const { host, botDriver } = setup();
    const agent = openAgent(host);
    await host.deliver("s_agent", { from: "bot", bot: "alpha", session: "s_alpha", text: "Go" });
    await flush();
    agent.end({ reason: "failed", failure: "sign-in", text: "sign in to Claude Code yourself" });
    await flush();
    expect(host.get("s_agent")).toMatchObject({ status: "failed", failure: "sign-in" });
    expect(botDriver.turns[0]!.input).toMatchObject({ from: "task-notification", stopReason: "sign-in" });
  });

  test("the user's interrupt of the bot never touches its agents or side threads", async () => {
    const { host, botDriver } = setup();
    const agent = openAgent(host);
    const side = new FakeSessionDriver();
    host.open({ id: "s_side", kind: "side-thread", bot: "alpha", parent: "s_alpha", computer: "Studio", routine: "r_1" }, side);
    await host.deliver("s_agent", { from: "bot", bot: "alpha", session: "s_alpha", text: "work" });
    await host.deliver("s_side", { from: "routine", routine: "r_1", name: "Nightly", sideThread: "s_side", text: "run" });
    await host.sendUser("s_alpha", user("hi"));
    await flush();
    await host.sendUser("s_alpha", user("hi again"));
    await flush();
    expect(botDriver.interrupts).toBe(1);
    expect(agent.interrupts).toBe(0);
    expect(side.interrupts).toBe(0);
    expect(side.turns).toHaveLength(1);
    expect(isContractError(await host.sendUser("s_side", user("x")).catch((e: unknown) => e), "refused")).toBe(true);
  });

  test("with no connection to the computer running the bot, the user's message isn't sent", async () => {
    const { host } = setup();
    host.setAsleep("s_alpha", true);
    expect(isContractError(await host.sendUser("s_alpha", user("hi")).catch((e: unknown) => e), "bot_asleep")).toBe(true);
  });

  test("a late message goes after the output already produced, keeping its send time; records carry the lease epoch", async () => {
    const { clock, host, botDriver, setEpoch } = setup();
    await host.sendUser("s_alpha", user("first", clock.now()));
    await flush();
    botDriver.emit({ type: "assistant_message", text: "an answer" });
    clock.advance(5000);
    botDriver.end();
    await flush();
    setEpoch(4);
    await host.sendUser("s_alpha", user("sent earlier", clock.now() - 10_000));
    const log = host.history("s_alpha");
    const late = log.at(-3)!;
    expect(late).toMatchObject({ type: "input", input: { text: "sent earlier", sentAt: clock.now() - 10_000 }, epoch: 4 });
    expect(log.findIndex((r) => r.type === "driver")).toBeLessThan(log.indexOf(late));
    expect(log.map((r) => r.seq)).toEqual(log.map((_, i) => i));
    expect(log[0]!.epoch).toBe(3);
  });

  test("history pages, subscribers hear records live, watchers hear views", async () => {
    const { host } = setup();
    const live: SessionRecord[] = [];
    host.subscribe("s_alpha", (r) => live.push(r));
    const views: string[] = [];
    host.watch((v) => views.push(`${v.id}:${v.status}`));
    await host.sendUser("s_alpha", user("hi"));
    await flush();
    expect(live.map((r) => r.type)).toEqual(["input", "turn_started", "status"]);
    expect(host.history("s_alpha", { afterSeq: 0, limit: 2 }).map((r) => r.seq)).toEqual([1, 2]);
    expect(views).toEqual(["s_alpha:prompting"]);
    expect(inputs(host.history("s_alpha"))).toEqual([["user", "turn"]]);
    expect(host.list({ kind: "bot" }).map((v) => v.id)).toEqual(["s_alpha"]);
  });
});

// -------------------------------------------------------------------------------------------------
// What only the durable host does
// -------------------------------------------------------------------------------------------------

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** A driver whose interrupt says it stopped but never ends the turn. */
function stuckDriver(): FakeSessionDriver {
  const d = new FakeSessionDriver();
  d.interrupt = async () => {
    d.interrupts++;
  };
  return d;
}

function durable(home = tempHome(), clock = new FakeClock(), approvals?: FakeApprovalBroker) {
  const warnings: string[] = [];
  const host = new DurableSessionHost({ home, clock, ...(approvals ? { approvals } : {}), warn: (m) => warnings.push(m) });
  return { home, clock, host, warnings };
}

describe("DurableSessionHost on disk", () => {
  test("a bot's conversation survives a restart: the same id, the same history, and the next seq after it", async () => {
    const { home, clock, host } = durable();
    const d1 = new FakeSessionDriver();
    host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio", title: "Alpha" }, d1);
    await host.sendUser("b_alpha", user("hi"));
    await flush();
    d1.emit({ type: "assistant_message", text: "Hello!" });
    d1.end({ text: "Hello!", usage: { inputTokens: 12, outputTokens: 3 } });
    await flush();
    const before = host.history("b_alpha");
    await host.close();
    expect(d1.stopped).toBe(true);

    const again = new DurableSessionHost({ home, clock });
    expect(again.get("b_alpha")).toMatchObject({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio", title: "Alpha", status: "idle" });
    expect(again.history("b_alpha")).toEqual(before);
    expect(again.isAttached("b_alpha")).toBe(false);
    const d2 = new FakeSessionDriver();
    again.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, d2);
    const sent = await again.sendUser("b_alpha", user("are you still there?"));
    expect(sent).toEqual({ disposition: "turn", seq: before.length });
    await flush();
    expect(d2.turns.map((t) => t.input)).toMatchObject([{ from: "user", text: "are you still there?" }]);

    const lines = readFileSync(sessionLogPath(home, "alpha", "b_alpha"), "utf8").trimEnd().split("\n");
    expect(lines.map((l) => (JSON.parse(l) as SessionRecord).seq)).toEqual(lines.map((_, i) => i));
    expect(JSON.parse(readFileSync(sessionMetaPath(home, "alpha", "b_alpha"), "utf8"))).toMatchObject({ meta: 1, id: "b_alpha", kind: "bot", bot: "alpha" });
  });

  test("a turn running when the daemon stopped is recorded interrupted, and what was queued behind it runs on reattach", async () => {
    const { home, clock, host } = durable();
    // A driver still winding down its turn when the process dies: the user's interrupt is recorded and queued.
    const d1 = stuckDriver();
    host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, d1);
    await host.deliver("b_alpha", fromBot);
    await flush();
    expect(await host.sendUser("b_alpha", user("are you there?"))).toMatchObject({ disposition: "interrupted" });
    // The daemon dies here, without a word to its sessions.

    const again = new DurableSessionHost({ home, clock });
    expect(again.history("b_alpha").filter((r) => r.type === "turn_ended")).toMatchObject([{ end: { reason: "interrupted" } }]);
    expect(again.get("b_alpha")?.status).toBe("idle");
    const d2 = new FakeSessionDriver();
    again.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, d2);
    await flush();
    expect(d2.turns.map((t) => t.input)).toMatchObject([{ from: "user", text: "are you there?" }]);
    expect(d1.turns).toHaveLength(1);
  });

  test("a torn last line is dropped; a corrupt line ends the log there, with the file copied aside first", async () => {
    const { home, clock, host } = durable();
    const d = new FakeSessionDriver();
    host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, d);
    await host.sendUser("b_alpha", user("one"));
    await flush();
    d.end();
    await flush();
    const n = host.length("b_alpha");
    const path = sessionLogPath(home, "alpha", "b_alpha");
    appendFileSync(path, '{"type":"input","seq":');
    const a = durable(home, clock);
    expect(a.host.length("b_alpha")).toBe(n);
    expect(a.warnings.join("\n")).toContain("unfinished last line");
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);

    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    lines[1] = "not json";
    writeFileSync(path, `${lines.join("\n")}\n`);
    const b = durable(home, clock);
    expect(b.host.length("b_alpha")).toBe(1);
    expect(b.warnings.join("\n")).toContain("corrupt line");
    expect(readdirSync(join(home, "transcripts", "alpha")).some((f) => f.includes(".corrupt-"))).toBe(true);
    // The log goes on from the last good record.
    b.host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, new FakeSessionDriver());
    expect((await b.host.sendUser("b_alpha", user("two"))).seq).toBe(1);
  });

  test("a resend of the same client message is not a second message, across a restart too", async () => {
    const { home, clock, host } = durable();
    const d = new FakeSessionDriver();
    host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, d);
    const first = await host.sendUser("b_alpha", user("hi", 1, "client-1"));
    const again = await host.sendUser("b_alpha", user("hi", 1, "client-1"));
    expect(again).toEqual(first);
    expect(inputs(host.history("b_alpha"))).toEqual([["user", "turn"]]);
    await host.close();
    const restored = new DurableSessionHost({ home, clock });
    restored.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, new FakeSessionDriver());
    expect(await restored.sendUser("b_alpha", user("hi", 1, "client-1"))).toEqual(first);
    expect(inputs(restored.history("b_alpha"))).toEqual([["user", "turn"]]);
  });

  test("a note reaches the model: folded now into a running turn, or into the next turn as it starts", async () => {
    const { host } = durable();
    const d = new FakeSessionDriver();
    host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, d);
    const note: DeliveredInput = { from: "note", label: "Forecast", text: "Rain after 4", by: { kind: "plugin", pluginId: "weather" } };
    expect(await host.deliver("b_alpha", note)).toMatchObject({ disposition: "note" });
    await host.sendUser("b_alpha", user("should I bike?"));
    await flush();
    expect(d.turns[0]!.folded).toMatchObject([{ from: "note", text: "Rain after 4" }]);
    await host.deliver("b_alpha", { ...note, text: "Storm warning" });
    expect(d.turns[0]!.folded.map((i) => (i.from === "note" ? i.text : ""))).toEqual(["Rain after 4", "Storm warning"]);
    d.end();
    await flush();
    await host.sendUser("b_alpha", user("and tomorrow?"));
    await flush();
    expect(d.turns[1]!.folded).toEqual([]);
  });

  test("a routine's result posts into an idle bot's conversation without starting a turn, and reaches its next turn", async () => {
    const { host } = durable();
    const d = new FakeSessionDriver();
    host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, d);
    const result: DeliveredInput = { from: "routine", routine: "r_morning", name: "Morning brief", sideThread: "t_1", text: "3 new issues." };
    expect(await host.deliver("b_alpha", result)).toMatchObject({ disposition: "note" });
    await flush();
    expect(d.turns).toEqual([]);
    await host.sendUser("b_alpha", user("anything new?"));
    await flush();
    expect(d.turns[0]).toMatchObject({ input: { from: "user" }, folded: [{ from: "routine", text: "3 new issues." }] });
  });

  test("a dormant session takes deliveries, and runs them when its driver is attached", async () => {
    const { home, clock, host } = durable();
    host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, new FakeSessionDriver());
    await host.release("b_alpha");
    expect(await host.deliver("b_alpha", fromBot)).toMatchObject({ disposition: "queued" });
    expect(await host.deliver("b_alpha", { from: "note", label: "N", text: "a note", by: { kind: "core" } })).toMatchObject({ disposition: "note" });
    const restored = new DurableSessionHost({ home, clock });
    const d = new FakeSessionDriver();
    restored.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, d);
    await flush();
    expect(d.turns).toMatchObject([{ input: { from: "bot", text: "The deploy finished." }, folded: [{ from: "note", text: "a note" }] }]);
  });

  test("release interrupts the running turn and leaves the session dormant; open picks it up again", async () => {
    const { host } = durable();
    const d1 = new FakeSessionDriver();
    host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, d1);
    await host.sendUser("b_alpha", user("long task"));
    await flush();
    await host.release("b_alpha");
    expect(d1.stopped).toBe(true);
    expect(host.isAttached("b_alpha")).toBe(false);
    expect(host.get("b_alpha")?.status).toBe("idle");
    expect(host.history("b_alpha").filter((r) => r.type === "turn_ended")).toMatchObject([{ end: { reason: "interrupted" } }]);
    expect(isContractError(thrown(() => host.open({ id: "b_alpha", kind: "side-thread", bot: "alpha", computer: "Studio" }, new FakeSessionDriver())), "conflict")).toBe(true);
    const d2 = new FakeSessionDriver();
    host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, d2);
    expect(isContractError(thrown(() => host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, new FakeSessionDriver())), "conflict")).toBe(true);
  });

  test("the needs-you counts: the session's pending cards and its unanswered questions", async () => {
    const clock = new FakeClock();
    const approvals = new FakeApprovalBroker({ clock });
    const { host } = durable(tempHome(), clock, approvals);
    const d = new FakeSessionDriver();
    host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, d);
    expect(host.get("b_alpha")?.needsYou).toEqual({ cards: 0, questions: 0 });
    await host.sendUser("b_alpha", user("clean up"));
    await flush();
    const card = approvals.request({ kind: "tool", session: "b_alpha", origin: "user", computers: ["Studio"], effect: "delete", fields: {} });
    await flush();
    d.emit({ type: "question_asked", callId: "q1", questions: [{ question: "Which folder?", header: "Folder", options: [{ label: "a" }, { label: "b" }], multiSelect: false }] });
    expect(host.get("b_alpha")?.needsYou).toEqual({ cards: 1, questions: 1 });
    d.emit({ type: "question_resolved", callId: "q1", answers: { "Which folder?": "a" }, by: "user" });
    expect(host.get("b_alpha")?.needsYou).toEqual({ cards: 1, questions: 0 });
    await host.sendUser("b_alpha", user("never mind"));
    await card;
    await flush();
    expect(host.get("b_alpha")?.needsYou).toEqual({ cards: 0, questions: 0 });
  });

  test("streaming events reach onTransient listeners and never the log", async () => {
    const { host } = durable();
    const d = new FakeSessionDriver();
    host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, d);
    const streamed: string[] = [];
    host.onTransient("b_alpha", (e) => streamed.push(String(e.type)));
    await host.sendUser("b_alpha", user("hi"));
    await flush();
    d.emit({ type: "assistant_delta", delta: "Hel" });
    d.emit({ type: "assistant_message", text: "Hello" });
    expect(streamed).toEqual(["assistant_delta"]);
    expect(host.history("b_alpha").filter((r) => r.type === "driver").map((r) => (r.type === "driver" ? r.event.type : ""))).toEqual(["assistant_message"]);
  });

  test("a driver that never ends its interrupted turn has it ended for it", async () => {
    const { clock, host } = durable();
    const stuck = stuckDriver();
    host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, stuck);
    await host.deliver("b_alpha", fromBot);
    await flush();
    await host.sendUser("b_alpha", user("hello?"));
    await flush();
    expect(stuck.turns).toHaveLength(1);
    expect(host.get("b_alpha")?.status).toBe("cancelling");
    clock.advance(INTERRUPT_GRACE_MS);
    await flush();
    expect(stuck.turns.map((t) => t.input.from)).toEqual(["bot", "user"]);
    expect(host.history("b_alpha").filter((r) => r.type === "turn_ended")).toMatchObject([{ end: { reason: "interrupted" } }]);
  });

  test("ids a file system might refuse are named by their hash; the meta keeps the real id", async () => {
    const { home, clock, host } = durable();
    host.open({ id: "agent:7.alpha", kind: "agent", bot: "alpha", computer: "Studio" }, new FakeSessionDriver({ canFold: false }));
    await host.close();
    const files = readdirSync(join(home, "transcripts", "alpha"));
    expect(files.every((f) => /^h-[0-9a-f]{40}\.(ndjson|meta\.json)$/.test(f))).toBe(true);
    expect(new DurableSessionHost({ home, clock }).get("agent:7.alpha")?.kind).toBe("agent");
  });

  test("a meta file in the wrong folder is skipped", () => {
    const { home, clock, host } = durable();
    host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, new FakeSessionDriver());
    const meta = readFileSync(sessionMetaPath(home, "alpha", "b_alpha"), "utf8");
    rmSync(join(home, "transcripts", "alpha"), { recursive: true });
    mkdirSync(join(home, "transcripts", "luna"), { recursive: true });
    writeFileSync(join(home, "transcripts", "luna", "b_alpha.meta.json"), meta);
    const b = durable(home, clock);
    expect(b.host.get("b_alpha")).toBeUndefined();
    expect(b.warnings.join("\n")).toContain("whose files live elsewhere");
  });
});
