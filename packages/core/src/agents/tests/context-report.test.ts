// The context an ACP agent reports (`usage_update`'s `used`) reaches the turn's end, where the session's context reads it
// (`turn_completed.contextTokens`, sessions/panel-reads.ts): its last in the turn; an agent that reports none gives none.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakeFence } from "../../contracts/fakes/fence";
import { WELL_BEHAVED_QUIRKS } from "../../contracts/fakes/agent-backend";
import type { AgentStartSpec } from "../../contracts/agent-backend";
import { usageOf } from "../driver";
import { acpHarness } from "../testing/harness";
import type { FakeAcpStep } from "../testing/fake-acp-agent";

const root = realpathSync(mkdtempSync(join(tmpdir(), "moss-context-report-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const spec = (): AgentStartSpec => ({
  sessionId: "s_agent", root: "/Users/me/project1", fence: new FakeFence({ home: "/Users/me", mossHome: "/Users/me/.moss" }).policy(),
  bridge: { name: "moss-bridge", command: "/opt/moss/moss-core", args: ["bridge"], env: { MOSS_BRIDGE_TOKEN: "placeholder" }, tools: ["SendMessage", "Glossary"] },
});

async function turnEnd(script: FakeAcpStep[]) {
  const h = acpHarness(join(root, `agent-${++n}`), { id: "fake", clock: new FakeClock(), quirks: WELL_BEHAVED_QUIRKS, script: [script] as never });
  const s = await h.start(spec());
  try {
    return await s.prompt({ text: "go" });
  } finally {
    await s.stop();
  }
}

describe("an agent's reported context", () => {
  test("its last usage_update in the turn is the turn's contextTokens", async () => {
    const end = await turnEnd([{ context: { used: 12_000, size: 200_000 } }, { say: "done" }, { context: { used: 18_500, size: 200_000 } }]);
    expect(end.text).toBe("done");
    expect(end.contextTokens).toBe(18_500);
  }, 30_000);

  test("an agent that reports none gives none", async () => {
    const end = await turnEnd([{ say: "done" }]);
    expect(end.contextTokens).toBeUndefined();
  }, 30_000);

  test("the driver records it in the turn's usage, alone or beside the counts", () => {
    expect(usageOf({ stopReason: "end_turn", text: "", usage: { inputTokens: 900, outputTokens: 12 }, contextTokens: 18_500 })).toEqual({ usage: { inputTokens: 900, outputTokens: 12, contextTokens: 18_500 } });
    expect(usageOf({ stopReason: "end_turn", text: "", contextTokens: 18_500 })).toEqual({ usage: { inputTokens: 0, outputTokens: 0, contextTokens: 18_500 } });
    expect(usageOf({ stopReason: "end_turn", text: "", usage: { inputTokens: 900, outputTokens: 12 } })).toEqual({ usage: { inputTokens: 900, outputTokens: 12 } });
    expect(usageOf({ stopReason: "end_turn", text: "" })).toEqual({});
  });
});
