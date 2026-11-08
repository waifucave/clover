// The app's methods with no handler before (K's audit): `session.answer` for a bot's `AskUserQuestion`, the archive of
// the previous app's sessions (`archive.list`, `archive.history`), and the user's apps' plan readings (`usage.plans`).
import { afterEach, describe, expect, test } from "bun:test";
import { SESSIONS_METHODS, USAGE_METHODS, type Caller } from "@waifucave/clover-protocol";
import { flush } from "../../contracts/fakes/clock";
import { SessionStore } from "../../sessions/store";
import { archiveMethods } from "../../sessions/archive-rpc";
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
    await b.shutdown();
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
    expect(all.sessions[1]).toMatchObject({ id: code, mode: "code", messages: 2, project: "/Users/me/garden", model: "openai/gpt-6.1-sol" });
    expect(all.more).toBe(false);
    expect((await list({ query: "BEANS" }, { caller: theUser } as never) as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual([code]);
    expect((await list({ query: "garden" }, { caller: theUser } as never) as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual([code]);
    const first = await list({ limit: 1 }, { caller: theUser } as never) as { sessions: { id: string; updatedAt: number }[]; more: boolean };
    expect(first).toMatchObject({ more: true });
    const next = await list({ limit: 1, before: first.sessions[0]!.updatedAt }, { caller: theUser } as never) as { sessions: { id: string }[] };
    expect(next.sessions.map((s) => s.id)).toEqual([code]);
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
});

describe("usage.plans", () => {
  test("each window of each app that answered, named for this computer; an app that isn't here or fails is left out", async () => {
    const reading = (over: Partial<PlanReading>): PlanReading => ({ provider: "codex", source: "codex-app-server", at: 1_000, windows: [], ...over });
    const readers: PlanReaders = {
      codexPlan: async () => reading({ planType: "pro", windows: [{ id: "a", kind: "five_hour", windowMinutes: 300, usedPercent: 42, resetsAt: 9_000, stale: false }, { id: "b", kind: "weekly", usedPercent: 7, stale: false }] }),
      claudeCodePlan: async () => reading({ provider: "claude-code", source: "not-installed" }),
      antigravityPlan: async () => { throw new Error("agy broke"); },
    };
    const readings = await planReadings({ readers, computer: () => "Studio" });
    expect(readings).toEqual([
      { source: "codex", computer: "Studio", plan: "pro", window: "five_hour", usedPercent: 42, resetsAt: 9_000, readAt: 1_000 },
      { source: "codex", computer: "Studio", plan: "pro", window: "weekly", usedPercent: 7, readAt: 1_000 },
    ]);
    const answer = await usagePlansMethods({ readers, computer: () => "Studio" })[USAGE_METHODS.usagePlans.name]!({}, { caller: theUser } as never);
    expect(USAGE_METHODS.usagePlans.result.parse(answer)).toEqual({ readings });
  });
});
