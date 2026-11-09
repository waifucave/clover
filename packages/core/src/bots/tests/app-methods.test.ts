// The app's methods with no handler before (K's audit): `session.answer` for a bot's `AskUserQuestion`, the archive of
// the previous app's sessions (`archive.list`, `archive.history`), and the user's apps' plan readings (`usage.plans`).
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLOVER_ERR, SESSIONS_METHODS, UNATTENDED_CARD_TIMEOUT_MS, USAGE_METHODS, type Caller, type TurnOrigin } from "@waifucave/clover-protocol";
import { flush } from "../../contracts/fakes/clock";
import { SessionStore, type SessionRow } from "../../sessions/store";
import { archiveMethods, HISTORY_EVENT_MAX_BYTES, HISTORY_PAGE_BYTES } from "../../sessions/archive-rpc";
import { readLogRange } from "../../sessions/log-range";
import { botQuestions, questionTimeoutMs } from "../questions";
import { MethodError } from "../rpc";
import { planReadings, usagePlansMethods, type PlanReaders } from "../../usage/rpc";
import type { PlanReading } from "../../usage/plan";
import { ALPHA_FOLDER, boot, pluginFromFolder, removeTemps, tempDir } from "./fixtures";

afterEach(() => removeTemps());

const theUser: Caller = { kind: "user", client: "app" };
const question = { questions: [{ question: "Which one?", header: "Pick", options: [{ label: "Tea" }, { label: "Coffee" }] }] };
const caught = (fn: () => unknown) => Promise.resolve().then(fn).catch((e: unknown) => e);

describe("session.answer: a bot's AskUserQuestion", () => {
  test("the question is the session's (in its log and its needs-you count), and the user's answer reaches the model", async () => {
    const b = await boot({ home: tempDir(), plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs });
    const others: string[] = [];
    const canUseTool = b.side.questions.canUseTool("b_alpha", async (tool) => (others.push(tool), { behavior: "allow", updatedInput: {} }));
    // Another tool goes on to the session's own check.
    await canUseTool("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "call_0" } as never);
    expect(others).toEqual(["Bash"]);
    const asked = canUseTool("AskUserQuestion", question, { signal: new AbortController().signal, toolUseID: "call_1" } as never);
    await flush();
    expect(b.host.history("b_alpha").some((r) => r.type === "driver" && r.event.type === "question_asked")).toBe(true);
    expect(b.host.get("b_alpha")?.needsYou?.questions).toBe(1);
    const methods = b.side.methods({ localDevice: "studio" });
    const answer = methods[SESSIONS_METHODS.sessionAnswer.name]!;
    // Not a session's to answer; not a question that isn't waiting.
    expect(await caught(() => answer({ id: "b_alpha", callId: "call_1", answers: { "Which one?": "Tea" } }, { caller: { kind: "session", sessionId: "b_alpha", sessionKind: "bot", bot: "alpha" } } as never))).toBeDefined();
    expect(String(await caught(() => answer({ id: "b_alpha", callId: "call_9", answers: {} }, { caller: theUser } as never)))).toContain("no question call_9 is waiting");
    expect(await answer({ id: "b_alpha", callId: "call_1", answers: { "Which one?": "Tea" } }, { caller: theUser } as never)).toEqual({ ok: true });
    const result = await asked as { behavior: string; updatedInput: { answers: Record<string, string> } };
    expect(result.behavior).toBe("allow");
    expect(result.updatedInput.answers).toEqual({ "Which one?": "Tea" });
    await flush();
    expect(b.host.history("b_alpha").some((r) => r.type === "driver" && r.event.type === "question_resolved")).toBe(true);
    expect(b.host.get("b_alpha")?.needsYou?.questions).toBe(0);
    // A plugin showing the question may answer one too.
    const again = canUseTool("AskUserQuestion", question, { signal: new AbortController().signal, toolUseID: "call_2" } as never);
    await flush();
    expect(await answer({ id: "b_alpha", callId: "call_2", answers: { "Which one?": "Coffee" } }, { caller: { kind: "plugin", pluginId: "clover/conversation" } } as never)).toEqual({ ok: true });
    expect(((await again) as unknown as { updatedInput: { answers: Record<string, string> } }).updatedInput.answers).toEqual({ "Which one?": "Coffee" });
    await flush();
    const resolved = b.host.history("b_alpha").flatMap((r) => (r.type === "driver" && r.event.type === "question_resolved" ? [r.event as unknown as { callId: string; by: string }] : []));
    expect(resolved.map((e) => [e.callId, e.by])).toEqual([["call_1", "user"], ["call_2", "plugin:clover/conversation"]]);
    await b.shutdown();
  });

  test("refused: a peer's answer, a plugin's for an uninstalled bot, keys the question doesn't ask, and the losing answer of a race", async () => {
    const b = await boot({ home: tempDir(), plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs });
    const canUseTool = b.side.questions.canUseTool("b_alpha", async () => ({ behavior: "allow", updatedInput: {} }));
    const answer = b.side.methods({ localDevice: "studio" })[SESSIONS_METHODS.sessionAnswer.name]!;
    const asked = canUseTool("AskUserQuestion", question, { signal: new AbortController().signal, toolUseID: "call_1" } as never);
    await flush();
    // Another computer is never the user.
    const peer = await caught(() => answer({ id: "b_alpha", callId: "call_1", answers: { "Which one?": "Tea" } }, { caller: { kind: "peer", device: "dev_other" } } as never));
    expect(peer instanceof MethodError && peer.code).toBe(CLOVER_ERR.NOT_THE_USER);
    // An answer, or a note, to a question the card didn't ask.
    expect(String(await caught(() => answer({ id: "b_alpha", callId: "call_1", answers: { "Which two?": "Tea" } }, { caller: theUser } as never)))).toContain("doesn't ask \"Which two?\"");
    expect(String(await caught(() => answer({ id: "b_alpha", callId: "call_1", answers: { "Which one?": "Tea" }, notes: { "Why?": "x" } }, { caller: theUser } as never)))).toContain("doesn't ask \"Why?\"");
    expect(b.side.questions.broker.isPending("b_alpha", "call_1")).toBe(true);
    // Two answers at once: the first wins, the other is told nothing is waiting.
    const raced = await Promise.all([
      answer({ id: "b_alpha", callId: "call_1", answers: { "Which one?": "Tea" } }, { caller: theUser } as never).catch((e: unknown) => e),
      answer({ id: "b_alpha", callId: "call_1", answers: { "Which one?": "Coffee" } }, { caller: { kind: "plugin", pluginId: "clover/conversation" } } as never).catch((e: unknown) => e),
    ]);
    expect(raced[0]).toEqual({ ok: true });
    expect(String(raced[1])).toContain("no question call_1 is waiting");
    expect(((await asked) as unknown as { updatedInput: { answers: Record<string, string> } }).updatedInput.answers).toEqual({ "Which one?": "Tea" });
    // A plugin answering for a bot that is no longer installed.
    const again = canUseTool("AskUserQuestion", question, { signal: new AbortController().signal, toolUseID: "call_2" } as never);
    await flush();
    b.registry.remove("alpha");
    await flush();
    expect(String(await caught(() => answer({ id: "b_alpha", callId: "call_2", answers: { "Which one?": "Tea" } }, { caller: { kind: "plugin", pluginId: "clover/conversation" } } as never)))).toContain("isn't installed");
    b.side.questions.broker.respond("b_alpha", "call_2", {}, "aborted");
    await again;
    await b.shutdown();
  });

  test("the 10-minute rule: a question from a turn the user didn't start is denied unanswered; one from the user's waits", async () => {
    expect(questionTimeoutMs("user")).toBeUndefined();
    for (const origin of ["bot", "routine", "plugin", "agent", "peer", "task-notification", undefined] as const) {
      expect(questionTimeoutMs(origin)).toBe(UNATTENDED_CARD_TIMEOUT_MS);
    }
    expect(UNATTENDED_CARD_TIMEOUT_MS).toBe(10 * 60 * 1000);
    let origin: TurnOrigin | undefined = "routine";
    const recorded: { type: string; by?: string }[] = [];
    const q = botQuestions({
      host: { get: () => ({}) as never, recordCore: (_id, event) => (recorded.push(event as never), undefined as never), turnOrigin: () => origin },
      unattendedMs: 30,
    });
    const canUseTool = q.canUseTool("b_alpha", async () => ({ behavior: "allow", updatedInput: {} }));
    const denied = await canUseTool("AskUserQuestion", question, { signal: new AbortController().signal, toolUseID: "call_r" } as never) as { behavior: string; message: string };
    expect(denied.behavior).toBe("deny");
    expect(denied.message).toContain("not answered");
    expect(recorded.map((e) => [e.type, e.by])).toEqual([["question_asked", undefined], ["question_resolved", "timeout"]]);
    expect(q.answer("b_alpha", "call_r", { "Which one?": "Tea" }, "user")).toMatchObject({ ok: false, code: "not_found" });
    // The user's own turn: still waiting long after the unattended wait would have ended.
    origin = "user";
    const waiting = canUseTool("AskUserQuestion", question, { signal: new AbortController().signal, toolUseID: "call_u" } as never);
    await Bun.sleep(90);
    expect(q.broker.isPending("b_alpha", "call_u")).toBe(true);
    expect(q.answer("b_alpha", "call_u", { "Which one?": "Tea" }, "user")).toEqual({ ok: true });
    expect(((await waiting) as { behavior: string }).behavior).toBe("allow");
  });
});

describe("the archive of the previous app's sessions", () => {
  test("archive.list: top-level code, chat and dispatch sessions, newest first, matched and paged; archive.history pages a log", async () => {
    const store = new SessionStore(tempDir());
    const code = store.createSession("global", { mode: "code", cwd: "/Users/me/garden", model: "openai/gpt-6.1-sol" });
    store.append(code, { type: "user_message", sessionId: code, threadId: "main", text: "plant the beans", clientName: "t" });
    store.append(code, { type: "assistant_message", sessionId: code, threadId: "main", text: "planted" } as never);
    await Bun.sleep(5);
    const chat = store.createSession("global", { mode: "chat" });
    store.append(chat, { type: "user_message", sessionId: chat, threadId: "main", text: "what's for dinner", clientName: "t" });
    store.createSession("global", { mode: "chat", parentSessionId: chat });
    const methods = archiveMethods({ store });
    const list = methods[SESSIONS_METHODS.archiveList.name]!;
    const all = await list({}, { caller: theUser } as never) as { sessions: { id: string; mode: string; messages: number; project?: string; model?: string; updatedAt: number }[]; more: boolean };
    expect(all.sessions.map((s) => s.id)).toEqual([chat, code]);
    // The index's counts: the log's length (session_created and the two messages).
    expect(all.sessions[1]).toMatchObject({ id: code, mode: "code", messages: 3, project: "/Users/me/garden", model: "openai/gpt-6.1-sol" });
    expect(all.more).toBe(false);
    expect((await list({ query: "BEANS" }, { caller: theUser } as never) as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual([code]);
    expect((await list({ query: "garden" }, { caller: theUser } as never) as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual([code]);
    const first = await list({ limit: 1 }, { caller: theUser } as never) as { sessions: { id: string; updatedAt: number }[]; more: boolean; cursor?: string };
    expect(first).toMatchObject({ more: true });
    const next = await list({ limit: 1, cursor: first.cursor }, { caller: theUser } as never) as { sessions: { id: string }[]; more: boolean; cursor?: string };
    expect(next.sessions.map((s) => s.id)).toEqual([code]);
    expect(next.more).toBe(false);
    expect(next.cursor).toBeUndefined();
    // Only the user reads it.
    expect(await caught(() => list({}, { caller: { kind: "plugin", pluginId: "x" } } as never))).toBeDefined();

    const history = methods[SESSIONS_METHODS.archiveHistory.name]!;
    const page1 = await history({ id: code, limit: 2 }, { caller: theUser } as never) as { events: { seq: number; type: string }[]; cursor?: string };
    expect(page1.events.map((e) => e.type)).toEqual(["session_created", "user_message"]);
    const page2 = await history({ id: code, limit: 2, cursor: page1.cursor }, { caller: theUser } as never) as { events: { type: string }[]; cursor?: string };
    expect(page2.events.map((e) => e.type)).toEqual(["assistant_message"]);
    expect(page2.cursor).toBeUndefined();
    expect(String(await caught(() => history({ id: "s_nothere" }, { caller: theUser } as never)))).toContain("no archived session s_nothere");
  });

  test("archive.list pages by (updatedAt, id): sessions that share a time are neither skipped nor shown twice", async () => {
    const rows = ["s_d", "s_b", "s_a", "s_c", "s_e"].map((id): SessionRow => ({ sessionId: id, scope: "global", createdAt: 1, lastSeq: 1, approvalPolicy: "ask", mode: "chat" }));
    // Three share their last write; the others are older and newer.
    const at: Record<string, number> = { s_a: 500, s_b: 500, s_c: 500, s_d: 900, s_e: 100 };
    const store = { list: () => rows, lastEventTs: (id: string) => at[id]!, firstMessage: () => undefined, readRange: () => ({ events: [], more: false }) };
    const list = archiveMethods({ store })[SESSIONS_METHODS.archiveList.name]!;
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 10; pages++) {
      const page = await list({ limit: 2, ...(cursor === undefined ? {} : { cursor }) }, { caller: theUser } as never) as { sessions: { id: string; messages: number }[]; more: boolean; cursor?: string };
      seen.push(...page.sessions.map((v) => v.id));
      for (const v of page.sessions) expect(v.messages).toBe(0);
      if (!page.more) break;
      cursor = page.cursor;
    }
    expect(seen).toEqual(["s_d", "s_a", "s_b", "s_c", "s_e"]);
    for (const bad of ["500", "x:s_a", ":s_a", "500:", "-1:s_a"]) {
      expect(String(await caught(() => list({ cursor: bad }, { caller: theUser } as never)))).toContain("a bad cursor");
    }
  });

  test("archive.history refuses another caller, a bad cursor, and a session outside the archive", async () => {
    const store = new SessionStore(tempDir());
    const chat = store.createSession("global", { mode: "chat" });
    const child = store.createSession("global", { mode: "chat", parentSessionId: chat });
    const history = archiveMethods({ store })[SESSIONS_METHODS.archiveHistory.name]!;
    for (const caller of [{ kind: "plugin", pluginId: "clover/archive" }, { kind: "session", sessionId: "b_alpha", sessionKind: "bot", bot: "alpha" }, { kind: "peer", device: "dev_other" }]) {
      expect(await caught(() => history({ id: chat }, { caller } as never))).toBeInstanceOf(Error);
    }
    for (const bad of ["-1", "1.5", "1e3", " 1", "0x10", "abc", "9".repeat(16)]) {
      expect(String(await caught(() => history({ id: chat, cursor: bad }, { caller: theUser } as never)))).toContain("a bad cursor");
    }
    expect(await history({ id: chat, cursor: "0" }, { caller: theUser } as never)).toMatchObject({ events: [{ type: "session_created" }] });
    // A dispatch session's child is its parent's; a mode the previous app didn't run isn't archived.
    expect(String(await caught(() => history({ id: child }, { caller: theUser } as never)))).toContain(`no archived session ${child}`);
    const other: SessionRow = { sessionId: "s_bot", scope: "global", createdAt: 1, lastSeq: 1, approvalPolicy: "ask", mode: "cowork" };
    const fake = { list: () => [other], lastEventTs: () => 1, firstMessage: () => undefined, readRange: () => ({ events: [], more: false }) };
    expect(String(await caught(() => archiveMethods({ store: fake })[SESSIONS_METHODS.archiveHistory.name]!({ id: "s_bot" }, { caller: theUser } as never)))).toContain("no archived session s_bot");
  });

  test("a history page is found by bisecting the log, skips lines that don't parse, and stops at its byte budget", async () => {
    const path = join(tempDir(), "log.jsonl");
    const line = (seq: number, text = `m${seq}`) => JSON.stringify({ type: "user_message", sessionId: "s_x", threadId: "main", text, clientName: "t", seq, ts: 1_000 + seq }) + "\n";
    writeFileSync(path, "");
    for (let seq = 1; seq <= 300; seq++) {
      appendFileSync(path, line(seq));
      if (seq === 150) appendFileSync(path, "{not json\n");
    }
    appendFileSync(path, '{"type":"user_mess'); // a crash's cut tail
    const big = { limit: 1000, maxBytes: 1 << 30, maxOne: 1 << 30 };
    expect(readLogRange(path, 0, big).events.map((e) => e.seq)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
    for (const after of [0, 1, 149, 150, 151, 299]) {
      const page = readLogRange(path, after, { ...big, limit: 3 });
      expect(page.events.map((e) => e.seq)).toEqual([after + 1, after + 2, after + 3].filter((s) => s <= 300));
      expect(page.more).toBe(after + 3 < 300);
    }
    expect(readLogRange(path, 300, big)).toEqual({ events: [], more: false });
    expect(readLogRange(path, 10_000, big)).toEqual({ events: [], more: false });
    // The byte budget: as many whole lines as fit, never none.
    const one = Buffer.byteLength(line(10));
    expect(readLogRange(path, 9, { ...big, maxBytes: one * 2 + 1 }).events.map((e) => e.seq)).toEqual([10, 11]);
    expect(readLogRange(path, 9, { ...big, maxBytes: 1 }).events.map((e) => e.seq)).toEqual([10]);
    // A line too long to send is named, alone, and paged past.
    const huge = join(tempDir(), "huge.jsonl");
    writeFileSync(huge, line(1) + line(2, "x".repeat(5_000)) + line(3));
    expect(readLogRange(huge, 0, { limit: 10, maxBytes: 1 << 20, maxOne: 1_000 })).toMatchObject({ events: [{ seq: 1 }], more: true });
    expect(readLogRange(huge, 1, { limit: 10, maxBytes: 1 << 20, maxOne: 1_000 })).toMatchObject({ events: [], oversized: { seq: 2 }, more: true });
    expect(readLogRange(huge, 2, { limit: 10, maxBytes: 1 << 20, maxOne: 1_000 })).toMatchObject({ events: [{ seq: 3 }], more: false });
    // The page sizes archive.history uses fit one request line.
    expect(HISTORY_PAGE_BYTES + HISTORY_EVENT_MAX_BYTES).toBeLessThan(8 * 1024 * 1024);
  });

  test("archive.history names an event too long to send and pages past it", async () => {
    const store = new SessionStore(tempDir());
    const id = store.createSession("global", { mode: "chat" });
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "y".repeat(HISTORY_EVENT_MAX_BYTES + 10), clientName: "t" });
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "after", clientName: "t" });
    const history = archiveMethods({ store })[SESSIONS_METHODS.archiveHistory.name]!;
    const p1 = await history({ id }, { caller: theUser } as never) as { events: { seq: number; type: string }[]; cursor?: string };
    expect(p1.events.map((e) => [e.seq, e.type])).toEqual([[1, "session_created"]]);
    const p2 = await history({ id, cursor: p1.cursor }, { caller: theUser } as never) as { events: { seq: number; type: string; reason?: string }[]; cursor?: string };
    expect(p2.events).toEqual([expect.objectContaining({ seq: 2, type: "archive_omitted", reason: "too_large" })]);
    const p3 = await history({ id, cursor: p2.cursor }, { caller: theUser } as never) as { events: { seq: number; text?: string }[]; cursor?: string };
    expect(p3.events).toEqual([expect.objectContaining({ seq: 3, text: "after" })]);
    expect(p3.cursor).toBeUndefined();
  });
});

describe("usage.plans", () => {
  test("each window of each app that answered, named for this computer; an app that isn't here or fails is left out", async () => {
    const reading = (over: Partial<PlanReading>): PlanReading => ({ provider: "codex", source: "codex-app-server", at: 1_000, windows: [], ...over });
    const readers: PlanReaders = {
      codexPlan: async () => reading({ planType: "pro", windows: [{ id: "a", kind: "five_hour", windowMinutes: 300, usedPercent: 42, resetsAt: 9_000, stale: false }, { id: "b", kind: "weekly", usedPercent: 7, stale: false }] }),
      claudeCodePlan: async () => reading({ provider: "claude-code", source: "not-installed" }),
      antigravityPlan: async () => { throw new Error("agy broke"); },
    };
    const readings = await planReadings({ readers, computer: () => "Studio", now: () => 2_000 });
    expect(readings).toEqual([
      { source: "codex", computer: "Studio", plan: "pro", window: "five_hour", usedPercent: 42, resetsAt: 9_000, readAt: 1_000 },
      { source: "codex", computer: "Studio", plan: "pro", window: "weekly", usedPercent: 7, readAt: 1_000 },
    ]);
    const answer = await usagePlansMethods({ readers, computer: () => "Studio", now: () => 2_000 })[USAGE_METHODS.usagePlans.name]!({}, { caller: theUser } as never);
    expect(USAGE_METHODS.usagePlans.result.parse(answer)).toEqual({ readings });
  });

  test("claude-code and antigravity: not installed, turned off or failing are left out; so is a window that is over", async () => {
    const reading = (over: Partial<PlanReading>): PlanReading => ({ provider: "claude-code", source: "claude-cli", at: 1_000, windows: [], ...over });
    const now = 10_000;
    for (const source of ["not-installed", "disabled", "none"] as const) {
      const readers: PlanReaders = {
        codexPlan: async () => reading({ provider: "codex", source: "not-installed" }),
        claudeCodePlan: async () => reading({ source, windows: [{ id: "a", kind: "five_hour", usedPercent: 1, stale: false }] }),
        antigravityPlan: async () => reading({ provider: "antigravity", source, windows: [{ id: "a", kind: "weekly", usedPercent: 1, stale: false }] }),
      };
      expect(await planReadings({ readers, computer: () => "Studio", now: () => now })).toEqual([]);
    }
    const failing: PlanReaders = {
      codexPlan: async () => { throw new Error("codex broke"); },
      claudeCodePlan: async () => { throw new Error("claude broke"); },
      antigravityPlan: () => Promise.reject(new Error("agy broke")),
    };
    expect(await planReadings({ readers: failing, computer: () => "Studio", now: () => now })).toEqual([]);
    const ageing: PlanReaders = {
      codexPlan: async () => reading({ provider: "codex", source: "not-installed" }),
      claudeCodePlan: async () => reading({
        planType: "max",
        windows: [
          { id: "now", kind: "five_hour", windowMinutes: 300, usedPercent: 30, resetsAt: now + 60_000, stale: false },
          { id: "reset", kind: "weekly", usedPercent: 90, resetsAt: now - 1, stale: false },
          { id: "flagged", kind: "weekly_scoped", usedPercent: 50, stale: true, staleReason: "older_than_window" },
        ],
      }),
      // Read long ago against a one-minute window: over by now, though its reader didn't say so then.
      antigravityPlan: async () => reading({ provider: "antigravity", source: "agy-cli", at: 1, windows: [{ id: "old", kind: "other", windowMinutes: 0.1, usedPercent: 5, stale: false }] }),
    };
    expect(await planReadings({ readers: ageing, computer: () => "Studio", now: () => now })).toEqual([
      { source: "claude-code", computer: "Studio", plan: "max", window: "five_hour", usedPercent: 30, resetsAt: now + 60_000, readAt: 1_000 },
    ]);
  });
});
