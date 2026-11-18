// The tracker that reads the session host into the feed (spec revision 19, §3.6, G4): the states a bot and a code session
// show, the tool's wire name, and the one property that matters: nothing said, no tool argument and no card text is ever
// in a view the feed holds, whatever the records carried.
import { describe, expect, test } from "bun:test";
import type { SessionView } from "@waifucave/moss-protocol";
import type { SessionRecord } from "../../contracts/session-host";
import { Listeners } from "../../contracts/common";
import { ActivityTracker, DONE_MS } from "../derive";
import { EngineActivityFeed } from "../feed";

const SECRETS = ["hunter2-password", "rm -rf /secret", "Delete my tax folder?", "sk-live-0123456789", "the key is under the mat"];

class Host {
  readonly views = new Map<string, SessionView>();
  readonly watchers = new Listeners<SessionView>();
  readonly subs = new Map<string, Listeners<SessionRecord>>();
  seq = 0;
  list() { return [...this.views.values()]; }
  get(id: string) { return this.views.get(id); }
  watch(fn: (v: SessionView) => void) { return this.watchers.add(fn); }
  subscribe(id: string, fn: (r: SessionRecord) => void) { const l = this.subs.get(id) ?? new Listeners<SessionRecord>(); this.subs.set(id, l); return l.add(fn); }
  put(v: SessionView) { this.views.set(v.id, v); this.watchers.emit(v); }
  record(id: string, body: Record<string, unknown>) { this.subs.get(id)?.emit({ seq: this.seq++, sessionId: id, ts: 1, ...body } as unknown as SessionRecord); }
}
const view = (extra: Partial<SessionView> & { id: string; kind: SessionView["kind"] }): SessionView => ({ computer: "mac", status: "ready", startedAt: 1, updatedAt: 1, ...extra });

function setup() {
  const host = new Host();
  const feed = new EngineActivityFeed();
  const ended: string[] = [];
  let now = 1000;
  const timers: { fn: () => void; ms: number }[] = [];
  const t = new ActivityTracker({
    host, feed, now: () => now, botName: (id) => (id === "alpha" ? "Alpha" : undefined), onSessionEnded: (id) => ended.push(id),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
  });
  t.start();
  return { host, feed, t, ended, timers, tick: (ms: number) => { now += ms; } };
}
const bots = (feed: EngineActivityFeed) => feed.list("bots", { kind: "user" });
const code = (feed: EngineActivityFeed) => feed.list("sessions", { kind: "user" });

describe("a bot's state in the feed", () => {
  test("thinking, then working with the tool's wire name, then done, then idle", () => {
    const { host, feed, timers } = setup();
    host.put(view({ id: "s_a", kind: "bot", bot: "alpha" }));
    expect(bots(feed)).toEqual([expect.objectContaining({ subject: { kind: "bots", id: "alpha" }, state: "idle", name: "Alpha" })]);
    host.put(view({ id: "s_a", kind: "bot", bot: "alpha", status: "prompting" }));
    host.record("s_a", { type: "turn_started", origin: "user" });
    expect(bots(feed)[0]!.state).toBe("thinking");
    host.record("s_a", { type: "driver", event: { type: "tool_call", callId: "c1", name: "mcp__moss__Browser", argsJson: JSON.stringify({ url: SECRETS[1] }) } });
    expect(bots(feed)[0]).toMatchObject({ state: "working", tool: "mcp__moss__Browser" });
    host.record("s_a", { type: "driver", event: { type: "tool_result", callId: "c1", output: SECRETS[4] } });
    expect(bots(feed)[0]!.state).toBe("thinking");
    host.record("s_a", { type: "turn_ended", end: { reason: "end_turn", text: SECRETS[0] } });
    host.put(view({ id: "s_a", kind: "bot", bot: "alpha", status: "idle" }));
    expect(bots(feed)[0]!.state).toBe("done");
    timers.at(-1)!.fn();
    expect(timers.at(-1)!.ms).toBe(DONE_MS);
    expect(bots(feed)[0]!.state).toBe("idle");
  });

  test("a waiting card or question is asking; a failed session is stuck; the bot shows what its coding task is doing", () => {
    const { host, feed } = setup();
    host.put(view({ id: "s_a", kind: "bot", bot: "alpha", status: "prompting", needsYou: { cards: 1, questions: 0 } }));
    expect(bots(feed)[0]!.state).toBe("asking");
    host.put(view({ id: "s_a", kind: "bot", bot: "alpha", status: "idle" }));
    host.put(view({ id: "s_task", kind: "agent", bot: "alpha", status: "prompting", title: "Fix the build" }));
    host.record("s_task", { type: "driver", event: { type: "agent_tool_call", id: "t1", kind: "execute", title: SECRETS[1], rawInput: { command: SECRETS[1] } } });
    expect(bots(feed)[0]).toMatchObject({ state: "working", tool: "execute" });
    expect(code(feed)).toEqual([expect.objectContaining({ subject: { kind: "sessions", id: "s_task", bot: "alpha" }, state: "working", name: "Fix the build", tool: "execute" })]);
    const heard: string[] = [];
    feed.watch("sessions", { kind: "user" }, (v) => heard.push(v.state));
    host.put(view({ id: "s_task", kind: "agent", bot: "alpha", status: "failed", failure: "crashed", title: "Fix the build" }));
    // A session that failed is heard stuck, once, and leaves the feed.
    expect(heard).toEqual(["stuck"]);
    expect(code(feed)).toEqual([]);
  });

  test("a coding session whose turn failed stays open: the bot reads stuck while it is idle with the failure, working in its next turn, and idle once a turn ends well", () => {
    const { host, feed } = setup();
    host.put(view({ id: "s_a", kind: "bot", bot: "alpha", status: "idle" }));
    host.put(view({ id: "s_task", kind: "agent", bot: "alpha", status: "idle", failure: "crashed", title: "Fix the build" }));
    expect(bots(feed)[0]!.state).toBe("stuck");
    expect(code(feed)).toEqual([expect.objectContaining({ subject: expect.objectContaining({ id: "s_task" }), state: "stuck" })]);
    host.put(view({ id: "s_task", kind: "agent", bot: "alpha", status: "prompting", failure: "crashed", title: "Fix the build" }));
    expect(bots(feed)[0]!.state).not.toBe("stuck");
    host.put(view({ id: "s_task", kind: "agent", bot: "alpha", status: "idle", title: "Fix the build" }));
    expect(bots(feed)[0]!.state).not.toBe("stuck");
  });
});

describe("a code session's state in the feed", () => {
  test("its name is its title, exactly; it is done when it stops, and its pictures end with it", () => {
    const { host, feed, ended } = setup();
    host.put(view({ id: "s_code", kind: "coding", title: "Fix the build" }));
    expect(code(feed)).toEqual([expect.objectContaining({ subject: { kind: "sessions", id: "s_code" }, state: "idle", name: "Fix the build" })]);
    expect(bots(feed)).toEqual([]);
    const heard: string[] = [];
    feed.watch("sessions", { kind: "user" }, (v) => heard.push(v.state));
    host.put(view({ id: "s_code", kind: "coding", title: "Fix the build", status: "stopped" }));
    // It is heard once in its last state, then it leaves the feed (and nothing more is published for it).
    expect(heard).toEqual(["done"]);
    expect(code(feed)).toEqual([]);
    expect(ended).toEqual(["s_code"]);
    host.record("s_code", { type: "turn_ended" });
    host.put(view({ id: "s_code", kind: "coding", title: "Fix the build", status: "stopped", updatedAt: 9 }));
    expect(code(feed)).toEqual([]);
    expect(heard).toEqual(["done"]);
    expect(ended).toEqual(["s_code"]);
  });
});

describe("no text, argument or card text in the feed", () => {
  test("whatever the records carry, no view the feed holds contains it", () => {
    const { host, feed } = setup();
    host.put(view({ id: "s_a", kind: "bot", bot: "alpha", status: "prompting", title: undefined }));
    host.put(view({ id: "s_code", kind: "coding", status: "prompting", title: "Fix the build" }));
    for (const id of ["s_a", "s_code"]) {
      host.record(id, { type: "input", input: { from: "user", text: SECRETS[0] }, disposition: "turn" });
      host.record(id, { type: "turn_started", origin: "user" });
      host.record(id, { type: "driver", event: { type: "tool_call", callId: "c", name: SECRETS[1], argsJson: JSON.stringify({ k: SECRETS[3] }) } });
      host.record(id, { type: "driver", event: { type: "agent_tool_call", id: "d", kind: SECRETS[2], title: SECRETS[2], rawInput: { token: SECRETS[3] } } });
      host.record(id, { type: "driver", event: { type: "assistant_message", text: SECRETS[4] } });
      host.record(id, { type: "driver", event: { type: "approval_requested", summary: SECRETS[2] } });
    }
    host.put(view({ id: "s_code", kind: "coding", status: "prompting", title: "Fix the build", needsYou: { cards: 1, questions: 1 } }));
    const all = JSON.stringify([...bots(feed), ...code(feed)]);
    for (const s of SECRETS) expect(all).not.toContain(s);
    // A tool name that isn't a wire name is no tool at all.
    expect(all).not.toContain("tool\":\"rm");
  });
});
