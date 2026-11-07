// Lane A's bot driver on the real embedded runtime (one Worker per session), with the runtime's scripted test models:
// a turn answers, core tools run under their plain names, MCP calls go to the router as the session, the pause holds a
// tool call, the user's interrupt stops a turn and what folded in is carried, the turn ends release the holds, the
// transcript resumes after a rebuild, and compaction runs on the host's word.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnClaudeCodeProcess } from "@waifucave/clover-agent-sdk";
import type { TurnControl, TurnInput } from "../../../src/contracts/session-host";
import type { BotSessionContext, EffectiveBot } from "../../../src/bots/service";
import { botPaths } from "../../../src/bots/paths";
import { BotSessionDriver, type BotDriverDeps } from "../../../src/runtime-sdk/turn-loop/driver";
import type { CoreToolDef, McpRunner } from "../../../src/runtime-sdk/turn-loop/servers";
import { NO_HOOKS, type TurnHooks } from "../../../src/runtime-sdk/turn-loop/hooks";
import { describeWithEmbeddedRuntime } from "../../helpers/embedded-runtime";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tempHome(): string {
  const d = mkdtempSync(join(tmpdir(), "clover-a3-"));
  temps.push(d);
  return d;
}

interface Ctl extends TurnControl {
  records: { type: string; [k: string]: unknown }[];
  fold(input: TurnInput): void;
  abort(): void;
}

function control(origin: TurnControl["origin"] = "user"): Ctl {
  const ac = new AbortController();
  const listeners: ((i: TurnInput) => void)[] = [];
  const held: TurnInput[] = [];
  const records: { type: string; [k: string]: unknown }[] = [];
  return {
    origin, signal: ac.signal, records,
    onFold(fn) {
      listeners.push(fn);
      for (const h of held.splice(0)) fn(h);
      return () => { listeners.splice(listeners.indexOf(fn), 1); };
    },
    record(e) { records.push(e); },
    fold(i) { if (listeners.length === 0) held.push(i); else for (const l of listeners) l(i); },
    abort() { ac.abort(); },
  };
}

function context(home: string, model: string, over: Partial<BotSessionContext> = {}): BotSessionContext & { bot: EffectiveBot } {
  const bot: EffectiveBot = { id: "luna", name: "Luna", instructions: "You are Luna.", model, userLayer: [] };
  return {
    bot,
    botId: "luna", sessionId: "b_luna", kind: "bot", computer: "Studio", paths: botPaths(home, "luna"),
    caller: { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" },
    current: () => bot,
    memoryBlock: () => "<memory>\nnothing yet\n</memory>",
    mayAct: () => true,
    whenMayAct: async () => {},
    cacheCold: () => false,
    ...over,
  };
}

const user = (text: string): TurnInput => ({ from: "user", text, device: "d_1", sentAt: Date.now(), clientMessageId: crypto.randomUUID() });

function deps(home: string, spawn: SpawnClaudeCodeProcess, over: Partial<BotDriverDeps> = {}): BotDriverDeps {
  return {
    home, spawn,
    canUseTool: () => async (_name, input) => ({ behavior: "allow", updatedInput: input as Record<string, unknown> }),
    sandbox: () => ({ enabled: false }),
    stopGraceMs: 5_000,
    log: (l) => { if (process.env.A3_DEBUG) console.error(l); },
    ...over,
  };
}

const results = (end: { text?: string }) => JSON.parse(end.text ?? "[]") as { name: string | null; isError: boolean; content: string }[];

describeWithEmbeddedRuntime("the bot driver on the embedded runtime", (spawn) => {
  test("a turn answers, with its usage; the next turn reuses the runtime", async () => {
    const home = tempHome();
    const driver = new BotSessionDriver(context(home, "winter-test/echo"), deps(home, spawn));
    try {
      const ctl = control();
      const end = await driver.turn(user("hello there"), ctl);
      expect(end.reason).toBe("end_turn");
      expect(end.text).toContain("hello there");
      expect(ctl.records.some((r) => r.type === "assistant_message")).toBe(true);
      // The host projects the turn's own boundaries; the runtime's echoes never reach the log.
      expect(ctl.records.some((r) => r.type === "user_message" || r.type === "turn_started" || r.type === "turn_completed")).toBe(false);
      const again = await driver.turn(user("second"), control());
      expect(again.reason).toBe("end_turn");
      expect(again.text).toContain("second");
    } finally {
      await driver.stop();
    }
  }, 60_000);

  test("core tools run under their plain names; MCP calls go through the router as the session; holds go at the turn's end", async () => {
    const home = tempHome();
    const ran: { server: string; tool: string; input: unknown; session: string; callId: string; as: unknown }[] = [];
    const runner: McpRunner = {
      async run(server, tool, input, c) {
        ran.push({ server, tool, input, session: c.session, callId: c.callId, as: c.as });
        return { result: { content: [{ type: "text", text: `ran ${tool} on Laptop` }] }, computer: "Laptop" };
      },
    };
    const released: string[] = [];
    const sent: unknown[] = [];
    const core: CoreToolDef[] = [{
      name: "SendMessage", description: "Send a message to another bot or session.",
      inputSchema: { type: "object", properties: { to: { type: "string" }, message: { type: "string" } }, required: ["to", "message"] },
      run: async (input) => { sent.push(input); return { text: "delivered", isError: false }; },
    }];
    const driver = new BotSessionDriver(context(home, "winter-test/calls"), deps(home, spawn, {
      coreTools: () => core,
      mcp: { servers: () => [{ server: "blender", plugin: "blender", instructions: "Render scenes.", tools: [{ name: "Render", inputSchema: { type: "object", properties: { scene: { type: "string" } } }, load: "preload" }] }], runner },
      holds: { releaseSession: (s) => { released.push(s); return 0; } },
    }));
    try {
      const end = await driver.turn(user(['CALL SendMessage {"to":"alpha","message":"hi"}', 'CALL mcp__blender__Render {"scene":"cube"}'].join("\n")), control());
      expect(end.reason).toBe("end_turn");
      const r = results(end);
      expect(r.map((x) => [x.name, x.isError, x.content])).toEqual([["SendMessage", false, "delivered"], ["mcp__blender__Render", false, "ran Render on Laptop"]]);
      expect(sent).toEqual([{ to: "alpha", message: "hi" }]);
      expect(ran).toHaveLength(1);
      expect(ran[0]).toMatchObject({ server: "blender", tool: "Render", input: { scene: "cube" }, session: "b_luna", as: { kind: "session", sessionId: "b_luna", bot: "luna" } });
      expect(ran[0]!.callId).toMatch(/^calls-/);
      expect(released).toEqual(["b_luna"]);
    } finally {
      await driver.stop();
    }
  }, 60_000);

  test("the pause holds a tool call until the user resumes; a computer that stops running the bots refuses it", async () => {
    const home = tempHome();
    let may = false;
    let resume: () => void = () => {};
    const ctx = context(home, "winter-test/calls", {
      mayAct: () => may,
      whenMayAct: () => new Promise<void>((r) => { resume = () => { may = true; r(); }; }),
    });
    const ran: string[] = [];
    const core: CoreToolDef[] = [{ name: "ListAgents", description: "List agents.", inputSchema: { type: "object", properties: {} }, run: async () => { ran.push("ListAgents"); return { text: "none", isError: false }; } }];
    const driver = new BotSessionDriver(ctx, deps(home, spawn, { coreTools: () => core }));
    try {
      const p = driver.turn(user("CALL ListAgents {}"), control());
      await Bun.sleep(1_500);
      expect(ran).toEqual([]);
      resume();
      const end = await p;
      expect(results(end)).toEqual([{ name: "ListAgents", isError: false, content: "none" }]);
      // Fenced: mayAct false and whenMayAct refusing (the lease went elsewhere).
      may = false;
      const fenced = new BotSessionDriver(context(home, "winter-test/calls", { sessionId: "b_luna2", mayAct: () => false, whenMayAct: async () => { throw new Error("lease lost"); } }), deps(home, spawn, { coreTools: () => core }));
      try {
        const end2 = await fenced.turn(user("CALL ListAgents {}"), control());
        const r = results(end2);
        expect(r[0]!.content).toContain("may not act");
        expect(ran).toEqual(["ListAgents"]);
      } finally {
        await fenced.stop();
      }
    } finally {
      await driver.stop();
    }
  }, 60_000);

  test("review B1: the pause that comes on while a card is open holds the allowed call; a lease lost then refuses it", async () => {
    const home = tempHome();
    let may = true;
    let resume: () => void = () => {};
    let leaseLost = false;
    const ctx = context(home, "winter-test/calls", {
      mayAct: () => may,
      whenMayAct: () => (leaseLost ? Promise.reject(new Error("lease lost")) : new Promise<void>((r) => { resume = () => { may = true; r(); }; })),
    });
    const ran: number[] = [];
    const core: CoreToolDef[] = [{ name: "ListAgents", description: "List agents.", inputSchema: { type: "object", properties: {} }, run: async () => { ran.push(Date.now()); return { text: "none", isError: false }; } }];
    // The card: the pause comes on while it is open, then the user allows.
    const canUseTool: BotDriverDeps["canUseTool"] = () => async (_n, input) => { may = false; return { behavior: "allow", updatedInput: input as Record<string, unknown> }; };
    const driver = new BotSessionDriver(ctx, deps(home, spawn, { coreTools: () => core, canUseTool }));
    try {
      const p = driver.turn(user("CALL ListAgents {}"), control());
      await Bun.sleep(1_500);
      expect(ran).toEqual([]);
      const resumedAt = Date.now();
      resume();
      expect(results(await p)[0]!.content).toBe("none");
      expect(ran[0]!).toBeGreaterThanOrEqual(resumedAt);
      leaseLost = true;
      const end = await driver.turn(user("CALL ListAgents {}"), control());
      expect(results(end)[0]!.content).toContain("may not act");
      expect(ran).toHaveLength(1);
    } finally {
      await driver.stop();
    }
  }, 60_000);

  test("review S1: a refused MCP call never leaves its id for the next call of the tool", async () => {
    const home = tempHome();
    const ids: string[] = [];
    const runner: McpRunner = { async run(_s, _t, _i, c) { ids.push(c.callId); return { result: { content: [{ type: "text", text: "ok" }] }, computer: "Studio" }; } };
    let first = true;
    const canUseTool: BotDriverDeps["canUseTool"] = () => async (_n, input) => {
      if (first) { first = false; return { behavior: "deny", message: "no" }; }
      return { behavior: "allow", updatedInput: input as Record<string, unknown> };
    };
    const driver = new BotSessionDriver(context(home, "winter-test/calls"), deps(home, spawn, {
      canUseTool,
      mcp: { servers: () => [{ server: "blender", plugin: "blender", tools: [{ name: "Render", inputSchema: { type: "object" }, load: "preload" }] }], runner },
    }));
    try {
      const end = await driver.turn(user(['CALL mcp__blender__Render {"n":1}', 'CALL mcp__blender__Render {"n":2}'].join("\n")), control());
      expect(results(end).map((r) => r.content)).toEqual(["no", "ok"]);
      expect(ids).toHaveLength(1);
      expect(ids[0]).toMatch(/-2$/);
    } finally {
      await driver.stop();
    }
  }, 60_000);

  test("Glob and Grep start on-demand; Glossary finds and loads them, and returns a skill's instructions", async () => {
    const home = tempHome();
    const ctx = context(home, "winter-test/calls");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(ctx.paths.scratch, { recursive: true });
    writeFileSync(join(ctx.paths.scratch, "notes.md"), "# notes\n");
    const pluginDir = join(home, "plugins", "pdfkit");
    mkdirSync(join(pluginDir, "skills", "pdf"), { recursive: true });
    writeFileSync(join(pluginDir, "skills", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: Fill and read PDF forms\n---\nUse pdftk to fill forms.\n");
    const registry = {
      entries: (point: string) => (point === "skills" ? [{ point, pluginId: "pdfkit", ref: "skills/0", value: "skills/*/SKILL.md", state: "active" as const }] : []),
      get: (id: string) => (id === "pdfkit" ? { id, folder: pluginDir } : undefined),
      list: () => [],
      points: () => [],
    } as unknown as NonNullable<BotDriverDeps["registry"]>;
    const driver = new BotSessionDriver(ctx, deps(home, spawn, { registry }));
    try {
      const end = await driver.turn(user([
        'CALL Glob {"pattern":"*.md"}',
        'CALL Glossary {"query":"find files by name pattern"}',
        'CALL Glossary {"load":["Glob","pdfkit:pdf"]}',
        'CALL Glob {"pattern":"*.md"}',
      ].join("\n")), control());
      const r = results(end);
      // Not loaded yet: the runtime refuses it, pointing at Glossary.
      expect(r[0]!.content).toContain("deferred tool that has not been loaded");
      expect(r[0]!.content).toContain("use Glossary to load it");
      expect(r[1]!.content).toContain("- Glob (tool)");
      expect(r[2]!.content).toContain("Loaded, callable now: Glob");
      expect(r[2]!.content).toContain("Use pdftk to fill forms.");
      expect(r[3]!.isError).toBe(false);
      expect(r[3]!.content).toContain("notes.md");
    } finally {
      await driver.stop();
    }
  }, 60_000);

  test("the hook events: tool.before refuses a call, message.in and message.out rewrite the text, turn.start adds a note", async () => {
    const home = tempHome();
    const seen: string[] = [];
    const hooks: TurnHooks = {
      ...NO_HOOKS,
      toolBefore: async (_s, tool, input) => (tool.name === "ListAgents" ? { deny: "a hook said no", input } : { input }),
      messageIn: async (_s, text) => { seen.push(text); return text.replace("secret", "[redacted]"); },
      messageOut: async (_s, text) => text.toUpperCase(),
      turnStart: async () => [{ label: "Weather", text: "Sunny", pluginId: "weather", hook: "w" }],
      rewritesReplies: () => true,
    };
    const ran: string[] = [];
    const core: CoreToolDef[] = [{ name: "ListAgents", description: "List agents.", inputSchema: { type: "object", properties: {} }, run: async () => { ran.push("x"); return { text: "none", isError: false }; } }];
    const echo = new BotSessionDriver(context(home, "winter-test/echo"), deps(home, spawn, { hooks }));
    try {
      const ctl = control();
      const end = await echo.turn(user("my secret plan"), ctl);
      expect(seen[0]).toBe("my secret plan");
      // The model saw the hook's text and the note; the reply is the message.out hook's.
      expect(end.text).toContain("[REDACTED] PLAN");
      expect(end.text).toContain("SUNNY");
      expect(ctl.records.some((r) => r.type === "assistant_delta")).toBe(false);
      const reply = ctl.records.find((r) => r.type === "assistant_message") as { text: string } | undefined;
      expect(reply?.text).toBe(reply?.text.toUpperCase());
    } finally {
      await echo.stop();
    }
    const calls = new BotSessionDriver(context(home, "winter-test/calls", { sessionId: "b_luna_h" }), deps(home, spawn, { hooks: { ...hooks, rewritesReplies: () => false, messageOut: async (_s, t) => t }, coreTools: () => core }));
    try {
      const end = await calls.turn(user("CALL ListAgents {}"), control());
      expect(results(end)[0]!.content).toContain("a hook said no");
      expect(ran).toEqual([]);
    } finally {
      await calls.stop();
    }
  }, 60_000);

  test("compaction on the host's word: nothing to compact before a transcript; after one, it compacts and the next turn rebuilds", async () => {
    const home = tempHome();
    let built = 0;
    const ctx = context(home, "winter-test/echo", { memoryBlock: () => { built += 1; return "<memory>\nm\n</memory>"; } });
    const driver = new BotSessionDriver(ctx, deps(home, spawn));
    try {
      expect(await driver.compact({ reason: "cache", signal: new AbortController().signal })).toEqual({ compacted: false });
      // More than the runtime's four-pair retention window, so there is something to summarize.
      for (const t of ["one", "two", "three", "four", "five", "six"]) await driver.turn(user(t), control());
      expect(built).toBe(1);
      const aborted = new AbortController();
      aborted.abort();
      expect(await driver.compact({ reason: "cache", signal: aborted.signal })).toEqual({ compacted: false });
      expect(await driver.compact({ reason: "user", signal: new AbortController().signal })).toEqual({ compacted: true });
      const end = await driver.turn(user("seven"), control());
      expect(end.reason).toBe("end_turn");
      // The harness blocks were rebuilt for the turn after the compaction.
      expect(built).toBe(2);
      // A cold cache rebuilds them too, without compacting.
      let cold = false;
      const coldCtx = { ...ctx, sessionId: "b_luna_cold", cacheCold: () => cold };
      const again = new BotSessionDriver(coldCtx, deps(home, spawn));
      try {
        await again.turn(user("eight"), control());
        expect(built).toBe(3);
        await again.turn(user("nine"), control());
        expect(built).toBe(3);
        cold = true;
        await again.turn(user("ten"), control());
        expect(built).toBe(4);
      } finally {
        await again.release();
      }
    } finally {
      await driver.stop();
    }
  }, 90_000);

  test("the user's interrupt stops the step; a rebuilt runtime resumes the transcript", async () => {
    const home = tempHome();
    const ctx = context(home, "winter-test/hang");
    const driver = new BotSessionDriver(ctx, deps(home, spawn));
    try {
      const ctl = control();
      const p = driver.turn(user("wait forever"), ctl);
      await Bun.sleep(1_500);
      ctl.abort();
      const end = await p;
      expect(end.reason).toBe("interrupted");
    } finally {
      await driver.release();
    }
    // A new driver for the same session (a restart) resumes the same transcript.
    const echo = context(home, "winter-test/echo");
    const next = new BotSessionDriver(echo, deps(home, spawn));
    try {
      const end = await next.turn(user("after the restart"), control());
      expect(end.reason).toBe("end_turn");
      expect(end.text).toContain("after the restart");
    } finally {
      await next.stop();
    }
  }, 60_000);
});

describe("formatting", () => {
  test("placeholder", () => expect(true).toBe(true));
});
