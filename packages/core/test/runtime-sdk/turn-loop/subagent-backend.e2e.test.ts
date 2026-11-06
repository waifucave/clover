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
