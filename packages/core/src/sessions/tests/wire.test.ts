// The wire (../wire.ts): every record a session's log can hold projects onto an event the protocol's schemas accept,
// in order, with the envelope and the lease epoch; sealed card parts never reach a plugin.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloverSessionEvent, SessionEvent, UserMessageEvent, UserMessageStamp } from "@waifucave/clover-protocol";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import type { SessionRecord } from "../../contracts/session-host";
import { DurableSessionHost } from "../durable-host";
import { projectRecord, projectRecords, WIRE_EVENT_TYPES } from "../wire";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/** The inherited user message, with the stamp Clover adds (§6.4). */
const StampedUserMessage = UserMessageEvent.extend(UserMessageStamp.shape);

function parseWire(event: Record<string, unknown>): void {
  if (event.type === "user_message") {
    StampedUserMessage.parse(event);
    return;
  }
  const clover = CloverSessionEvent.safeParse(event);
  if (clover.success) return;
  SessionEvent.parse(event);
}

describe("projecting a session's log", () => {
  test("a conversation with every kind of input projects onto events the protocol accepts, records without one left out", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-d-wire-"));
    homes.push(home);
    const clock = new FakeClock();
    const host = new DurableSessionHost({ home, clock, epoch: () => 7 });
    const d = new FakeSessionDriver();
    host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, d);
    await host.sendUser("b_alpha", { text: "Look at [Image #1]", device: "studio0000000000000", sentAt: clock.now(), clientMessageId: "c1", images: [{ n: 1, path: "/tmp/a.png" }] });
    await flush();
    d.emit({ type: "tool_call", callId: "call_1", name: "Bash", argsJson: "{\"command\":\"ls\"}" });
    d.emit({ type: "tool_result", callId: "call_1", output: "a.txt", isError: false });
    d.emit({ type: "turn_usage", model: "anthropic/claude-sonnet-5-5", inputTokens: 10, outputTokens: 2 });
    await host.deliver("b_alpha", { from: "bot", bot: "pack/luna", session: "b_pack--luna", text: "Deploy done." });
    await host.deliver("b_alpha", { from: "agent", agent: "a_1", text: "Tests pass." });
    await host.deliver("b_alpha", { from: "routine", routine: "r_1", name: "Morning", sideThread: "t_1", text: "3 issues" });
    await host.deliver("b_alpha", { from: "plugin", pluginId: "blender", text: "Render frame 2", app: { callId: "call_7" } });
    await host.deliver("b_alpha", { from: "note", label: "Forecast", text: "Rain", by: { kind: "plugin", pluginId: "weather" } });
    await host.deliver("b_alpha", { from: "task-notification", agent: "a_1", backend: "claude-code", stopReason: "end_turn", text: "Done.", transcript: "bots/alpha/agents/a_1/acp.ndjson", usage: { inputTokens: 5, outputTokens: 1 } });
    d.emit({ type: "assistant_message", text: "All set." });
    d.end({ text: "All set.", usage: { inputTokens: 40, outputTokens: 8 } });
    await flush();
    const records = host.history("b_alpha");
    const events = projectRecords(records, { kind: "bot" });
    for (const e of events) parseWire(e);
    expect(events.map((e) => e.type)).toEqual([
      "user_message", "turn_started", "tool_call", "tool_result", "bot_message", "agent_message", "routine_result",
      "plugin_message", "note", "agent_finished", "assistant_message", "turn_completed",
    ]);
    expect(events.every((e) => e.epoch === 7 && e.sessionId === "b_alpha")).toBe(true);
    expect(events[0]).toMatchObject({ device: "studio0000000000000", sentAt: clock.now(), images: [{ n: 1, path: "/tmp/a.png" }] });
    expect(events.at(-1)).toMatchObject({ stopReason: "end_turn", inputTokens: 40, outputTokens: 8 });
    // Status records reach clients as `session_changed`; `turn_usage` is the usage counter's.
    expect(records.filter((r) => r.type === "status").map((r) => projectRecord(r, { kind: "bot" }))).toEqual([undefined, undefined, undefined]);
    expect(WIRE_EVENT_TYPES.has("turn_usage")).toBe(false);
  });

  test("a routine's input is the run's instructions in its side thread, and its result in the conversation", () => {
    const record: SessionRecord = { type: "input", disposition: "turn", seq: 0, sessionId: "t_1", ts: 1, input: { from: "routine", routine: "r_1", name: "Nightly backup", sideThread: "t_1", text: "Back up the photos." } };
    expect(projectRecord(record, { kind: "side-thread" })).toEqual({ type: "note", seq: 0, sessionId: "t_1", ts: 1, from: { kind: "core" }, label: "Nightly backup", text: "Back up the photos." });
    expect(projectRecord(record, { kind: "bot" })).toMatchObject({ type: "routine_result", routine: "r_1", sideThread: "t_1" });
  });

  test("a turn's end maps onto the inherited stop reasons", () => {
    const end = (reason: "end_turn" | "refusal" | "interrupted" | "cancelled" | "stopped" | "failed") =>
      projectRecord({ type: "turn_ended", seq: 1, sessionId: "s", ts: 1, end: { reason } }, { kind: "bot" })?.stopReason;
    expect(["end_turn", "refusal", "interrupted", "cancelled", "stopped", "failed"].map((r) => end(r as never))).toEqual(["end_turn", "end_turn", "aborted", "aborted", "aborted", "error"]);
  });

  test("a plugin reader never gets a card's sealed parts", () => {
    const record: SessionRecord = {
      type: "driver", seq: 3, sessionId: "b_alpha", ts: 1,
      event: { type: "approval_requested", callId: "call_2", toolName: "Bash", summary: "rm -rf build", reviewerReason: "deletes files" },
    };
    expect(projectRecord(record, { kind: "bot" })).toMatchObject({ summary: "rm -rf build", reviewerReason: "deletes files" });
    const forPlugin = projectRecord(record, { kind: "bot", sealed: true })!;
    expect(forPlugin.summary).toBeUndefined();
    expect(forPlugin.reviewerReason).toBeUndefined();
    expect(forPlugin).toMatchObject({ type: "approval_requested", callId: "call_2", toolName: "Bash" });
  });
});
