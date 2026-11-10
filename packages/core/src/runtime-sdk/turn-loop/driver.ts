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
// * **After each tool call** the next request waits while the pause holds (`PostToolUse`): the call is never cut off.
// * **Before each model turn** too (the runtime's `UserPromptSubmit`): a turn the runtime starts on its own, when a
//   background task finishes or is stopped and its notification comes in, waits while the pause holds the session, as
//   does an input about to fold in; the turn starts once the user resumes, and never on a computer that stopped
//   running the bot.
// * **The pause stops background work** (the owner's rule: the pause stops everything): once the switch says no, the
//   session's background shells and monitors are stopped through the runtime (`Query.stopTask`, by the host). Resuming
//   doesn't restart them; the runtime's own notification of each stop reaches the model once the user resumes.
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
import type { Os, TurnOrigin } from "@waifucave/clover-protocol";
import type { Unsubscribe } from "../../contracts/common";
import type { SessionDriver, TurnControl, TurnEnd, TurnInput } from "../../contracts/session-host";
import type { BotSessionContext } from "../../bots/service";
import { writeJsonAtomic } from "../../sessions/atomic-file";
import { createProjector, type Projector } from "../../projector";
import { hostInputFoldedCount } from "../fold";
import { createHostPromptQueue, type HostPromptQueue } from "../prompt-queue";
import { testProviderNameFor } from "../provider-selection";
import { cloverSessions } from "../sessions";
import { NO_HOOKS, type HookSession, type TurnHooks } from "./hooks";
import { harnessPrompt, mcpChangesSince, mcpFingerprint, type PromptComputer, type PromptMcpServer } from "./prompt";
import { coreToolsServer, routedMcpServer, type BotMcpServer, type CallIds, type CoreToolDef, type McpRunner } from "./servers";
import { formatTurnInput, TASK_NOTIFICATION_FRAME } from "./input";
import { embeddedSessionOptions, fillProvider } from "./embedded-session";
import { mergedHooks } from "./hook-merge";
import { NAMESPACE_RE } from "@waifucave/clover-plugin-sdk";
import { GLOSSARY_TOOL_NAME, glossaryTool, type GlossaryDeps } from "./glossary";
import { fenceSearchOutput, fileToolFenceRefusal, type FileFence } from "./file-fence";
import type { Fence } from "../../contracts/fence";

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

/** What every bot's and agent's sandbox is, whatever the host gives: on, no unsandboxed command (a call's
 *  `dangerouslyDisableSandbox` is refused), and the paths to launchd closed (F8). Bots, their side threads and routines,
 *  and in-process agents never run a command unsandboxed (the owner's ruling). */
export const BOT_SANDBOX = { enabled: true, allowUnsandboxedCommands: false, denyLaunchServices: true } as const;

/** The daemon's fence for a bot's own Read, Glob and Grep: lane C's fence as the session meets it (`forCaller`), so
 *  inside the Clover home only its own folders are readable (`fileToolFenceRefusal`). */
export function botFileFence(fence: Pick<Fence, "forCaller">, home: string, os?: Os): (ctx: BotSessionContext) => FileFence {
  return (ctx) => {
    const own = fence.forCaller(ctx.caller);
    return { check: (op) => own.check(op), home, ...(os === undefined ? {} : { os }) };
  };
}

export interface BotDriverDeps {
  /** The Clover home: this driver's state; the runtime's own home (`CLOVER_HOME`) and its transcripts are its store home under it (`storeHomeFor`). */
  home: string;
  profile?: string;
  /** The embedded runtime's spawn hook (`createEmbeddedSessionHost().spawn`). */
  spawn: SpawnClaudeCodeProcess;
  /** macOS: the process holder (`EmbeddedSessionDeps.processHolder`); default, the one beside the daemon. */
  processHolder?: string;
  /** Test seam: the agent SDK's `query`. */
  query?: typeof sdkQuery;
  /** The approval check for a session's tool calls (lanes B and C's broker, through the approval bridge). */
  canUseTool(ctx: BotSessionContext, origin: () => TurnOrigin | undefined): CanUseTool;
  /** The core tools the session gets: lane D's `SendMessage` and `ListAgents` (`BotSide.tools`), lane K's `Agent` and
   *  `TaskStop` (`agentToolDefs`), and `Glossary`. Read at each build. */
  coreTools?(ctx: BotSessionContext, origin: () => TurnOrigin | undefined): readonly CoreToolDef[];
  /** The plugins' MCP servers for this session (lanes B and D's host, J's placement), and lane J's router
   *  (`ComputerNode.mcp`), which runs each call where its server is. */
  /** `settled`: waits (briefly) for the first listing of a server just installed or enabled, so the turn that starts
   *  right after sees its tools (`PluginMcp.settled`). */
  mcp?: { servers(ctx: BotSessionContext): readonly BotMcpServer[]; runner: McpRunner; settled?(): Promise<void> };
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
  /** The Bash sandbox; the runtime's default floor when left out. Whatever it says, a bot's commands run sandboxed
   *  (`BOT_SANDBOX`). */
  sandbox?(ctx: BotSessionContext): SandboxSettingsConfig | undefined;
  /** The fence for the session's own Read, Glob and Grep (`fileToolFenceRefusal`): the Clover home's default-deny, as
   *  its Bash meets it in `sandbox`. None without it. */
  fileFence?(ctx: BotSessionContext): FileFence | undefined;
  /** Extra environment for the runtime (never secrets). */
  env?: Record<string, string>;
  /** How long `stop` waits for the runtime to end. */
  stopGraceMs?: number;
  /** How often a session with background tasks looks at the pause (`PAUSE_POLL_MS`); a test's seam. */
  pausePollMs?: number;
  /** How long a tool call waits for the pause to lift before it's refused (`TOOL_HOLD_MS`); a test's seam. */
  toolHoldMs?: number;
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
  /** The text that started the turn: carried into the next one when an interrupt lands while the pause holds it. */
  first: string;
  /** Why the pause hold blocked the turn's start (the session ended, or the lease went): it ends `stopped`. */
  heldOff?: string;
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
  /** The runtime's background tasks (shells, monitors) still running, by task id. */
  tasks: Set<string>;
  /** Tasks that ended, in the runtime's order, not yet handed to the host (`#promptHold`, `ctx.wake`). */
  ended: TaskWake[];
  /** Wakes for the runtime's own turns `#promptHold` ended: each goes to the host once that turn's result is in, so
   *  the turn the host starts never takes the ended one's result for its own. */
  wakes: TaskWake[];
  /** Task ids a stop is under way for. */
  stopping: Set<string>;
  /** Looks at the pause while `tasks` isn't empty. */
  taskWatch?: ReturnType<typeof setInterval>;
}

/** A background task of the session's runtime that ended (lane D's `BotSessionContext.wake`). */
export interface TaskWake {
  task: string;
  /** How it ended; `event` for a monitor's event, the task still running. */
  status: "completed" | "failed" | "stopped" | "event";
  text: string;
}

/** The wake for the runtime's own turn: the ended task its notification names (by `<task-id>`), else read from the
 *  notification itself (a monitor's event has no ending of its own). Never another task's. */
function wakeFor(prompt: string, ended: TaskWake[]): TaskWake {
  const field = (tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(prompt)?.[1];
  const id = field("task-id");
  if (id !== undefined) {
    const i = ended.findIndex((e) => e.task === id);
    if (i >= 0) return ended.splice(i, 1)[0]!;
  }
  const raw = field("status");
  const status: TaskWake["status"] = raw === "failed" ? "failed" : raw === "stopped" || raw === "killed" ? "stopped" : raw === "completed" ? "completed" : "event";
  const event = /<event>([\s\S]*?)<\/event>/.exec(prompt)?.[1];
  const text = [field("summary"), event].filter((x): x is string => x !== undefined && x !== "").join("\n");
  return { task: id ?? "unknown", status, text: text !== "" ? text : prompt };
}

/** The session's context, with lane D's `wake` where the host has it: the runtime's own notification turn is handed to
 *  the host as input instead of running unseen. */
type WakeContext = BotSessionContext & { wake?(w: TaskWake): unknown };

/** How long the tool hook may run (seconds): a call the pause holds waits inside it (`TOOL_HOLD_MS`). */
const TOOL_HOOK_TIMEOUT_S = 3600;
/** How long a tool call waits for the pause to lift before it's refused, saying why (a minute inside the hook's hour). */
const TOOL_HOLD_MS = (TOOL_HOOK_TIMEOUT_S - 60) * 1000;

/** Whether `stopTask` failed because the runtime has no such task (it ended, or isn't this session's). */
export function isUnknownTask(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "unknown_task" || (err instanceof Error && /unknown_task/.test(err.message));
}

/** How often a session with background tasks looks at the pause switch (it has no event for it). */
const PAUSE_POLL_MS = 1_000;

/** The events the host projects itself; the runtime's echoes of them are dropped. */
const HOST_OWNED = new Set(["user_message", "turn_started", "turn_completed"]);

/** How long the runtime lets the model-turn hold run (seconds): the longest a timer can wait, about 24.8 days. A pause
 *  that outlasts it ends the held turn blocked, never started. */
const PROMPT_HOLD_TIMEOUT_S = Math.floor(2_147_483_647 / 1000);

/** A plugin id's top-level tree (`clover` for `clover/web`). */
const top = (id: string) => (id.includes("/") ? id.slice(0, id.indexOf("/")) : id);

/** Names no tree but their own may take, installed or not: the bundled tree's. */
export const RESERVED_SERVER_NAMES: readonly string[] = ["clover"];

/** Servers that share a name prefix (the bundled tree's children all read `mcp__clover__…`: the browser's, the web
 *  plugin's) are one server to the runtime, with every tool; a tool name two of them give keeps the first, by plugin
 *  id, as the registry keeps a name (§6.7 "Tool names are unique"). Only one plugin tree may hold a name (§6.7: one
 *  enabled plugin per namespace): the name belongs to the plugin tree whose top-level id it is (`clover` for
 *  `mcp__clover__…`), else to the first tree by plugin id; a server of any other tree under it is left out, never merged
 *  in (`onRefused`), so no plugin can slip its tools under another's name. */
export function mergedServers(servers: readonly BotMcpServer[], onRefused?: (s: BotMcpServer, holder: string) => void, reserved: Iterable<string> | ReadonlyMap<string, string> = RESERVED_SERVER_NAMES): BotMcpServer[] {
  const sorted = [...servers].sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0));
  // Who holds each name, compared without case: an installed tree's namespace is its own even when it gives no server
  // (`reserved`: name → the tree's top-level id; a plain name is its own tree's), else the tree whose top-level id is
  // the name (`clover` holds `mcp__clover__…`), else the first by plugin id.
  const holder = new Map<string, string>();
  for (const entry of reserved) {
    const [name, tree] = typeof entry === "string" ? [entry, entry] : entry;
    // The first claim holds: `clover` stays the bundled tree's whatever another tree's id or namespace spells.
    if (!holder.has(name.toLowerCase())) holder.set(name.toLowerCase(), tree);
  }
  const fixed = new Set(holder.keys());
  for (const s of sorted) {
    const key = s.server.toLowerCase();
    if (fixed.has(key)) continue;
    const h = holder.get(key);
    if (h === undefined || (top(s.plugin).toLowerCase() === key && h.toLowerCase() !== key)) holder.set(key, top(s.plugin));
  }
  const out = new Map<string, BotMcpServer>();
  for (const s of sorted) {
    // A server name is a namespace (lane B's wire name): lower-case letters and digits, joined by single hyphens.
    if (!NAMESPACE_RE.test(s.server)) {
      onRefused?.(s, "no one (the name isn't a namespace)");
      continue;
    }
    const h = holder.get(s.server.toLowerCase())!;
    if (top(s.plugin) !== h) {
      onRefused?.(s, h);
      continue;
    }
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

/** The servers `mergedServers` keeps, each as its plugin gave it (for the prompt, which lists every server's text). */
export function keptServers(servers: readonly BotMcpServer[], reserved: Iterable<string> | ReadonlyMap<string, string> = RESERVED_SERVER_NAMES): BotMcpServer[] {
  const refused = new Set<BotMcpServer>();
  mergedServers(servers, (r) => refused.add(r), reserved);
  return servers.filter((s) => !refused.has(s));
}

/** A uuid from a session id: the runtime keys its transcript by a uuid. */
function backendIdFor(): string {
  return crypto.randomUUID();
}

export class BotSessionDriver implements SessionDriver {
  readonly canFold = true;
  readonly #ctx: BotSessionContext;
  readonly #fileFence: FileFence | undefined;
  readonly #d: BotDriverDeps;
  readonly #log: (line: string) => void;
  readonly #statePath: string;
  #state: DriverState | undefined;
  #inc: Incarnation | undefined;
  #generation = 0;
  #rebuild = true;
  /** The sandbox the open runtime was given (canonical JSON): the agent SDK takes `sandbox` only when a runtime opens,
   *  so each turn start compares the host's sandbox now with it and reopens on a difference (`#sandboxChanged`). */
  #builtSandbox: string | undefined;
  /** The model and effort the open runtime was given: a pick in the bot's user layer reopens it before the next turn. */
  #builtModel: string | undefined;
  /** The MCP servers the open runtime was given, by name: the agent SDK takes `mcpServers` only when a runtime opens,
   *  so a server a plugin adds (an install, an enable) or takes away since reopens it at the next turn start
   *  (`#serversChanged`). A server whose tools change keeps the runtime and is told in the turn (`mcpChangesSince`). */
  #builtServers: string | undefined;
  #builtMcp: Map<string, string> = new Map();
  #turn: RunningTurn | undefined;
  #origin: TurnOrigin | undefined;
  /** Pushes an interrupt cleared, carried into the next turn ahead of its message. */
  #carry: string[] = [];
  #stopped = false;
  /** Model turns the pause holds at their start (`#promptHold`), and what let each go other than the resume. */
  readonly #promptHolds = new Set<{ release: AbortController; why?: "interrupt" | "closing" }>();
  /** The records a `message.out` hook holds back, in order. */
  #recordChain: Promise<void> = Promise.resolve();
  /** The ids of the tool calls starting, by `mcp__<server>__<tool>`, oldest first (`CallIds`). */
  readonly #callIds = new Map<string, string[]>();

  constructor(ctx: BotSessionContext, deps: BotDriverDeps) {
    this.#ctx = ctx;
    this.#d = deps;
    this.#fileFence = deps.fileFence?.(ctx);
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

  /** Every installed tree's namespace (the registry's, lane B's wire name), and the bundled tree's: names only that
   *  tree's servers may take, by name → the tree's top-level id. */
  #reservedNames(): Map<string, string> {
    const names = new Map<string, string>(RESERVED_SERVER_NAMES.map((n) => [n, n]));
    try {
      for (const p of this.#d.registry?.list() ?? []) {
        const ns = typeof p.namespace === "string" && p.namespace !== "" ? p.namespace.toLowerCase() : top(p.id).toLowerCase();
        if (!names.has(ns)) names.set(ns, top(p.id));
      }
    } catch {
      // a registry that can't list: the bundled tree's name still holds
    }
    return names;
  }

  #promptServers(servers: readonly BotMcpServer[]): PromptMcpServer[] {
    return servers.map((s) => ({
      plugin: s.plugin, server: s.server,
      ...(s.instructions === undefined ? {} : { instructions: s.instructions }),
      ...(s.computers === undefined ? {} : { computers: s.computers }),
      ...(s.reachable === undefined ? {} : { reachable: s.reachable }),
    }));
  }

  /** The pause and the lease (§6.4, §9.2): undefined when the session may act now, after waiting while the pause
   *  switch holds it; otherwise why the call is refused (the lease went elsewhere, or the turn ended). */
  async #gate(signal: AbortSignal): Promise<string | undefined> {
    if (!this.#ctx.mayAct()) {
      // Held at most `TOOL_HOLD_MS`, inside the tool hook's own hour: past it the call is refused, saying why.
      const limit = new AbortController();
      const timer = setTimeout(() => limit.abort(), this.#d.toolHoldMs ?? TOOL_HOLD_MS);
      try {
        await this.#ctx.whenMayAct(AbortSignal.any([signal, limit.signal, ...(this.#turn ? [this.#turn.ctl.signal] : [])]));
      } catch {
        if (limit.signal.aborted && !signal.aborted) {
          return "Not run: the user paused the bots and the pause outlasted how long a call can wait (an hour). Nothing was done; try the call again once the bots are resumed.";
        }
        return "Stopped: this computer may not act for the bot now (the user paused bots, or another computer runs them).";
      } finally {
        clearTimeout(timer);
      }
    }
    return this.#ctx.mayAct() ? undefined : "Stopped: this computer no longer runs the bot.";
  }

  /** A queued MCP call id the runtime won't use: its call was refused or failed before it reached the router. */
  #dropCallId(name: string, id: string | undefined): void {
    if (id === undefined || !name.startsWith("mcp__")) return;
    const q = this.#callIds.get(name);
    const i = q?.indexOf(id) ?? -1;
    if (q !== undefined && i >= 0) q.splice(i, 1);
  }

  /** The approval check, then the pause and the lease again (review B1): the switch may have come on, or the lease
   *  gone, while the card was open, and an allow given then must not run the call. */
  #gatedCanUseTool(inner: CanUseTool): CanUseTool {
    return async (name, input, opts) => {
      const r = await inner(name, input, opts);
      if (r === null || r.behavior !== "allow") {
        this.#dropCallId(name, opts.toolUseID);
        return r;
      }
      const stop = await this.#gate(opts.signal);
      if (stop === undefined) return r;
      this.#dropCallId(name, opts.toolUseID);
      return { behavior: "deny", message: stop };
    };
  }

  #releasePromptHolds(why: "interrupt" | "closing"): void {
    for (const h of this.#promptHolds) {
      h.why ??= why;
      h.release.abort();
    }
  }

  /** The pause at a model turn's start (§9.2: a paused bot starts no model turn). The runtime runs `UserPromptSubmit`
   *  before every turn's first request, its own included (a background task's notification starts one when the task
   *  finishes or is stopped, with no host turn asking), and before an input folds in. While the pause holds the
   *  session it waits; resumed, the turn goes on. The user's interrupt, the session's end and a lease that went
   *  elsewhere let it go blocked instead, so no request goes out; an interrupted turn's text leads the next turn. */
  #promptHold(): HookCallbackMatcher {
    return {
      timeout: PROMPT_HOLD_TIMEOUT_S,
      hooks: [async (raw, _id, { signal }) => {
        // A turn no host turn covers (the runtime's own) asks what a host turn asked before it started: `mayStart`,
        // no while paused, or while this computer isn't the runner or hands its bots back. One the host started, and
        // an input folding into it, ask `mayAct`: a hand-back lets the running turn finish.
        const own = this.#turn === undefined || this.#turn.ended;
        const ctx = this.#ctx as WakeContext;
        // A turn of the runtime's own, where the host takes wakes (lane D): it ends here before any request, and the
        // notification goes to the host, which folds it into a running turn or starts one (through its `mayStart`) that
        // reaches this driver as any turn does, logged, its usage counted.
        if (own && typeof ctx.wake === "function") {
          const inc = this.#inc;
          const prompt = (raw as { prompt?: unknown }).prompt;
          // Matched by the task id its notification names: a notification taken inside a host turn leaves an entry
          // behind (bounded), which no later wake takes for its own.
          const w = wakeFor(typeof prompt === "string" ? prompt : "", inc?.ended ?? []);
          inc?.wakes.push(w);
          return { decision: "block" as const, reason: "Handed to the host as a background task's input." };
        }
        const may = own && ctx.mayStart !== undefined && ctx.whenMayStart !== undefined
          ? { now: () => ctx.mayStart!(), when: (sig: AbortSignal) => ctx.whenMayStart!(sig) }
          : { now: () => ctx.mayAct(), when: (sig: AbortSignal) => ctx.whenMayAct(sig) };
        if (may.now()) return {};
        const hold: { release: AbortController; why?: "interrupt" | "closing" } = { release: new AbortController() };
        this.#promptHolds.add(hold);
        try {
          await may.when(AbortSignal.any([signal, hold.release.signal]));
        } catch {
          // let go, timed out, or the lease went elsewhere: decided below
        } finally {
          this.#promptHolds.delete(hold);
        }
        if (hold.why === undefined && !signal.aborted && !this.#stopped && may.now()) return {};
        const t = this.#turn;
        const prompt = (raw as { prompt?: unknown }).prompt;
        const reason = hold.why === "interrupt" ? "Interrupted while the bots were paused."
          : hold.why === "closing" || this.#stopped ? "The session ended while the bots were paused."
            : signal.aborted ? "The bots stayed paused too long." : "Stopped: this computer no longer runs the bot.";
        if (t !== undefined && typeof prompt === "string" && prompt === t.first) {
          if (hold.why === "interrupt") this.#carry.push(prompt);
          else t.heldOff = reason;
        }
        return { decision: "block" as const, reason };
      }],
    };
  }

  /** Why the fence refuses one of the session's own file tool calls (`fileToolFenceRefusal`), or undefined. */
  #fileFenceRefusal(input: ToolUseInput): string | undefined {
    if (this.#fileFence === undefined) return undefined;
    return fileToolFenceRefusal(input.tool_name ?? "", input.tool_input, this.#fileFence, this.#ctx.paths.scratch);
  }

  /** The pause and the lease once more, after every other `PreToolUse` hook (`mergedHooks`' trailing check). */
  #trailingGate(): HookCallbackMatcher {
    return {
      failClosed: true,
      timeout: TOOL_HOOK_TIMEOUT_S,
      hooks: [async (raw, _id, { signal }) => {
        const stop = await this.#gate(signal);
        if (stop !== undefined) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: stop } };
        // The fence again, on the input as the earlier hooks left it.
        const fenced = this.#fileFenceRefusal(raw as ToolUseInput);
        return fenced === undefined ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: fenced } };
      }],
    };
  }

  /** The tool hooks: the pause and the lease first, then the plugins' `tool.before`; `tool.after` after the call. */
  #toolHooks(): Partial<Record<"PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "UserPromptSubmit", HookCallbackMatcher[]>> {
    const pre: HookCallbackMatcher = {
      // A hook that breaks must never wave the call through.
      failClosed: true,
      timeout: TOOL_HOOK_TIMEOUT_S,
      hooks: [async (raw, toolUseId, { signal }) => {
        const input = raw as ToolUseInput;
        const name = input.tool_name ?? "";
        const callId = input.tool_use_id ?? toolUseId ?? "";
        const stop = await this.#gate(signal);
        if (stop !== undefined) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: stop } };
        const r = await this.#hooks.toolBefore(this.#hookSession, { name, callId }, input.tool_input, signal);
        if (r.deny !== undefined) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: r.deny } };
        // The plugins' hooks take time: the pause may have come on, or the lease gone, meanwhile. A call that asks no
        // one (a read-only tool) has no later check (`#gatedCanUseTool`), so the gate is asked again here.
        const after = await this.#gate(signal);
        if (after !== undefined) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: after } };
        // The Clover home's default-deny for the session's own file tools, on the input a plugin's hook may have changed.
        const changedInput = r.input !== input.tool_input && r.input !== null && typeof r.input === "object" && !Array.isArray(r.input);
        const fenced = this.#fileFenceRefusal({ tool_name: name, tool_input: changedInput ? r.input : input.tool_input });
        if (fenced !== undefined) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: fenced } };
        // The call id the router gets, queued only for a call that goes on; a refusal after this drops it
        // (`#gatedCanUseTool`, `PostToolUseFailure`), so the next call of the tool never takes a stale one (review S1).
        if (name.startsWith("mcp__") && callId !== "") {
          const q = this.#callIds.get(name) ?? [];
          q.push(callId);
          this.#callIds.set(name, q);
        }
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
        this.#dropCallId(name, input.tool_use_id ?? toolUseId);
        // A search's hits through a link out of the session's folders are dropped before anyone sees them, plugins too.
        const fenced = this.#fileFence === undefined ? undefined : fenceSearchOutput(name, input.tool_response, this.#fileFence, this.#ctx.paths.scratch);
        const result = await this.#hooks.toolAfter(this.#hookSession, { name, callId: input.tool_use_id ?? toolUseId ?? "" }, input.tool_input, fenced ?? input.tool_response, signal);
        if (result === input.tool_response) return {};
        return { hookSpecificOutput: { hookEventName: "PostToolUse", ...(name.startsWith("mcp__") ? { updatedMCPToolOutput: result } : { updatedToolOutput: result }) } };
      }],
    };
    const failed: HookCallbackMatcher = {
      hooks: [async (raw, toolUseId) => {
        const input = raw as ToolUseInput;
        this.#dropCallId(input.tool_name ?? "", input.tool_use_id ?? toolUseId);
        return {};
      }],
    };
    // After a call (done or failed), the next request waits while the pause holds: the call itself is never cut off,
    // and no model request goes out until the user resumes (the owner's rule: the pause stops everything).
    const after: HookCallbackMatcher = {
      timeout: TOOL_HOOK_TIMEOUT_S,
      hooks: [async (_raw, _id, { signal }) => {
        if (!this.#ctx.mayAct()) await this.#gate(signal);
        return {};
      }],
    };
    return { PreToolUse: [pre], PostToolUse: [post, after], PostToolUseFailure: [failed, after], UserPromptSubmit: [this.#promptHold()] };
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
    this.#builtModel = `${bot.model}\u0000${bot.effort ?? ""}`;
    const state = this.#readState();
    const resume = await this.#hasTranscript(state.backendSessionId);
    const all = this.#mcpServers();
    const refused = new Set<string>();
    const merged = mergedServers(all, (r, holder) => {
      refused.add(`${r.plugin}\u0000${r.server}`);
      this.#log(`bot driver ${ctx.sessionId}: ${r.plugin}'s MCP server ${r.server} is left out: ${holder} holds that name`);
    }, this.#reservedNames());
    const servers = all.filter((s) => !refused.has(`${s.plugin}\u0000${s.server}`));
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
      tools: () => [...ON_DEMAND_BUILTINS, ...others(), ...mergedServers(this.#mcpServers(), undefined, this.#reservedNames()).flatMap((s) => s.tools.map((t) => ({ name: `mcp__${s.server}__${t.name}`, ...(t.description === undefined ? {} : { description: t.description }), inputSchema: t.inputSchema })))],
      ...(this.#d.registry === undefined ? {} : { registry: this.#d.registry }),
    });
    mcpServers.clover_core = coreToolsServer(() => [...others(), glossary]);
    if (this.#d.mcp !== undefined) {
      for (const server of merged) {
        if (server.server === "clover_core" || mcpServers[server.server] !== undefined) continue;
        mcpServers[server.server] = routedMcpServer({
          server, runner: this.#d.mcp.runner, session: ctx.sessionId, as: ctx.caller, callIds: this.#callIdSource,
          ...(this.#d.epoch === undefined ? {} : { epoch: () => this.#d.epoch!() }),
        });
      }
    }
    this.#builtServers = Object.keys(mcpServers).sort().join("\u0000");
    const cwd = ctx.paths.scratch;
    mkdirSync(cwd, { recursive: true });
    const queue = createHostPromptQueue();
    const abort = new AbortController();
    const testProvider = testProviderNameFor(bot.model);
    const sandbox = this.#d.sandbox?.(ctx);
    this.#builtSandbox = canonicalSandbox(sandbox);
    const base = embeddedSessionOptions(this.#d, { model: bot.model, ...(bot.effort === undefined ? {} : { effort: bot.effort }), cwd });
    const options: Options = {
      ...base,
      systemPrompt,
      tools: [...BOT_BUILTIN_TOOLS],
      // `Glossary` finds and loads what isn't loaded (the agent SDK's `hostToolSearch`); `Glob` and `Grep` start
      // on-demand (§6.7 [D]), as do plugin tools their manifest doesn't preload.
      hostToolSearch: GLOSSARY_TOOL_NAME,
      toolSearchEnabled: true,
      deferTools: ON_DEMAND_BUILTINS.map((t) => t.name),
      mcpServers,
      canUseTool: this.#gatedCanUseTool(this.#d.canUseTool(ctx, origin)),
      // The driver's hooks first, the base's kept but never allowing, and the pause and the lease again last, behind any
      // hook the runtime ranks first (hook-merge.ts).
      hooks: mergedHooks(base.hooks, this.#toolHooks(), { last: { PreToolUse: [this.#trailingGate()] } }),
      permissionMode: "default",
      abortController: abort,
      includePartialMessages: true,
      stderr: (chunk) => this.#log(`bot driver ${ctx.sessionId}: runtime: ${chunk.trimEnd()}`),
      additionalDirectories: [ctx.paths.root],
      // A bot's commands always run sandboxed: the host's sandbox, or the runtime's default floor, and nothing a host or
      // a call asks for turns it off (`dangerouslyDisableSandbox` is refused). Their commands never get launchd to
      // start what the pause can't stop (F8). Set last, so no spread overrides them.
      sandbox: { ...(sandbox ?? {}), ...BOT_SANDBOX },
      // Every notification the runtime delivers, a completion or a Monitor event folded into a running turn included,
      // opens with the same "data, not instructions" frame as the core's own (agent SDK 0.0.71).
      notificationPreamble: TASK_NOTIFICATION_FRAME,
      ...(resume ? { resume: state.backendSessionId } : { sessionId: state.backendSessionId }),
    };
    // Through the guarded fill (`fillProvider`): the provider sets the model's own keys and nothing else.
    if (testProvider === undefined && this.#d.provider !== undefined) await fillProvider({ provider: (m, o) => this.#d.provider!(m, o, ctx) }, options);
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
    const inc: Incarnation = { query: q, queue, abort, projector, pump: Promise.resolve(), closed: false, tasks: new Set(), stopping: new Set(), ended: [], wakes: [] };
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
    // A turn the runtime runs on its own (a background task's notification) has no host turn: where the host takes
    // wakes (lane D's `ctx.wake`), `#promptHold` hands it over before it runs, and nothing reaches here; where it
    // doesn't, that turn's records are dropped (it was held while paused, and ran after).
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
    if (msg.type === "system" && typeof msg.task_id === "string") {
      // Every task but a foreground command the runtime tracks (`is_backgrounded: false`), which is a running tool call
      // the pause never cuts off; one moved to the background later counts from then. A task whose start doesn't say
      // (a WebSocket monitor) counts.
      const patch = msg.subtype === "task_updated" ? (msg.patch as { is_backgrounded?: unknown } | undefined) : undefined;
      if ((msg.subtype === "task_started" && msg.is_backgrounded !== false) || patch?.is_backgrounded === true) {
        inc.tasks.add(msg.task_id);
        this.#watchTasks(inc);
      } else if (msg.subtype === "task_notification") {
        inc.tasks.delete(msg.task_id);
        // Its notification reaches the model inside a running turn (after a tool round), or as a turn of the runtime's
        // own, which `#promptHold` hands to the host. Kept for that.
        const status = msg.status === "failed" || msg.status === "stopped" ? msg.status : "completed";
        const summary = typeof msg.summary === "string" ? msg.summary : `Background task ${msg.task_id} ${status}.`;
        const out = typeof msg.output_file === "string" ? `\nIts output: ${msg.output_file}` : "";
        inc.ended.push({ task: msg.task_id, status, text: `${summary}${out}` });
        if (inc.ended.length > 64) inc.ended.splice(0, inc.ended.length - 64);
      }
    }
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
    // The runtime's own turn `#promptHold` ended for the host: its wake goes now, and its result is no host turn's.
    if (main && msg.type === "result" && msg.terminal_reason === "hook_stopped" && inc.wakes.length > 0) {
      const w = inc.wakes.shift()!;
      const ctx = this.#ctx as WakeContext;
      void Promise.resolve().then(() => ctx.wake?.(w)).catch((err: unknown) => this.#log(`bot driver ${ctx.sessionId}: the host refused a background task's wake: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    // A turn the runtime ran on its own (a background task's notification), with no host turn: its holds on the
    // computers' screens go at its end too.
    if (main && msg.type === "result" && (t === undefined || t.ended)) {
      void Promise.resolve().then(() => this.#d.holds?.releaseSession(this.#ctx.sessionId)).catch((err: unknown) => this.#log(`bot driver ${this.#ctx.sessionId}: releasing holds failed: ${err instanceof Error ? err.message : String(err)}`));
    }
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
      if (terminal === "hook_stopped" && t.heldOff !== undefined) {
        t.finish({ reason: "stopped", text: t.heldOff });
        return;
      }
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
    if (this.#inc !== undefined && !this.#inc.closed && !this.#rebuild && !coldCache && !this.#sandboxChanged() && !this.#serversChanged() && !this.#modelChanged()) return this.#inc;
    // A rebuild resumes the transcript under the new prompt; the old runtime ends first (one engine per transcript).
    if (this.#inc !== undefined) await this.#closeIncarnation(this.#inc);
    this.#inc = await this.#open();
    return this.#inc;
  }

  /** Whether the host's sandbox for this session differs from what the open runtime got (a folder the fence names was
   *  made or went, a policy changed): the runtime then reopens before the turn, resuming its transcript. A host whose
   *  sandbox can't be read now reopens too, so the open surfaces the error rather than a stale sandbox running on. */
  #serversChanged(): boolean {
    if (this.#d.mcp === undefined || this.#builtServers === undefined) return false;
    let now: string;
    try {
      now = ["clover_core", ...mergedServers(this.#mcpServers(), undefined, this.#reservedNames()).map((x) => x.server).filter((n) => n !== "clover_core")].sort().join("\u0000");
    } catch {
      return false;
    }
    if (now === this.#builtServers) return false;
    this.#log(`bot driver ${this.#ctx.sessionId}: reopening: its MCP servers changed`);
    return true;
  }

  /** Whether the bot's model or effort is not what the open runtime got (the user picked another): the runtime then reopens
   *  before the turn, resuming its transcript on the picked model. */
  #modelChanged(): boolean {
    if (this.#builtModel === undefined) return false;
    let now: string;
    try {
      const bot = this.#ctx.current();
      now = `${bot.model}\u0000${bot.effort ?? ""}`;
    } catch {
      return false;
    }
    if (now === this.#builtModel) return false;
    this.#log(`bot driver ${this.#ctx.sessionId}: reopening: its model or effort changed`);
    return true;
  }

  #sandboxChanged(): boolean {
    if (this.#d.sandbox === undefined) return false;
    try {
      return canonicalSandbox(this.#d.sandbox(this.#ctx)) !== this.#builtSandbox;
    } catch (err) {
      this.#log(`bot driver ${this.#ctx.sessionId}: the sandbox could not be read: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }
  }

  async #closeIncarnation(inc: Incarnation): Promise<void> {
    this.#releasePromptHolds("closing");
    if (inc.taskWatch !== undefined) clearInterval(inc.taskWatch);
    inc.taskWatch = undefined;
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

  /** While background tasks run, looks at the pause; once it says no, they are stopped (`#stopTasks`). */
  #watchTasks(inc: Incarnation): void {
    if (inc.taskWatch !== undefined) return;
    const look = () => {
      if (inc.closed || inc.tasks.size === 0 || this.#inc !== inc) {
        if (inc.taskWatch !== undefined) clearInterval(inc.taskWatch);
        inc.taskWatch = undefined;
        return;
      }
      if (this.#ctx.mayAct()) return;
      // Kept looking while tasks remain and the pause holds: a stop that failed is tried again at the next look.
      void this.#stopTasks(inc);
    };
    inc.taskWatch = setInterval(look, this.#d.pausePollMs ?? PAUSE_POLL_MS);
    (inc.taskWatch as { unref?: () => void }).unref?.();
    look();
  }

  /** The pause stops the session's background shells and monitors (the owner's rule), as the host (the model is told
   *  "stopped by the host" when its turn may start again). Resuming doesn't restart them. */
  async #stopTasks(inc: Incarnation): Promise<void> {
    for (const id of [...inc.tasks]) {
      if (inc.stopping.has(id)) continue;
      inc.stopping.add(id);
      try {
        if (typeof inc.query.stopTask !== "function") throw new Error("this runtime can't stop a task (agent SDK 0.0.69's stopTask)");
        await inc.query.stopTask(id, { by: "host" });
        inc.tasks.delete(id);
      } catch (err) {
        // A task the runtime no longer has (it ended meanwhile) is done with; any other failure is tried again.
        if (isUnknownTask(err)) inc.tasks.delete(id);
        else this.#log(`bot driver ${this.#ctx.sessionId}: stopping background task ${id} failed (tried again while paused): ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        inc.stopping.delete(id);
      }
    }
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
    // A server just installed or enabled is listed first (briefly), so the open below gives the runtime its tools.
    await this.#d.mcp?.settled?.().catch(() => {});
    try {
      inc = await this.#ensureOpen();
    } catch (err) {
      return { reason: "failed", failure: "error", text: `the runtime could not start: ${err instanceof Error ? err.message : String(err)}` };
    }
    const notes = await this.#hooks.turnStart(hs, ctl.signal).catch(() => []);
    const first = await this.#hooks.messageIn(hs, formatTurnInput(input, this.#ctx.kind), ctl.signal).catch(() => formatTurnInput(input, this.#ctx.kind));
    const nowServers = this.#promptServers(keptServers(this.#mcpServers(), this.#reservedNames()));
    const mcpNote = mcpChangesSince(this.#builtMcp, nowServers);
    if (mcpNote !== undefined) this.#builtMcp = mcpFingerprint(nowServers);
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
        ctl, owed: 1, unfolded: [], usage: { inputTokens: 0, outputTokens: 0 }, interrupted: false, ended: false, first: text,
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
    // A turn the pause holds at its start ends without a request (`#promptHold`).
    this.#releasePromptHolds("interrupt");
  }

  async compact(req: { reason: "cache" | "full" | "user"; signal: AbortSignal }): Promise<{ compacted: boolean }> {
    if (this.#stopped || req.signal.aborted) return { compacted: false };
    // A compaction is a model request: none while the pause holds or this computer doesn't run the bot (lane D's host
    // asks `mayStart` first too).
    if (!this.#ctx.mayAct()) return { compacted: false };
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

/** A sandbox as canonical JSON: keys sorted, and each list sorted (its entries are paths and hosts, whose order means
 *  nothing), so the same settings compare equal however they were built. */
function canonicalSandbox(sandbox: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm).map((x) => JSON.stringify(x)).sort().map((x) => JSON.parse(x) as unknown);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(norm(sandbox ?? null));
}
