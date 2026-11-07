// Lane A's bot driver on the real embedded runtime (one Worker per session), with the runtime's scripted test models:
// a turn answers, core tools run under their plain names, MCP calls go to the router as the session, the pause holds a
// tool call, the user's interrupt stops a turn and what folded in is carried, the turn ends release the holds, the
// transcript resumes after a rebuild, and compaction runs on the host's word.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query as sdkQuery, type SpawnClaudeCodeProcess } from "@waifucave/clover-agent-sdk";
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

/** The SDK's `query`, with every frame the runtime sends recorded and timed. */
function tappedQuery(): { frames: { at: number; msg: Record<string, unknown> }[]; query: typeof sdkQuery } {
  const frames: { at: number; msg: Record<string, unknown> }[] = [];
  const query: typeof sdkQuery = (args) => {
    const q = sdkQuery(args);
    const it = q[Symbol.asyncIterator]();
    const tapped: AsyncIterator<unknown> & AsyncIterable<unknown> = {
      async next() {
        const n = await it.next();
        if (n.done !== true) frames.push({ at: Date.now(), msg: n.value as Record<string, unknown> });
        return n;
      },
      return: (v?: unknown) => it.return?.(v as never) ?? Promise.resolve({ done: true, value: undefined }),
      [Symbol.asyncIterator]() { return this; },
    };
    return new Proxy(q, {
      get(target, prop) {
        if (prop === Symbol.asyncIterator) return () => tapped;
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  };
  return { frames, query };
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
      // Fenced: mayAct false and whenMayAct refusing (the lease went elsewhere): the model turn doesn't even start
      // (the tool call's own refusal is review B1's test, below).
      may = false;
      const fenced = new BotSessionDriver(context(home, "winter-test/calls", { sessionId: "b_luna2", mayAct: () => false, whenMayAct: async () => { throw new Error("lease lost"); } }), deps(home, spawn, { coreTools: () => core }));
      try {
        const end2 = await fenced.turn(user("CALL ListAgents {}"), control());
        expect(end2).toEqual({ reason: "stopped", text: "Stopped: this computer no longer runs the bot." });
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

  test("the pause holds a turn the runtime starts on its own (a background task's notification) until the user resumes", async () => {
    const home = tempHome();
    let may = true;
    let resume: () => void = () => {};
    const ctx = context(home, "winter-test/calls", {
      mayAct: () => may,
      whenMayAct: (signal) => new Promise<void>((r, j) => {
        resume = () => { may = true; r(); };
        signal?.addEventListener("abort", () => j(new Error("aborted")), { once: true });
      }),
    });
    // The runtime's own frames, timed: the driver records none of a turn no host turn covers.
    const { frames, query } = tappedQuery();
    // The pause stops background tasks (the next test); here the task is left to finish while the pause holds, as a
    // task the stop missed by a moment would (or one `Query.stopTask` stopped, which also sends a notification).
    const released: number[] = [];
    const driver = new BotSessionDriver(ctx, deps(home, spawn, { query, pausePollMs: 3_600_000, holds: { releaseSession: () => { released.push(Date.now()); return 0; } } }));
    const resultsAfter = (t: number) => frames.filter((f) => f.msg.type === "result" && f.at > t);
    try {
      const end = await driver.turn(user('CALL Bash {"command":"sleep 2; echo finished","run_in_background":true,"description":"wait"}'), control());
      expect(end.reason).toBe("end_turn");
      // The pause comes on; the task finishes while it holds, and its notification would start a model turn.
      may = false;
      const pausedAt = Date.now();
      await Bun.sleep(5_000);
      expect(resultsAfter(pausedAt)).toEqual([]);
      expect(frames.some((f) => f.at > pausedAt && f.msg.type === "assistant")).toBe(false);
      const resumedAt = Date.now();
      resume();
      for (let i = 0; i < 150 && resultsAfter(resumedAt).length === 0; i++) await Bun.sleep(100);
      expect(resultsAfter(resumedAt)).toHaveLength(1);
      expect(frames.some((f) => f.at > pausedAt && f.at < resumedAt && f.msg.type === "assistant")).toBe(false);
      // The turn the runtime ran on its own let go of its holds at its end, as a host turn does.
      for (let i = 0; i < 20 && !released.some((at) => at >= resumedAt); i++) await Bun.sleep(50);
      expect(released.some((at) => at >= resumedAt)).toBe(true);
    } finally {
      await driver.stop();
    }
  }, 60_000);

  test("where the host takes wakes (lane D), the runtime's own turn is handed over before any request, as one wake per task", async () => {
    const home = tempHome();
    const wakes: { task: string; status: string; text: string }[] = [];
    const ctx = Object.assign(context(home, "winter-test/calls"), { wake: (w: { task: string; status: string; text: string }) => { wakes.push(w); return { disposition: "turn", seq: 1 }; } });
    const { frames, query } = tappedQuery();
    const driver = new BotSessionDriver(ctx, deps(home, spawn, { query }));
    try {
      const end = await driver.turn(user('CALL Bash {"command":"sleep 1; echo finished","run_in_background":true,"description":"wait"}'), control());
      expect(end.reason).toBe("end_turn");
      const after = Date.now();
      for (let i = 0; i < 100 && wakes.length === 0; i++) await Bun.sleep(100);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.status).toBe("completed");
      expect(wakes[0]!.task).toBe(String(frames.find((f) => f.msg.subtype === "task_started")!.msg.task_id));
      expect(wakes[0]!.text.length).toBeGreaterThan(0);
      // The runtime's own turn ended before any request: no reply, a hook-stopped result.
      expect(frames.some((f) => f.at > after && f.msg.type === "assistant")).toBe(false);
      expect(frames.some((f) => f.at > after && f.msg.type === "result" && f.msg.terminal_reason === "hook_stopped")).toBe(true);
      // The host's turn for it runs through the driver like any other.
      const next = await driver.turn({ from: "task", task: wakes[0]!.task, status: "completed", text: wakes[0]!.text } as never, control("task-notification" as never));
      expect(next.reason).toBe("end_turn");
    } finally {
      await driver.stop();
    }
  }, 60_000);

  test("a hand-back holds a turn the runtime starts on its own (mayStart), though the running turn may still act", async () => {
    const home = tempHome();
    let start = true;
    let started: () => void = () => {};
    const ctx = context(home, "winter-test/calls", {
      // Handing back: a running turn may act, nothing new starts here.
      mayAct: () => true,
      mayStart: () => start,
      whenMayStart: (signal) => new Promise<void>((r, j) => {
        started = () => { start = true; r(); };
        signal?.addEventListener("abort", () => j(new Error("aborted")), { once: true });
      }),
    });
    const { frames, query } = tappedQuery();
    const driver = new BotSessionDriver(ctx, deps(home, spawn, { query }));
    try {
      const end = await driver.turn(user('CALL Bash {"command":"sleep 2; echo finished","run_in_background":true,"description":"wait"}'), control());
      expect(end.reason).toBe("end_turn");
      start = false;
      const from = Date.now();
      await Bun.sleep(5_000);
      expect(frames.some((f) => f.at > from && (f.msg.type === "result" || f.msg.type === "assistant"))).toBe(false);
      const at = Date.now();
      started();
      for (let i = 0; i < 150 && !frames.some((f) => f.at > at && f.msg.type === "result"); i++) await Bun.sleep(100);
      expect(frames.some((f) => f.at > at && f.msg.type === "result")).toBe(true);
    } finally {
      await driver.stop();
    }
  }, 60_000);

  test("a tool call the pause holds past the limit is refused, telling the model why", async () => {
    const home = tempHome();
    let asked = 0;
    const ctx = context(home, "winter-test/calls", {
      // The turn starts; the pause comes on before its call.
      mayAct: () => asked++ === 0,
      whenMayAct: (signal) => new Promise<void>((_r, j) => signal?.addEventListener("abort", () => j(new Error("aborted")), { once: true })),
    });
    const ran: string[] = [];
    const core: CoreToolDef[] = [{ name: "ListAgents", description: "List agents.", inputSchema: { type: "object", properties: {} }, run: async () => { ran.push("x"); return { text: "none", isError: false }; } }];
    const driver = new BotSessionDriver(ctx, deps(home, spawn, { coreTools: () => core, toolHoldMs: 1_000 }));
    try {
      const end = await driver.turn(user("CALL ListAgents {}"), control());
      expect(results(end)[0]!.content).toContain("the pause outlasted how long a call can wait");
      expect(ran).toEqual([]);
    } finally {
      await driver.stop();
    }
  }, 60_000);

  test("the pause stops the bot's background shells as the host; the resume doesn't restart them, and the model hears of it then", async () => {
    const home = tempHome();
    let may = true;
    let resume: () => void = () => {};
    const ctx = context(home, "winter-test/calls", {
      mayAct: () => may,
      whenMayAct: (signal) => new Promise<void>((r, j) => {
        resume = () => { may = true; r(); };
        signal?.addEventListener("abort", () => j(new Error("aborted")), { once: true });
      }),
    });
    const marker = join(tempHome(), "ran.txt");
    const { frames, query } = tappedQuery();
    const driver = new BotSessionDriver(ctx, deps(home, spawn, { query, pausePollMs: 200 }));
    try {
      const end = await driver.turn(user(`CALL Bash ${JSON.stringify({ command: `sleep 4; touch ${JSON.stringify(marker)}`, run_in_background: true, description: "wait" })}`), control());
      expect(results(end)[0]!.content).toContain("background task");
      may = false;
      const pausedAt = Date.now();
      await Bun.sleep(6_000);
      expect(existsSync(marker)).toBe(false);
      expect(frames.some((f) => f.msg.subtype === "task_notification" && f.msg.status === "stopped")).toBe(true);
      // The stop's notification would start a model turn: it waits for the resume.
      expect(frames.some((f) => f.at > pausedAt && f.msg.type === "result")).toBe(false);
      const resumedAt = Date.now();
      resume();
      for (let i = 0; i < 150 && !frames.some((f) => f.at > resumedAt && f.msg.type === "result"); i++) await Bun.sleep(100);
      expect(frames.some((f) => f.at > resumedAt && f.msg.type === "result")).toBe(true);
      const next = await driver.turn(user("back again"), control());
      expect(next.reason).toBe("end_turn");
      expect(existsSync(marker)).toBe(false);
    } finally {
      await driver.stop();
    }
  }, 60_000);

  test("a model turn the pause holds at its start: the interrupt ends it with no request and its text leads the next turn; the runtime's end lets a held one go", async () => {
    const home = tempHome();
    let may = false;
    let resume: () => void = () => {};
    const ctx = context(home, "winter-test/echo", {
      mayAct: () => may,
      whenMayAct: (signal) => new Promise<void>((r, j) => {
        resume = () => { may = true; r(); };
        signal?.addEventListener("abort", () => j(new Error("aborted")), { once: true });
      }),
    });
    const { frames, query } = tappedQuery();
    const driver = new BotSessionDriver(ctx, deps(home, spawn, { query }));
    try {
      const ctl = control();
      const p = driver.turn(user("held hello"), ctl);
      await Bun.sleep(2_000);
      ctl.abort();
      const end = await p;
      expect(end.reason).toBe("interrupted");
      expect(frames.some((f) => f.msg.type === "assistant")).toBe(false);
      resume();
      const next = await driver.turn(user("after the resume"), control());
      expect(next.reason).toBe("end_turn");
      expect(next.text).toContain("held hello");
      expect(next.text).toContain("after the resume");
    } finally {
      await driver.stop();
    }
    // The session ends while the pause holds a turn's start: the hold lets go at once, nothing is asked.
    may = false;
    const tap2 = tappedQuery();
    const ending = new BotSessionDriver(context(home, "winter-test/echo", { sessionId: "b_luna3", mayAct: () => false, whenMayAct: (signal) => new Promise<void>((_r, j) => signal?.addEventListener("abort", () => j(new Error("aborted")), { once: true })) }), deps(home, spawn, { query: tap2.query, stopGraceMs: 30_000 }));
    const p2 = ending.turn(user("never asked"), control());
    await Bun.sleep(1_500);
    const t0 = Date.now();
    await ending.release();
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(await p2).toEqual({ reason: "stopped", text: "The session ended while the bots were paused." });
    await ending.stop();
    expect(tap2.frames.some((f) => f.msg.type === "assistant")).toBe(false);
  }, 60_000);

  test("the pause that comes on during the plugins' tool.before holds a read-only call (no approval to check it again)", async () => {
    const home = tempHome();
    let may = true;
    let resume: () => void = () => {};
    const ctx = context(home, "winter-test/calls", {
      mayAct: () => may,
      whenMayAct: () => new Promise<void>((r) => { resume = () => { may = true; r(); }; }),
    });
    const ran: number[] = [];
    const hooks: TurnHooks = {
      ...NO_HOOKS,
      toolBefore: async (_s, _tool, input) => { may = false; return { input }; },
      toolAfter: async (_s, _tool, _input, output) => { ran.push(Date.now()); return output; },
    };
    // In the session's working folder, where a read asks no one.
    const file = join(ctx.paths.scratch, "note.txt");
    await Bun.write(file, "hello");
    const driver = new BotSessionDriver(ctx, deps(home, spawn, { hooks }));
    try {
      const p = driver.turn(user(`CALL Read ${JSON.stringify({ file_path: file })}`), control());
      await Bun.sleep(1_500);
      expect(ran).toEqual([]);
      const resumedAt = Date.now();
      resume();
      expect(results(await p)[0]!.content).toContain("hello");
      expect(ran[0]!).toBeGreaterThanOrEqual(resumedAt);
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
