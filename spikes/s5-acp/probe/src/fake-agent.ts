#!/usr/bin/env bun
// A fake ACP agent for the probe's self-tests. It behaves the way Clover hopes a real agent
// does: it connects to the MCP servers passed at session/new, asks permission before an
// edit and a command, uses the client's fs/* and terminal/* when offered, honours cancel,
// and replays history on session/load. No model is involved.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { probeHttp, probeStdio } from "./mcp/mini-client.ts";

interface Session {
  cwd: string;
  mcpServers: acp.McpServer[];
  history: acp.SessionUpdate[];
  abort?: AbortController;
  model: string;
}

const sessions = new Map<string, Session>();
let clientCaps: acp.ClientCapabilities = {};

const MODEL_OPTION = (current: string): acp.SessionConfigOption => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: current,
  options: [
    { value: "fake-small", name: "Fake small" },
    { value: "fake-large", name: "Fake large" },
  ],
});

// Sessions persist under <cwd>/.s5-fake-agent/, so a new process can load them (as real agents do).
function save(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return;
  mkdirSync(join(s.cwd, ".s5-fake-agent"), { recursive: true });
  writeFileSync(join(s.cwd, ".s5-fake-agent", `${sessionId}.json`), JSON.stringify({ cwd: s.cwd, history: s.history, model: s.model }));
}

function restore(sessionId: string, cwd: string): Session | undefined {
  try {
    const d = JSON.parse(readFileSync(join(cwd, ".s5-fake-agent", `${sessionId}.json`), "utf8"));
    const s: Session = { cwd: d.cwd, mcpServers: [], history: d.history, model: d.model };
    sessions.set(sessionId, s);
    return s;
  } catch {
    return undefined;
  }
}

async function emit(client: acp.AgentContext, sessionId: string, update: acp.SessionUpdate) {
  sessions.get(sessionId)?.history.push(update);
  save(sessionId);
  await client.notify(acp.methods.client.session.update, { sessionId, update });
}

async function ask(client: acp.AgentContext, sessionId: string, toolCallId: string, title: string, kind: acp.ToolKind) {
  const r = await client.request(acp.methods.client.session.requestPermission, {
    sessionId,
    toolCall: { toolCallId, title, kind, status: "pending" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });
  return r.outcome.outcome === "selected" && r.outcome.optionId.startsWith("allow");
}

async function prompt(client: acp.AgentContext, p: acp.PromptRequest): Promise<acp.PromptResponse> {
  const s = sessions.get(p.sessionId);
  if (!s) throw acp.RequestError.resourceNotFound(p.sessionId);
  const text = p.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
  s.history.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
  save(p.sessionId);
  s.abort = new AbortController();
  const signal = s.abort.signal;

  if (text.includes("sleep 37.25")) {
    // A long command through the client's terminal; cancel kills it and ends the turn.
    await emit(client, p.sessionId, { sessionUpdate: "tool_call", toolCallId: "slow-1", title: "`sleep 37.25`", kind: "execute", status: "pending" });
    if (!(await ask(client, p.sessionId, "slow-1", "`sleep 37.25`", "execute"))) return { stopReason: signal.aborted ? "cancelled" : "end_turn" };
    await emit(client, p.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "slow-1", status: "in_progress" });
    const term = clientCaps.terminal ? await client.createTerminal({ sessionId: p.sessionId, command: "sleep", args: ["37.25"], cwd: s.cwd }) : undefined;
    await new Promise<void>((r) => {
      term?.waitForExit().then(() => r());
      const t = setTimeout(r, 40_000);
      signal.addEventListener("abort", () => (clearTimeout(t), r()));
    });
    if (signal.aborted) {
      await term?.kill();
      await term?.release();
      await emit(client, p.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "slow-1", status: "failed" });
      return { stopReason: "cancelled" };
    }
    await term?.release();
    return { stopReason: "end_turn" };
  }

  // 1. Every MCP server passed at session/new.
  const results: string[] = [];
  const words: string[] = [];
  for (const [i, server] of s.mcpServers.entries()) {
    const id = `mcp-${i}`;
    await emit(client, p.sessionId, { sessionUpdate: "tool_call", toolCallId: id, title: `${server.name}: echo`, kind: "other", status: "in_progress" });
    try {
      const r = "command" in server ? await probeStdio(server as any, `fake-${i}`) : await probeHttp(server as any, `fake-${i}`);
      if (r.callText) results.push(r.callText);
      const m = r.instructions?.match(/instruction word of .*?, it is (\S+?)\.?$/);
      if (m) words.push(m[1]!);
      await emit(client, p.sessionId, { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
    } catch (e) {
      results.push(`${server.name} failed: ${e}`);
      await emit(client, p.sessionId, { sessionUpdate: "tool_call_update", toolCallId: id, status: "failed" });
    }
  }

  // 2. An edit, through the client's fs when offered.
  const file = join(s.cwd, "s5-out.txt");
  if (await ask(client, p.sessionId, "edit-1", `Write ${file}`, "edit")) {
    if (clientCaps.fs?.writeTextFile) {
      await client.request(acp.methods.client.fs.writeTextFile, { sessionId: p.sessionId, path: file, content: results.join("\n") + "\n" });
      if (clientCaps.fs?.readTextFile) await client.request(acp.methods.client.fs.readTextFile, { sessionId: p.sessionId, path: file });
    }
  }

  // 3. A command, through the client's terminal when offered.
  let commandOutput = "";
  if (await ask(client, p.sessionId, "exec-1", "`cat s5-out.txt`", "execute")) {
    if (clientCaps.terminal) {
      await using term = await client.createTerminal({ sessionId: p.sessionId, command: "cat", args: ["s5-out.txt"], cwd: s.cwd });
      await term.waitForExit();
      commandOutput = (await term.currentOutput()).output;
    }
  }
  // 4. A command the client is expected to refuse.
  const refused = !(await ask(client, p.sessionId, "exec-2", "`touch s5-should-not-exist.txt`", "execute"));

  const reply = `results: ${results.join(" | ")}; words: ${words.join(",") || "none"}; cat: ${commandOutput.trim().split("\n").length} lines; refused: ${refused}; model: ${s.model}`;
  await emit(client, p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
  return { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
}

const app = acp
  .agent({ name: "s5-fake-agent" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => {
    clientCaps = params.clientCapabilities ?? {};
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: false },
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { list: {}, close: {} },
      },
      agentInfo: { name: "s5-fake-agent", version: "0.0.1" },
      authMethods: [],
    };
  })
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    const sessionId = randomUUID();
    sessions.set(sessionId, { cwd: params.cwd, mcpServers: params.mcpServers, history: [], model: "fake-small" });
    save(sessionId);
    return { sessionId, configOptions: [MODEL_OPTION("fake-small")] };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    const s = sessions.get(params.sessionId);
    if (!s) throw acp.RequestError.resourceNotFound(params.sessionId);
    if (params.configId === "model" && "value" in params && typeof params.value === "string") s.model = params.value;
    return { configOptions: [MODEL_OPTION(s.model)] };
  })
  .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    const s = sessions.get(params.sessionId) ?? restore(params.sessionId, params.cwd);
    if (!s) throw acp.RequestError.resourceNotFound(params.sessionId);
    s.mcpServers = params.mcpServers;
    for (const update of s.history) await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update });
    return { configOptions: [MODEL_OPTION(s.model)] };
  })
  .onRequest(acp.methods.agent.session.list, () => ({
    sessions: [...sessions.entries()].map(([sessionId, s]) => ({ sessionId, cwd: s.cwd })),
  }))
  .onRequest(acp.methods.agent.session.close, ({ params }) => {
    sessions.get(params.sessionId)?.abort?.abort();
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, ({ params, client }) => prompt(client, params))
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    sessions.get(params.sessionId)?.abort?.abort();
  });

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
);
const conn = app.connect(stream);
await conn.closed;
