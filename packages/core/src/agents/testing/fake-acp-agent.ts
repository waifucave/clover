// A scripted ACP agent, run as a real process (`bun fake-acp-agent.ts <config.json> acp`), that bends the protocol
// the way a quirks descriptor says: the fake for lane K's real client, as lane B's `FakeAgentBackend` is the fake for
// everything above the contract. It never calls a model. The agent suite (tests/) runs the spine's AgentBackend
// conformance suite and the bridge's end-to-end checks against it, one mode per quirks row (S5 review item 19).
//
// It keeps to what S5 saw on the wire:
// * ids are numbers, or strings when the quirks have snake_case duplicates (Antigravity sends `"id": "1"`);
// * Cursor-style agents put an MCP call's server and tool in `rawInput` (`providerIdentifier`, `toolName`), in an
//   update before the permission request, whose own `toolCall` carries no input;
// * a refusal ends the turn with `end_turn` and no reply (Antigravity), or the call is reported `completed` (Cursor);
// * a cancel leaves tool calls open where the quirks say;
// * `load`, and a `resume` that replays, send the history as updates before answering;
// * a model choice that persists is written to the "user's own settings" (a file), as Cursor's is.
// It starts each stdio MCP server it is given at `session/new`, as real agents do, and its `mcp` step calls one.
//
// What it saw goes to the report file, one JSON line each, for the harness (testing/harness.ts).
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentEvent, AgentQuirks } from "../../contracts/agent-backend";
import type { AgentStep } from "../../contracts/fakes/agent-backend";
import { RpcPeer, RpcError } from "../acp/jsonrpc";

/** B's steps, plus two only a real process can play. */
export type FakeAcpStep =
  | AgentStep
  /** Calls a tool on one of the MCP servers it was given, asking first unless `ask` is false. `$bridge` names the
   *  bridge, whose name is new for each session. */
  | { mcp: { server: string; tool: string; input?: unknown; ask?: boolean } }
  /** Runs a real `sleep` as an `execute` call, for the stall watchdog and the stop sequence. */
  | { exec: { seconds: number; id?: string } }
  /** A hostile agent (review 12): calls a client method Clover didn't offer (`fs/*`, `terminal/*`), and reports how
   *  it was answered. */
  | { clientCall: { method: string; params?: unknown } }
  /** Opens this many permission requests at once and reports each answer. */
  | { flood: number }
  /** Says the bridge's token, as read from its server entry at `session/new`. */
  | { sayBridgeToken: true };

export interface FakeAcpConfig {
  quirks: AgentQuirks;
  script: FakeAcpStep[][];
  history?: AgentEvent[];
  signedIn?: boolean;
  /** What `--version` prints. */
  version: string;
  report: string;
  /** The "user's own settings": where a persisting model choice lands. */
  selection: string;
  /** A `mode` config option with these values (Cursor's `agent`, `plan`, `ask`), the first one current. */
  modes?: string[];
  /** Asks a permission while it replays a `session/load`'s history, and reports the answer. */
  askDuringReplay?: boolean;
}

const [configPath, mode] = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(configPath!, "utf8")) as FakeAcpConfig;
const q = cfg.quirks;

if (mode === "--version") {
  process.stdout.write(`${cfg.version}\n`);
  process.exit(0);
}

const report = (rec: Record<string, unknown>) => appendFileSync(cfg.report, `${JSON.stringify({ ...rec, at: Date.now() })}\n`);
report({ type: "started", pid: process.pid, env: Object.keys(process.env).sort() });

let sessionSeq = 0;
let toolSeq = 0;
let sessionId = "";
let bridgeToken = "";
let bridgeName = "";
const mcp = new Map<string, { child: ChildProcess; peer: RpcPeer; ready?: Promise<void> }>();

interface TurnState {
  cancelled: boolean;
  wake?: () => void;
}
let turn: TurnState | undefined;

const peer = new RpcPeer({
  write: (line) => process.stdout.write(line),
  // Antigravity sends string ids; the quirk that marks it is its snake_case duplicates.
  stringIds: q.capabilities.snakeCaseDuplicates,
  onRequest: (method, params) => handle(method, (params ?? {}) as Record<string, unknown>),
  onNotification: (method) => {
    if (method === "session/cancel" && turn) {
      turn.cancelled = true;
      turn.wake?.();
    }
  },
});
const ask = (method: string, params: unknown) => peer.request(method, params);
process.stdin.on("data", (c: Buffer) => peer.feed(c));
process.stdin.on("end", () => shutdown());
process.on("SIGTERM", () => shutdown());
process.on("SIGUSR2", () => turn?.wake?.());

function shutdown(): void {
  for (const m of mcp.values()) m.child.kill("SIGKILL");
  process.exit(0);
}

function update(u: Record<string, unknown>): void {
  peer.notify("session/update", { sessionId, update: u });
}

function configOptions(): unknown[] {
  const out: unknown[] = [];
  let sel: { model?: string } = {};
  try {
    sel = JSON.parse(readFileSync(cfg.selection, "utf8")) as { model?: string };
  } catch {
    // No selection yet.
  }
  if (q.config.modelOption) out.push({ id: q.config.modelOption, name: "Model", category: "model", type: "select", currentValue: current.model ?? sel.model ?? "fake-model-a", options: [{ value: "fake-model-a", name: "A" }, { value: "fake-model-b", name: "B" }] });
  if (q.config.effortOption) out.push({ id: q.config.effortOption, name: "Effort", category: "thought_level", type: "select", currentValue: current.effort ?? "medium", options: ["low", "medium", "high"].map((v) => ({ value: v, name: v })) });
  if (cfg.modes?.length) out.push({ id: "mode", name: "Mode", category: "mode", type: "select", currentValue: current.mode ?? cfg.modes[0], options: cfg.modes.map((v) => ({ value: v, name: v })) });
  return out;
}
const current: { model?: string; effort?: string; mode?: string } = {};

function startMcpServers(servers: unknown): void {
  for (const s of Array.isArray(servers) ? servers : []) {
    const e = s as { name?: string; command?: string; args?: string[]; env?: { name: string; value: string }[]; type?: string };
    if (e.type && e.type !== "stdio") continue;
    if (!e.name || !e.command) continue;
    const env: Record<string, string> = {};
    // Like Antigravity when its quirks say so, it passes its whole environment on; otherwise a small one.
    if (q.mcp.passesEnvironment) Object.assign(env, process.env);
    else for (const k of ["PATH", "HOME", "TMPDIR"]) if (process.env[k]) env[k] = process.env[k]!;
    for (const kv of e.env ?? []) env[kv.name] = kv.value;
    for (const kv of e.env ?? []) {
      if (kv.name !== "CLOVER_BRIDGE_TOKEN") continue;
      bridgeToken = kv.value;
      bridgeName = e.name;
    }
    const child = spawn(e.command, e.args ?? [], { env, stdio: ["pipe", "pipe", "inherit"] });
    child.on("error", () => report({ type: "mcp-error", server: e.name }));
    const p = new RpcPeer({ write: (line) => child.stdin?.write(line) });
    child.stdout?.on("data", (c: Buffer) => p.feed(c));
    child.on("exit", () => p.close());
    mcp.set(e.name, { child, peer: p });
    report({ type: "mcp-started", server: e.name, pid: child.pid ?? 0 });
  }
}

async function callMcp(server: string, tool: string, input: unknown): Promise<{ text: string; isError: boolean }> {
  const m = mcp.get(server);
  if (!m) return { text: `no server ${server}`, isError: true };
  m.ready ??= (async () => {
    await m.peer.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fake-acp-agent", version: "1.0.0" } }, { timeoutMs: 10_000 });
    m.peer.notify("notifications/initialized");
  })();
  await m.ready;
  const r = (await m.peer.request("tools/call", { name: tool, arguments: input ?? {} }, { timeoutMs: 30_000 })) as { content?: { type: string; text?: string }[]; isError?: boolean };
  return { text: (r.content ?? []).map((c) => c.text ?? "").join(""), isError: r.isError === true };
}

function caps(): Record<string, unknown> {
  const sessionCaps: Record<string, unknown> = { list: {} };
  if (q.sessions.load.supported) sessionCaps["load"] = {};
  if (q.sessions.resume.supported) sessionCaps["resume"] = {};
  if (q.sessions.close) sessionCaps["close"] = {};
  const c: Record<string, unknown> = {
    loadSession: q.sessions.load.supported,
    promptCapabilities: { image: true, audio: false, embeddedContext: false },
    sessionCapabilities: sessionCaps,
  };
  if (!q.capabilities.httpMcpUnadvertised) c["mcpCapabilities"] = { http: q.mcp.transports.includes("http"), sse: q.mcp.transports.includes("sse") };
  if (q.capabilities.snakeCaseDuplicates) {
    c["load_session"] = c["loadSession"];
    c["session_capabilities"] = sessionCaps;
  }
  if (q.mcp.systemPromptChannel === "_meta.antigravity.systemPrompt.append") c["_meta"] = { antigravity: { systemPrompt: { append: true } } };
  return c;
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "initialize":
      return { protocolVersion: 1, agentCapabilities: caps(), agentInfo: { name: "fake-acp-agent", version: "1.0.0" }, authMethods: q.auth.methods.map((m) => ({ id: m.id, name: m.id })) };
    case "session/new": {
      if (cfg.signedIn === false) throw new RpcError(q.auth.requiredError.code ?? -32603, "Authentication required. Run 'cursor-agent login' first.");
      sessionId = `fake-session-${++sessionSeq}`;
      report({ type: "session", how: "new", sessionId, meta: params["_meta"] ?? null, servers: names(params["mcpServers"]), cwd: params["cwd"] ?? null });
      startMcpServers(params["mcpServers"]);
      return { sessionId, configOptions: configOptions() };
    }
    case "session/load":
    case "session/resume": {
      sessionId = String(params["sessionId"]);
      const replays = method === "session/load" ? q.sessions.load.replays : q.sessions.resume.replays;
      let replayed = 0;
      if (replays) {
        for (const e of cfg.history ?? []) {
          if (e.type === "text") update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: e.text } });
          else if (e.type === "tool_call") update({ sessionUpdate: "tool_call", toolCallId: q.sessions.replayKeepsToolCallIds ? e.id : `replay-0-${replayed}`, title: e.title, kind: e.kind, status: e.status });
          else continue;
          replayed++;
        }
      }
      if (cfg.askDuringReplay && replays) {
        const res = (await ask("session/request_permission", { sessionId, toolCall: { toolCallId: "replay-ask", title: "edit", kind: "edit", status: "pending" }, options: [{ optionId: "allow_once", name: "allow", kind: "allow_once" }, { optionId: "reject_once", name: "reject", kind: "reject_once" }] })) as { outcome?: unknown };
        report({ type: "replay-answer", answer: res.outcome ?? null });
      }
      report({ type: "session", how: method === "session/load" ? "load" : "resume", sessionId, replayed, servers: names(params["mcpServers"]), cwd: params["cwd"] ?? null });
      startMcpServers(params["mcpServers"]);
      return { configOptions: configOptions() };
    }
    case "session/set_config_option": {
      const id = String(params["configId"]);
      const value = String(params["value"]);
      const option = id === q.config.modelOption ? "model" : id === q.config.effortOption ? "effort" : id === "mode" && cfg.modes?.length ? "mode" : undefined;
      if (!option) throw new RpcError(-32602, `no config option ${id}`);
      current[option] = value;
      report({ type: "config", option, value });
      if (option === "model" && q.config.choicePersists) writeFileSync(cfg.selection, JSON.stringify({ model: value }));
      return { configOptions: configOptions() };
    }
    case "session/prompt":
      return runTurn(params);
    default:
      throw new RpcError(-32601, `fake agent: no ${method}`);
  }
}

function names(servers: unknown): string[] {
  return (Array.isArray(servers) ? servers : []).map((s) => String((s as { name?: string }).name));
}

const script = [...cfg.script];

async function runTurn(params: Record<string, unknown>): Promise<unknown> {
  const prompt = (params["prompt"] as { type: string; text?: string }[] | undefined) ?? [];
  report({ type: "prompt", text: prompt.map((b) => b.text ?? "").join("") });
  const steps = script.shift() ?? [];
  const t: TurnState = { cancelled: false };
  turn = t;
  const open = new Set<string>();
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  const finish = (stopReason: string) => {
    if (stopReason === "cancelled" && !q.turns.cancelLeavesToolCallsOpen) {
      for (const id of open) update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed" });
    }
    turn = undefined;
    return { stopReason, ...(usage && q.turns.reportsUsage ? { usage } : {}) };
  };
  const waitWake = (on: string, extra: Record<string, unknown> = {}) =>
    new Promise<void>((resolve) => {
      t.wake = resolve;
      report({ type: "blocked", on, ...extra });
    });
  const askPermission = async (id: string, kind: string, title: string): Promise<{ allowed: boolean; cancelled: boolean }> => {
    const options = q.permissions.optionKinds.map((k) => ({ optionId: k, name: k.replace("_", " "), kind: k }));
    const pending = ask("session/request_permission", { sessionId, toolCall: { toolCallId: id, title, kind, status: "pending" }, options });
    report({ type: "blocked", on: "permission", toolCallId: id });
    const res = (await pending) as { outcome?: { outcome: string; optionId?: string } };
    const outcome = res.outcome ?? { outcome: "cancelled" };
    const picked = outcome.outcome === "selected" ? options.find((o) => o.optionId === outcome.optionId)?.kind : undefined;
    report({ type: "answer", toolCallId: id, answer: outcome, ...(picked ? { kind: picked } : {}) });
    return { allowed: picked === "allow_once" || picked === "allow_always", cancelled: t.cancelled };
  };
  const refuse = (id: string): "end" | "go-on" => {
    open.delete(id);
    if (q.turns.refusal === "ends-turn") {
      update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed" });
      return "end";
    }
    update({ sessionUpdate: "tool_call_update", toolCallId: id, status: q.turns.refusal === "reported-completed" ? "completed" : "failed" });
    return "go-on";
  };
  const rawFor = (server: string, tool: string, input: unknown): Record<string, unknown> => {
    const names = q.permissions.mcpNames;
    if (!names) return (input ?? {}) as Record<string, unknown>;
    const raw: Record<string, unknown> = { args: input ?? {} };
    raw[names.server.replace(/^rawInput\./, "")] = server;
    raw[names.tool.replace(/^rawInput\./, "")] = tool;
    return raw;
  };

  for (const step of steps) {
    if (t.cancelled) return finish("cancelled");
    if ("say" in step) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.say } });
    else if ("sayBridgeToken" in step) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `my token is ${bridgeToken}` } });
    else if ("clientCall" in step) {
      try {
        const result = await peer.request(step.clientCall.method, step.clientCall.params ?? { sessionId }, { timeoutMs: 10_000 });
        report({ type: "client-call", method: step.clientCall.method, result });
      } catch (err) {
        report({ type: "client-call", method: step.clientCall.method, error: err instanceof RpcError ? err.code : String(err) });
      }
    } else if ("flood" in step) {
      const asks = Array.from({ length: step.flood }, (_, i) => {
        const id = `flood-${i}`;
        update({ sessionUpdate: "tool_call", toolCallId: id, title: `edit ${i}`, kind: "edit", status: "pending" });
        return askPermission(id, "edit", `edit ${i}`);
      });
      const answers = await Promise.all(asks);
      report({ type: "flood", allowed: answers.filter((a) => a.allowed).length, cancelled: t.cancelled });
      if (t.cancelled) return finish("cancelled");
    }
    else if ("think" in step) update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: step.think } });
    else if ("usage" in step) usage = step.usage;
    else if ("wait" in step) {
      await waitWake("wait");
      if (t.cancelled) return finish("cancelled");
    } else if ("end" in step) return finish(step.end);
    else if ("exec" in step) {
      const id = step.exec.id ?? `call-${++toolSeq}`;
      open.add(id);
      update({ sessionUpdate: "tool_call", toolCallId: id, title: `sleep ${step.exec.seconds}`, kind: "execute", status: "pending", rawInput: { command: `sleep ${step.exec.seconds}` } });
      update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress" });
      const child = spawn("sleep", [String(step.exec.seconds)], { stdio: "ignore" });
      const exited = new Promise<void>((r) => child.on("exit", () => r()));
      const woke = waitWake("exec", { toolCallId: id, childPid: child.pid ?? 0 });
      await Promise.race([exited, woke]);
      if (t.cancelled) {
        child.kill("SIGKILL");
        return finish("cancelled");
      }
      open.delete(id);
      update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
    } else if ("mcp" in step) {
      const { tool, input } = step.mcp;
      const server = step.mcp.server === "$bridge" ? bridgeName : step.mcp.server;
      const id = `call-${++toolSeq}`;
      open.add(id);
      update({ sessionUpdate: "tool_call", toolCallId: id, title: "MCP: tool", kind: "other", status: "pending", rawInput: {} });
      update({ sessionUpdate: "tool_call_update", toolCallId: id, title: `${server}: ${tool}`, rawInput: rawFor(server, tool, input) });
      if (step.mcp.ask !== false) {
        const a = await askPermission(id, "other", `${server}-${tool}: ${tool}`);
        if (a.cancelled) return finish("cancelled");
        if (!a.allowed) {
          if (refuse(id) === "end") return finish("end_turn");
          continue;
        }
      }
      update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress" });
      const r = await callMcp(server, tool, input).catch((e: unknown) => ({ text: e instanceof Error ? e.message : String(e), isError: true }));
      report({ type: "mcp-result", server, tool, text: r.text, isError: r.isError });
      open.delete(id);
      update({ sessionUpdate: "tool_call_update", toolCallId: id, status: r.isError ? "failed" : "completed", content: [{ type: "content", content: { type: "text", text: r.text } }] });
    } else {
      const s = step.tool;
      const id = s.id ?? `call-${++toolSeq}`;
      open.add(id);
      const locations = (s.paths ?? []).map((path) => ({ path }));
      const raw = s.mcp ? rawFor(s.mcp.server, s.mcp.tool, s.rawInput) : s.rawInput;
      update({ sessionUpdate: "tool_call", toolCallId: id, title: s.title, kind: s.kind, status: "pending", ...(raw === undefined ? {} : { rawInput: raw }), ...(locations.length ? { locations } : {}) });
      if (s.ask !== false) {
        const a = await askPermission(id, s.kind, s.title);
        if (a.cancelled) return finish("cancelled");
        if (!a.allowed) {
          if (refuse(id) === "end") return finish("end_turn");
          continue;
        }
      }
      update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress" });
      open.delete(id);
      update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
    }
  }
  return finish(t.cancelled ? "cancelled" : "end_turn");
}
