// What D-M2 adds to the durable host and around it: compaction on the host's word and on the clock (§6.3), the gate,
// calls that never ended (a restart, a takeover), every session's caller naming its bot, and per-session grants (R10).
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalDecision, ApprovalRequest } from "../../contracts/approval-broker";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import type { DeliveredInput, SessionRecord, UserInput } from "../../contracts/session-host";
import { CacheTimedCompaction, DEFAULT_COMPACTION_POLICY } from "../compaction";
import { CORE_ONLY_EVENT_TYPES, DurableSessionHost, interruptedCallOutput, type CompactReason } from "../durable-host";
import { SessionGrants, USER_BROWSER_PARTITION_GRANT } from "../grants";
import { acpRecordEvent, projectRecords } from "../wire";

const homes: string[] = [];
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "clover-d-life-"));
  homes.push(home);
  return home;
}
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const user = (text: string, sentAt = 1, id = `m-${text}`): Omit<UserInput, "from"> => ({ text, device: "phone0000000000000", sentAt, clientMessageId: id });
const fromBot: DeliveredInput = { from: "bot", bot: "pack/luna", session: "b_pack--luna", text: "The deploy finished." };
const driverEvents = (records: SessionRecord[], type: string) => records.flatMap((r) => (r.type === "driver" && r.event.type === type ? [r.event] : []));

/** A driver that compacts when the host asks, until the test finishes it or the signal aborts. */
class CompactingDriver extends FakeSessionDriver {
  readonly compactions: { reason: CompactReason; signal: AbortSignal }[] = [];
  #finish?: (r: { compacted: boolean }) => void;
  compact(req: { reason: CompactReason; signal: AbortSignal }): Promise<{ compacted: boolean }> {
    this.compactions.push(req);
    return new Promise((resolve) => {
      this.#finish = resolve;
      req.signal.addEventListener("abort", () => resolve({ compacted: false }), { once: true });
    });
  }
  finishCompaction(compacted = true): void {
    const f = this.#finish;
    this.#finish = undefined;
    f?.({ compacted });
  }
}

function hostOn(home = tempHome(), clock = new FakeClock(), mayStart?: (v: { kind: string }) => boolean) {
  const warnings: string[] = [];
  const host = new DurableSessionHost({ home, clock, warn: (m) => warnings.push(m), ...(mayStart ? { mayStart } : {}) });
  return { home, clock, host, warnings };
}

function openBot(host: DurableSessionHost, driver = new CompactingDriver()) {
  host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, driver);
  return driver;
}

describe("compaction on the host's word (§6.3)", () => {
  test("an idle session compacts; what arrives meanwhile waits and runs after", async () => {
    const { host } = hostOn();
    const d = openBot(host);
    const done = host.compact("b_alpha", "user");
    await flush();
    expect(d.compactions.map((c) => c.reason)).toEqual(["user"]);
    expect(host.get("b_alpha")!.status).toBe("prompting");
    expect(host.isCompacting("b_alpha")).toBe(true);
    // A forced compaction finishes first: the user's message waits for it rather than dropping it.
    expect((await host.sendUser("b_alpha", user("hi"))).disposition).toBe("queued");
    expect((await host.deliver("b_alpha", fromBot)).disposition).toBe("queued");
    await flush();
    expect(d.turns).toHaveLength(0);
    d.finishCompaction();
    expect(await done).toBe("compacted");
    await flush();
    expect(d.turns.map((t) => t.input.from)).toEqual(["user"]);
    const events = driverEvents(host.history("b_alpha"), "compaction");
    expect(events).toEqual([
      { type: "compaction", phase: "started", reason: "user" },
      { type: "compaction", phase: "ended", reason: "user", outcome: "compacted" },
    ]);
  });

  test("the user's message drops a cache-timed compaction and runs at once; another bot's message waits for it", async () => {
    const { host } = hostOn();
    const d = openBot(host);
    let done = host.compact("b_alpha", "cache");
    await flush();
    expect((await host.deliver("b_alpha", fromBot)).disposition).toBe("queued");
    expect(d.compactions[0]!.signal.aborted).toBe(false);
    d.finishCompaction();
    expect(await done).toBe("compacted");
    await flush();
    expect(d.turns.map((t) => t.input.from)).toEqual(["bot"]);
    d.end();
    await flush();

    done = host.compact("b_alpha", "cache");
    await flush();
    expect((await host.sendUser("b_alpha", user("are you there?"))).disposition).toBe("turn");
    expect(await done).toBe("dropped");
    await flush();
    expect(d.turns.map((t) => (t.input.from === "user" ? t.input.text : t.input.from))).toEqual(["bot", "are you there?"]);
    expect(driverEvents(host.history("b_alpha"), "compaction").at(-1)).toEqual({ type: "compaction", phase: "ended", reason: "cache", outcome: "dropped" });
  });

  test("the user's interrupt drops a cache-timed compaction, never a forced one", async () => {
    const { host } = hostOn();
    const d = openBot(host);
    const cache = host.compact("b_alpha", "cache");
    await flush();
    await host.interrupt("b_alpha");
    expect(await cache).toBe("dropped");
    const full = host.compact("b_alpha", "full");
    await flush();
    await host.interrupt("b_alpha");
    expect(d.compactions[1]!.signal.aborted).toBe(false);
    d.finishCompaction();
    expect(await full).toBe("compacted");
  });

  test("while a turn runs: a cache-timed one is skipped, a forced one runs as the turn ends, before what waits", async () => {
    const { host } = hostOn();
    const d = openBot(host);
    await host.deliver("b_alpha", fromBot);
    await flush();
    expect(await host.compact("b_alpha", "cache")).toBe("skipped");
    const forced = host.compact("b_alpha", "user");
    // The compaction goes first as the turn ends, and what arrives during it waits for it.
    d.end();
    await flush();
    expect(d.compactions.map((c) => c.reason)).toEqual(["user"]);
    expect((await host.deliver("b_alpha", { ...fromBot, text: "And another thing." })).disposition).toBe("queued");
    await flush();
    expect(d.turns).toHaveLength(1);
    d.finishCompaction();
    expect(await forced).toBe("compacted");
    await flush();
    expect(d.turns).toHaveLength(2);
  });

  test("something already waiting goes before a cache-timed compaction; a driver that can't compact says so", async () => {
    const { host } = hostOn(undefined, undefined, (v) => v.kind !== "bot");
    openBot(host);
    // The gate is shut: the message waits, and a cache-timed compaction then yields to it.
    await host.deliver("b_alpha", fromBot);
    expect(await host.compact("b_alpha", "cache")).toBe("skipped");
    host.open({ id: "s_agent", kind: "agent", bot: "alpha", parent: "b_alpha", computer: "Studio", backend: "codex" }, new FakeSessionDriver({ canFold: false }));
    expect(await host.compact("s_agent", "user")).toBe("unsupported");
  });

  test("a compaction the context forces inside a turn finishes before the user's message interrupts", async () => {
    const { host } = hostOn();
    const d = openBot(host);
    await host.deliver("b_alpha", fromBot);
    await flush();
    d.emit({ type: "compaction", phase: "started", reason: "full" });
    expect(host.isCompacting("b_alpha")).toBe(true);
    expect((await host.sendUser("b_alpha", user("stop"))).disposition).toBe("interrupted");
    await flush();
    expect(d.interrupts).toBe(0);
    d.emit({ type: "compaction", phase: "ended", reason: "full", outcome: "compacted" });
    await flush();
    expect(d.interrupts).toBe(1);
    expect(d.turns.map((t) => (t.input.from === "user" ? t.input.text : t.input.from))).toEqual(["bot", "stop"]);
  });

  test("stopping a session drops its compaction", async () => {
    const { host } = hostOn();
    const d = new CompactingDriver();
    host.open({ id: "s_side", kind: "side-thread", bot: "alpha", parent: "b_alpha", computer: "Studio" }, d);
    const done = host.compact("s_side", "user");
    await flush();
    await host.stop("s_side");
    expect(await done).toBe("dropped");
    expect(host.get("s_side")!.status).toBe("stopped");
  });
});

describe("cache-timed compaction (§6.3, §6.1)", () => {
  const usage = (inputTokens: number) => ({ usage: { inputTokens, outputTokens: 2_000 } });

  test("over the threshold, it compacts just before the cache expires; a turn in between moves it", async () => {
    const { host, clock } = hostOn();
    const d = openBot(host);
    const timed = new CacheTimedCompaction({ host, clock });
    await host.deliver("b_alpha", fromBot);
    await flush();
    d.end(usage(130_000));
    await flush();
    const ended = clock.now();
    const { cacheTtlMs, leadMs } = DEFAULT_COMPACTION_POLICY;
    expect(timed.dueAt("b_alpha")).toBe(ended + cacheTtlMs - leadMs);
    // Another turn before then restarts the cache's life.
    clock.advance(60_000);
    await host.deliver("b_alpha", fromBot);
    await flush();
    expect(timed.dueAt("b_alpha")).toBeUndefined();
    d.end(usage(131_000));
    await flush();
    const second = clock.now();
    clock.advance(cacheTtlMs - leadMs - 1);
    await flush();
    expect(d.compactions).toHaveLength(0);
    clock.advance(1);
    await flush();
    expect(d.compactions.map((c) => c.reason)).toEqual(["cache"]);
    expect(clock.now()).toBe(second + cacheTtlMs - leadMs);
    d.finishCompaction();
    await flush();
    expect(timed.outcomes()).toEqual([{ id: "b_alpha", outcome: "compacted" }]);
    // A compaction is a model call on the short context: the cache is warm, and nothing more is due.
    expect(timed.cacheCold("b_alpha")).toBe(false);
    expect(timed.dueAt("b_alpha")).toBeUndefined();
    timed.close();
  });

  test("under the threshold it never compacts; once the cache has expired, the next turn is told it is cold", async () => {
    const { host, clock } = hostOn();
    const d = openBot(host);
    const timed = new CacheTimedCompaction({ host, clock });
    expect(timed.cacheCold("b_alpha")).toBe(true);
    await host.deliver("b_alpha", fromBot);
    await flush();
    d.end(usage(40_000));
    await flush();
    expect(timed.dueAt("b_alpha")).toBeUndefined();
    expect(timed.cacheCold("b_alpha")).toBe(false);
    clock.advance(DEFAULT_COMPACTION_POLICY.cacheTtlMs);
    await flush();
    expect(d.compactions).toHaveLength(0);
    expect(timed.cacheCold("b_alpha")).toBe(true);
    timed.close();
  });

  test("the numbers are settings; only bots' own conversations compact on the clock", async () => {
    const { host, clock } = hostOn();
    const d = openBot(host);
    const side = new CompactingDriver();
    host.open({ id: "s_side", kind: "side-thread", bot: "alpha", parent: "b_alpha", computer: "Studio" }, side);
    const timed = new CacheTimedCompaction({ host, clock, policy: () => ({ cacheTtlMs: 60 * 60_000, thresholdTokens: 50_000, leadMs: 60_000 }) });
    await host.deliver("b_alpha", fromBot);
    await host.deliver("s_side", { from: "routine", routine: "r1", name: "Brief", sideThread: "s_side", text: "go" });
    await flush();
    d.end(usage(60_000));
    side.end(usage(200_000));
    await flush();
    expect(timed.dueAt("b_alpha")).toBe(clock.now() + 59 * 60_000);
    expect(timed.dueAt("s_side")).toBeUndefined();
    timed.close();
  });

  test("a dropped one is tried again after the turn the user's message started", async () => {
    const { host, clock } = hostOn();
    const d = openBot(host);
    const timed = new CacheTimedCompaction({ host, clock });
    await host.deliver("b_alpha", fromBot);
    await flush();
    d.end(usage(150_000));
    await flush();
    clock.advance(DEFAULT_COMPACTION_POLICY.cacheTtlMs - DEFAULT_COMPACTION_POLICY.leadMs);
    await flush();
    expect(d.compactions).toHaveLength(1);
    await host.sendUser("b_alpha", user("quick question"));
    await flush();
    expect(timed.outcomes()).toEqual([{ id: "b_alpha", outcome: "dropped" }]);
    d.end(usage(152_000));
    await flush();
    expect(timed.dueAt("b_alpha")).toBe(clock.now() + DEFAULT_COMPACTION_POLICY.cacheTtlMs - DEFAULT_COMPACTION_POLICY.leadMs);
    timed.close();
  });

  test("after a restart it reads the last turn's end from the log", async () => {
    const home = tempHome();
    const clock = new FakeClock();
    const first = hostOn(home, clock);
    const d = openBot(first.host);
    await first.host.deliver("b_alpha", fromBot);
    await flush();
    d.end(usage(120_000));
    await flush();
    const ended = clock.now();
    await first.host.close();
    clock.advance(10_000);
    const again = hostOn(home, clock);
    openBot(again.host);
    const timed = new CacheTimedCompaction({ host: again.host, clock });
    expect(timed.dueAt("b_alpha")).toBe(ended + DEFAULT_COMPACTION_POLICY.cacheTtlMs - DEFAULT_COMPACTION_POLICY.leadMs);
    expect(timed.cacheCold("b_alpha")).toBe(false);
    timed.close();
  });
});

describe("the gate", () => {
  test("while it is shut, inputs are recorded and wait; resume starts them", async () => {
    let open = false;
    const { host } = hostOn(undefined, undefined, (v) => v.kind !== "bot" || open);
    const d = openBot(host, new FakeSessionDriver() as CompactingDriver);
    expect((await host.sendUser("b_alpha", user("hello"))).disposition).toBe("queued");
    expect((await host.deliver("b_alpha", fromBot)).disposition).toBe("queued");
    await flush();
    expect(d.turns).toHaveLength(0);
    // Other kinds aren't held.
    const agent = new FakeSessionDriver({ canFold: false });
    host.open({ id: "s_agent", kind: "agent", bot: "alpha", parent: "b_alpha", computer: "Studio", backend: "codex" }, agent);
    await host.deliver("s_agent", { from: "bot", bot: "alpha", session: "b_alpha", text: "go" });
    await flush();
    expect(agent.turns).toHaveLength(1);
    open = true;
    host.resume();
    await flush();
    expect(d.turns.map((t) => t.input.from)).toEqual(["user"]);
  });
});

describe("calls that never ended", () => {
  test("a restart gives each call of the turn it interrupts an interrupted result", async () => {
    const home = tempHome();
    const clock = new FakeClock();
    const first = hostOn(home, clock);
    const d = openBot(first.host);
    await first.host.deliver("b_alpha", fromBot);
    await flush();
    d.emit({ type: "tool_call", callId: "c1", name: "Bash", argsJson: "{}" });
    d.emit({ type: "tool_result", callId: "c1", output: "ok", isError: false });
    d.emit({ type: "tool_call", callId: "c2", name: "Bash", argsJson: "{\"command\":\"deploy\"}" });
    // The daemon dies here: no close, no turn end.
    const again = hostOn(home, clock);
    const records = again.host.history("b_alpha");
    expect(driverEvents(records, "tool_result").slice(1)).toEqual([{ type: "tool_result", callId: "c2", output: interruptedCallOutput(), isError: true }]);
    expect(records.at(-2)).toMatchObject({ type: "turn_ended", end: { reason: "interrupted" } });
  });

  test("a turn another computer left open waits; a takeover ends it, saying where its calls may have run", async () => {
    // Laptop ran the bot and stopped answering mid-turn; its log reached Studio as it was (lane H's sync).
    const laptopHome = tempHome();
    const clock = new FakeClock();
    const laptop = new DurableSessionHost({ home: laptopHome, clock, computer: "Laptop" });
    const ld = openBot(laptop);
    await laptop.deliver("b_alpha", fromBot);
    await flush();
    ld.emit({ type: "tool_call", callId: "a", name: "Bash", argsJson: "{\"command\":\"deploy\"}" });
    ld.emit({ type: "tool_call", callId: "b", name: "Edit", argsJson: "{}" });
    ld.emit({ type: "tool_result", callId: "a", output: "done", isError: false });
    const studioHome = tempHome();
    cpSync(join(laptopHome, "transcripts"), join(studioHome, "transcripts"), { recursive: true });
    let runsHere = false;
    const studio = new DurableSessionHost({ home: studioHome, clock, computer: "Studio", mayStart: (v) => v.kind !== "bot" || runsHere });
    const sd = openBot(studio);
    // Not Studio's turn to end while Laptop may still run it.
    expect(studio.history("b_alpha").at(-1)?.type).not.toBe("turn_ended");
    expect((await studio.sendUser("b_alpha", user("still there?"))).disposition).toBe("queued");
    await flush();
    expect(sd.turns).toHaveLength(0);
    expect(studio.catchUp("b_alpha")).toBe(1);
    const records = studio.history("b_alpha");
    expect(driverEvents(records, "tool_result").at(-1)).toEqual({ type: "tool_result", callId: "b", output: interruptedCallOutput("Laptop"), isError: true });
    expect(records.at(-1)).toMatchObject({ type: "turn_ended", end: { reason: "interrupted" } });
    expect(studio.catchUp("b_alpha")).toBe(0);
    runsHere = true;
    studio.resume();
    await flush();
    expect(sd.turns.map((t) => (t.input.from === "user" ? t.input.text : t.input.from))).toEqual(["still there?"]);
    // The turn's start names the computer running it.
    expect(studio.history("b_alpha").filter((r) => r.type === "turn_started").at(-1)).toMatchObject({ on: "Studio" });
  });

  test("the host catches a takeover up by itself before it starts the session's first turn here", async () => {
    const laptopHome = tempHome();
    const clock = new FakeClock();
    const laptop = new DurableSessionHost({ home: laptopHome, clock, computer: "Laptop" });
    const ld = openBot(laptop);
    await laptop.deliver("b_alpha", fromBot);
    await flush();
    ld.emit({ type: "tool_call", callId: "x", name: "Bash", argsJson: "{}" });
    const studioHome = tempHome();
    cpSync(join(laptopHome, "transcripts"), join(studioHome, "transcripts"), { recursive: true });
    const studio = new DurableSessionHost({ home: studioHome, clock, computer: "Studio" });
    const sd = openBot(studio);
    await flush();
    expect(driverEvents(studio.history("b_alpha"), "tool_result")).toEqual([{ type: "tool_result", callId: "x", output: interruptedCallOutput("Laptop"), isError: true }]);
    // The bot message Laptop was running isn't run again here.
    expect(sd.turns).toHaveLength(0);
  });
});

describe("a failed turn's cards", () => {
  test("resolve cancelled, whether the session ends (an agent) or goes on (a bot)", async () => {
    const cancelled: string[] = [];
    const approvals = { withdrawSession: () => 0, cancelSession: (id: string) => (cancelled.push(id), 1) };
    const host = new DurableSessionHost({ home: tempHome(), clock: new FakeClock(), approvals });
    const bot = openBot(host);
    const agent = new FakeSessionDriver({ canFold: false });
    host.open({ id: "s_agent", kind: "agent", bot: "alpha", parent: "b_alpha", computer: "Studio", backend: "codex" }, agent);
    await host.deliver("s_agent", { from: "bot", bot: "alpha", session: "b_alpha", text: "go" });
    await host.deliver("b_alpha", fromBot);
    await flush();
    agent.end({ reason: "failed", failure: "crashed" });
    await flush();
    expect(cancelled).toEqual(["s_agent"]);
    expect(host.get("s_agent")!.status).toBe("failed");
    bot.end({ reason: "failed", failure: "error" });
    await flush();
    expect(cancelled).toEqual(["s_agent", "b_alpha"]);
    // The bot goes on: its conversation never ends.
    expect(host.get("b_alpha")!.status).toBe("idle");
  });
});

describe("callers and core-only records", () => {
  test("a side thread and an agent carry their bot, from their own meta or their parent's", () => {
    const { host } = hostOn();
    openBot(host);
    host.open({ id: "s_side", kind: "side-thread", bot: "alpha", parent: "b_alpha", computer: "Studio" }, new FakeSessionDriver());
    host.open({ id: "s_agent", kind: "agent", parent: "b_alpha", computer: "Studio", backend: "codex" }, new FakeSessionDriver({ canFold: false }));
    host.open({ id: "s_code", kind: "coding", computer: "Studio", backend: "codex" }, new FakeSessionDriver({ canFold: false }));
    expect(host.callerOf("b_alpha")).toEqual({ kind: "session", sessionId: "b_alpha", sessionKind: "bot", bot: "alpha" });
    expect(host.callerOf("s_side")).toEqual({ kind: "session", sessionId: "s_side", sessionKind: "side-thread", bot: "alpha" });
    expect(host.callerOf("s_agent")).toEqual({ kind: "session", sessionId: "s_agent", sessionKind: "agent", bot: "alpha" });
    expect(host.callerOf("s_code")).toEqual({ kind: "session", sessionId: "s_code", sessionKind: "coding" });
  });

  test("a driver can't write a record only the core writes", async () => {
    const { host, warnings } = hostOn();
    const d = openBot(host);
    await host.deliver("b_alpha", fromBot);
    await flush();
    expect(CORE_ONLY_EVENT_TYPES.has("session_grant")).toBe(true);
    d.emit({ type: "session_grant", key: USER_BROWSER_PARTITION_GRANT });
    expect(driverEvents(host.history("b_alpha"), "session_grant")).toEqual([]);
    expect(warnings.some((w) => w.includes("session_grant event was dropped"))).toBe(true);
  });
});

describe("per-session grants (R10)", () => {
  function approvals() {
    const asked: ApprovalRequest[] = [];
    let answer: (d: ApprovalDecision) => void = () => {};
    return {
      asked,
      answer: (d: ApprovalDecision) => answer(d),
      broker: {
        request: (req: ApprovalRequest) => {
          asked.push(req);
          return new Promise<ApprovalDecision>((resolve) => {
            answer = resolve;
          });
        },
      },
    };
  }
  const card = { kind: "confirm" as const, computers: ["Studio"], effect: "screen" as const, fields: {} };

  test("the first ask shows one card; a yes holds for that session, after a restart too, and for no other", async () => {
    const home = tempHome();
    const clock = new FakeClock();
    const { host } = hostOn(home, clock);
    openBot(host);
    host.open({ id: "s_code", kind: "coding", computer: "Studio", backend: "codex" }, new FakeSessionDriver({ canFold: false }));
    const a = approvals();
    const grants = new SessionGrants({ host, approvals: a.broker });
    const one = grants.ensure("b_alpha", USER_BROWSER_PARTITION_GRANT, card);
    const two = grants.ensure("b_alpha", USER_BROWSER_PARTITION_GRANT, card);
    await flush();
    expect(a.asked).toHaveLength(1);
    expect(a.asked[0]).toMatchObject({ session: "b_alpha", bot: "alpha", origin: "bot", kind: "confirm" });
    a.answer({ allowed: true, by: "card", cardId: "card_1" });
    expect(await one).toMatchObject({ allowed: true, by: "card" });
    expect(await two).toMatchObject({ allowed: true, by: "card" });
    expect(await grants.ensure("b_alpha", USER_BROWSER_PARTITION_GRANT, card)).toEqual({ allowed: true, by: "grant", cardId: "card_1" });
    expect(grants.has("s_code", USER_BROWSER_PARTITION_GRANT)).toBe(false);
    await host.close();
    const again = hostOn(home, clock);
    expect(new SessionGrants({ host: again.host, approvals: approvals().broker }).has("b_alpha", USER_BROWSER_PARTITION_GRANT)).toBe(true);
  });

  test("a no is asked again next time; an ended session takes no grant", async () => {
    const { host } = hostOn();
    openBot(host);
    host.open({ id: "s_code", kind: "coding", computer: "Studio", backend: "codex" }, new FakeSessionDriver({ canFold: false }));
    const a = approvals();
    const grants = new SessionGrants({ host, approvals: a.broker });
    const no = grants.ensure("s_code", USER_BROWSER_PARTITION_GRANT, card);
    await flush();
    a.answer({ allowed: false, by: "card", cardId: "card_2" });
    expect((await no).allowed).toBe(false);
    void grants.ensure("s_code", USER_BROWSER_PARTITION_GRANT, card);
    await flush();
    expect(a.asked).toHaveLength(2);
    expect(a.asked[1]).not.toHaveProperty("bot");
    await host.stop("s_code");
    await expect(grants.ensure("s_code", USER_BROWSER_PARTITION_GRANT, card)).rejects.toThrow("has ended");
  });

  test("the user's own turn is the card's origin, so it waits for them", async () => {
    const { host } = hostOn();
    openBot(host);
    await host.sendUser("b_alpha", user("look this up on my account"));
    await flush();
    const a = approvals();
    void new SessionGrants({ host, approvals: a.broker }).ensure("b_alpha", USER_BROWSER_PARTITION_GRANT, card);
    await flush();
    expect(a.asked[0]!.origin).toBe("user");
  });
});

describe("an agent's live tab reads its ACP records as a code session's (item 90)", () => {
  test("text, tool calls and their ends project onto the inherited events; thoughts and usage stay home", async () => {
    const { host } = hostOn();
    openBot(host);
    const agent = new FakeSessionDriver({ canFold: false });
    host.open({ id: "s_agent", kind: "agent", bot: "alpha", parent: "b_alpha", computer: "Studio", backend: "codex" }, agent);
    await host.deliver("s_agent", { from: "bot", bot: "alpha", session: "b_alpha", text: "fix the tests" });
    await flush();
    agent.emit({ type: "agent_thought", text: "Looking at the failures." });
    agent.emit({ type: "agent_tool_call", id: "t1", kind: "execute", title: "bun test", status: "pending", rawInput: { command: "bun test" } });
    agent.emit({ type: "agent_tool_call_update", id: "t1", status: "in_progress" });
    agent.emit({ type: "agent_tool_call_update", id: "t1", status: "completed" });
    agent.emit({ type: "agent_tool_call", id: "t2", kind: "edit", title: "Edit src/a.ts", status: "pending" });
    agent.emit({ type: "agent_tool_call_update", id: "t2", status: "failed", refused: true });
    agent.emit({ type: "agent_text", text: "Fixed two tests." });
    agent.emit({ type: "agent_usage", inputTokens: 10, outputTokens: 5 });
    const events = projectRecords(host.history("s_agent"), { kind: "agent" }).filter((e) => !["user_message", "turn_started", "bot_message"].includes(e.type));
    expect(events.map((e) => [e.type, e["callId"] ?? e["text"]])).toEqual([
      ["tool_call", "t1"], ["tool_result", "t1"], ["tool_call", "t2"], ["tool_result", "t2"], ["assistant_message", "Fixed two tests."],
    ]);
    expect(events[0]).toMatchObject({ name: "bun test", argsJson: "{\"command\":\"bun test\"}", threadId: "s_agent" });
    expect(events[3]).toMatchObject({ output: "Refused.", isError: true });
    // A bot's own conversation never reads them so: its driver is the embedded runtime.
    expect(acpRecordEvent({ type: "agent_text", text: "x" })).toEqual({ type: "assistant_message", text: "x" });
    expect(projectRecords([{ type: "driver", event: { type: "agent_text", text: "x" }, seq: 0, sessionId: "b_alpha", ts: 1 }], { kind: "bot" })).toEqual([]);
  });
});
