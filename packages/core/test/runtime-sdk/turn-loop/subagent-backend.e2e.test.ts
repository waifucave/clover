// In-process subagents (lane A for lane K): an `AgentBackend` over the embedded runtime. A delegation answers a
// prompt in its root, asks the host's permission handler before it writes (allow once, reject once), reports its
// events, cancels, and stops.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentPermissionAsk, AgentStartSpec } from "../../../src/contracts/agent-backend";
import { inProcessAgentBackend } from "../../../src/runtime-sdk/turn-loop/subagent-backend";
import { describeWithEmbeddedRuntime } from "../../helpers/embedded-runtime";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); temps.push(d); return d; };

function spec(root: string, model: string): AgentStartSpec {
  return {
    sessionId: "s_agent", root, model,
    instructions: "Message your bot with SendMessage when you are done.",
    bridge: { name: "clover_bridge", command: "/bin/sh", args: ["-c", "exit 0"], env: {}, tools: [] },
    fence: { allowWrite: [root], denyWrite: [], denyRead: [], closedDoors: [], blockedAddresses: ["169.254.169.254"], network: "none" },
  };
}

describeWithEmbeddedRuntime("the in-process agent backend", (spawn) => {
  test("a prompt runs in the root; a write asks the host first; events and usage arrive", async () => {
    const home = temp("clover-a3-sub-home-");
    const root = temp("clover-a3-sub-root-");
    const backend = inProcessAgentBackend({ home, spawn, defaultModel: () => "winter-test/calls" });
    expect((await backend.detect()).installed).toBe(true);
    const session = await backend.start(spec(root, "winter-test/calls"));
    const asks: AgentPermissionAsk[] = [];
    session.onPermission(async (ask) => {
      asks.push(ask);
      return { outcome: "selected", optionId: ask.paths.some((p) => p.endsWith("no.txt")) ? "reject" : "allow" };
    });
    const events: AgentEvent[] = [];
    session.onEvent((e) => events.push(e));
    try {
      const yes = join(root, "yes.txt");
      const no = join(root, "no.txt");
      const end = await session.prompt({ text: [`CALL Write {"file_path":${JSON.stringify(yes)},"content":"ok"}`, `+CALL Write {"file_path":${JSON.stringify(no)},"content":"no"}`].join("\n") });
      expect(end.stopReason).toBe("end_turn");
      expect(readFileSync(yes, "utf8")).toBe("ok");
      expect(existsSync(no)).toBe(false);
      expect(asks.map((a) => a.options.map((o) => o.kind))).toEqual([["allow_once", "reject_once"], ["allow_once", "reject_once"]]);
      expect(events.some((e) => e.type === "tool_call")).toBe(true);
      expect(events.some((e) => e.type === "tool_call_update" && e.status === "completed")).toBe(true);
      expect(events.some((e) => e.type === "usage")).toBe(true);
      expect(session.state()).toBe("idle");
      expect(session.lastProgressAt()).toBeGreaterThan(0);
    } finally {
      await session.stop();
    }
    expect(session.state()).toBe("stopped");
  }, 60_000);

  test("review B2: the delegating bot's pause holds every tool call, read-only ones too, until the user resumes", async () => {
    const home = temp("clover-a3-sub-home-");
    const root = temp("clover-a3-sub-root-");
    let paused = true;
    const listeners = new Set<() => void>();
    const gate = { mayAct: () => !paused, watch: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); } };
    const session = await inProcessAgentBackend({ home, spawn, defaultModel: () => "winter-test/calls", pauseGateFor: () => gate }).start(spec(root, "winter-test/calls"));
    session.onPermission(async () => ({ outcome: "selected", optionId: "allow" }));
    const events: AgentEvent[] = [];
    session.onEvent((e) => events.push(e));
    try {
      const p = session.prompt({ text: `CALL Read {"file_path":${JSON.stringify(join(root, "nothing.txt"))}}` });
      await Bun.sleep(1_500);
      expect(events.some((e) => e.type === "tool_call_update")).toBe(false);
      paused = false;
      for (const fn of listeners) fn();
      const end = await p;
      expect(end.stopReason).toBe("end_turn");
      expect(events.some((e) => e.type === "tool_call_update")).toBe(true);
    } finally {
      await session.stop();
    }
  }, 60_000);

  test("a delegation can't reach the bot's memory (the owner's decision): Read and Write there are refused", async () => {
    const home = temp("clover-a3-sub-home-");
    const root = temp("clover-a3-sub-root-");
    const memory = temp("clover-a3-sub-mem-");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(memory, "MEMORY.md"), "- secret plans\n");
    const session = await inProcessAgentBackend({ home, spawn, defaultModel: () => "winter-test/calls", privateFoldersFor: () => [memory] }).start(spec(root, "winter-test/calls"));
    session.onPermission(async () => ({ outcome: "selected", optionId: "allow" }));
    try {
      const end = await session.prompt({ text: [`CALL Read {"file_path":${JSON.stringify(join(memory, "MEMORY.md"))}}`, `CALL Write {"file_path":${JSON.stringify(join(memory, "x.md"))},"content":"x"}`].join("\n") });
      const r = JSON.parse(end.text) as { content: string }[];
      expect(r[0]!.content).not.toContain("secret plans");
      expect(existsSync(join(memory, "x.md"))).toBe(false);
    } finally {
      await session.stop();
    }
  }, 60_000);

  test("lane K's in-process bridge replaces the stdio one; its tools reach the manager", async () => {
    const home = temp("clover-a3-sub-home-");
    const root = temp("clover-a3-sub-root-");
    const got: unknown[] = [];
    const inProcessBridge = {
      type: "sdk" as const, name: "clover_bridge",
      instance: {
        listTools: () => [{ name: "SendMessage", inputSchema: { type: "object" } }],
        callTool: async (_n: string, args: Record<string, unknown>) => { got.push(args); return { content: [{ type: "text", text: "sent" }] }; },
      },
    };
    const backend = inProcessAgentBackend({ home, spawn, defaultModel: () => "winter-test/calls" });
    expect(backend.inProcess).toBe(true);
    const session = await backend.start({ ...spec(root, "winter-test/calls"), inProcessBridge } as AgentStartSpec);
    session.onPermission(async () => ({ outcome: "selected", optionId: "allow" }));
    try {
      const end = await session.prompt({ text: 'CALL mcp__clover_bridge__SendMessage {"to":"luna","message":"done"}' });
      expect(JSON.parse(end.text)[0].content).toBe("sent");
      expect(got).toEqual([{ to: "luna", message: "done" }]);
    } finally {
      await session.stop();
    }
  }, 60_000);

  test("cancel ends a running turn cancelled", async () => {
    const home = temp("clover-a3-sub-home-");
    const root = temp("clover-a3-sub-root-");
    const session = await inProcessAgentBackend({ home, spawn, defaultModel: () => "winter-test/hang" }).start(spec(root, "winter-test/hang"));
    try {
      const p = session.prompt({ text: "wait" });
      await Bun.sleep(1_000);
      await session.cancel();
      expect((await p).stopReason).toBe("cancelled");
    } finally {
      await session.stop();
    }
  }, 60_000);
});
