// MOSS's own coding agent reports its context as a bot's turn does: the runtime's `context_tokens` at each turn's end
// (the last request's whole prompt) reaches MOSS's ACP client as ACP's `usage_update`, so the session's context reads it
// (`AgentTurnEnd.contextTokens`); a turn whose runtime says none reports none ("Not reported" is for an agent that says nothing).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@waifucave/clover-agent-sdk";
import { FakeFence } from "../../contracts/fakes/fence";
import { contextUpdates, MossCodeBackend, reportingContext, type MossCodeDeps } from "../moss-code/backend";

const root = realpathSync(mkdtempSync(join(tmpdir(), "moss-code-context-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const MODEL = "winter-test/calls";

/** A runtime whose turns end with these results, one per prompt. */
function fakeQuery(results: Record<string, unknown>[]): MossCodeDeps["query"] {
  return ((args: { prompt: AsyncIterable<string>; options: Options }) => {
    async function* run() {
      yield { type: "system", subtype: "init", model: MODEL, permissionMode: "default" };
      let i = 0;
      for await (const _ of args.prompt) {
        yield { type: "assistant", message: { content: [{ type: "text", text: `reply ${i + 1}` }] } };
        yield { type: "result", subtype: "success", is_error: false, result: `reply ${i + 1}`, usage: { input_tokens: 1, output_tokens: 1 }, ...results[i++] };
      }
    }
    return Object.assign(run(), { interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, setEffort: async () => {}, supportedModels: async () => [] });
  }) as unknown as MossCodeDeps["query"];
}

describe("MOSS's own agent's context", () => {
  test("each turn's end carries the runtime's context_tokens; a turn whose runtime counts none carries none", async () => {
    const fence = new FakeFence({ home: root, mossHome: join(root, ".moss") });
    const backend = new MossCodeBackend({
      clock: { now: () => Date.now() } as never, defaultModel: () => MODEL, sandboxReady: () => true, pause: { mayAct: () => true },
      baseOptions: (o) => ({ model: o.model, cwd: o.cwd, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, settingSources: [] }) as Options,
      query: fakeQuery([{ context_tokens: 41_250 }, {}, { context_tokens: 52_000 }]),
    });
    const s = await backend.start({ sessionId: "s_code", root, bridge: { name: "moss_testbridge", command: "x", args: [], env: {}, tools: [] }, fence: fence.policy(), inProcessBridge: { type: "sdk", name: "moss_testbridge", instance: {} } as never });
    try {
      const first = await s.prompt({ text: "one" });
      expect(first.contextTokens).toBe(41_250);
      const second = await s.prompt({ text: "two" });
      expect(second.contextTokens).toBeUndefined();
      const third = await s.prompt({ text: "three" });
      expect(third.contextTokens).toBe(52_000);
    } finally {
      await s.stop();
    }
  }, 30_000);

  test("the update names the ACP session it learned, and says nothing before it knows one or for a count that isn't one", async () => {
    const lines: string[] = [];
    const u = contextUpdates();
    const write = u.writer((l) => lines.push(l));
    u.report(10);
    expect(lines).toEqual([]);
    u.heard(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "acp-1", prompt: [] } }));
    for (const bad of [0, -5, 1.5, Number.NaN]) u.report(bad);
    expect(lines).toEqual([]);
    u.report(900);
    write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } })}\n`);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp-1", update: { sessionUpdate: "usage_update", used: 900 } } },
      { jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } },
    ]);
  });

  test("the query's messages pass through unchanged, a report that throws among them", async () => {
    async function* gen() {
      yield { type: "result", context_tokens: 7 };
      yield { type: "assistant" };
    }
    const seen: number[] = [];
    const q = reportingContext(gen() as never, (n) => {
      seen.push(n);
      throw new Error("no");
    });
    const out: unknown[] = [];
    for await (const m of q as AsyncIterable<unknown>) out.push(m);
    expect(out).toEqual([{ type: "result", context_tokens: 7 }, { type: "assistant" }]);
    expect(seen).toEqual([7]);
  });
});
