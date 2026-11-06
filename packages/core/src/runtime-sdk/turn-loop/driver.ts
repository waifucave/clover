// The bot driver (plan §4 A, M3 "the turn loop"; spec §6.1, §6.3, §6.4, §6.7): lane D's `SessionDriver` for a bot's
// conversation and its side threads, over the embedded agent runtime (one Bun Worker per session, `embedded.ts`).
// Owner: lane A. Lane D's `BotService` gets one per session from `botDriverFactory` (its `DriverFactory`).
//
// * **One runtime per session, kept between turns.** The session's input is a host prompt queue: each turn pushes the
//   message that starts it, and what folds in is pushed while the turn runs, so the runtime takes it after its next
//   tool call (agent SDK 0.0.44's fold, `fold.ts`). A push the runtime didn't fold before its turn ended runs as the
//   runtime's next turn, which the same host turn covers: the host turn ends once every push has been answered.
// * **The transcript is the runtime's own,** under the Clover home, keyed by a backend id this driver keeps in
//   `<home>/sessions-runtime/<session>.json`; a new runtime (a restart, a rebuild) resumes it.
// * **The harness owns the system prompt** (prompt.ts): rebuilt at the first turn, after every compaction, and when the
//   cached prompt has expired (`cacheCold()`), each time by resuming the transcript under the new prompt. MCP servers
//   that change in between reach the conversation as a note at the next turn.
// * **The user's interrupt** stops the step at once: the runtime's turn is interrupted (its model call cancelled, a
//   running tool call cancelled and recorded interrupted), and what was pushed to fold but not yet taken is cleared
//   and carried into the next turn, ahead of the user's message.
// * **Before each tool call** the driver asks `mayAct()` (§6.4 fencing, §9.2 pause): while the pause switch holds the
//   session the call waits (`whenMayAct`), and once this computer stops running the bots it is refused. Then the
//   plugins' `tool.before` hooks run, then the approval check (`canUseTool`), then the call; `tool.after` after it.
// * **At each turn's end** the session lets go of its holds on every computer's screen (J's `releaseSession`); at the
//   session's end its terminals close (J's `TerminalRouter.closeSession`).
// * **Compaction:** `compact()` on the host's word (lane D's cache-timed or forced compaction), and the runtime's own
//   when the context fills mid-turn, recorded as `compaction` records; either way the harness blocks rebuild next.
// * **Usage:** each turn's `usage` sums its requests; `contextTokens` is the runtime's `context_tokens`, the last
//   main-loop request's whole prompt, cache included (lane D's ask).
// * **Records** are the inherited session events, projected from the runtime's frames by the core's projector: tool
//   calls and results, the reply, thinking and the streaming deltas (which the host never logs).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query as sdkQuery, type CanUseTool, type HookCallbackMatcher, type McpServerConfig, type Options, type Query, type SpawnClaudeCodeProcess } from "@waifucave/clover-agent-sdk";
import type { SandboxSettingsConfig } from "@waifucave/clover-agent-sdk";
import type { TurnOrigin } from "@waifucave/clover-protocol";
import type { Unsubscribe } from "../../contracts/common";
import type { SessionDriver, TurnControl, TurnEnd, TurnInput } from "../../contracts/session-host";
import type { BotSessionContext } from "../../bots/service";
import { writeJsonAtomic } from "../../sessions/atomic-file";
import { createProjector, type Projector } from "../../projector";
import { buildCoreBrand } from "../brand";
import { hostInputFoldedCount } from "../fold";
import { createHostPromptQueue, type HostPromptQueue } from "../prompt-queue";
import { testProviderNameFor } from "../provider-selection";
import { cloverSessions } from "../sessions";
import { NO_HOOKS, type HookSession, type TurnHooks } from "./hooks";
import { harnessPrompt, mcpChangesSince, mcpFingerprint, type PromptComputer, type PromptMcpServer } from "./prompt";
import { coreToolsServer, routedMcpServer, type BotMcpServer, type CallIds, type CoreToolDef, type McpRunner } from "./servers";
import { formatTurnInput } from "./input";
import { GLOSSARY_TOOL_NAME, glossaryTool, type GlossaryDeps } from "./glossary";

/** The runtime's built-in tools a bot's session is offered (spec §6.7). The runtime's own `SendMessage`, `ListAgents`,
 *  `TaskStop` and `Agent` are not: the core's take those names. Nor are `Skill` and `ToolSearch` (retired for
 *  `Glossary`), `NotebookEdit`, worktrees and plan mode (the coding agents'), or the web tools (the web plugin's). */
export const BOT_BUILTIN_TOOLS: readonly string[] = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep", "AskUserQuestion",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "Monitor",
  "ListMcpResourcesTool", "ReadMcpResourceTool",
  ...(process.platform === "win32" ? ["PowerShell"] : []),
];

/** The built-ins that start on-demand (§6.7 [D]), with what `Glossary` says of them. */
export const ON_DEMAND_BUILTINS: readonly { name: string; description: string }[] = [
  { name: "Glob", description: "Find files by name pattern (\"**/*.ts\"), anywhere in the folder tree; the search runs on the computer that holds the files." },
  { name: "Grep", description: "Search file contents with a regular expression, anywhere in the folder tree; the search runs on the computer that holds the files." },
];

/** The fields every hook and tool hook sees of a tool call. */
interface ToolUseInput { tool_name?: string; tool_input?: unknown; tool_use_id?: string; tool_response?: unknown }

export interface BotDriverDeps {
  /** The Clover home: the runtime's own home (`CLOVER_HOME`), its transcripts and this driver's state. */
  home: string;
  profile?: string;
  /** The embedded runtime's spawn hook (`createEmbeddedSessionHost().spawn`). */
  spawn: SpawnClaudeCodeProcess;
  /** Test seam: the agent SDK's `query`. */
  query?: typeof sdkQuery;
  /** The approval check for a session's tool calls (lanes B and C's broker, through the approval bridge). */
  canUseTool(ctx: BotSessionContext, origin: () => TurnOrigin | undefined): CanUseTool;
  /** The core tools the session gets: lane D's `SendMessage` and `ListAgents` (`BotSide.tools`), lane K's `Agent` and
   *  `TaskStop` (`agentToolDefs`), and `Glossary`. Read at each build. */
  coreTools?(ctx: BotSessionContext, origin: () => TurnOrigin | undefined): readonly CoreToolDef[];
  /** The plugins' MCP servers for this session (lanes B and D's host, J's placement), and lane J's router
   *  (`ComputerNode.mcp`), which runs each call where its server is. */
  mcp?: { servers(ctx: BotSessionContext): readonly BotMcpServer[]; runner: McpRunner };
  /** Lane J's holds (`ComputerNode.holds`): the session lets go of them at each turn's end. */
  holds?: { releaseSession(session: string): Promise<number> | number };
  /** Lane J's terminals (`ComputerNode.terminals`): the session's close at its end. */
  terminals?: { closeSession(session: string): Promise<number> | number };
  /** The plugin registry, for `Glossary`'s skills, agent definitions, plugins and points. */
  registry?: GlossaryDeps["registry"];
  /** The plugins' hooks (`pluginHooks`); none without it. */
  hooks?: TurnHooks;
  /** The computers for the devices block (lane J's registry). */
  computers?(): readonly PromptComputer[];
  /** The lease epoch the calls are made under (§6.4); 0 outside a lease. */
  epoch?(): number;
  /** Fills what a real model needs (the provider, the credential broker, the model plugins' adapters) into a
   *  session's options; the daemon's. A `winter-test/*` model needs nothing. */
  provider?(model: string, options: Options, ctx: BotSessionContext): void | Promise<void>;
  /** The Bash sandbox; the runtime's default floor when left out. */
  sandbox?(ctx: BotSessionContext): SandboxSettingsConfig | undefined;
  /** Extra environment for the runtime (never secrets). */
  env?: Record<string, string>;
  /** How long `stop` waits for the runtime to end. */
  stopGraceMs?: number;
  log?(line: string): void;
}

/** The persisted half of a session's runtime: the transcript's id. */
interface DriverState { backendSessionId: string }

/** One running host turn. */
interface RunningTurn {
  ctl: TurnControl;
  /** Pushes not yet answered: the first, and each one folded in that the runtime hasn't taken. */
  owed: number;
  /** What was pushed to fold in and not yet taken, oldest first. */
  unfolded: string[];
  usage: { inputTokens: number; outputTokens: number; contextTokens?: number };
  text?: string;
  interrupted: boolean;
  offFold: Unsubscribe;
  offAbort: () => void;
  /** The last record a `message.out` hook holds back; the turn ends after it. */
  pending?: Promise<void>;
  finish(end: TurnEnd): void;
  ended: boolean;
}

interface Incarnation {
  query: Query;
  queue: HostPromptQueue;
  abort: AbortController;
  projector: Projector;
  pump: Promise<void>;
  closed: boolean;
}

/** The events the host projects itself; the runtime's echoes of them are dropped. */
const HOST_OWNED = new Set(["user_message", "turn_started", "turn_completed"]);

/** Servers that share a name prefix (the bundled tree's children all read `mcp__clover__…`: the browser's, the web
 *  plugin's) are one server to the runtime, with every tool; a tool name two of them give keeps the first, by plugin
 *  id, as the registry keeps a name (§6.7 "Tool names are unique"). */
export function mergedServers(servers: readonly BotMcpServer[]): BotMcpServer[] {
  const out = new Map<string, BotMcpServer>();
  for (const s of [...servers].sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0))) {
    const had = out.get(s.server);
    if (had === undefined) {
      out.set(s.server, { ...s, tools: [...s.tools] });
      continue;
    }
    const names = new Set(had.tools.map((t) => t.name));
    out.set(s.server, { ...had, tools: [...had.tools, ...s.tools.filter((t) => !names.has(t.name))] });
  }
  return [...out.values()];
}

/** A uuid from a session id: the runtime keys its transcript by a uuid. */
function backendIdFor(): string {
  return crypto.randomUUID();
}

export class BotSessionDriver implements SessionDriver {
  readonly canFold = true;
  readonly #ctx: BotSessionContext;
  readonly #d: BotDriverDeps;
  readonly #log: (line: string) => void;
  readonly #statePath: string;
  #state: DriverState | undefined;
  #inc: Incarnation | undefined;
  #generation = 0;
  #rebuild = true;
  #builtMcp: Map<string, string> = new Map();
  #turn: RunningTurn | undefined;
  #origin: TurnOrigin | undefined;
  /** Pushes an interrupt cleared, carried into the next turn ahead of its message. */
  #carry: string[] = [];
  #stopped = false;
  /** The records a `message.out` hook holds back, in order. */
  #recordChain: Promise<void> = Promise.resolve();
  /** The ids of the tool calls starting, by `mcp__<server>__<tool>`, oldest first (`CallIds`). */
  readonly #callIds = new Map<string, string[]>();

  constructor(ctx: BotSessionContext, deps: BotDriverDeps) {
    this.#ctx = ctx;
    this.#d = deps;
    this.#log = deps.log ?? (() => {});
    this.#statePath = join(deps.home, "sessions-runtime", `${ctx.sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  get #hookSession(): HookSession {
    return { id: this.#ctx.sessionId, kind: this.#ctx.kind, caller: this.#ctx.caller, bot: this.#ctx.botId, computer: this.#ctx.computer };
  }

  get #hooks(): TurnHooks {
    return this.#d.hooks ?? NO_HOOKS;
  }

  #readState(): DriverState {
    if (this.#state !== undefined) return this.#state;
    try {
      const raw = JSON.parse(readFileSync(this.#statePath, "utf8")) as Partial<DriverState>;
      if (typeof raw.backendSessionId === "string" && /^[0-9a-f-]{36}$/.test(raw.backendSessionId)) return (this.#state = { backendSessionId: raw.backendSessionId });
    } catch {
      // none yet
    }
    const state = { backendSessionId: backendIdFor() };
    mkdirSync(join(this.#d.home, "sessions-runtime"), { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.#statePath, state);
    return (this.#state = state);
  }

  async #hasTranscript(id: string): Promise<boolean> {
    try {
      await cloverSessions(this.#d.home).getSessionInfo(id);
      return true;
    } catch {
      return false;
    }
  }

  #mcpServers(): readonly BotMcpServer[] {
    try {
      return this.#d.mcp?.servers(this.#ctx) ?? [];
    } catch (err) {
      this.#log(`bot driver ${this.#ctx.sessionId}: listing MCP servers failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  #promptServers(servers: readonly BotMcpServer[]): PromptMcpServer[] {
    return servers.map((s) => ({
      plugin: s.plugin, server: s.server,
      ...(s.instructions === undefined ? {} : { instructions: s.instructions }),
      ...(s.computers === undefined ? {} : { computers: s.computers }),
      ...(s.reachable === undefined ? {} : { reachable: s.reachable }),
    }));
  }

  /** The tool hooks: the pause and the lease first, then the plugins' `tool.before`; `tool.after` after the call. */
  #toolHooks(): Partial<Record<"PreToolUse" | "PostToolUse", HookCallbackMatcher[]>> {
    const pre: HookCallbackMatcher = {
      // A hook that breaks must never wave the call through.
      failClosed: true,
      timeout: 3600,
      hooks: [async (raw, toolUseId, { signal }) => {
        const input = raw as ToolUseInput;
        const name = input.tool_name ?? "";
        const callId = input.tool_use_id ?? toolUseId ?? "";
        if (!this.#ctx.mayAct()) {
          try {
            await this.#ctx.whenMayAct(AbortSignal.any([signal, ...(this.#turn ? [this.#turn.ctl.signal] : [])]));
          } catch {
            return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Stopped: this computer may not act for the bot now (the user paused bots, or another computer runs them)." } };
          }
        }
        if (!this.#ctx.mayAct()) {
          return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Stopped: this computer no longer runs the bot." } };
        }
        if (name.startsWith("mcp__")) {
          const q = this.#callIds.get(name) ?? [];
          q.push(callId);
          this.#callIds.set(name, q);
        }
        const r = await this.#hooks.toolBefore(this.#hookSession, { name, callId }, input.tool_input, signal);
        if (r.deny !== undefined) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: r.deny } };
        const changed = r.input !== input.tool_input && r.input !== null && typeof r.input === "object" && !Array.isArray(r.input);
        if (r.ask !== undefined || changed) {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              ...(r.ask !== undefined ? { permissionDecision: "ask" as const, permissionDecisionReason: r.ask } : {}),
              ...(changed ? { updatedInput: r.input as Record<string, unknown> } : {}),
            },
          };
        }
        return {};
      }],
    };
    const post: HookCallbackMatcher = {
      timeout: 600,
      hooks: [async (raw, toolUseId, { signal }) => {
        const input = raw as ToolUseInput;
        const name = input.tool_name ?? "";
        const result = await this.#hooks.toolAfter(this.#hookSession, { name, callId: input.tool_use_id ?? toolUseId ?? "" }, input.tool_input, input.tool_response, signal);
        if (result === input.tool_response) return {};
        return { hookSpecificOutput: { hookEventName: "PostToolUse", ...(name.startsWith("mcp__") ? { updatedMCPToolOutput: result } : { updatedToolOutput: result }) } };
      }],
    };
    return { PreToolUse: [pre], PostToolUse: [post] };
  }

  readonly #callIdSource: CallIds = {
    take: (server, tool) => {
      const q = this.#callIds.get(`mcp__${server}__${tool}`);
      return q?.shift();
    },
  };

  async #open(): Promise<Incarnation> {
    const ctx = this.#ctx;
    const bot = ctx.current();
    const state = this.#readState();
    const resume = await this.#hasTranscript(state.backendSessionId);
    const servers = this.#mcpServers();
    const promptServers = this.#promptServers(servers);
    const systemPrompt = harnessPrompt({
      bot: { id: bot.id, name: typeof bot.name === "string" ? bot.name : (bot.name as { en: string }).en, instructions: bot.instructions },
      kind: ctx.kind, computer: ctx.computer, memory: ctx.memoryBlock(),
      ...(this.#d.computers === undefined ? {} : { computers: this.#d.computers() }),
      mcpServers: promptServers,
    });
    this.#builtMcp = mcpFingerprint(promptServers);
    const origin = () => this.#origin;
    const mcpServers: Record<string, McpServerConfig> = {};
    // The core tools, and `Glossary` over everything the session has (spec §6.8): it loads the on-demand tools.
    const others = (): readonly CoreToolDef[] => (this.#d.coreTools?.(ctx, origin) ?? []).filter((t) => t.name !== GLOSSARY_TOOL_NAME);
    const glossary = glossaryTool({
      tools: () => [...ON_DEMAND_BUILTINS, ...others(), ...this.#mcpServers().flatMap((s) => s.tools.map((t) => ({ name: `mcp__${s.server}__${t.name}`, ...(t.description === undefined ? {} : { description: t.description }), inputSchema: t.inputSchema })))],
      ...(this.#d.registry === undefined ? {} : { registry: this.#d.registry }),
    });
    mcpServers.clover_core = coreToolsServer(() => [...others(), glossary]);
    if (this.#d.mcp !== undefined) {
      for (const server of mergedServers(servers)) {
        if (server.server === "clover_core" || mcpServers[server.server] !== undefined) continue;
        mcpServers[server.server] = routedMcpServer({
          server, runner: this.#d.mcp.runner, session: ctx.sessionId, as: ctx.caller, callIds: this.#callIdSource,
          ...(this.#d.epoch === undefined ? {} : { epoch: () => this.#d.epoch!() }),
        });
      }
    }
    const cwd = ctx.paths.scratch;
    mkdirSync(cwd, { recursive: true });
    const queue = createHostPromptQueue();
    const abort = new AbortController();
    const testProvider = testProviderNameFor(bot.model);
    const env: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "LANG"] as const) {
      const v = process.env[key];
      if (typeof v === "string" && v !== "") env[key] = v;
    }
    Object.assign(env, this.#d.env);
    env.CLOVER_HOME = this.#d.home;
    env.CLOVER_PROFILE = this.#d.profile ?? "";
    if (testProvider !== undefined) env.WINTER_TEST_PROVIDER = testProvider;
    const sandbox = this.#d.sandbox?.(ctx);
    const options: Options = {
      brand: buildCoreBrand(undefined, this.#d.home),
      model: bot.model,
      ...(bot.effort === undefined ? {} : { effort: bot.effort as Options["effort"] }),
      cwd,
      env,
      systemPrompt,
      spawnClaudeCodeProcess: this.#d.spawn,
      tools: [...BOT_BUILTIN_TOOLS],
      // `Glossary` finds and loads what isn't loaded (the agent SDK's `hostToolSearch`); `Glob` and `Grep` start
      // on-demand (§6.7 [D]), as do plugin tools their manifest doesn't preload.
      // (agent SDK 0.0.67's option; spread untyped until core pins it)
      ...({ hostToolSearch: GLOSSARY_TOOL_NAME } as {}),
      toolSearchEnabled: true,
      deferTools: ON_DEMAND_BUILTINS.map((t) => t.name),
      settingSources: [],
      mcpServers,
      canUseTool: this.#d.canUseTool(ctx, origin),
      hooks: this.#toolHooks(),
      permissionMode: "default",
      abortController: abort,
      includePartialMessages: true,
      stderr: (chunk) => this.#log(`bot driver ${ctx.sessionId}: runtime: ${chunk.trimEnd()}`),
      additionalDirectories: [ctx.paths.root],
      ...(sandbox === undefined ? {} : { sandbox }),
      ...(resume ? { resume: state.backendSessionId } : { sessionId: state.backendSessionId }),
    };
    if (testProvider === undefined) await this.#d.provider?.(bot.model, options, ctx);
    const q = (this.#d.query ?? sdkQuery)({ prompt: queue, options });
    this.#generation += 1;
    let claimed = 0;
    const projector = createProjector({
      sessionId: ctx.sessionId, mode: "chat", generation: this.#generation, winterSessionId: ctx.sessionId, runtimeKind: "winter-agent",
      nextSeq: () => ++claimed,
      checkpoint: { begin: () => "begun", complete: () => undefined },
      now: () => new Date().toISOString(),
      log: { warn: (message, fields) => this.#log(`bot driver ${ctx.sessionId}: ${message} ${fields === undefined ? "" : JSON.stringify(fields)}`.trim()) },
    });
    const inc: Incarnation = { query: q, queue, abort, projector, pump: Promise.resolve(), closed: false };
    inc.pump = this.#pump(inc);
    this.#rebuild = false;
    return inc;
  }

  async #pump(inc: Incarnation): Promise<void> {
    try {
      for await (const msg of inc.query) this.#accept(inc, msg as Record<string, unknown>);
    } catch (err) {
      this.#log(`bot driver ${this.#ctx.sessionId}: the runtime ended: ${err instanceof Error ? err.message : String(err)}`);
      const t = this.#turn;
      if (t !== undefined && this.#inc === inc) {
        for (const e of inc.projector.acceptError(err).persist) this.#emit(e);
        t.finish({ reason: t.interrupted ? "interrupted" : "failed", failure: "crashed", text: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      inc.closed = true;
      if (this.#inc === inc) this.#inc = undefined;
      const t = this.#turn;
      if (t !== undefined && !t.ended) t.finish({ reason: t.interrupted ? "interrupted" : this.#stopped ? "stopped" : "failed", failure: "crashed", text: "the runtime ended during the turn" });
    }
  }

  #emit(event: { type: string; [k: string]: unknown }): void {
    if (HOST_OWNED.has(event.type)) return;
    const t = this.#turn;
    if (t === undefined || t.ended) return;
    // While a `message.out` hook is on, the bot's text shows only after it ran (§5.3): no streaming deltas, and each
    // record waits its turn behind the reply before it, so the log keeps the runtime's order.
    if (this.#hooks.rewritesReplies()) {
      if (event.type === "assistant_delta") return;
      const ctl = t.ctl;
      this.#recordChain = this.#recordChain.then(async () => {
        if (event.type === "assistant_message" && typeof event.text === "string") {
          const text = await this.#hooks.messageOut(this.#hookSession, event.text).catch(() => event.text as string);
          ctl.record({ ...event, text });
        } else ctl.record(event);
      });
      t.pending = this.#recordChain;
      return;
    }
    t.ctl.record(event);
  }

  #accept(inc: Incarnation, msg: Record<string, unknown>): void {
    const batch = inc.projector.accept(msg as never);
    const t = this.#turn;
    const main = !(typeof msg.parent_tool_use_id === "string" && msg.parent_tool_use_id.length > 0);
    // In-turn compaction: the runtime's own, when the context fills (§6.3).
    if (main && msg.type === "system" && msg.subtype === "status" && msg.status === "compacting") {
      this.#emit({ type: "compaction", phase: "started", reason: "full" });
      void this.#hooks.compactBefore(this.#hookSession).catch(() => {});
    }
    if (main && msg.type === "system" && msg.subtype === "compact_boundary") {
      this.#emit({ type: "compaction", phase: "ended", reason: "full" });
      this.#rebuild = true;
      void this.#hooks.compactAfter(this.#hookSession).catch(() => {});
    }
    for (const e of batch.broadcast) this.#emit(e as never);
    for (const e of batch.persist) this.#emit(e as never);
    if (t === undefined || t.ended) return;
    const folded = hostInputFoldedCount(msg);
    if (folded !== undefined) {
      const n = Math.min(folded, t.unfolded.length);
      t.unfolded.splice(0, n);
      t.owed -= n;
      return;
    }
    if (main && msg.type === "result") {
      const usage = msg.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
      t.usage.inputTokens += (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0);
      t.usage.outputTokens += usage?.output_tokens ?? 0;
      const ctxTokens = msg.context_tokens;
      if (typeof ctxTokens === "number" && Number.isInteger(ctxTokens) && ctxTokens > 0) t.usage.contextTokens = ctxTokens;
      if (typeof msg.result === "string") t.text = msg.result;
      t.owed -= 1;
      const interrupted = msg.interrupted === true || t.interrupted;
      // A push the runtime didn't fold runs as its next turn, which this host turn covers.
      if (!interrupted && t.owed > 0 && t.unfolded.length > 0) {
        t.unfolded.shift();
        return;
      }
      if (interrupted) {
        t.finish({ reason: "interrupted", usage: { ...t.usage }, ...(t.text === undefined ? {} : { text: t.text }) });
        return;
      }
      const terminal = msg.terminal_reason;
      const isError = msg.is_error === true || (typeof msg.subtype === "string" && msg.subtype.startsWith("error_"));
      if (terminal === "refusal") t.finish({ reason: "refusal", usage: { ...t.usage }, ...(t.text === undefined ? {} : { text: t.text }) });
      else if (isError) t.finish({ reason: "failed", failure: "error", usage: { ...t.usage }, text: typeof msg.result === "string" && msg.result !== "" ? msg.result : `the turn failed (${String(msg.subtype)})` });
      else t.finish({ reason: "end_turn", usage: { ...t.usage }, ...(t.text === undefined ? {} : { text: t.text }) });
    }
  }

  async #ensureOpen(): Promise<Incarnation> {
    const coldCache = (() => {
      try {
        return this.#ctx.cacheCold();
      } catch {
        return false;
      }
    })();
    if (this.#inc !== undefined && !this.#inc.closed && !this.#rebuild && !coldCache) return this.#inc;
    // A rebuild resumes the transcript under the new prompt; the old runtime ends first (one engine per transcript).
    if (this.#inc !== undefined) await this.#closeIncarnation(this.#inc);
    this.#inc = await this.#open();
    return this.#inc;
  }

  async #closeIncarnation(inc: Incarnation): Promise<void> {
    if (!inc.queue.closed) inc.queue.close();
    const grace = this.#d.stopGraceMs ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([inc.pump, new Promise<void>((r) => { timer = setTimeout(r, grace); })]);
    if (timer !== undefined) clearTimeout(timer);
    if (!inc.closed) {
      inc.abort.abort();
      await Promise.race([inc.pump, new Promise<void>((r) => setTimeout(r, 1_000))]);
    }
    if (this.#inc === inc) this.#inc = undefined;
  }

  #push(inc: Incarnation, text: string): void {
    for (const e of inc.projector.beginTurn({ text }).persist) this.#emit(e as never);
    inc.queue.push(text);
  }

  async turn(input: TurnInput, ctl: TurnControl): Promise<TurnEnd> {
    if (this.#stopped) return { reason: "stopped" };
    this.#origin = ctl.origin;
    const hs = this.#hookSession;
    let inc: Incarnation;
    try {
      inc = await this.#ensureOpen();
    } catch (err) {
      return { reason: "failed", failure: "error", text: `the runtime could not start: ${err instanceof Error ? err.message : String(err)}` };
    }
    const notes = await this.#hooks.turnStart(hs, ctl.signal).catch(() => []);
    const first = await this.#hooks.messageIn(hs, formatTurnInput(input, this.#ctx.kind), ctl.signal).catch(() => formatTurnInput(input, this.#ctx.kind));
    const mcpNote = mcpChangesSince(this.#builtMcp, this.#promptServers(this.#mcpServers()));
    if (mcpNote !== undefined) this.#builtMcp = mcpFingerprint(this.#promptServers(this.#mcpServers()));
    const carried = this.#carry.splice(0);
    const lead = [
      ...(mcpNote === undefined ? [] : [mcpNote]),
      ...notes.map((n) => formatTurnInput({ from: "note", label: n.label, text: n.text, by: { kind: "hook", pluginId: n.pluginId, hook: n.hook } }, this.#ctx.kind)),
      ...carried,
    ];
    const text = lead.length === 0 ? first : `${lead.join("\n\n")}\n\n${first}`;
    if (ctl.signal.aborted) return { reason: "interrupted" };
    const end = await new Promise<TurnEnd>((resolve) => {
      const t: RunningTurn = {
        ctl, owed: 1, unfolded: [], usage: { inputTokens: 0, outputTokens: 0 }, interrupted: false, ended: false,
        offFold: () => {}, offAbort: () => {},
        finish: (e) => {
          if (t.ended) return;
          t.ended = true;
          t.offFold();
          t.offAbort();
          if (this.#turn === t) this.#turn = undefined;
          resolve(e);
        },
      };
      this.#turn = t;
      const onAbort = () => void this.interrupt();
      ctl.signal.addEventListener("abort", onAbort, { once: true });
      t.offAbort = () => ctl.signal.removeEventListener("abort", onAbort);
      try {
        this.#push(inc, text);
      } catch (err) {
        t.finish({ reason: "failed", failure: "crashed", text: err instanceof Error ? err.message : String(err) });
        return;
      }
      t.offFold = ctl.onFold((folded) => {
        const raw = formatTurnInput(folded, this.#ctx.kind);
        void this.#hooks.messageIn(hs, raw, ctl.signal).catch(() => raw).then((tx) => {
          // Taken after the turn ended (a slow hook): it leads the next turn instead.
          if (t.ended || t.interrupted || this.#inc !== inc || inc.queue.closed) {
            this.#carry.push(tx);
            return;
          }
          t.owed += 1;
          t.unfolded.push(tx);
          this.#push(inc, tx);
        });
      });
    });
    // What a `message.out` hook held back is recorded before the turn ends.
    await this.#recordChain.catch(() => {});
    await this.#settleTurn(end);
    return end.text === undefined ? end : { ...end, text: await this.#hooks.messageOut(hs, end.text).catch(() => end.text!) };
  }

  async #settleTurn(end: TurnEnd): Promise<void> {
    const session = this.#ctx.sessionId;
    try {
      await this.#d.holds?.releaseSession(session);
    } catch (err) {
      this.#log(`bot driver ${session}: releasing holds failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.#hooks.turnEnd(this.#hookSession, end.text).catch(() => {});
    this.#callIds.clear();
  }

  async interrupt(): Promise<void> {
    const t = this.#turn;
    const inc = this.#inc;
    if (t === undefined || t.ended || inc === undefined) return;
    if (t.interrupted) return;
    t.interrupted = true;
    // What was pushed to fold and not yet taken is cleared from the runtime and leads the next turn (§6.4: other
    // bots' messages are never lost to the user's interrupt).
    if (t.unfolded.length > 0 && typeof inc.query.clearQueuedInput === "function") {
      try {
        const { cleared } = await inc.query.clearQueuedInput();
        const n = typeof cleared === "number" ? Math.min(cleared, t.unfolded.length) : 0;
        if (n > 0) this.#carry.push(...t.unfolded.splice(t.unfolded.length - n, n));
      } catch {
        // an older runtime: they run as its next turns, inside this one
      }
    }
    try {
      await inc.query.interrupt();
    } catch (err) {
      this.#log(`bot driver ${this.#ctx.sessionId}: interrupt failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async compact(req: { reason: "cache" | "full" | "user"; signal: AbortSignal }): Promise<{ compacted: boolean }> {
    if (this.#stopped || req.signal.aborted) return { compacted: false };
    const state = this.#readState();
    if (this.#inc === undefined && !(await this.#hasTranscript(state.backendSessionId))) return { compacted: false };
    const inc = await this.#ensureOpen();
    if (typeof inc.query.compact !== "function") return { compacted: false };
    await this.#hooks.compactBefore(this.#hookSession).catch(() => {});
    let off: (() => void) | undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      const on = () => resolve("aborted");
      req.signal.addEventListener("abort", on, { once: true });
      off = () => req.signal.removeEventListener("abort", on);
    });
    try {
      const r = await Promise.race([inc.query.compact().then(() => "done" as const), aborted]);
      if (r === "aborted") return { compacted: false };
    } catch (err) {
      this.#log(`bot driver ${this.#ctx.sessionId}: compaction failed: ${err instanceof Error ? err.message : String(err)}`);
      return { compacted: false };
    } finally {
      off?.();
    }
    // The harness blocks (the MCP block, the devices, the memory index, the instructions) rebuild at the next turn.
    this.#rebuild = true;
    await this.#hooks.compactAfter(this.#hookSession).catch(() => {});
    return { compacted: true };
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    await this.interrupt();
    const inc = this.#inc;
    if (inc !== undefined) await this.#closeIncarnation(inc);
    const session = this.#ctx.sessionId;
    for (const step of [() => this.#d.terminals?.closeSession(session), () => this.#d.holds?.releaseSession(session)]) {
      try {
        await step();
      } catch (err) {
        this.#log(`bot driver ${session}: ending failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Lets the runtime go without ending the session (a shutdown): it resumes with the next daemon. */
  async release(): Promise<void> {
    const inc = this.#inc;
    if (inc !== undefined) await this.#closeIncarnation(inc);
  }
}

/** Lane D's `DriverFactory` for bots and side threads. */
export function botDriverFactory(deps: BotDriverDeps): (ctx: BotSessionContext) => BotSessionDriver {
  return (ctx) => new BotSessionDriver(ctx, deps);
}

/** Whether the driver's state for a session exists (a test's check). */
export function botDriverStateExists(home: string, sessionId: string): boolean {
  return existsSync(join(home, "sessions-runtime", `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`));
}
