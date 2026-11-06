// DurableSessionHost (../durable-host.ts): first the SessionHost contract's own conformance suite (lane B's), run against
// the durable host as against B's fake, so the two route the same way; then what only a host with a log on disk does: survive a restart,
// repair a torn log, remember resends, hand notes and routine results to the next turn, count what needs the user.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContractError } from "../../contracts/common";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { advanceAndSettle, FakeClock, flush } from "../../contracts/fakes/clock";
import { runSessionHostConformance, type SessionHostHarness } from "../../contracts/conformance/session-host";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import type { DeliveredInput, SessionRecord, UserInput } from "../../contracts/session-host";
import { DurableSessionHost, INTERRUPT_GRACE_MS, PUMP_RETRY_MS } from "../durable-host";
import { MAX_RECORD_BYTES } from "../event-log";
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

// Lane B's conformance suite (review S15): the contract's own cases, the same ones its fake passes. The durable host
// also returns each input record's `seq` (`session.send`'s result); the harness leaves it out, as the contract does.
runSessionHostConformance((opts): SessionHostHarness => {
  const host = new DurableSessionHost({ home: tempHome(), ...opts });
  return {
    open: (spec, driver) => host.open(spec, driver),
    list: (filter) => host.list(filter),
    get: (id) => host.get(id),
    sendUser: async (id, input) => ({ disposition: (await host.sendUser(id, input)).disposition }),
    deliver: async (id, input) => ({ disposition: (await host.deliver(id, input)).disposition }),
    interrupt: (id) => host.interrupt(id),
    stop: (id, reason) => host.stop(id, reason),
    history: (id, o) => host.history(id, o),
    subscribe: (id, fn) => host.subscribe(id, fn),
    watch: (fn) => host.watch(fn),
    setAsleep: (id, asleep) => host.setAsleep(id, asleep),
  };
});

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

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

  test("a failed turn doesn't end a bot's conversation: it is recorded, what waits runs, and it reopens after a restart", async () => {
    const { home, clock, host } = durable();
    // A driver that can't fold, so the bot's message waits for a turn of its own.
    const d1 = new FakeSessionDriver({ canFold: false });
    host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, d1);
    await host.sendUser("b_alpha", user("hi"));
    await flush();
    expect(await host.deliver("b_alpha", fromBot)).toMatchObject({ disposition: "queued" });
    d1.end({ reason: "failed", failure: "sign-in", text: "sign in to Anthropic again" });
    await flush();
    // The bot's message waiting behind the failed turn runs next; the conversation is open throughout.
    expect(d1.turns.map((t) => t.input.from)).toEqual(["user", "bot"]);
    expect(host.get("b_alpha")).toMatchObject({ status: "prompting" });
    expect(host.get("b_alpha")?.failure).toBeUndefined();
    d1.end();
    await flush();
    expect(host.history("b_alpha").filter((r) => r.type === "turn_ended").map((r) => (r.type === "turn_ended" ? r.end.reason : ""))).toEqual(["failed", "end_turn"]);
    expect(await host.sendUser("b_alpha", user("still there?"))).toMatchObject({ disposition: "turn" });
    await flush();
    d1.end({ reason: "failed", failure: "error" });
    await flush();
    expect(host.get("b_alpha")?.status).toBe("idle");
    await host.close();

    const again = new DurableSessionHost({ home, clock });
    expect(again.get("b_alpha")?.status).toBe("idle");
    const d2 = new FakeSessionDriver();
    again.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, d2);
    expect(await again.sendUser("b_alpha", user("and now?"))).toMatchObject({ disposition: "turn" });
  });

  test("a torn last line is dropped; a corrupt line in the middle is a lost record, with the file copied aside first", async () => {
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
    expect(b.host.length("b_alpha")).toBe(n);
    expect(b.host.history("b_alpha")[1]).toMatchObject({ type: "driver", event: { type: "record_lost" } });
    expect(b.warnings.join("\n")).toContain("unreadable record(s) in the middle");
    expect(readdirSync(join(home, "transcripts", "alpha")).some((f) => f.includes(".corrupt-"))).toBe(true);
    // The log goes on after its last record.
    b.host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, new FakeSessionDriver());
    expect((await b.host.sendUser("b_alpha", user("two"))).seq).toBe(n);
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

describe("DurableSessionHost when things go wrong", () => {
  const open = (host: DurableSessionHost, driver = new FakeSessionDriver()) => {
    host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, driver);
    return driver;
  };

  test("a log whose meta was lost is picked up by `open`, never written over", async () => {
    const { home, clock, host } = durable();
    const d1 = open(host);
    for (const t of ["one", "two"]) {
      await host.sendUser("b_alpha", user(t));
      await flush();
      d1.end({ text: `re ${t}` });
      await flush();
    }
    const before = host.history("b_alpha");
    await host.close();
    writeFileSync(sessionMetaPath(home, "alpha", "b_alpha"), "{ not json");

    const again = durable(home, clock);
    expect(again.host.get("b_alpha")).toBeUndefined();
    const d2 = open(again.host);
    expect(again.warnings.join("\n")).toContain("picked up again");
    expect(again.host.history("b_alpha").slice(0, before.length)).toEqual(before);
    expect(await again.host.sendUser("b_alpha", user("three"))).toEqual({ disposition: "turn", seq: before.length });
    await flush();
    expect(d2.turns.map((t) => t.input.from === "user" && t.input.text)).toEqual(["three"]);
    const seqs = readFileSync(sessionLogPath(home, "alpha", "b_alpha"), "utf8").trimEnd().split("\n").map((l) => (JSON.parse(l) as SessionRecord).seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  });

  test("a meta written by a newer Clover stops the start rather than be skipped", async () => {
    const { home, clock, host } = durable();
    open(host);
    await host.close();
    writeFileSync(sessionMetaPath(home, "alpha", "b_alpha"), JSON.stringify({ meta: 2, id: "b_alpha" }));
    expect(() => new DurableSessionHost({ home, clock })).toThrow("newer Clover");
  });

  test("when the disk refuses a turn's start, the input stays first in line and runs once the disk is back", async () => {
    const { home, clock, host, warnings } = durable();
    const d = open(host);
    const log = sessionLogPath(home, "alpha", "b_alpha");
    let armed = true;
    host.subscribe("b_alpha", (r) => {
      if (armed && r.type === "input") {
        armed = false;
        chmodSync(log, 0o444); // the disk is full from here
      }
    });
    expect(await host.sendUser("b_alpha", user("hello", 1, "m1"))).toMatchObject({ disposition: "turn" });
    await flush();
    expect(d.turns).toHaveLength(0);
    expect(warnings.join("\n")).toContain("turn_started record wasn't written");
    // A bot's message now is refused, not folded into a turn that doesn't exist.
    await expect(host.deliver("b_alpha", fromBot)).rejects.toThrow();
    chmodSync(log, 0o644);
    // A resend is the same message, and the retry runs it.
    expect(await host.sendUser("b_alpha", user("hello", 1, "m1"))).toMatchObject({ disposition: "turn" });
    await advanceAndSettle(clock, PUMP_RETRY_MS);
    expect(d.turns.map((t) => t.input.from === "user" && t.input.text)).toEqual(["hello"]);
    expect(host.get("b_alpha")?.status).toBe("prompting");
  });

  test("folds and the notes waiting for a turn reach a driver that subscribes after it starts building its prompt", async () => {
    const { host } = durable();
    const heard: string[] = [];
    let end: ((e: { reason: "end_turn" }) => void) | undefined;
    const late = {
      canFold: true,
      async turn(_input: unknown, ctl: { onFold(fn: (i: { from: string; text?: string }) => void): () => void }) {
        await Promise.resolve();
        ctl.onFold((i) => heard.push(`${i.from}:${i.text}`));
        return new Promise<{ reason: "end_turn" }>((resolve) => (end = resolve));
      },
      async interrupt() {},
      async stop() {},
    };
    host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, late as never);
    await host.deliver("b_alpha", { from: "note", label: "weather", text: "Rain at 6", by: { kind: "core" } });
    await host.deliver("b_alpha", { from: "routine", routine: "r1", name: "Inbox", sideThread: "t_1", text: "3 new mails" });
    await host.sendUser("b_alpha", user("hi"));
    expect(await host.deliver("b_alpha", fromBot)).toMatchObject({ disposition: "folded" });
    await flush();
    expect(heard).toEqual(["note:Rain at 6", "routine:3 new mails", "bot:The deploy finished."]);
    end?.({ reason: "end_turn" });
    await flush();
  });

  test("what a driver never subscribed to take waits for the next turn", async () => {
    const { host } = durable();
    const d = new FakeSessionDriver({ canFold: true });
    const realTurn = d.turn.bind(d);
    d.turn = (input, ctl) => realTurn(input, { ...ctl, onFold: () => () => {} });
    open(host, d);
    await host.sendUser("b_alpha", user("hi"));
    await host.deliver("b_alpha", { from: "note", label: "weather", text: "Rain at 6", by: { kind: "core" } });
    await host.deliver("b_alpha", fromBot);
    await flush();
    d.end();
    await flush();
    // The bot's message runs as a turn of its own, and the note is folded into it.
    expect(d.turns.map((t) => t.input.from)).toEqual(["user", "bot"]);
  });

  test("a driver that never finishes stopping holds nobody up past the grace", async () => {
    const { clock, host, warnings } = durable();
    const d = new FakeSessionDriver();
    d.stop = () => new Promise<void>(() => {});
    d.interrupt = () => new Promise<void>(() => {});
    open(host, d);
    await host.sendUser("b_alpha", user("hi"));
    await flush();
    let released = false;
    void host.release("b_alpha").then(() => (released = true));
    await flush();
    expect(released).toBe(false);
    await advanceAndSettle(clock, INTERRUPT_GRACE_MS * 2, INTERRUPT_GRACE_MS);
    expect(released).toBe(true);
    expect(host.isAttached("b_alpha")).toBe(false);
    expect(warnings.join("\n")).toContain("didn't interrupt within");
    expect(warnings.join("\n")).toContain("didn't stop within");
  });

  test("a queued input whose record was lost doesn't take a later one with it: replay goes by the started input's seq", async () => {
    const { home, clock, host } = durable();
    const d1 = new FakeSessionDriver({ canFold: false });
    host.open({ id: "a_1", kind: "agent", computer: "Studio" }, d1);
    for (const t of ["A", "B", "C"]) await host.sendUser("a_1", user(t));
    await flush();
    d1.end({ text: "did A" });
    await flush(); // B runs now, C waits
    const started = host.history("a_1").filter((r) => r.type === "turn_started");
    const bSeq = host.history("a_1").find((r) => r.type === "input" && r.input.from === "user" && r.input.text === "B")!.seq;
    expect(started.at(-1)).toMatchObject({ inputSeq: bSeq });
    // The daemon dies, and B's input line is damaged.
    const path = sessionLogPath(home, undefined, "a_1");
    const lines = readFileSync(path, "utf8").split("\n");
    const at = lines.findIndex((l) => l.includes('"text":"B"'));
    lines[at] = lines[at]!.replace('"text":"B"', '"text":"B\u0000"');
    writeFileSync(path, lines.join("\n"));
    const again = durable(home, clock);
    const d2 = new FakeSessionDriver({ canFold: false });
    again.host.open({ id: "a_1", kind: "agent", computer: "Studio" }, d2);
    await flush();
    expect(d2.turns.map((t) => t.input.from === "user" && t.input.text)).toEqual(["C"]);
  });

  test("an input too large for the log is refused to its sender; the longest message the protocol takes fits whole", async () => {
    const { home, clock, host } = durable();
    const d = open(host);
    // A plugin's message over the cap: refused, nothing recorded, no turn.
    const before = host.length("b_alpha");
    await expect(host.deliver("b_alpha", { from: "plugin", pluginId: "weather", text: "x".repeat(MAX_RECORD_BYTES) })).rejects.toThrow("over the");
    expect(host.length("b_alpha")).toBe(before);
    // 1,000,000 control characters: 6 MB as JSON, the worst a user's message can be.
    const text = "\u0001".repeat(1_000_000);
    expect(await host.sendUser("b_alpha", { ...user("big"), text })).toMatchObject({ disposition: "turn" });
    await flush();
    expect(d.turns[0]?.input.from === "user" && d.turns[0].input.text.length).toBe(1_000_000);
    d.end();
    await flush();
    await host.close();
    const again = durable(home, clock);
    const logged = again.host.history("b_alpha").find((r) => r.type === "input");
    expect(logged?.type === "input" && logged.input.from === "user" && logged.input.text).toBe(text);
  });

  test("an ended session's log is read only when asked for", async () => {
    const { home, clock, host } = durable();
    host.open({ id: "t_run1", kind: "side-thread", bot: "alpha", parent: "b_alpha", computer: "Studio", routine: "r1" }, new FakeSessionDriver());
    await host.stop("t_run1", "the run ended");
    const length = host.length("t_run1");
    await host.close();
    expect(JSON.parse(readFileSync(sessionMetaPath(home, "alpha", "t_run1"), "utf8"))).toMatchObject({ ended: { status: "stopped" } });
    // A log that couldn't even be read wouldn't stop the start: it isn't read.
    writeFileSync(sessionLogPath(home, "alpha", "t_run1"), "{ broken\n" + readFileSync(sessionLogPath(home, "alpha", "t_run1"), "utf8"));
    const again = durable(home, clock);
    expect(again.host.get("t_run1")).toMatchObject({ status: "stopped" });
    expect(again.warnings).toEqual([]);
    expect(again.host.length("t_run1")).toBe(length);
  });
});
