// The AgentBackend conformance suite (review S15). `runAgentBackendConformance(make)` registers every case against the
// implementation `make` builds; `tests/agent-backend.test.ts` runs it against FakeAgentBackend, and the lane that writes the real
// one runs it there through a harness with the same drivers. What it pins:
// the S5 rows its quirks play (refusals, replays, open tool
// calls on cancel, usage, persisting choices), sign-in, and permission answers through the ApprovalBroker.
import { describe, expect, test } from "bun:test";
import { acpOutcomeFor } from "../approval-broker";
import type { AgentEvent, AgentStartSpec } from "../agent-backend";
import { isContractError } from "../common";
import { type FakeAgentBackend, S5_ANTIGRAVITY_QUIRKS, S5_CURSOR_QUIRKS, WELL_BEHAVED_QUIRKS, type AgentStep } from "../fakes/agent-backend";
import { FakeApprovalBroker } from "../fakes/approval-broker";
import { FakeClock, flush } from "../fakes/clock";
import { FakeFence } from "../fakes/fence";

/** What the suite drives: the contract and the fake's own drivers (what a test does to the world around it),
 *  as public members, so a real implementation's harness can provide them. */
export type AgentBackendHarness = Pick<FakeAgentBackend, keyof FakeAgentBackend>;
/** Builds the implementation under test from the options the fake takes. */
export type AgentBackendFactory = (...args: ConstructorParameters<typeof FakeAgentBackend>) => AgentBackendHarness;

export function runAgentBackendConformance(make: AgentBackendFactory): void {
  const fence = new FakeFence({ home: "/Users/me", cloverHome: "/Users/me/.clover" }).policy();
  const spec = (over: Partial<AgentStartSpec> = {}): AgentStartSpec => ({
    sessionId: "s_agent", root: "/Users/me/project1", fence,
    bridge: { name: "clover-bridge", command: "/opt/clover/clover-core", args: ["bridge"], env: { CLOVER_BRIDGE_TOKEN: "placeholder" }, tools: ["SendMessage", "Glossary"] },
    ...over,
  });
  const runCmd: AgentStep = { tool: { kind: "execute", title: "npm test", rawInput: { command: "npm test" } } };

  function backend(quirks = WELL_BEHAVED_QUIRKS, script: AgentStep[][] = [], extra: Partial<ConstructorParameters<typeof FakeAgentBackend>[0]> = {}) {
    const clock = new FakeClock();
    return { clock, backend: make({ id: "fake", clock, quirks, script, ...extra }) };
  }

  describe("AgentBackend", () => {
    test("detect checks the binary is the vendor's; start refuses one that isn't, or an agent signed out", async () => {
      expect((await backend().backend.detect()).identityOk).toBe(true);
      const impostor = backend(WELL_BEHAVED_QUIRKS, [], { detection: { identityOk: false, path: "/usr/local/bin/agent" } }).backend;
      expect(isContractError(await impostor.start(spec()).catch((e: unknown) => e), "refused")).toBe(true);
      const signedOut = backend(WELL_BEHAVED_QUIRKS, [], { signedIn: false }).backend;
      expect(isContractError(await signedOut.start(spec()).catch((e: unknown) => e), "sign_in")).toBe(true);
    });

    test("a turn plays its steps, and usage shows only where the backend reports it", async () => {
      for (const [quirks, usage] of [[S5_ANTIGRAVITY_QUIRKS, true], [S5_CURSOR_QUIRKS, false]] as const) {
        const { backend: b } = backend(quirks, [[{ say: "Tests " }, { usage: { inputTokens: 43_467, outputTokens: 318 } }, { say: "pass." }]]);
        const s = await b.start(spec());
        const events: AgentEvent[] = [];
        s.onEvent((e) => events.push(e));
        const end = await s.prompt({ text: "run the tests" });
        expect(end.text).toBe("Tests pass.");
        expect(end.usage !== undefined).toBe(usage);
        expect(events.some((e) => e.type === "usage")).toBe(usage);
        expect(s.state()).toBe("idle");
      }
    });

    test("permission requests go to the host's handler, which answers through the broker with allow_once, never always", async () => {
      const clock = new FakeClock();
      const broker = new FakeApprovalBroker({ clock, levels: () => "automatic" });
      const b = make({ id: "cursor", clock, quirks: S5_CURSOR_QUIRKS, script: [[runCmd, { say: "done" }]] });
      const s = await b.start(spec());
      s.onPermission(async (ask) => acpOutcomeFor(await broker.request({ kind: "agent-permission", session: "s_agent", origin: "agent", computers: ["Studio"], effect: "execute", paths: ask.paths, fields: {} }), ask.options));
      expect((await s.prompt({ text: "go" })).stopReason).toBe("end_turn");
      const fs = b.sessions[0]!;
      expect(fs.answers).toEqual([{ toolCallId: "call-1", answer: { outcome: "selected", optionId: "allow_once" }, kind: "allow_once" }]);
    });

    test("with no handler set, a request is answered cancelled", async () => {
      const { backend: b } = backend(WELL_BEHAVED_QUIRKS, [[runCmd]]);
      const s = await b.start(spec());
      await s.prompt({ text: "go" });
      expect(b.sessions[0]!.answers[0]!.answer).toEqual({ outcome: "cancelled" });
    });

    test("a refusal ends the turn on Antigravity; Cursor reports the call completed and goes on, and Clover's record says refused", async () => {
      const reject = async () => ({ outcome: "selected" as const, optionId: "reject_once" });
      const agy = await backend(S5_ANTIGRAVITY_QUIRKS, [[runCmd, { say: "after" }]]).backend.start(spec());
      agy.onPermission(reject);
      const agyEvents: AgentEvent[] = [];
      agy.onEvent((e) => agyEvents.push(e));
      expect(await agy.prompt({ text: "go" })).toEqual({ stopReason: "refusal", text: "" });
      expect(agyEvents.at(-1)).toEqual({ type: "tool_call_update", id: "call-1", status: "failed", refused: true });

      const cursor = await backend(S5_CURSOR_QUIRKS, [[runCmd, { say: "after" }]]).backend.start(spec());
      cursor.onPermission(reject);
      const cursorEvents: AgentEvent[] = [];
      cursor.onEvent((e) => cursorEvents.push(e));
      expect(await cursor.prompt({ text: "go" })).toEqual({ stopReason: "end_turn", text: "after" });
      expect(cursorEvents).toContainEqual({ type: "tool_call_update", id: "call-1", status: "completed", refused: true });
    });

    test("a cancel answers the pending request cancelled, and Clover closes the tool calls the agent leaves open", async () => {
      const { backend: b } = backend(S5_CURSOR_QUIRKS, [[{ say: "working" }, { tool: { id: "t2", kind: "execute", title: "deploy" } }]]);
      const s = await b.start(spec());
      s.onPermission(() => new Promise(() => {}));
      const events: AgentEvent[] = [];
      s.onEvent((e) => events.push(e));
      const turn = s.prompt({ text: "deploy" });
      await flush();
      expect(s.state()).toBe("prompting");
      await s.cancel();
      expect((await turn).stopReason).toBe("cancelled");
      expect(b.sessions[0]!.answers).toEqual([{ toolCallId: "t2", answer: { outcome: "cancelled" } }]);
      expect(events.at(-1)).toEqual({ type: "tool_call_update", id: "t2", status: "failed", closedByClover: true });
      expect(s.state()).toBe("idle");
    });

    test("a cancel during a long step ends the turn cancelled", async () => {
      const { backend: b } = backend(WELL_BEHAVED_QUIRKS, [[{ tool: { id: "t1", kind: "execute", title: "long build", ask: false } }, { wait: true }, { say: "never" }]]);
      const s = await b.start(spec());
      const turn = s.prompt({ text: "build" });
      await flush();
      await s.cancel();
      expect(await turn).toEqual({ stopReason: "cancelled", text: "" });
      await s.stop();
      expect(s.state()).toBe("stopped");
      expect(isContractError(await s.prompt({ text: "again" }).catch((e: unknown) => e), "closed")).toBe(true);
    });

    test("reattaching: an honest resume replays nothing; a load, or Antigravity's replaying resume, has its replay dropped", async () => {
      const history: AgentEvent[] = [{ type: "text", text: "old" }, { type: "tool_call", id: "x", kind: "read", title: "read", status: "completed" }];
      const honest = backend(WELL_BEHAVED_QUIRKS, [], { history }).backend;
      await honest.start(spec({ reattach: { agentSessionId: "fake-session-9" } }));
      expect(honest.sessions[0]).toMatchObject({ agentSessionId: "fake-session-9", reattachedWith: "resume", droppedReplay: 0 });
      for (const q of [S5_ANTIGRAVITY_QUIRKS, S5_CURSOR_QUIRKS]) {
        const b = backend(q, [], { history }).backend;
        await b.start(spec({ reattach: { agentSessionId: "s-1" } }));
        expect(b.sessions[0]).toMatchObject({ reattachedWith: "load", droppedReplay: 2 });
      }
    });

    test("model and effort: Cursor folds effort into its model and keeps a delegation's model as the user's own", async () => {
      const cursor = backend(S5_CURSOR_QUIRKS).backend;
      const s = await cursor.start(spec());
      expect(isContractError(await s.setConfig("effort", "high").catch((e: unknown) => e), "refused")).toBe(true);
      await s.setConfig("model", "gpt-5.5-high");
      expect(cursor.userSelection).toEqual({ model: "gpt-5.5-high" });
      const agy = backend(S5_ANTIGRAVITY_QUIRKS).backend;
      const a = await agy.start(spec());
      await a.setConfig("model", "gemini-3-pro");
      await a.setConfig("effort", "high");
      expect(agy.userSelection).toEqual({});
      expect(agy.sessions[0]!.config).toEqual({ model: "gemini-3-pro", effort: "high" });
    });

    test("progress moves with every event, for the stall watchdog", async () => {
      const { clock, backend: b } = backend(WELL_BEHAVED_QUIRKS, [[{ say: "a" }, { wait: true }, { say: "b" }]]);
      const s = await b.start(spec());
      const turn = s.prompt({ text: "go" });
      await flush();
      const first = s.lastProgressAt();
      clock.advance(60_000);
      b.sessions[0]!.proceed();
      await turn;
      expect(s.lastProgressAt()).toBe(first + 60_000);
    });

    test("Settings' marks come with the backend", () => {
      expect(S5_CURSOR_QUIRKS.marks).toEqual(["unasked-actions", "persists-model-choice"]);
      expect(S5_ANTIGRAVITY_QUIRKS.marks).toEqual(["stores-plain-text", "passes-environment"]);
      expect(S5_ANTIGRAVITY_QUIRKS.permissions.optionKinds).not.toContain("allow_always");
    });
  });
}
