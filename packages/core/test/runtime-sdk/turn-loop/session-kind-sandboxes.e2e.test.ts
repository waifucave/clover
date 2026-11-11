// The sandbox every bot-side session kind hands the runtime, measured from what it really passes (`Options.sandbox`
// at the runtime's `query`), not read from the code: a bot's conversation, a side thread, a routine's run (a side
// thread with its routine's level), and an in-process agent. (Clover's coding agent as a bot's Agent child: its own
// test, `src/agents/tests/clover-code.test.ts`, holds the same three fields.) Each prints its row of the table.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query as sdkQuery, type SandboxSettingsConfig } from "@waifucave/clover-agent-sdk";
import type { TurnControl, TurnInput } from "../../../src/contracts/session-host";
import type { BotSessionContext, EffectiveBot } from "../../../src/bots/service";
import { botPaths } from "../../../src/bots/paths";
import { BotSessionDriver, type BotDriverDeps } from "../../../src/runtime-sdk/turn-loop/driver";
import { inProcessAgentBackend } from "../../../src/runtime-sdk/turn-loop/subagent-backend";
import type { AgentStartSpec } from "../../../src/contracts/agent-backend";
import { botChildFor } from "../../../src/agents/bot-child";
import { rootCovered } from "../../../src/fence/sandbox-settings";
import { describeWithEmbeddedRuntime } from "../../helpers/embedded-runtime";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };

/** A row of the table: the three fields this bump is about. */
function row(kind: string, s: SandboxSettingsConfig | undefined): { enforce: unknown; hardLinks: unknown; unsandboxed: unknown } {
  const r = { enforce: s?.filesystem?.enforceWriteRootsInFileTools, hardLinks: s?.filesystem?.allowHardLinkWrites, unsandboxed: s?.allowUnsandboxedCommands };
  console.log(`| ${kind} | enforceWriteRootsInFileTools=${String(r.enforce)} | allowHardLinkWrites=${String(r.hardLinks)} | allowUnsandboxedCommands=${String(r.unsandboxed)} |`);
  return r;
}
const EXPECTED = { enforce: true, hardLinks: undefined, unsandboxed: false };

function control(): TurnControl {
  return { origin: "user", signal: new AbortController().signal, onFold: () => () => {}, record: () => {} } as unknown as TurnControl;
}
const user = (text: string): TurnInput => ({ from: "user", text, device: "d_1", sentAt: Date.now(), clientMessageId: crypto.randomUUID() });

function context(home: string, over: Partial<BotSessionContext> = {}): BotSessionContext & { bot: EffectiveBot } {
  const bot: EffectiveBot = { id: "luna", name: "Luna", instructions: "You are Luna.", model: "winter-test/echo", modelFrom: "user", userLayer: [] };
  return {
    bot, botId: "luna", sessionId: "b_luna", kind: "bot", computer: "Studio", paths: botPaths(home, "luna"),
    caller: { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" },
    current: () => bot, memoryBlock: () => "<memory>\nnothing yet\n</memory>",
    mayAct: () => true, whenMayAct: async () => {}, cacheCold: () => false,
    ...over,
  } as BotSessionContext & { bot: EffectiveBot };
}

describeWithEmbeddedRuntime("each bot-side session kind's sandbox, as the runtime receives it", (spawn) => {
  // The host's sandbox asks for hard links and for unsandboxed commands: neither survives.
  const hostSandbox = () => ({ allowUnsandboxedCommands: true, filesystem: { allowWrite: ["/nowhere"], allowHardLinkWrites: true } } as SandboxSettingsConfig);

  const driverCases: [string, Partial<BotSessionContext>][] = [
    ["bot conversation", {}],
    ["side thread", { kind: "side-thread", sessionId: "s_side" }],
    ["routine run (a side thread at its routine's level)", { kind: "side-thread", sessionId: "s_routine", level: "ask-risky" }],
  ];
  for (const [kind, over] of driverCases) {
    test(kind, async () => {
      const home = temp("clover-kinds-");
      const seen: (SandboxSettingsConfig | undefined)[] = [];
      const deps: BotDriverDeps = {
        home, spawn, stopGraceMs: 5_000, log: () => {}, sandbox: hostSandbox,
        canUseTool: () => async (_n, input) => ({ behavior: "allow", updatedInput: input as Record<string, unknown> }),
        query: (args) => { seen.push(args.options?.sandbox); return sdkQuery(args); },
      };
      const driver = new BotSessionDriver(context(home, over), deps);
      try {
        const end = await driver.turn(user("hello"), control());
        expect(end.reason).toBe("end_turn");
      } finally {
        await driver.stop();
      }
      expect(seen.length).toBeGreaterThan(0);
      expect(row(kind, seen[0])).toEqual(EXPECTED);
    }, 60_000);
  }

  test("in-process agent (a bot's Agent child on Clover's sandboxed backend)", async () => {
    const home = temp("clover-kinds-home-");
    const root = temp("clover-kinds-root-");
    const seen: (SandboxSettingsConfig | undefined)[] = [];
    const backend = inProcessAgentBackend({
      home, spawn, defaultModel: () => "winter-test/echo", pauseGateFor: () => ({ mayAct: () => true, watch: () => () => {} }), sandboxReady: () => true,
      query: (args) => { seen.push(args.options?.sandbox); return sdkQuery(args); },
      // As `createAgents` hands it: a bot's child is drawn by its bot's builder.
      botChild: botChildFor({ cloverHome: home, userHome: temp("clover-kinds-user-") }),
    });
    const spec: AgentStartSpec = {
      sessionId: "s_agent", bot: "alpha", root, model: "winter-test/echo", instructions: "Say hello.",
      bridge: { name: "clover_bridge", command: "/bin/sh", args: ["-c", "exit 0"], env: {}, tools: [] },
      fence: { allowWrite: [root], denyWrite: [], denyRead: [], closedDoors: [], blockedAddresses: ["169.254.169.254"], network: "none" },
    } as AgentStartSpec;
    const session = await backend.start(spec);
    try {
      await session.prompt({ text: "hello" });
    } finally {
      await session.stop();
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(row("in-process agent", seen[0])).toEqual(EXPECTED);
    // Drawn by the bot's builder: the run-later denies hold under its root.
    const deny = seen[0]?.filesystem?.denyWrite ?? [];
    expect(rootCovered(join(root, ".husky", "pre-commit"), deny, process.platform === "darwin" ? "macos" : "linux")).toBe(true);
  }, 60_000);
});
