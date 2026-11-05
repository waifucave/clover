// Pins the SessionHost contract through FakeSessionHost and FakeSessionDriver: interrupts, folding, queueing, task
// notifications, the cards an interrupt or a stop resolves, and send order.
import { describe, expect, test } from "bun:test";
import type { ApprovalDecision } from "../approval-broker";
import { isContractError } from "../common";
import { FakeApprovalBroker } from "../fakes/approval-broker";
import { FakeClock, flush } from "../fakes/clock";
import { FakeSessionDriver, FakeSessionHost } from "../fakes/session-host";
import type { DeliveredInput, SessionRecord, UserInput } from "../session-host";

const user = (text: string, sentAt = 1): Omit<UserInput, "from"> => ({ text, device: "phone0000000000000", sentAt, clientMessageId: `m-${text}` });
const fromBot: DeliveredInput = { from: "bot", bot: "pack/luna", session: "s_luna", text: "The deploy finished." };

function setup() {
  const clock = new FakeClock();
  const approvals = new FakeApprovalBroker({ clock });
  let epoch = 3;
  const host = new FakeSessionHost({ clock, approvals, epoch: () => epoch });
  const botDriver = new FakeSessionDriver({ canFold: true });
  host.open({ id: "s_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, botDriver);
  return { clock, approvals, host, botDriver, setEpoch: (e: number) => (epoch = e) };
}

function openAgent(host: FakeSessionHost) {
  const driver = new FakeSessionDriver({ canFold: false });
  host.open({ id: "s_agent", kind: "agent", bot: "alpha", parent: "s_alpha", computer: "Desktop1", backend: "claude-code", root: "home/Desktop1/project1" }, driver);
  return driver;
}

const inputs = (records: SessionRecord[]) => records.filter((r) => r.type === "input").map((r) => (r.type === "input" ? [r.input.from, r.disposition] : []));

describe("FakeSessionHost", () => {
  test("the user's message starts a turn in an idle bot", async () => {
    const { host, botDriver } = setup();
    expect(host.get("s_alpha")?.status).toBe("ready");
    expect(await host.sendUser("s_alpha", user("hi"))).toEqual({ disposition: "turn" });
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
    expect(await host.sendUser("s_alpha", user("stop, wrong folder"))).toEqual({ disposition: "interrupted" });
    await flush();
    expect(botDriver.interrupts).toBe(1);
    expect(await card).toMatchObject({ allowed: false, by: "withdrawn" });
    expect(botDriver.turns.map((t) => [t.input.from, t.origin])).toEqual([["bot", "bot"], ["user", "user"]]);
    const ended = host.history("s_alpha").filter((r) => r.type === "turn_ended");
    expect(ended).toMatchObject([{ end: { reason: "interrupted" } }]);
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
    expect(await host.deliver("s_alpha", fromBot)).toEqual({ disposition: "folded" });
    expect(await host.deliver("s_alpha", { from: "routine", routine: "r_1", name: "Morning", sideThread: "s_side", text: "3 issues" })).toEqual({ disposition: "folded" });
    expect(botDriver.turns[0]!.folded.map((i) => i.from)).toEqual(["bot", "routine"]);
    expect(botDriver.interrupts).toBe(0);
  });

  test("an idle session starts a turn for a delivered message, with that message's origin", async () => {
    const { host, botDriver } = setup();
    expect(await host.deliver("s_alpha", { from: "plugin", pluginId: "weather", text: "Rain after 4" })).toEqual({ disposition: "turn" });
    await flush();
    expect(botDriver.turns[0]!.origin).toBe("plugin");
  });

  test("a note never starts a turn", async () => {
    const { host, botDriver } = setup();
    expect(await host.deliver("s_alpha", { from: "note", label: "Forecast", text: "Rain", by: { kind: "plugin", pluginId: "weather" } })).toEqual({ disposition: "note" });
    await flush();
    expect(botDriver.turns).toEqual([]);
  });

  test("an agent can't fold: the user's and the bot's messages queue as its next prompts, without interrupting", async () => {
    const { host } = setup();
    const agent = openAgent(host);
    await host.deliver("s_agent", { from: "bot", bot: "alpha", session: "s_alpha", text: "Fix the login bug" });
    await flush();
    expect(await host.sendUser("s_agent", user("also update the docs"))).toEqual({ disposition: "queued" });
    expect(await host.deliver("s_agent", { from: "bot", bot: "alpha", session: "s_alpha", text: "and run the tests" })).toEqual({ disposition: "queued" });
    expect(agent.interrupts).toBe(0);
    agent.end();
    await flush();
    expect(agent.turns.map((t) => t.input.from === "user" ? t.input.text : t.input.from === "bot" ? t.input.text : "")).toEqual(["Fix the login bug", "also update the docs"]);
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
