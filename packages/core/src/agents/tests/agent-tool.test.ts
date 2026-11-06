// The Agent tool end to end (spec §9.3, plan §4 K-M1): a bot delegates to an ACP agent (the scripted agent process),
// the agent reaches the bot through the real bridge process, the bot keeps control, the transcript is written, and
// the watchdog stops a stalled agent. Lane B's fakes stand in for the session host, the broker, the tree and the fence.
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { S5_ANTIGRAVITY_QUIRKS, S5_CURSOR_QUIRKS, WELL_BEHAVED_QUIRKS } from "../../contracts/fakes/agent-backend";
import { advanceAndSettle } from "../../contracts/fakes/clock";
import { FakeSessionHost } from "../../contracts/fakes/session-host";
import { isContractError } from "../../contracts/common";
import { AcpAgentBackend } from "../backend";
import { bridgeCommand } from "../bridge/main";
import { BridgeTokens } from "../bridge/tokens";
import { AgentManager } from "../manager";
import { agentMethods } from "../rpc";
import { FAKE_AGENT_PATH, fakeLaunch } from "../testing/harness";
import { agentToolDefs } from "../tools";
import { REDACTED_TOKEN } from "../transcript";
import { StallWatchdog } from "../watchdog";
import { waitFor, World, type WorldOptions } from "./world";

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
    expect(w.report("session")[0]).toMatchObject({ how: "new", servers: ["clover"] });
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
    expect(JSON.parse(readFileSync(join(dir, "agent.json"), "utf8"))).toMatchObject({ backend: "fake", agentSessionId: "fake-session-1", root: "home/Studio/project1", rootPath: w.project });
    // The live transcript is the session's own log.
    const log = w.host.history(r.sessionId).filter((x) => x.type === "driver").map((x) => (x as { event: { type: string } }).event.type);
    expect(log).toEqual(expect.arrayContaining(["agent_started", "agent_text", "agent_tool_call", "agent_tool_call_update"]));
    expect(w.host.get(r.sessionId)!.status).toBe("idle");
  });

  test("SendMessage through the bridge folds into the bot's conversation; a request naming the bridge exactly is answered at once, even at ask", async () => {
    const w = make({
      quirks: S5_CURSOR_QUIRKS, level: "ask",
      script: [[{ mcp: { server: "clover", tool: "SendMessage", input: { message: "Halfway: 6 of 12 fixed." } } }, { mcp: { server: "clover", tool: "Glossary", input: { query: "tests" } } }, { say: "Done." }]],
    });
    const r = await w.delegate();
    const n = await waitFor(() => notification(w), "the task notification");
    expect(n.text).toBe("Done.");
    expect(w.parentInputs("agent").map((x) => x.input)).toEqual([{ from: "agent", agent: r.sessionId, text: "Halfway: 6 of 12 fixed." }]);
    expect(w.report("mcp-result").map((x) => x["text"])).toEqual(["Sent.", JSON.stringify({ results: [], loaded: [] }, null, 2)]);
    expect(w.approvals.cards()).toEqual([]);
    const calls = readFileSync(join(w.cloverHome, "bots", "alpha", "agents", r.sessionId, "calls.ndjson"), "utf8");
    expect(calls.trim().split("\n").map((l) => (JSON.parse(l) as { by: string }).by)).toEqual(["bridge", "bridge"]);
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

  test("a request touching a fenced path is a card even at automatic", async () => {
    const w = make({ script: [[{ tool: { kind: "edit", title: "Edit settings", paths: [] } }]] });
    // The path is only known once the world exists: the script is rewritten with it.
    const settings = join(w.cloverHome, "settings");
    const script = JSON.parse(readFileSync(w.agent.config, "utf8")) as { script: { tool: { paths: string[] } }[][] };
    script.script[0]![0]!.tool.paths = [settings];
    await Bun.write(w.agent.config, JSON.stringify(script));
    const r = await w.delegate();
    const card = await waitFor(() => w.approvals.cards()[0], "a card");
    expect(card.fields["paths"]).toEqual({ type: "list", items: [settings] });
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

  test("the bot's tools: Agent, ListAgents, TaskStop", async () => {
    const w = make({ script: [[{ wait: true }]] });
    const [agent, taskStop, listAgents] = agentToolDefs(w.manager, { bot: "alpha", session: "s_alpha", origin: "user" }, { backends: () => ["fake"] });
    expect(agent!.inputSchema).toMatchObject({ required: ["prompt", "backend", "root"] });
    const started = await agent!.run({ prompt: "Fix it.", backend: "fake", root: "home/Studio/project1", description: "Fix it" });
    expect(started.isError).toBe(false);
    const id = /agent_[A-Za-z0-9_-]+/.exec(started.text)![0];
    const listed = await listAgents!.run({});
    expect(listed.text.split("\n")[0]).toContain(id);
    expect((await agent!.run({ prompt: "x" })).isError).toBe(true);
    expect(await taskStop!.run({ id })).toEqual({ text: `Stopped ${id}.`, isError: false });
    expect((await taskStop!.run({ id: "agent_nope" })).isError).toBe(true);
  });

  test("a message from the bot is the agent's next prompt, queued while a turn runs", async () => {
    const w = make({ script: [[{ wait: true }, { say: "first" }], [{ say: "second" }]] });
    const r = await w.delegate();
    await waitFor(() => w.report("blocked").length > 0, "the agent to block");
    await w.manager.send(r.sessionId, { bot: "alpha", session: "s_alpha" }, "Also update the docs.");
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

  test("a running command counts as progress until its limit", async () => {
    let wall = Date.now();
    const w = make({ script: [[{ exec: { seconds: 60 } }, { say: "built" }]], wallNow: () => wall });
    const r = await w.delegate();
    await waitFor(() => w.report("blocked").length > 0, "the command to start");
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
    await w.manager.setModel(r.sessionId, "fake-model-a");
    await w.manager.stop(r.sessionId, { bot: "alpha" });
    expect(JSON.parse(readFileSync(w.agent.selection, "utf8"))).toEqual({ model: "fake-model-a" });
    expect(w.report("config").map((x) => x["value"])).toEqual(["fake-model-b", "fake-model-a", "fake-model-a"]);
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
    // The daemon stops: every agent and token goes with it.
    const view = w.host.get(r.sessionId)!;
    await w.manager.stop(r.sessionId, { bot: "alpha" });
    w.tokens.revokeAll();
    // A new daemon: a new host restored the session (a fresh fake here), new tokens, a new manager.
    const host2 = new FakeSessionHost({ clock: w.clock, approvals: w.approvals });
    host2.open({ id: "s_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, w.parentDriver);
    const tokens2 = new BridgeTokens();
    let m2!: AgentManager;
    const backend2 = new AcpAgentBackend({
      id: "fake", pluginId: "clover/agent-fake", quirks: fakeLaunch(S5_CURSOR_QUIRKS), clock: w.clock,
      command: { program: process.execPath, prefixArgs: [FAKE_AGENT_PATH, w.agent.config], acpArgs: ["acp"] }, wire: (id) => m2.wire(id),
    });
    m2 = new AgentManager({
      home: w.cloverHome, computer: "Studio", host: host2, approvals: w.approvals, tree: w.tree, fence: w.fence, backends: () => [backend2],
      tokens: tokens2, bridge: { ...bridgeCommand(), socketPath: w.endpoint.socketPath }, watchdog: new StallWatchdog({ clock: w.clock }), clock: w.clock,
    });
    expect(m2.reattach({ ...view, status: "idle" })).toBe(true);
    await host2.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Now the docs." });
    await waitFor(() => host2.history("s_alpha").some((x) => x.type === "input" && x.input.from === "task-notification"), "the second notification");
    expect(w.report("session").map((x) => [x["how"], x["sessionId"]])).toEqual([["new", "fake-session-1"], ["load", "fake-session-1"]]);
    expect(w.report("session")[1]!["replayed"]).toBe(2);
    const wire = readFileSync(join(w.cloverHome, "bots", "alpha", "agents", r.sessionId, "acp.ndjson"), "utf8");
    expect(wire).not.toContain("replay-0-");
    expect(wire).not.toContain("old reply");
    expect(tokens2.has(r.sessionId)).toBe(true);
    await host2.stop(r.sessionId);
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
    expect(backends).toMatchObject([{ id: "fake", protocol: "acp", placement: "local", computers: [{ computer: "Studio", installed: true, version: "1.0.0", marks: ["unsandboxed"] }] }]);
    expect(await methods["agent.definitions"]!({}, user)).toEqual({ definitions: [] });
    void WELL_BEHAVED_QUIRKS;
  });
});
