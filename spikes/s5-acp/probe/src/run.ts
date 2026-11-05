#!/usr/bin/env bun
// Spike S5 probe runner. One check per invocation; see ../README.md.
//
//   bun src/run.ts <initialize|session|prompt|cancel|load|list> --agent <cursor|agy|fake> [options]
//
// Checks that send a prompt (prompt, cancel, load --follow-up) spend a model call and refuse
// to run without --allow-model-calls. Every call into the agent has a timeout, and the whole
// check has a deadline (--timeout, seconds).
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { AGENTS, agentEnv, writeShims, type AgentSpec } from "./agents.ts";
import { buildClient, CLIENT_CAPABILITIES, CLIENT_INFO, newState, type Decision } from "./acp/client.ts";
import { spawnAgent } from "./acp/transport.ts";
import { startHttpStub } from "./mcp/http-stub.ts";
import { RunLog, sha12 } from "./util/log.ts";
import { sleep, waitFor, withTimeout } from "./util/time.ts";

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: "string", default: "fake" },
    "agent-arg": { type: "string", multiple: true, default: [] },
    model: { type: "string" },
    effort: { type: "string" },
    session: { type: "string" },
    "no-mcp": { type: "boolean", default: false },
    raw: { type: "boolean", default: false },
    runs: { type: "string" },
    "allow-model-calls": { type: "boolean", default: false },
    "follow-up": { type: "boolean", default: false },
    resume: { type: "boolean", default: false },
    settle: { type: "string", default: "8" },
    "cancel-after": { type: "string", default: "4" },
    timeout: { type: "string", default: "240" },
  },
});

const check = positionals[0] ?? "initialize";
const CHECKS = ["initialize", "session", "prompt", "cancel", "load", "list"];
if (!CHECKS.includes(check)) {
  console.error(`unknown check ${check}; one of ${CHECKS.join(", ")}`);
  process.exit(2);
}
const spec: AgentSpec | undefined = AGENTS[opt.agent!];
if (!spec) {
  console.error(`unknown agent ${opt.agent}; one of ${Object.keys(AGENTS).join(", ")}`);
  process.exit(2);
}
const spendsModelCall = check === "prompt" || check === "cancel" || (check === "load" && opt["follow-up"]);
if (spendsModelCall && spec.id !== "fake" && !opt["allow-model-calls"]) {
  console.error(`check "${check}" sends a prompt to ${spec.id} (a model call); pass --allow-model-calls`);
  process.exit(2);
}

const runsBase = resolve(opt.runs ?? process.env.S5_RUNS ?? join(tmpdir(), "clover-s5-acp"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = join(runsBase, `${stamp}-${spec.id}-${check}`);
const workDir = join(runsBase, "work", spec.id); // stable per agent, so load finds its sessions
mkdirSync(workDir, { recursive: true });
const statePath = join(runsBase, `state-${spec.id}.json`);
const log = new RunLog(runDir);

// Values only the stubs and this runner know. Tokens are secrets and never reach a log;
// nonces and words must reach the model to prove a path works.
const rnd = (n = 6) => randomBytes(n).toString("hex");
const secrets = {
  stdioToken: rnd(16),
  httpToken: rnd(16),
  stdioNonce: `SN-${rnd()}`,
  httpNonce: `HN-${rnd()}`,
  stdioWord: `sword${rnd(3)}`,
  httpWord: `hword${rnd(3)}`,
};
log.redactor.add(secrets.stdioToken, "stdio-token");
log.redactor.add(secrets.httpToken, "http-token");

const summary: Record<string, any> = {
  check,
  agent: spec.id,
  command: [spec.command, ...spec.args, ...(opt["agent-arg"] ?? [])].join(" "),
  started: new Date().toISOString(),
  // The stdio stub logs the sha of the token it got; the HTTP stub compares it itself.
  bridgeTokenSha: { stdio: sha12(secrets.stdioToken) },
  nonces: { stdio: secrets.stdioNonce, http: secrets.httpNonce, stdioWord: secrets.stdioWord, httpWord: secrets.httpWord },
};

function ledger(kind: string, extra: Record<string, unknown> = {}) {
  appendFileSync(join(runsBase, "model-calls.ndjson"), JSON.stringify({ at: new Date().toISOString(), agent: spec!.id, check, kind, run: runDir, ...extra }) + "\n");
}

function readNdjson(file: string): any[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function mcpActivity() {
  const stdio = readNdjson(log.path("mcp-stdio.ndjson"));
  const http = readNdjson(log.path("mcp-http.ndjson"));
  return {
    stdio: {
      starts: stdio.filter((r) => r.kind === "start").length,
      // Did the env we passed in the stdio entry reach the server the agent started?
      bridgeCheck: stdio.find((r) => r.kind === "start")?.bridgeCheck ?? "never started",
      envTokenMatches: stdio.find((r) => r.kind === "start")?.bridgeCheck === `present sha256=${sha12(secrets.stdioToken)}`,
      envNames: stdio.find((r) => r.kind === "start")?.envNames,
      methods: stdio.filter((r) => r.kind === "in").map((r) => r.msg?.method ?? "(response)"),
      calls: stdio.filter((r) => r.kind === "in" && r.msg?.method === "tools/call").map((r) => r.msg.params),
    },
    http: {
      requests: http.filter((r) => r.kind === "http").map((r) => `${r.method} ${r.path} → ${r.status}${r.notes?.length ? " " + r.notes.join(",") : ""}`),
      // Did the headers we passed in the http entry arrive? "match" = our bearer token, verbatim.
      authCheck: [...new Set(http.filter((r) => r.kind === "http").map((r) => r.authCheck))],
      protocolVersionHeader: [...new Set(http.filter((r) => r.kind === "http").map((r) => r.headers?.["mcp-protocol-version"]).filter(Boolean))],
      userAgent: [...new Set(http.filter((r) => r.kind === "http").map((r) => r.headers?.["user-agent"]).filter(Boolean))],
      calls: http.filter((r) => r.kind === "http").flatMap((r) => (Array.isArray(r.body) ? r.body : [r.body])).filter((m: any) => m?.method === "tools/call").map((m: any) => m.params),
    },
  };
}

const PROMPT_MAIN = (s: typeof secrets) =>
  [
    "This is an automated protocol test. Do exactly these steps, in order, and nothing else:",
    `1. Call the MCP tool s5_stdio_echo (server s5-stdio) with text "alpha".`,
    `2. Call the MCP tool s5_http_echo (server s5-http) with text "beta".`,
    "3. Create the file s5-out.txt in the current folder holding the two tool results, one per line.",
    "4. Run the shell command: cat s5-out.txt",
    "5. Run the shell command: touch s5-should-not-exist.txt",
    "Then reply with one line: the two tool results exactly as returned, then the instruction words of",
    "s5-stdio and s5-http if your MCP server instructions gave you any (otherwise say none), then whether step 5 ran.",
    "Use no other tools, no web access and no browser.",
  ].join("\n");

const PROMPT_SLOW = "This is an automated protocol test. Run the shell command `sleep 37.25`, then reply with the single word DONE. Use no other tools.";
const PROMPT_FOLLOW_UP =
  "This is an automated protocol test. Earlier in this conversation two MCP echo tools returned results containing nonces. " +
  "Reply with both results on one line, from memory, without calling any tool. Then, on a second line, give the instruction " +
  "words of s5-stdio and s5-http if your MCP server instructions gave you any (otherwise say none).";

function decideFor(_checkName: string) {
  return (req: acp.RequestPermissionRequest): Decision => {
    const text = JSON.stringify(req.toolCall ?? {});
    if (text.includes("should-not-exist")) return "reject"; // the scripted refusal
    // Safety net: nothing that could open a browser, reach the web or drive the screen.
    if (req.toolCall?.kind === "fetch" || /browser|web ?search|web ?fetch|computer|screenshot|\bopen\b|osascript/i.test(text)) return "reject";
    return "allow";
  };
}

async function main() {
  const shimDir = writeShims(runDir);
  const env = agentEnv(spec!, shimDir);
  log.event("run.start", { check, agent: spec!.id, runDir, workDir });

  const http = opt["no-mcp"]
    ? undefined
    : startHttpStub(
        { serverName: "s5-http", toolName: "s5_http_echo", nonce: secrets.httpNonce, instructionWord: secrets.httpWord },
        { logFile: log.path("mcp-http.ndjson"), expectedToken: secrets.httpToken, redactor: log.redactor },
      );
  const mcpServers: acp.McpServer[] = opt["no-mcp"]
    ? []
    : [
        {
          name: "s5-stdio",
          command: process.execPath,
          args: [resolve(import.meta.dir, "mcp/stdio-stub.ts"), "--log", log.path("mcp-stdio.ndjson")],
          env: [
            { name: "S5_NONCE", value: secrets.stdioNonce },
            { name: "S5_INSTRUCTION_WORD", value: secrets.stdioWord },
            { name: "S5_BRIDGE_TOKEN", value: secrets.stdioToken },
          ],
        },
        { type: "http", name: "s5-http", url: http!.url, headers: [{ name: "Authorization", value: `Bearer ${secrets.httpToken}` }] },
      ];

  const agent = spawnAgent({ command: spec!.command, args: [...spec!.args, ...(opt["agent-arg"] ?? [])], cwd: workDir, env }, log);
  const state = newState();
  const { app, terminals } = buildClient({ log, root: workDir, childEnv: env, decide: decideFor(check), raw: opt.raw }, state);

  const deadline = setTimeout(async () => {
    log.event("run.deadline", { seconds: Number(opt.timeout) });
    summary.deadline = true;
    await finish(1);
  }, Number(opt.timeout) * 1000);

  let finished = false;
  async function finish(code: number) {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    terminals.killAll();
    const stopped = await agent.stop(5000);
    summary.agentStop = stopped;
    http?.stop();
    summary.mcp = mcpActivity();
    summary.client = {
      permissions: state.permissions,
      fsCalls: state.fsCalls,
      terminalCalls: state.terminalCalls,
      elicitations: state.elicitations.length,
      unknownMethods: state.unknown,
      updateKinds: countBy(state.updates.map((u) => (u.update as any).sessionUpdate)),
      toolCalls: [...state.toolCalls.entries()].map(([id, t]) => ({ id, ...t, rawInput: undefined })),
    };
    summary.shimsUsed = existsSync(join(runDir, "shims.log")) ? readFileSync(join(runDir, "shims.log"), "utf8").trim().split("\n") : [];
    summary.finished = new Date().toISOString();
    writeFileSync(join(runDir, "summary.json"), JSON.stringify(log.redactor.scrub(summary), null, 2));
    console.log(`\nsummary: ${join(runDir, "summary.json")}`);
    console.log(JSON.stringify(log.redactor.scrub(pick(summary, ["check", "agent", "verdict", "result", "error"])), null, 2));
    process.exit(code);
  }

  try {
    await app.connectWith(agent.stream, async (ctx) => {
      const init = await withTimeout(
        ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: CLIENT_CAPABILITIES, clientInfo: CLIENT_INFO }),
        60_000,
        "initialize",
      );
      const initRaw = agent.rawResponse("initialize")?.result ?? init;
      summary.initialize = initRaw;
      log.event("initialize", { protocolVersion: initRaw.protocolVersion, agentCapabilities: initRaw.agentCapabilities, authMethods: initRaw.authMethods?.map((m: any) => m.id), agentInfo: initRaw.agentInfo });
      const caps = initRaw.agentCapabilities ?? {};
      if (check === "initialize") return;

      if (check === "list") {
        if (!caps.sessionCapabilities?.list) {
          summary.result = { list: "not offered" };
          return;
        }
        // Filtered by our work folder, so none of the owner's other sessions are read.
        const r: any = await withTimeout(ctx.request(acp.methods.agent.session.list, { cwd: workDir }), 30_000, "session/list");
        summary.result = { list: r.sessions.map((s: any) => ({ sessionId: s.sessionId, cwd: s.cwd, updatedAt: s.updatedAt })) };
        return;
      }

      let sessionId: string;
      let sessionRaw: any;
      if (check === "load") {
        const prev = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
        sessionId = !opt.session || opt.session === "last" ? prev.lastSessionId : opt.session;
        if (!sessionId) throw new Error(`no session to load: run a prompt check first or pass --session`);
        const method = opt.resume ? acp.methods.agent.session.resume : acp.methods.agent.session.load;
        if (opt.resume ? !caps.sessionCapabilities?.resume : !caps.loadSession) {
          summary.result = { [method]: "not offered" };
          return;
        }
        const before = state.updates.length;
        const t = Date.now();
        await withTimeout(ctx.request(method as any, { sessionId, cwd: workDir, mcpServers } as any), 120_000, method);
        sessionRaw = agent.rawResponse(method)?.result;
        const replayed = state.updates.slice(before);
        summary.load = {
          method,
          sessionId,
          ms: Date.now() - t,
          replayedUpdates: replayed.length,
          replayedKinds: countBy(replayed.map((u) => (u.update as any).sessionUpdate)),
          replayedText: (replayed as any[])
            .filter((u) => u.update.sessionUpdate === "agent_message_chunk" && u.update.content?.type === "text")
            .map((u) => u.update.content.text)
            .join("")
            .slice(0, 2000),
          previousNoncesInReplay: prev.nonces
            ? { stdio: JSON.stringify(replayed).includes(prev.nonces.stdio), http: JSON.stringify(replayed).includes(prev.nonces.http) }
            : "no previous run recorded",
          response: sessionRaw,
        };
        log.event("session.loaded", { replayed: replayed.length, kinds: summary.load.replayedKinds });
        if (!opt["follow-up"]) {
          await sleep(Number(opt.settle) * 1000);
          return;
        }
        state.text.set(sessionId, "");
        ledger("follow-up");
        const resp = await withTimeout(ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: PROMPT_FOLLOW_UP }] }), 180_000, "session/prompt");
        const text = state.text.get(sessionId) ?? "";
        summary.result = {
          stopReason: resp.stopReason,
          text: text.slice(0, 2000),
          remembers: prev.nonces ? { stdio: text.includes(prev.nonces.stdio), http: text.includes(prev.nonces.http) } : "no previous run recorded",
          // This run's servers carry fresh words: naming them means the instructions reached the model.
          instructionsReachedModel: { stdio: text.includes(secrets.stdioWord), http: text.includes(secrets.httpWord) },
        };
        return;
      }

      const tNew = Date.now();
      const created = await withTimeout(ctx.request(acp.methods.agent.session.new, { cwd: workDir, mcpServers }), 90_000, "session/new");
      sessionId = created.sessionId;
      sessionRaw = agent.rawResponse("session/new")?.result ?? created;
      summary.session = {
        sessionId,
        ms: Date.now() - tNew,
        modes: sessionRaw.modes,
        models: sessionRaw.models
          ? { current: sessionRaw.models.currentModelId, available: sessionRaw.models.availableModels?.map((m: any) => m.modelId) }
          : undefined,
        configOptions: sessionRaw.configOptions?.map((o: any) => ({
          id: o.id,
          category: o.category,
          type: o.type,
          currentValue: o.currentValue,
          values: Array.isArray(o.options) ? o.options.flatMap((x: any) => (x.options ? x.options.map((y: any) => y.value) : [x.value])) : undefined,
        })),
      };
      log.event("session.new", { sessionId, tookMs: summary.session.ms });

      await chooseModel(ctx, sessionId, sessionRaw);

      if (check === "session") {
        await sleep(Number(opt.settle) * 1000); // does the agent reach its MCP servers before any prompt?
        summary.mcpBeforePrompt = mcpActivity();
        if (caps.sessionCapabilities?.close) {
          await withTimeout(ctx.request(acp.methods.agent.session.close, { sessionId }), 30_000, "session/close").catch((e) => (summary.closeError = String(e)));
          summary.closed = true;
        }
        return;
      }

      await sleep(3000); // let MCP servers connect, as a person would take a moment to type

      if (check === "prompt") {
        for (const f of ["s5-out.txt", "s5-should-not-exist.txt"]) rmSync(join(workDir, f), { force: true });
        ledger("prompt", { model: opt.model });
        const t = Date.now();
        const resp = await withTimeout(ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: PROMPT_MAIN(secrets) }] }), 200_000, "session/prompt");
        const text = state.text.get(sessionId) ?? "";
        const outFile = join(workDir, "s5-out.txt");
        const out = existsSync(outFile) ? readFileSync(outFile, "utf8") : undefined;
        summary.result = {
          ms: Date.now() - t,
          stopReason: resp.stopReason,
          usage: (agent.rawResponse("session/prompt")?.result as any)?.usage,
          text: text.slice(0, 3000),
          verdict: {
            stdioToolResultReachedModel: text.includes(secrets.stdioNonce),
            httpToolResultReachedModel: text.includes(secrets.httpNonce),
            stdioInstructionsReachedModel: text.includes(secrets.stdioWord),
            httpInstructionsReachedModel: text.includes(secrets.httpWord),
            fileWritten: out !== undefined,
            fileHasBothResults: !!out && out.includes(secrets.stdioNonce) && out.includes(secrets.httpNonce),
            rejectedCommandDidNotRun: !existsSync(join(workDir, "s5-should-not-exist.txt")),
            usedClientFs: state.fsCalls.length > 0,
            usedClientTerminal: state.terminalCalls.length > 0,
            permissionRequests: state.permissions.length,
          },
        };
        writeFileSync(statePath, JSON.stringify({ lastSessionId: sessionId, cwd: workDir, nonces: { stdio: secrets.stdioNonce, http: secrets.httpNonce } }, null, 2));
        if (caps.sessionCapabilities?.list) {
          const r: any = await withTimeout(ctx.request(acp.methods.agent.session.list, { cwd: workDir }), 30_000, "session/list").catch((e) => ({ error: String(e) }));
          summary.listAfter = r.sessions ? { count: r.sessions.length, includesThisSession: r.sessions.some((s: any) => s.sessionId === sessionId) } : r;
        }
        return;
      }

      if (check === "cancel") {
        ledger("cancel", { model: opt.model });
        const started = Date.now();
        let resolvedAt = 0;
        const promptP = ctx
          .request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: PROMPT_SLOW }] })
          .then((r) => ((resolvedAt = Date.now()), r));
        const running = await waitFor(
          () => [...state.toolCalls.values()].some((t) => t.status === "in_progress" || /sleep/.test(String(t.title ?? ""))) || state.permissions.length > 0,
          60_000,
        );
        await sleep(Number(opt["cancel-after"]) * 1000);
        const sleepsBefore = pgrep("sleep 37.25");
        const cancelAt = Date.now();
        log.event("cancel.send", { running, sleepsBefore: sleepsBefore.length });
        await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
        const resp = await withTimeout(promptP, 60_000, "session/prompt after cancel").catch((e) => ({ stopReason: `error: ${e}` }) as any);
        await sleep(1500);
        const sleepsAfter = pgrep("sleep 37.25");
        summary.result = {
          commandSeenRunning: running,
          stopReason: resp.stopReason,
          msFromCancelToStop: resolvedAt ? resolvedAt - cancelAt : null,
          msPromptTotal: resolvedAt ? resolvedAt - started : null,
          sleepProcessesBeforeCancel: sleepsBefore,
          sleepProcessesAfterCancel: sleepsAfter,
          verdict: { stopReasonCancelled: resp.stopReason === "cancelled", commandKilled: sleepsBefore.length > 0 && sleepsAfter.length === 0 },
        };
        return;
      }
    });
  } catch (e: any) {
    summary.error = e?.message ? `${e.message}${e.code ? ` (code ${e.code})` : ""}${e.data ? ` ${JSON.stringify(e.data)}` : ""}` : String(e);
    log.event("run.error", { error: summary.error });
    await finish(1);
    return;
  }
  await finish(0);
}

async function chooseModel(ctx: acp.ClientContext, sessionId: string, sessionRaw: any) {
  const opts: any[] = sessionRaw.configOptions ?? [];
  if (opt.model) {
    const modelOpt = opts.find((o) => o.category === "model") ?? opts.find((o) => o.id === "model");
    if (modelOpt) {
      const r = await withTimeout(ctx.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: modelOpt.id, value: opt.model }), 30_000, "set_config_option model");
      summary.modelSet = { via: "session/set_config_option", configId: modelOpt.id, value: opt.model, current: (r as any).configOptions?.find((o: any) => o.id === modelOpt.id)?.currentValue };
    } else if (sessionRaw.models) {
      await withTimeout(ctx.request("session/set_model", { sessionId, modelId: opt.model }), 30_000, "set_model");
      summary.modelSet = { via: "session/set_model (legacy unstable)", value: opt.model };
    } else {
      summary.modelSet = { via: "none offered", value: opt.model };
    }
    log.event("model.set", summary.modelSet);
  }
  if (opt.effort) {
    const eff = opts.find((o) => o.category === "thought_level") ?? opts.find((o) => /effort|reasoning|thought/i.test(o.id));
    if (eff) {
      await withTimeout(ctx.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: eff.id, value: opt.effort }), 30_000, "set_config_option effort");
      summary.effortSet = { configId: eff.id, value: opt.effort };
    } else summary.effortSet = { via: "none offered", value: opt.effort };
    log.event("effort.set", summary.effortSet);
  }
}

/** Processes whose command line is exactly `pattern` (e.g. "sleep 37.25"), as "pid ppid command". */
function pgrep(pattern: string): string[] {
  try {
    const out = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.replace(/^\d+\s+\d+\s+/, "") === pattern);
  } catch {
    return [];
  }
}

function countBy(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

function pick(o: Record<string, any>, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}

await main();
