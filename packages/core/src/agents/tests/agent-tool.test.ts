// The Agent tool end to end (spec §9.3, plan §4 K-M1): a bot delegates to an ACP agent (the scripted agent process),
// the agent reaches the bot through the real bridge process, the bot keeps control, the transcript is written, and
// the watchdog stops a stalled agent. Lane B's fakes stand in for the session host, the broker, the tree and the fence.
import { readProcessTable, type ProcessTableReader } from "../process/table";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentQuirks } from "../../contracts/agent-backend";
import { S5_ANTIGRAVITY_QUIRKS, S5_CURSOR_QUIRKS, WELL_BEHAVED_QUIRKS } from "../../contracts/fakes/agent-backend";
import { advanceAndSettle } from "../../contracts/fakes/clock";
import { FakeSessionHost } from "../../contracts/fakes/session-host";
import { isContractError } from "../../contracts/common";
import { UserSelections } from "../acp/selections";
import { MAX_OPEN_ASKS } from "../acp/session";
import { AcpAgentBackend } from "../backend";
import { bridgeCloverParts } from "../bridge/handlers";
import { serveClover } from "../testing/clover-endpoint";
import { bridgeCommand } from "../bridge/main";
import { BridgeTokens } from "../bridge/tokens";
import { AgentManager } from "../manager";
import { bundledBackends } from "../testing/bundled-backends";

// The bundled backends' rows, as their plugins hold them.
const ROWS = bundledBackends();
const QUIRKS = Object.fromEntries(Object.entries(ROWS).map(([id, r]) => [id, r.quirks]));
import { agentMethods } from "../rpc";
import { FAKE_AGENT_PATH, fakeLaunch } from "../testing/harness";
import { agentToolDefs } from "../tools";
import { readAgentRecord } from "../records";
import { REDACTED_TOKEN } from "../transcript";
import { StallWatchdog } from "../watchdog";
import { fakeAdmissions, waitFor, World, type WorldOptions } from "./world";

// Real processes: generous on a loaded CI runner.
setDefaultTimeout(60_000);

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});
const make = (o: WorldOptions = {}) => (world = new World(o));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
type Notification = { from: "task-notification"; agent: string; backend: string; stopReason: string; text: string; transcript: string; usage?: unknown };
const notification = (w: World) => w.parentInputs("task-notification")[0]?.input as Notification | undefined;

describe("Agent", () => {
  test("starts a background agent and returns at once; the final text reaches the bot as a task notification", async () => {
    const w = make({ script: [[{ say: "Working. " }, { tool: { kind: "execute", title: "npm test", rawInput: { command: "npm test" } } }, { say: "All 12 tests pass." }]] });
    const r = await w.delegate();
    const view = w.host.get(r.sessionId)!;
    expect(view).toMatchObject({ kind: "agent", bot: "alpha", parent: "s_alpha", backend: "fake", root: "home/Studio/project1", title: "Fix the tests" });
    expect(r.transcript).toBe(`bots/alpha/agents/${r.sessionId}/acp.ndjson`);
    const n = await waitFor(() => notification(w), "the task notification");
    expect(n).toEqual({ from: "task-notification", agent: r.sessionId, backend: "fake", stopReason: "end_turn", text: "All 12 tests pass.", transcript: r.transcript });

    // The agent was handed the bridge as its one MCP server, and its essentials in the first prompt.
    // Its name is `clover_` and a random suffix, new for each session (review 14).
    expect(w.report("session")[0]).toMatchObject({ how: "new", servers: [expect.stringMatching(/^clover_[0-9a-f]{16}$/)], cwd: w.project });
    expect(String(w.report("prompt")[0]!["text"])).toContain("SendMessage");
    expect(String(w.report("prompt")[0]!["text"])).toEndWith("Fix the tests.");
    // Its environment came from the allow-list: nothing of Clover's.
    expect((w.report("started")[0]!["env"] as string[]).filter((n) => /^CLOVER_/.test(n))).toEqual([]);

    // The transcript: the wire with the token redacted, Clover's own record, and who the agent is.
    const dir = join(w.cloverHome, "bots", "alpha", "agents", r.sessionId);
    const wire = readFileSync(join(dir, "acp.ndjson"), "utf8");
    expect(wire).toContain(REDACTED_TOKEN);
    expect(wire).toContain("session/prompt");
    const calls = readFileSync(join(dir, "calls.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(calls).toMatchObject([{ type: "permission", toolKind: "execute", allowed: true, by: "level" }]);
    expect(JSON.parse(readFileSync(join(dir, "agent.json"), "utf8"))).toMatchObject({ backend: "fake", agentSessionId: "fake-session-1", root: "home/Studio/project1" });
    // The daemon's own record, in the fenced run folder, is what a reattach trusts.
    expect(readAgentRecord(w.cloverHome, r.sessionId)).toMatchObject({ backend: "fake", bot: "alpha", parent: "s_alpha", root: "home/Studio/project1", agentSessionId: "fake-session-1" });
    // The live transcript is the session's own log.
    const log = w.host.history(r.sessionId).filter((x) => x.type === "driver").map((x) => (x as { event: { type: string } }).event.type);
    expect(log).toEqual(expect.arrayContaining(["agent_started", "agent_text", "agent_tool_call", "agent_tool_call_update"]));
    expect(w.host.get(r.sessionId)!.status).toBe("idle");
  });

  test("SendMessage through the bridge folds into the bot's conversation; a request naming the bridge exactly is answered at once, even at ask", async () => {
    const w = make({
      quirks: S5_CURSOR_QUIRKS, level: "ask",
      script: [[{ mcp: { server: "$bridge", tool: "SendMessage", input: { message: "Halfway: 6 of 12 fixed." } } }, { mcp: { server: "$bridge", tool: "Glossary", input: { query: "tests" } } }, { say: "Done." }]],
    });
    const r = await w.delegate();
    const n = await waitFor(() => notification(w), "the task notification");
    expect(n.text).toBe("Done.");
    expect(w.parentInputs("agent").map((x) => x.input)).toEqual([{ from: "agent", agent: r.sessionId, text: "Halfway: 6 of 12 fixed." }]);
    expect(w.report("mcp-result").map((x) => x["text"])).toEqual(["Sent.", JSON.stringify({ results: [], loaded: [] }, null, 2)]);
    expect(w.approvals.cards()).toEqual([]);
    const calls = readFileSync(join(w.cloverHome, "bots", "alpha", "agents", r.sessionId, "calls.ndjson"), "utf8");
    expect(calls.trim().split("\n").map((l) => (JSON.parse(l) as { by: string }).by)).toEqual(["bridge", "bridge"]);
    // An agent's SendMessage to its own session is refused, as lane D's is (review 13).
    expect(isContractError(await w.manager.agentMessage(r.sessionId, "me?", r.sessionId).catch((e: unknown) => e), "refused")).toBe(true);
  });

  test("a plugin tool through the bridge runs for the delegation: its bot, computer and origin reach the tool source", async () => {
    const seen: unknown[] = [];
    const w = make({
      pluginTools: {
        tools: async () => [{ name: "Render", description: "Render a scene.", inputSchema: { type: "object" } }],
        call: async (_s, c, ctx) => {
          seen.push({ tool: c.tool, bot: ctx.bot, computer: ctx.computer, origin: ctx.origin, level: ctx.level, withSignal: ctx.signal !== undefined });
          return { content: [{ type: "text", text: "rendered" }], isError: false };
        },
      },
      script: [[{ mcp: { server: "$bridge", tool: "Render", input: { scene: "a" } } }, { say: "Done." }]],
    });
    await w.delegate();
    await waitFor(() => notification(w), "the notification");
    expect(seen).toEqual([{ tool: "Render", bot: "alpha", computer: "Studio", origin: "bot", level: undefined, withSignal: true }]);
    expect(w.report("mcp-result").map((x) => x["text"])).toEqual(["rendered"]);
  });

  test("a request outside the bridge goes to a card at ask; a card's always is Clover's own rule and the agent gets allow_once", async () => {
    const w = make({ quirks: S5_CURSOR_QUIRKS, level: "ask", script: [[{ tool: { kind: "execute", title: "`make`", rawInput: { command: "make" } } }, { say: "Built." }]] });
    await w.delegate();
    const card = await waitFor(() => w.approvals.cards()[0], "a card");
    expect(card.kind).toBe("agent-permission");
    expect(card.fields["command"]).toEqual({ type: "code", code: "make" });
    const always = card.options.find((o) => o.remember === "always")!;
    const frame = w.approvals.frameChannel(card.id)!;
    expect(await w.approvals.answer(card.id, { optionId: always.id, hash: card.hash, proof: { via: "sealed-frame", frame, input: "click", at: w.clock.now() } }, { role: "app" })).toBe("accepted");
    await waitFor(() => notification(w), "the task notification");
    expect(w.report("answer")).toMatchObject([{ toolCallId: "call-1", kind: "allow_once" }]);
    expect(w.approvals.rules().map((x) => x.ruleKey)).toEqual(["Agent(fake):Bash(make)"]);
  });

  test("a bot no one had when the agent started is covered too: the whole home is denied, and a request into it is refused", async () => {
    const w = make({ script: [[{ tool: { kind: "edit", title: "Edit notes", paths: [] } }, { say: "Done." }]] });
    // `latecomer` has no folder at the start; the home's denial and the request check still hold.
    const late = join(w.cloverHome, "bots", "latecomer", "memory", "MEMORY.md");
    const script = JSON.parse(readFileSync(w.agent.config, "utf8")) as { script: { tool: { paths: string[] } }[][] };
    script.script[0]![0]!.tool.paths = [late];
    await Bun.write(w.agent.config, JSON.stringify(script));
    let fence: { denyRead: string[]; denyWrite: string[] } | undefined;
    const start = w.backend.start.bind(w.backend);
    w.backend.start = async (spec) => ((fence = spec.fence), start(spec));
    await w.delegate();
    expect((await waitFor(() => notification(w), "the notification")).stopReason).toBe("end_turn");
    expect(fence!.denyRead).toContain(w.cloverHome);
    expect(fence!.denyWrite).toContain(w.cloverHome);
    expect(w.approvals.cards()).toEqual([]);
    expect(w.report("answer")).toMatchObject([{ kind: "reject_once" }]);
    // A bot's own Bash may work in its own memory (`ownMemory`); an agent's policy never carries it.
    expect("ownMemory" in fence!).toBe(false);
  });

  test("an agent never gets a bot's own memory: a policy that carries ownMemory is refused and the agent doesn't start", async () => {
    const w = make({ script: [[{ say: "never" }]] });
    const policy = w.fence.policy.bind(w.fence);
    w.fence.policy = () => ({ ...policy(), ownMemory: join(w.cloverHome, "bots", "alpha", "memory") }) as ReturnType<typeof policy>;
    const r = await w.delegate();
    // The start fails at its first turn: the bot is told, and no agent process ever ran.
    const n = await waitFor(() => notification(w), "the notification");
    expect(n.stopReason).not.toBe("end_turn");
    expect(JSON.stringify(n)).toContain("ownMemory");
    expect(w.report("started")).toEqual([]);
    expect(w.tokens.has(r.sessionId)).toBe(false);
  });

  test("bots' memory is out of every agent's reach: denied to its sandbox, and a request into it refused without a card", async () => {
    const w = make({ script: [[{ tool: { kind: "read", title: "Read notes", paths: [] } }, { say: "Done." }]] });
    // Another bot's memory, under a folded name, and the delegating bot's own (which it doesn't have yet).
    const other = join(w.cloverHome, "bots", "beta", "Memory", "notes.md");
    mkdirSync(join(w.cloverHome, "bots", "beta", "Memory"), { recursive: true });
    const script = JSON.parse(readFileSync(w.agent.config, "utf8")) as { script: { tool: { paths: string[] } }[][] };
    script.script[0]![0]!.tool.paths = [other];
    await Bun.write(w.agent.config, JSON.stringify(script));
    let fence: { denyRead: string[]; denyWrite: string[] } | undefined;
    const start = w.backend.start.bind(w.backend);
    w.backend.start = async (spec) => ((fence = spec.fence), start(spec));
    const r = await w.delegate();
    expect((await waitFor(() => notification(w), "the notification")).stopReason).toBe("end_turn");
    expect(w.approvals.cards()).toEqual([]);
    expect(w.report("answer")).toMatchObject([{ kind: "reject_once" }]);
    const calls = readFileSync(join(w.cloverHome, "bots", "alpha", "agents", r.sessionId, "calls.ndjson"), "utf8");
    expect(calls).toContain('"by":"clover-home"');
    expect(fence!.denyRead).toContain(w.cloverHome);
    expect(fence!.denyWrite).toContain(w.cloverHome);
  });

  test("a request touching a fenced path outside the home is a card even at automatic; one into the home is refused", async () => {
    const w = make({ script: [[{ tool: { kind: "edit", title: "Edit settings", paths: [] } }, { tool: { kind: "edit", title: "Edit tools", paths: [] } }]] });
    // The paths are only known once the world exists: the script is rewritten with them. A development folder is a
    // fenced item outside the Clover home.
    const settings = join(w.cloverHome, "settings");
    const dev = join(w.userHome, "dev-tools");
    mkdirSync(dev, { recursive: true });
    w.fence.addDevFolder(dev);
    const script = JSON.parse(readFileSync(w.agent.config, "utf8")) as { script: { tool: { paths: string[] } }[][] };
    script.script[0]![0]!.tool.paths = [settings];
    script.script[0]![1]!.tool.paths = [join(dev, "x.sh")];
    await Bun.write(w.agent.config, JSON.stringify(script));
    const r = await w.delegate();
    const card = await waitFor(() => w.approvals.cards()[0], "a card");
    expect(card.fields["paths"]).toEqual({ type: "list", items: [join(dev, "x.sh")] });
    expect(w.report("answer")).toMatchObject([{ kind: "reject_once" }]);
    // TaskStop with the card still open: the card is cancelled, and so is the agent's request.
    await w.manager.stop(r.sessionId, { bot: "alpha" });
    expect(w.approvals.cards()).toEqual([]);
    expect((await waitFor(() => notification(w), "the notification")).stopReason).toBe("stopped");
  });

  test("the root folder: Clover's own home is refused, other computers and unknown backends too", async () => {
    const w = make();
    const err = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
    expect(isContractError(await err(w.delegate("x", { root: "home/Studio" })), "fenced")).toBe(true);
    expect(isContractError(await err(w.delegate("x", { root: "home/Desk/project" })), "not_found")).toBe(true);
    expect(isContractError(await err(w.delegate("x", { computer: "Desk" })), "refused")).toBe(true);
    expect(isContractError(await err(w.delegate("x", { backend: "nope" })), "not_installed")).toBe(true);
    expect(w.host.list({ kind: "agent" })).toEqual([]);
  });

  test("a cloud backend (Devin's cloud) is listed but never started until its bridge and root are settled", async () => {
    const w = make({ quirks: { ...WELL_BEHAVED_QUIRKS, placement: "cloud" } });
    const e = await w.delegate("x").then(() => undefined, (x: unknown) => x);
    expect(isContractError(e, "refused")).toBe(true);
    expect(String((e as Error).message)).toContain("bridge");
    expect(w.report("started")).toEqual([]);
    expect(w.host.list({ kind: "agent" })).toEqual([]);
    const methods = agentMethods({ manager: w.manager, backends: () => [w.backend], computer: "Studio" });
    const view = (await methods["agent.backends"]!({}, { caller: { kind: "user", client: "app" } })) as { backends: { protocol: string; placement: string }[] };
    expect(view.backends[0]).toMatchObject({ protocol: "acp", placement: "cloud" });
    expect(QUIRKS["devin-cloud"]!.placement).toBe("cloud");
    expect(QUIRKS["devin-cloud"]!.launch.command.macos).toEqual(["devin", "acp", "--cloud"]);
    expect(QUIRKS["devin"]!.placement).toBe("local");
  });
});

describe("the bot keeps control", () => {
  test("TaskStop cancels, ends the agent's process group and revokes the token; the bot is told", async () => {
    const w = make({ script: [[{ say: "Starting." }, { wait: true }]] });
    const r = await w.delegate();
    await waitFor(() => w.report("blocked").length > 0, "the agent to block");
    const pid = Number(w.report("started")[0]!["pid"]);
    expect(alive(pid)).toBe(true);
    expect(w.tokens.has(r.sessionId)).toBe(true);
    const other = await w.manager.stop(r.sessionId, { bot: "someone-else" }).catch((e: unknown) => e);
    expect(isContractError(other, "refused")).toBe(true);
    await w.manager.stop(r.sessionId, { bot: "alpha" });
    expect(w.host.get(r.sessionId)!.status).toBe("stopped");
    expect(w.tokens.has(r.sessionId)).toBe(false);
    await waitFor(() => !alive(pid), "the agent's process to end");
    expect((await waitFor(() => notification(w), "the notification")).stopReason).toBe("stopped");
  });

  test("the token is revoked when the agent's process exits, not only at TaskStop", async () => {
    const w = make({ script: [[{ wait: true }]] });
    const r = await w.delegate();
    await waitFor(() => w.report("blocked").length > 0, "the agent to block");
    expect(w.tokens.has(r.sessionId)).toBe(true);
    process.kill(Number(w.report("started")[0]!["pid"]), "SIGKILL");
    await waitFor(() => !w.tokens.has(r.sessionId), "the token to be revoked");
    expect((await waitFor(() => notification(w), "the notification")).stopReason).toBe("crashed");
  });

  test("the bot's tools: Agent and TaskStop; lane D's ListAgents gets the agent rows from the hooks", async () => {
    const w = make({ script: [[{ wait: true }]] });
    const tools = agentToolDefs(w.manager, { bot: "alpha", session: "s_alpha", origin: "user" }, { backends: () => ["fake"] });
    expect(tools.map((t) => t.name)).toEqual(["Agent", "TaskStop"]);
    const [agent, taskStop] = tools;
    expect(agent!.inputSchema).toMatchObject({ required: ["prompt", "backend", "root"] });
    const started = await agent!.run({ prompt: "Fix it.", backend: "fake", root: "home/Studio/project1", description: "Fix it" });
    expect(started.isError).toBe(false);
    const id = /agent_[A-Za-z0-9_-]+/.exec(started.text)![0];
    // The rows in place of the host's own agent rows: agents only, never the bot's session.
    expect(w.manager.sessionHooks().agents.list().map((v) => [v.id, v.kind])).toEqual([[id, "agent"]]);
    expect((await agent!.run({ prompt: "x" })).isError).toBe(true);
    expect(await taskStop!.run({ id })).toEqual({ text: `Stopped ${id}.`, isError: false });
    expect((await taskStop!.run({ id: "agent_nope" })).isError).toBe(true);
  });

  test("TaskStop passes a task id that names none of Clover's agents on to the runtime's own TaskStop", async () => {
    const w = make({ script: [[{ wait: true }]] });
    const passed: string[] = [];
    const stopRuntimeTask = async (taskId: string) => {
      passed.push(taskId);
      return { text: `stopped background task ${taskId}`, isError: false };
    };
    const [agent, taskStop] = agentToolDefs(w.manager, { bot: "alpha", session: "s_alpha", origin: "user" }, { backends: () => ["fake"], stopRuntimeTask });
    expect(taskStop!.description).toContain("background commands");
    expect(await taskStop!.run({ task_id: "bash_7" })).toEqual({ text: "stopped background task bash_7", isError: false });
    expect(await taskStop!.run({ id: "monitor_2" })).toEqual({ text: "stopped background task monitor_2", isError: false });
    // An agent of another bot is refused, never passed on; the bot's own agent stops as before.
    const started = await agent!.run({ prompt: "Fix it.", backend: "fake", root: "home/Studio/project1", description: "Fix it" });
    const id = /agent_[A-Za-z0-9_-]+/.exec(started.text)![0];
    const [, otherStop] = agentToolDefs(w.manager, { bot: "beta", session: "s_beta", origin: "user" }, { stopRuntimeTask });
    expect((await otherStop!.run({ id })).isError).toBe(true);
    expect(await taskStop!.run({ id })).toEqual({ text: `Stopped ${id}.`, isError: false });
    expect(passed).toEqual(["bash_7", "monitor_2"]);
  });

  test("a message from the bot is the agent's next prompt, queued while a turn runs", async () => {
    const w = make({ script: [[{ wait: true }, { say: "first" }], [{ say: "second" }]] });
    const r = await w.delegate();
    await waitFor(() => w.report("blocked").length > 0, "the agent to block");
    // Lane D's SendMessage delivers it (its rule is the one rule, review 13).
    await w.host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Also update the docs." });
    expect(w.host.history(r.sessionId).filter((x) => x.type === "input").map((x) => (x as { disposition: string }).disposition)).toEqual(["turn", "queued"]);
    process.kill(Number(w.report("started")[0]!["pid"]), "SIGUSR2");
    await waitFor(() => w.report("prompt").length === 2, "the second prompt");
    expect(w.report("prompt")[1]!["text"]).toBe("Also update the docs.");
  });
});

describe("the stall watchdog", () => {
  test("an agent with no progress for 10 minutes is stopped, and the bot is told it stalled", async () => {
    const w = make({ script: [[{ say: "Thinking." }, { wait: true }]] });
    const r = await w.delegate();
    await waitFor(() => w.report("blocked").length > 0, "the agent to block");
    await advanceAndSettle(w.clock, 9 * 60_000, 60_000);
    expect(w.host.get(r.sessionId)!.status).toBe("prompting");
    await advanceAndSettle(w.clock, 2 * 60_000, 60_000);
    const n = await waitFor(() => notification(w), "the notification");
    expect(n.stopReason).toBe("stalled");
    expect(w.host.get(r.sessionId)).toMatchObject({ status: "failed", failure: "stalled" });
  });

  test("an agent waiting on a card isn't stalled; the 10 minutes start again from the answer (review 3, the E1c probe)", async () => {
    const w = make({ level: "ask", script: [[{ tool: { kind: "edit", title: "Edit a file", paths: ["a.txt"] } }, { wait: true }]] });
    const r = await w.manager.start({ caller: { kind: "user", device: "d".repeat(16), clientMessageId: "m1" }, backend: "fake", prompt: "Edit it.", root: "home/Studio/project1" });
    const card = await waitFor(() => w.approvals.cards()[0], "a card");
    await advanceAndSettle(w.clock, 30 * 60_000, 60_000);
    expect(w.host.get(r.sessionId)!.status).toBe("prompting");
    const allow = card.options.find((o) => o.remember !== "always" && o.kind === "approve")!;
    const frame = w.approvals.frameChannel(card.id)!;
    expect(await w.approvals.answer(card.id, { optionId: allow.id, hash: card.hash, proof: { via: "sealed-frame", frame, input: "click", at: w.clock.now() } }, { role: "app" })).toBe("accepted");
    await waitFor(() => w.report("blocked").some((b) => b["on"] === "wait"), "the agent to go on");
    await advanceAndSettle(w.clock, 9 * 60_000, 60_000);
    expect(w.host.get(r.sessionId)!.status).toBe("prompting");
    await advanceAndSettle(w.clock, 2 * 60_000, 60_000);
    await waitFor(() => w.host.get(r.sessionId)!.status === "failed", "the stall");
    expect(w.host.get(r.sessionId)!.failure).toBe("stalled");
  });

  test("a running command counts as progress until its limit", async () => {
    let wall = Date.now();
    // Deterministic under load: the real process table gives the tree (the command's `sleep` under the agent), but
    // that one process's start is pinned to the call's start, so `ps`'s second-resolution ages, taken whenever a
    // loaded machine gets round to them, never decide it.
    let commandPid = 0;
    const table: ProcessTableReader = async () => (await readProcessTable()).map((row) => (row.pid === commandPid ? { ...row, startedAt: wall + 1 } : row));
    const w = make({ script: [[{ exec: { seconds: 60 } }, { say: "built" }]], wallNow: () => wall, table });
    const r = await w.delegate();
    await waitFor(() => w.report("blocked").length > 0, "the command to start");
    commandPid = Number((w.report("blocked")[0] as { childPid?: number }).childPid);
    expect(commandPid).toBeGreaterThan(0);
    await advanceAndSettle(w.clock, 11 * 60_000, 60_000);
    await new Promise((res) => setTimeout(res, 800));
    expect(w.host.get(r.sessionId)!.status).toBe("prompting");
    // Past the command's limit, the same process no longer counts. A check reads the process table, which takes
    // real time, so the clock moves on until one has seen it.
    wall += 11 * 60_000;
    const n = await waitFor(async () => {
      await advanceAndSettle(w.clock, 60_000);
      return notification(w);
    }, "the notification");
    expect(n.stopReason).toBe("stalled");
  });
});

describe("models and sessions", () => {
  test("the model reaches the agent; on Cursor the user's own selection is set back when the agent stops", async () => {
    const w = make({ quirks: S5_CURSOR_QUIRKS, script: [[{ wait: true }]] });
    const r = await w.delegate("Fix it.", { model: "fake-model-b" });
    await waitFor(() => w.report("blocked").length > 0, "the agent to block");
    expect(w.report("config")).toMatchObject([{ option: "model", value: "fake-model-b" }]);
    expect(JSON.parse(readFileSync(w.agent.selection, "utf8"))).toEqual({ model: "fake-model-b" });
    // `session.setModel` reaches the agent through lane D's hook.
    await w.manager.sessionHooks().setAgentModel(r.sessionId, "fake-model-a");
    await w.manager.stop(r.sessionId, { bot: "alpha" });
    expect(JSON.parse(readFileSync(w.agent.selection, "utf8"))).toEqual({ model: "fake-model-a" });
    expect(w.report("config").map((x) => x["value"])).toEqual(["fake-model-b", "fake-model-a", "fake-model-a"]);
  });

  test("two Cursor delegations at once: the second never takes the first one's choice for the user's (review 10)", async () => {
    const w = make({ quirks: S5_CURSOR_QUIRKS, script: [[{ wait: true }], [{ wait: true }]] });
    const a = await w.delegate("A.", { model: "fake-model-b" });
    await waitFor(() => w.report("blocked").length === 1, "the first agent to block");
    const b = await w.delegate("B.", { model: "fake-model-b" });
    await waitFor(() => w.report("blocked").length === 2, "the second agent to block");
    await w.manager.stop(a.sessionId, { bot: "alpha" });
    expect(JSON.parse(readFileSync(w.agent.selection, "utf8"))).toEqual({ model: "fake-model-b" });
    await w.manager.stop(b.sessionId, { bot: "alpha" });
    expect(JSON.parse(readFileSync(w.agent.selection, "utf8"))).toEqual({ model: "fake-model-a" });
  });

  test("Antigravity's essentials go in its system prompt, not the first prompt", async () => {
    const w = make({ quirks: S5_ANTIGRAVITY_QUIRKS, script: [[{ say: "ok" }]] });
    await w.delegate();
    await waitFor(() => notification(w), "the notification");
    const meta = w.report("session")[0]!["meta"] as { antigravity: { systemPrompt: { append: string } } };
    expect(meta.antigravity.systemPrompt.append).toContain("SendMessage");
    expect(w.report("prompt")[0]!["text"]).toBe("Fix the tests.");
  });

  test("after a daemon restart the agent is reattached with load, its replay dropped, under a new token", async () => {
    const history = [{ type: "text" as const, text: "old reply" }, { type: "tool_call" as const, id: "x1", kind: "read", title: "read", status: "completed" as const }];
    const w = make({ quirks: S5_CURSOR_QUIRKS, history, script: [[{ say: "first done" }], [{ say: "second done" }]] });
    const r = await w.delegate();
    await waitFor(() => notification(w), "the first notification");
    const view = w.host.get(r.sessionId)!;
    const { host2, tokens2, m2 } = await restart(w, S5_CURSOR_QUIRKS);
    expect(m2.reattach({ ...view, kind: "bot" })).toBe(false);
    // Lane D's BotService hands over the sessions a restart left dormant.
    m2.sessionHooks().reattach([{ ...view, status: "idle" }]);
    expect(host2.get(r.sessionId)).toMatchObject({ kind: "agent", backend: "fake" });
    expect(m2.reattach({ ...view, status: "idle" })).toBe(false);
    await host2.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Now the docs." });
    await waitFor(() => host2.history("s_alpha").some((x) => x.type === "input" && x.input.from === "task-notification"), "the second notification");
    expect(w.report("session").map((x) => [x["how"], x["sessionId"]])).toEqual([["new", "fake-session-1"], ["load", "fake-session-1"]]);
    expect(w.report("session")[1]!["replayed"]).toBe(2);
    const wire = readFileSync(join(w.cloverHome, "bots", "alpha", "agents", r.sessionId, "acp.ndjson"), "utf8");
    expect(wire).not.toContain("replay-0-");
    expect(wire).not.toContain("old reply");
    expect(tokens2.has(r.sessionId)).toBe(true);
    await host2.stop(r.sessionId);
    // A session that ended has no record left to reattach from.
    expect(readAgentRecord(w.cloverHome, r.sessionId)).toBeUndefined();
  });

  test("a reattach trusts the host and the daemon's record, never the bot's own agent.json (review 1, the E4 probe)", async () => {
    const w = make({ level: "ask", script: [[{ say: "first done" }]] });
    const r = await w.delegate();
    await waitFor(() => notification(w), "the first notification");
    const view = w.host.get(r.sessionId)!;
    // The bot rewrites agent.json in its own folder: the Clover home as the root, a raised level, another bot.
    const file = join(w.cloverHome, "bots", "alpha", "agents", r.sessionId, "agent.json");
    const forged = { ...(JSON.parse(readFileSync(file, "utf8")) as object), root: "home/Studio/.clover", rootPath: w.cloverHome, level: "automatic", bot: "beta", backend: "other" };
    writeFileSync(file, JSON.stringify(forged));
    // The agent's next process plays this turn: an edit of a file named relative to its root.
    const config = JSON.parse(readFileSync(w.agent.config, "utf8")) as { script: unknown[][] };
    config.script = [[{ tool: { kind: "edit", title: "Edit a file", paths: ["notes.md"] } }, { say: "edited" }]];
    writeFileSync(w.agent.config, JSON.stringify(config));
    const { host2, m2 } = await restart(w, WELL_BEHAVED_QUIRKS);
    expect(m2.reattach({ ...view, status: "idle" })).toBe(true);
    await host2.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Edit the notes." });
    // It resumed in its own root, and its edit at ask is a card, not allowed at a level nobody recorded.
    const card = await waitFor(() => w.approvals.cards()[0], "a card");
    expect(w.report("session")[1]).toMatchObject({ how: "resume", cwd: w.project });
    expect(card.fields["paths"]).toEqual({ type: "list", items: [join(w.project, "notes.md")] });
    await host2.stop(r.sessionId);
    expect(w.approvals.cards()).toEqual([]);
  });

  test("a reattach is refused when the daemon's record and the host disagree, or the record is gone", async () => {
    const w = make({ script: [[{ say: "first done" }]] });
    const r = await w.delegate();
    await waitFor(() => notification(w), "the first notification");
    const view = w.host.get(r.sessionId)!;
    const { m2 } = await restart(w, WELL_BEHAVED_QUIRKS);
    expect(m2.reattach({ ...view, status: "idle", root: "home/Studio" })).toBe(false);
    expect(m2.reattach({ ...view, status: "idle", parent: "s_other" })).toBe(false);
    expect(m2.reattach({ ...view, status: "stopped" })).toBe(false);
    rmSync(join(w.cloverHome, "run", "agents", `${r.sessionId}.json`));
    expect(m2.reattach({ ...view, status: "idle" })).toBe(false);
  });
});

/** The daemon closes (every agent's process ends, its records stay) and a new one starts: a new host restored the
 *  bot's session (a fresh fake here), new tokens, a new manager. */
async function restart(w: World, quirks: AgentQuirks) {
  await w.manager.close();
  expect(w.tokens.has(w.host.list({ kind: "agent" })[0]?.id ?? "")).toBe(false);
  const host2 = new FakeSessionHost({ clock: w.clock, approvals: w.approvals });
  host2.open({ id: "s_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, w.parentDriver);
  const tokens2 = new BridgeTokens();
  let m2!: AgentManager;
  const backend2 = new AcpAgentBackend({
    id: "fake", pluginId: "clover/agent-fake", quirks: fakeLaunch(quirks), clock: w.clock,
    command: { program: process.execPath, prefixArgs: [FAKE_AGENT_PATH, w.agent.config], acpArgs: ["acp"] }, wire: (id) => m2.wire(id),
    admissions: fakeAdmissions("protected"),
  });
  m2 = new AgentManager({
    home: w.cloverHome, computer: "Studio", host: host2, approvals: w.approvals, tree: w.tree, fence: w.fence, backends: () => [backend2],
    tokens: tokens2, bridge: { ...bridgeCommand(), socketPath: w.endpoint.socketPath }, watchdog: new StallWatchdog({ clock: w.clock }), clock: w.clock,
    levelOf: () => w.level,
  });
  w.endpoint.close();
  const ep2 = serveClover(w.endpoint.socketPath, bridgeCloverParts(tokens2, m2.bridgeHandlers()));
  afterRestart.push(async () => {
    await m2.close();
    ep2.close();
  });
  return { host2, tokens2, m2 };
}
const afterRestart: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of afterRestart.splice(0)) await f();
});

describe("what never runs quietly", () => {
  test("an agent outside its tested versions needs the OK too, even when sandboxed (review 15)", async () => {
    const w = make({ script: [[{ say: "never" }]] });
    const detect = w.backend.detect.bind(w.backend);
    w.backend.detect = async () => ({ ...(await detect()), sandboxed: true, versionOk: false, version: "0.9.0" });
    await w.delegate();
    const card = await waitFor(() => w.approvals.cards()[0], "the OK card");
    expect(card).toMatchObject({ kind: "change", change: "agent-unsandboxed" });
    expect(card.fields["title"]).toEqual({ type: "text", text: "Start an agent Clover hasn't tested?" });
    // Every name it gets from the environment, and every one set for it, is on the card (#233's review).
    const rows = (card.fields["detail"] as { rows: { label: string; value: unknown }[] }).rows;
    expect(JSON.stringify(rows.find((r) => r.label === "Gets from your environment"))).toContain("PATH, HOME");
    expect(rows.some((r) => r.label === "Sets in its environment")).toBe(true);
    const deny = card.options.find((o) => o.kind === "deny")!;
    const frame = w.approvals.frameChannel(card.id)!;
    await w.approvals.answer(card.id, { optionId: deny.id, hash: card.hash, proof: { via: "sealed-frame", frame, input: "click", at: w.clock.now() } }, { role: "app" });
    const n = await waitFor(() => notification(w), "the notification");
    expect(n.text).toContain("outside the versions Clover was tested with");
    expect(w.report("started")).toEqual([]);
  });

  test("at read-only, an agent that acts without asking starts in its read-only mode, or not at all (review 7)", async () => {
    const quirks: AgentQuirks = { ...WELL_BEHAVED_QUIRKS, marks: ["unasked-actions"] };
    const w = make({ quirks, level: "read-only", modes: ["agent", "plan", "ask"], readOnlyMode: { option: "mode", values: ["ask", "plan"] }, script: [[{ say: "read it" }]] });
    await w.delegate();
    await waitFor(() => notification(w), "the notification");
    expect(w.report("config")).toEqual([expect.objectContaining({ option: "mode", value: "ask" })]);
    await w.close();
    world = undefined;
    // No read-only mode offered: it isn't started.
    const w2 = make({ quirks, level: "read-only", modes: ["agent"], readOnlyMode: { option: "mode", values: ["ask", "plan"] }, script: [[{ say: "never" }]] });
    await w2.delegate();
    const n = await waitFor(() => notification(w2), "the notification");
    expect(n.stopReason).toBe("error");
    expect(n.text).toContain("no read-only mode");
    expect(w2.report("prompt")).toEqual([]);
    await w2.close();
    world = undefined;
    // Above read-only it starts as it is.
    const w3 = make({ quirks, level: "ask", modes: ["agent", "plan", "ask"], readOnlyMode: { option: "mode", values: ["ask", "plan"] }, script: [[{ say: "ok" }]] });
    await w3.delegate();
    await waitFor(() => notification(w3), "the notification");
    expect(w3.report("config")).toEqual([]);
  });
});

describe("check 2's minors", () => {
  test("a fenced path behind 200 harmless ones is still a card at automatic, and listed first (minor 1)", async () => {
    const w = make({ script: [[{ tool: { kind: "edit", title: "Edit many files", paths: [] } }]] });
    // A fenced item outside the Clover home (one in it is refused outright): a development folder.
    const dev = join(w.userHome, "dev-tools");
    mkdirSync(dev, { recursive: true });
    w.fence.addDevFolder(dev);
    const fenced = join(dev, "x.json");
    const config = JSON.parse(readFileSync(w.agent.config, "utf8")) as { script: { tool: { paths: string[] } }[][] };
    config.script[0]![0]!.tool.paths = [...Array.from({ length: 200 }, (_, i) => `f${i}.txt`), fenced];
    writeFileSync(w.agent.config, JSON.stringify(config));
    await w.delegate();
    const card = await waitFor(() => w.approvals.cards()[0], "a card");
    const items = (card.fields["paths"] as { items: string[] }).items;
    expect(items[0]).toBe(fenced);
    expect(items.at(-1)).toBe("… and 1 more");
  });

  test("a coding session's bridge offers no SendMessage, since there is no bot to message (minor 3)", async () => {
    const w = make({ script: [[{ say: "hi" }]] });
    const r = await w.manager.start({ caller: { kind: "user", device: "d".repeat(16), clientMessageId: "m1" }, backend: "fake", prompt: "Hi.", root: "home/Studio/project1" });
    const offered = await w.manager.bridgeHandlers().tools(r.sessionId);
    expect(offered.tools.map((t) => t.name)).toEqual(["Glossary"]);
    expect(offered.instructions).not.toContain("SendMessage");
    const bot = await w.delegate();
    expect((await w.manager.bridgeHandlers().tools(bot.sessionId)).tools.map((t) => t.name)).toEqual(["SendMessage", "Glossary"]);
  });

  test("a choice a crashed delegation left is set back as soon as the agent's next session opens (minor 4)", async () => {
    const selections = new UserSelections();
    const w = make({ quirks: S5_CURSOR_QUIRKS, selections, script: [[{ wait: true }]] });
    await w.delegate("A.", { model: "fake-model-b" });
    await waitFor(() => w.report("blocked").length === 1, "the agent to block");
    expect(JSON.parse(readFileSync(w.agent.selection, "utf8"))).toEqual({ model: "fake-model-b" });
    process.kill(Number(w.report("started")[0]!["pid"]), "SIGKILL");
    await waitFor(() => notification(w), "the crash's notification");
    expect(selections.record("fake", "model")).toEqual({ user: "fake-model-a", ours: "fake-model-b" });
    // The next delegation (a new process, which plays this script) sets no model of its own; the user's own comes
    // back when it opens.
    const config = JSON.parse(readFileSync(w.agent.config, "utf8")) as { script: unknown[][] };
    config.script = [[{ say: "no model asked" }]];
    writeFileSync(w.agent.config, JSON.stringify(config));
    await w.delegate("B.");
    await waitFor(() => w.parentInputs("task-notification").length === 2, "the second notification");
    expect(JSON.parse(readFileSync(w.agent.selection, "utf8"))).toEqual({ model: "fake-model-a" });
    expect(selections.record("fake", "model")).toBeUndefined();
  });

  test("lowering the computer to read-only reaches a running agent at its next turn, and raising it switches back (minor 5)", async () => {
    const quirks: AgentQuirks = { ...WELL_BEHAVED_QUIRKS, marks: ["unasked-actions"] };
    const w = make({ quirks, level: "ask", modes: ["agent", "plan", "ask"], readOnlyMode: { option: "mode", values: ["ask", "plan"] }, script: [[{ say: "one" }], [{ say: "two" }], [{ say: "three" }]] });
    const r = await w.delegate();
    await waitFor(() => notification(w), "the first notification");
    expect(w.report("config")).toEqual([]);
    w.level = "read-only";
    await w.host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Two." });
    await waitFor(() => w.parentInputs("task-notification").length === 2, "the second notification");
    expect(w.report("config").map((c) => [c["option"], c["value"]])).toEqual([["mode", "ask"]]);
    w.level = "ask";
    await w.host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Three." });
    await waitFor(() => w.parentInputs("task-notification").length === 3, "the third notification");
    expect(w.report("config").map((c) => [c["option"], c["value"]])).toEqual([["mode", "ask"], ["mode", "agent"]]);
  });
});

/** Lane D's gate, as lane K reads it. */
function pauseSwitch() {
  const fns = new Set<() => void>();
  let paused = false;
  return {
    mayAct: () => !paused,
    watch: (fn: () => void) => (fns.add(fn), () => void fns.delete(fn)),
    set(p: boolean) {
      paused = p;
      for (const f of [...fns]) f();
    },
  };
}

describe("the pause switch pauses background agents too (the owner's ruling)", () => {
  test("paused, no new prompt is sent and the agent isn't stalled; on resume it goes on", async () => {
    const gate = pauseSwitch();
    gate.set(true);
    const w = make({ pause: gate, script: [[{ say: "done" }]] });
    const r = await w.delegate();
    await waitFor(() => w.report("session").length > 0, "the agent to start");
    await advanceAndSettle(w.clock, 30 * 60_000, 60_000);
    expect(w.report("prompt")).toEqual([]);
    expect(w.host.get(r.sessionId)!.status).toBe("prompting");
    gate.set(false);
    expect((await waitFor(() => notification(w), "the notification")).text).toBe("done");
  });

  test("paused mid-turn, the agent is held at its next permission request, unanswered until resume", async () => {
    const gate = pauseSwitch();
    const w = make({ pause: gate, script: [[{ wait: true }, { tool: { kind: "edit", title: "Edit", paths: ["a.txt"] } }, { say: "edited" }]] });
    await w.delegate();
    await waitFor(() => w.report("blocked").length > 0, "the agent to block");
    gate.set(true);
    process.kill(Number(w.report("started")[0]!["pid"]), "SIGUSR2");
    await waitFor(() => w.report("blocked").some((b) => b["on"] === "permission"), "the permission request");
    await new Promise((res) => setTimeout(res, 300));
    expect(w.report("answer")).toEqual([]);
    gate.set(false);
    expect((await waitFor(() => notification(w), "the notification")).text).toBe("edited");
    expect(w.report("answer")).toMatchObject([{ kind: "allow_once" }]);
  });

  test("an agent that acts without asking has its turn cancelled at its next tool call while paused", async () => {
    const gate = pauseSwitch();
    const quirks: AgentQuirks = { ...WELL_BEHAVED_QUIRKS, marks: ["unasked-actions"] };
    const w = make({ pause: gate, quirks, level: "ask", script: [[{ wait: true }, { tool: { kind: "edit", title: "Edit", paths: ["a.txt"], ask: false } }, { wait: true }]] });
    await w.delegate();
    await waitFor(() => w.report("blocked").length > 0, "the agent to block");
    gate.set(true);
    process.kill(Number(w.report("started")[0]!["pid"]), "SIGUSR2");
    expect((await waitFor(() => notification(w), "the notification")).stopReason).toBe("cancelled");
  });
});

describe("K-M2 review", () => {
  test("a bridge call held by the pause never runs once the agent is stopped (blocking 1)", async () => {
    const gate = pauseSwitch();
    const ran: string[] = [];
    const w = make({
      pause: gate,
      pluginTools: {
        tools: async () => [{ name: "Render", description: "Render.", inputSchema: { type: "object" } }],
        call: async (_s, c) => (ran.push(c.tool), { content: [{ type: "text", text: "rendered" }], isError: false }),
      },
      script: [[{ wait: true }, { mcp: { server: "$bridge", tool: "Render", input: {}, ask: false } }, { say: "done" }]],
    });
    const r = await w.delegate();
    await waitFor(() => w.report("blocked").length > 0, "the agent to block");
    gate.set(true);
    process.kill(Number(w.report("started")[0]!["pid"]), "SIGUSR2");
    await new Promise((res) => setTimeout(res, 800));
    await w.manager.stop(r.sessionId, { bot: "alpha" });
    gate.set(false);
    await new Promise((res) => setTimeout(res, 500));
    expect(ran).toEqual([]);
  });

  test("the moment the switch pauses, a busy agent that acts without asking is cancelled (should-fix 4)", async () => {
    const gate = pauseSwitch();
    const quirks: AgentQuirks = { ...WELL_BEHAVED_QUIRKS, marks: ["unasked-actions"] };
    const w = make({ pause: gate, quirks, level: "ask", script: [[{ wait: true }]] });
    await w.delegate();
    await waitFor(() => w.report("blocked").length > 0, "the agent to block");
    gate.set(true);
    expect((await waitFor(() => notification(w), "the notification")).stopReason).toBe("cancelled");
  });

  test("a session outliving its bridge token is restarted under a new one at a turn boundary (minor 12)", async () => {
    const w = make({ tokenTtlMs: 2 * 60 * 60_000, script: [[{ say: "one" }]] });
    const r = await w.delegate();
    await waitFor(() => notification(w), "the first notification");
    const before = w.report("started").length;
    w.clock.advance(90 * 60_000);
    await w.host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Two." });
    await waitFor(() => w.parentInputs("task-notification").length === 2, "the second notification");
    expect(w.report("started").length).toBe(before + 1);
    expect(w.report("session").map((x) => x["how"])).toEqual(["new", "resume"]);
    expect(w.tokens.ageOf(r.sessionId)).toBeLessThan(60 * 60_000);
    expect(readFileSync(join(w.cloverHome, "bots", "alpha", "agents", r.sessionId, "calls.ndjson"), "utf8")).toContain("token-renewed");
  });

  test("start refuses a program other than the one admitted (should-fix 5)", async () => {
    const w = make();
    const fence = w.fence.policy();
    const base = { sessionId: "s", root: w.project, fence, bridge: { name: "b", command: "x", args: [], env: {}, tools: [] } };
    const err = await w.backend.start({ ...base, admitted: { path: "/somewhere/else", version: "1.0.0" } }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("its program changed");
    const d = await w.backend.detect();
    const err2 = await w.backend.start({ ...base, admitted: { path: d.path!, version: d.version!, sha256: "0".repeat(64) } }).catch((e: unknown) => e);
    expect((err2 as Error).message).toContain("its program changed");
    expect(w.report("started")).toEqual([]);
  });
});

describe("a hostile agent (review 12)", () => {
  test("client methods Clover didn't offer are refused, and the token never reaches the session's log", async () => {
    const w = make({ script: [[{ clientCall: { method: "fs/read_text_file", params: { path: "/etc/hosts" } } }, { clientCall: { method: "terminal/create", params: { command: "id" } } }, { sayBridgeToken: true }]] });
    const r = await w.delegate();
    const n = await waitFor(() => notification(w), "the notification");
    expect(w.report("client-call")).toMatchObject([{ method: "fs/read_text_file", error: -32601 }, { method: "terminal/create", error: -32601 }]);
    expect(n.text).toBe(`my token is ${REDACTED_TOKEN}`);
    const log = JSON.stringify(w.host.history(r.sessionId));
    expect(log).toContain(REDACTED_TOKEN);
    expect(log).not.toMatch(/my token is [A-Za-z0-9_-]{20,}/);
  });

  test("a flood of permission requests opens at most MAX_OPEN_ASKS cards; the rest are refused, and stopping takes the cards", async () => {
    const w = make({ level: "ask", script: [[{ flood: MAX_OPEN_ASKS + 12 }]] });
    const r = await w.delegate();
    await waitFor(() => w.approvals.cards().length === MAX_OPEN_ASKS && w.report("answer").length === 12, "the cards and the refusals");
    expect(w.report("answer").every((a) => a["kind"] === "reject_once")).toBe(true);
    await w.manager.stop(r.sessionId, { bot: "alpha" });
    expect(w.approvals.cards()).toEqual([]);
  });

  test("a request during a replay is cancelled, never a card", async () => {
    const history = [{ type: "text" as const, text: "old reply" }];
    const w = make({ quirks: S5_CURSOR_QUIRKS, history, askDuringReplay: true, script: [[{ say: "first" }], [{ say: "second" }]] });
    const r = await w.delegate();
    await waitFor(() => notification(w), "the first notification");
    const view = w.host.get(r.sessionId)!;
    const { host2, m2 } = await restart(w, S5_CURSOR_QUIRKS);
    expect(m2.reattach({ ...view, status: "idle" })).toBe(true);
    await host2.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Go on." });
    await waitFor(() => w.report("replay-answer").length > 0, "the replay's answer");
    expect(w.report("replay-answer")[0]!["answer"]).toEqual({ outcome: "cancelled" });
    expect(w.approvals.cards()).toEqual([]);
    await host2.stop(r.sessionId);
  });
});

describe("live tabs: the user drives a bot's agent directly", () => {
  test("the user's message is the agent's next prompt, its turn is the user's, so its cards wait", async () => {
    const w = make({ level: "ask", script: [[{ say: "first done" }], [{ tool: { kind: "execute", title: "`make`", rawInput: { command: "make" } } }]] });
    const r = await w.delegate();
    await waitFor(() => notification(w), "the first notification");
    await w.host.sendUser(r.sessionId, { text: "Now build it.", device: "d".repeat(16), clientMessageId: "m1", sentAt: w.clock.now() });
    const card = await waitFor(() => w.approvals.cards()[0], "a card");
    expect(card.origin).toBe("user");
    expect(w.report("prompt")[1]!["text"]).toBe("Now build it.");
    await w.manager.stop(r.sessionId);
  });

  test("the user's interrupt cancels the agent's turn; the agent stays, and the bot isn't told it finished", async () => {
    const w = make({ script: [[{ wait: true }], [{ say: "after" }]] });
    const r = await w.delegate();
    await waitFor(() => w.report("blocked").length > 0, "the agent to block");
    await w.host.interrupt(r.sessionId);
    await waitFor(() => w.host.get(r.sessionId)!.status === "idle", "the turn to end");
    expect(w.parentInputs("task-notification")).toEqual([]);
    const ends = w.host.history(r.sessionId).filter((x) => x.type === "turn_ended").map((x) => (x as { end: { reason: string } }).end.reason);
    expect(ends).toEqual(["interrupted"]);
    await w.host.sendUser(r.sessionId, { text: "Go on.", device: "d".repeat(16), clientMessageId: "m2", sentAt: w.clock.now() });
    expect((await waitFor(() => notification(w), "the notification")).text).toBe("after");
  });
});

describe("the agent's own sandbox, and the OK for one without", () => {
  test("a backend whose sandbox is admitted starts with the fenced set in its own format, written in the fenced run folder", async () => {
    const w = make({ script: [[{ wait: true }]] });
    const r = await w.delegate();
    await waitFor(() => w.report("blocked").length > 0, "the agent to block");
    const dir = join(w.cloverHome, "run", "agents", r.sessionId);
    const policy = JSON.parse(readFileSync(join(dir, "policy.json"), "utf8")) as { denyWrite: string[]; denyRead: string[] };
    // The fenced set, and the whole Clover home (the owner's decision, #208's check 2).
    expect(policy.denyWrite).toEqual([...w.fence.policy().denyWrite, w.cloverHome]);
    expect(policy.denyRead).toEqual([...w.fence.policy().denyRead, w.cloverHome]);
    // The setup folder is itself fenced: no bot or agent rewrites the agent's sandbox.
    expect(w.fence.touches([join(dir, "policy.json")])?.kind).toBe("run-folder");
    expect(w.report("started")[0]!["env"]).toContain("FAKE_SANDBOX_POLICY");
    expect(w.report("session")[0]!["meta"]).toMatchObject({ fakeSandbox: { policy: join(dir, "policy.json") } });
    expect(w.approvals.cards()).toEqual([]);
    await w.manager.stop(r.sessionId, { bot: "alpha" });
    expect(existsSync(dir)).toBe(false);
  });

  test("an agent with no sandbox Clover counts on starts only after the user's OK, asked once per version and computer", async () => {
    const w = make({ sandbox: "none", script: [[{ say: "one" }]] });
    const r = await w.delegate();
    const card = await waitFor(() => w.approvals.cards()[0], "the OK card");
    expect(card).toMatchObject({ kind: "change", change: "agent-unsandboxed", session: r.sessionId });
    expect(card.options.some((o) => o.remember === "always")).toBe(false);
    expect(w.report("started")).toEqual([]);
    const approve = card.options.find((o) => o.kind === "approve")!;
    const frame = w.approvals.frameChannel(card.id)!;
    expect(await w.approvals.answer(card.id, { optionId: approve.id, hash: card.hash, proof: { via: "sealed-frame", frame, input: "click", at: w.clock.now() } }, { role: "app" })).toBe("accepted");
    expect((await waitFor(() => notification(w), "the notification")).text).toBe("one");
    // The OK is kept: the next delegation to the same agent starts at once.
    await w.delegate("Again.");
    await waitFor(() => w.parentInputs("task-notification").length === 2, "the second notification");
    expect(w.approvals.cards()).toEqual([]);
  });

  test("a refused OK ends the delegation before the agent starts, and the bot is told", async () => {
    const w = make({ sandbox: "none", script: [[{ say: "never" }]] });
    await w.delegate();
    const card = await waitFor(() => w.approvals.cards()[0], "the OK card");
    const deny = card.options.find((o) => o.kind === "deny")!;
    const frame = w.approvals.frameChannel(card.id)!;
    await w.approvals.answer(card.id, { optionId: deny.id, hash: card.hash, proof: { via: "sealed-frame", frame, input: "click", at: w.clock.now() } }, { role: "app" });
    const n = await waitFor(() => notification(w), "the notification");
    expect(n.stopReason).toBe("error");
    expect(n.text).toContain("wasn't started");
    expect(w.report("started")).toEqual([]);
  });
});

describe("the agent methods", () => {
  test("agent.start opens a coding session the user drives; agent.backends says what this computer has", async () => {
    const w = make({ script: [[{ say: "Hello from the agent." }]] });
    const methods = agentMethods({ manager: w.manager, backends: () => [w.backend], computer: "Studio" });
    const user = { caller: { kind: "user" as const, client: "app" as const } };
    const { session } = (await methods["agent.start"]!({ backend: "fake", computer: "Studio", root: "home/Studio/project1" }, user)) as { session: string };
    expect(w.host.get(session)).toMatchObject({ kind: "coding", status: "ready" });
    expect(w.host.get(session)!.parent).toBeUndefined();
    await w.host.sendUser(session, { text: "Hi", device: "d".repeat(16), clientMessageId: "m1", sentAt: w.clock.now() });
    await waitFor(() => w.host.get(session)!.status === "idle" && w.report("prompt").length === 1, "the turn");
    expect(existsSync(join(w.cloverHome, "agents", session, "acp.ndjson"))).toBe(true);
    const bot = await methods["agent.start"]!({ backend: "fake", computer: "Studio", root: "home/Studio/project1" }, { caller: { kind: "session", sessionId: "s_alpha", sessionKind: "bot" } }).catch((e: unknown) => e);
    expect(isContractError(bot, "refused")).toBe(true);
    const { backends } = (await methods["agent.backends"]!({}, user)) as { backends: { id: string; computers: { installed: boolean; version?: string; marks: string[] }[] }[] };
    expect(backends).toMatchObject([{ id: "fake", protocol: "acp", placement: "local", computers: [{ computer: "Studio", installed: true, version: "1.0.0", sandboxed: true, marks: [] }] }]);
    expect(await methods["agent.definitions"]!({}, user)).toEqual({ definitions: [] });
    void WELL_BEHAVED_QUIRKS;
  });
});
