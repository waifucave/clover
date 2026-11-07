// Clover's own coding agent as an ACP backend (spec §9.3 "[D] the inherited coding mode becomes an ACP agent that bots
// can delegate to like any other"; the controller's option A for K-M3): `clover-code`.
//
// * **ACP, in the daemon.** Each delegation gets its own ACP agent, clover-sdk's `serveAcpAgent` over the SDK's
//   `query()` on the embedded runtime (lane A's embedded spawn and the daemon's provider fill), and Clover's own
//   `AcpAgentSession` talks to it through an in-memory pipe: the same client, quirks row, permission cards and
//   transcript as every ACP agent, with no child process and no new door for credentials.
// * **The coding mode:** the runtime's coding prompt (the preset `serveAcpAgent` appends the bridge's essentials to),
//   its coding tools, and plan mode as its read-only mode. No settings files load, and only Clover's answer to a
//   request allows a tool call (`serveAcpAgent`'s rule).
// * **The fence** is the runtime's own Bash and file sandbox, from the session's `SandboxPolicy` (writes only where it
//   allows, the fenced set denied for reads and writes), as for every in-process session.
// * **The bridge** is an in-process MCP server for the session (bridge/in-process.ts), in place of the stdio one the
//   manager names in the spec: there is no process to bind a token to.
// * **The pause** (lane A's rule, #238): while the gate says no, every model turn holds at its start
//   (`UserPromptSubmit`, the runtime's own included: a background task's notification starts one), every tool call
//   holds at a fail-closed `PreToolUse` (read-only ones too, which never ask), an allow given while it came on waits for
//   the resume, and the agent's background commands are stopped, as the host.
// * **The hooks** join the base options' with lane A's `mergedHooks`: the pause and the fence's check first, the
//   base's (never allowing), then the pause and the fence's check again, last. The provider fill is lane A's
//   `fillProvider`, which may set only the model's own keys.
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { query as sdkQuery, SDK_VERSION, type CanUseTool, type HookCallbackMatcher, type McpSdkServerConfigWithInstance, type Options } from "@waifucave/clover-agent-sdk";
import { serveAcpAgent, type AcpAgentServer, type AcpQuery, type AcpQueryFn } from "@waifucave/clover-agent-sdk/acp";
import type { AgentBackend, AgentDetection, AgentQuirks } from "../../contracts/agent-backend";
import type { Clock } from "../../contracts/clock";
import { ContractError } from "../../contracts/common";
import { UserSelections } from "../acp/selections";
import { AcpAgentSession, type AgentProcess } from "../acp/session";
import type { AcpStartSpec, AgentWire } from "../backend";
import type { AgentPauseGate } from "../manager";
import { agentPolicyOf, fileToolDenials, homeReach } from "../memory";
import { inProcessSandboxReady, notAvailableHere } from "../sandbox/in-process";
import { isUnknownTask } from "../../runtime-sdk/turn-loop/driver";
import { fillProvider } from "../../runtime-sdk/turn-loop/embedded-session";
import { mergedHooks } from "../../runtime-sdk/turn-loop/hook-merge";

export const CLOVER_CODE_ID = "clover-code";

/** The coding agent's tools: the runtime's coding set, with plan mode; the bot's own tools never (messages go through
 *  the bridge). `TaskStop` here is the runtime's own, for the agent's background commands. */
export const CLOVER_CODE_TOOLS: readonly string[] = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop",
  "Monitor", "EnterPlanMode", "ExitPlanMode",
  ...(process.platform === "win32" ? ["PowerShell"] : []),
];

/** What Clover's ACP client reads for this agent (S5 §8's rows), from its own code in clover-sdk's `acp/agent.ts`. */
export const CLOVER_CODE_QUIRKS: AgentQuirks = {
  launch: { command: {}, identity: { versionArgs: [], versionPattern: "" }, envAllow: [], envSet: {}, versions: "*" },
  capabilities: { snakeCaseDuplicates: false, httpMcpUnadvertised: false },
  mcp: { transports: ["stdio", "http", "sse"], storesPlainText: false, passesEnvironment: false, instructionsReachPrompt: true, systemPromptChannel: "_meta.systemPrompt", tellsConversationId: false },
  // `session/resume` opens the transcript with no replay; there is no `load`.
  sessions: { load: { supported: false, replays: false }, resume: { supported: true, replays: false }, replayKeepsToolCallIds: true, listFiltersHonestly: false, close: true },
  // A refused call's result is an error (`failed`); a cancel interrupts the turn, which may leave calls open.
  turns: { refusal: "reported-failed", cancelLeavesToolCallsOpen: true, reportsUsage: true, quotaErrorsAsText: false },
  permissions: { optionKinds: ["allow_once", "allow_always", "reject_once"], neverAsks: [], mcpNames: null },
  config: { modelOption: "model", effortOption: "thought_level", effortInModel: false, choicePersists: false },
  auth: { methods: [], requiredError: {} },
  progress: { countsChildProcesses: false },
  placement: "local",
  marks: [],
};

/** Plan mode is the read-only one (it asks before any change). */
export const CLOVER_CODE_READ_ONLY_MODE = { option: "mode", values: ["plan"] } as const;

export interface CloverCodeDeps {
  clock: Clock;
  /** The base options of a session on the embedded runtime (lane A's `embeddedSessionOptions`): the brand on the Clover
   *  home, an allow-listed environment, the embedded spawn hook, no settings files. */
  baseOptions(o: { model: string; effort?: string; cwd: string }): Options;
  /** The daemon's provider fill for a real model (lane A's `fillProvider`); a test model needs none. */
  fillProvider?(model: string, options: Options): void | Promise<void>;
  /** The model when the delegation names none (the user's default). */
  defaultModel(): string;
  /** The delegating bot's pause switch (lane D's gate), the one the manager holds ACP agents with. */
  pause?: AgentPauseGate;
  /** The session's in-process bridge, given by the manager for an in-process backend. */
  wire?: (sessionId: string) => AgentWire;
  selections?: UserSelections;
  /** Test seam. */
  query?: typeof sdkQuery;
  /** Whether the embedded runtime's sandbox can run here (`inProcessSandboxReady`); a test seam. */
  sandboxReady?: () => boolean;
  log?(line: string): void;
}

/** The ACP agent on one end of an in-memory pipe, as the process `AcpAgentSession` drives: lines cross on a microtask,
 *  so neither side re-enters the other. It has no pid: there is no process to bind a bridge token to. */
function inMemoryAgent(serve: (write: (line: string) => void) => AcpAgentServer): AgentProcess {
  const encoder = new TextEncoder();
  let onData: ((chunk: Uint8Array) => void) | undefined;
  const early: Uint8Array[] = [];
  let ended!: () => void;
  const exited = new Promise<void>((r) => (ended = r));
  const server = serve((line) => {
    const bytes = encoder.encode(line);
    queueMicrotask(() => (onData ? onData(bytes) : early.push(bytes)));
  });
  void server.ended.then(() => ended());
  return {
    pid: 0,
    exited,
    write: (line) => queueMicrotask(() => server.feed(line)),
    onData: (fn) => {
      onData = fn;
      for (const b of early.splice(0)) fn(b);
    },
    stop: async () => {
      await server.close();
      ended();
    },
  };
}

const PAUSED = "Stopped: the user paused bots and their agents.";

/** What a session with no pause gate gets: held, never open (lane A's `CLOSED_GATE`). */
const CLOSED_GATE: AgentPauseGate = { mayAct: () => false };

/** How often a paused session whose runtime can't stop a task says so. */
const NO_STOP_LOG_MS = 60_000;

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** The fixed folder an absolute glob pattern starts in (`/a/b/**` is `/a/b`), or undefined for a relative one. */
function globRoot(pattern: string): string | undefined {
  if (!isAbsolute(pattern)) return undefined;
  const parts = pattern.split(/[\\/]/);
  const fixed: string[] = [];
  for (const part of parts) {
    if (/[*?[{]/.test(part)) break;
    fixed.push(part);
  }
  return fixed.join("/") || "/";
}

/** Why a file tool's call may not run under the fence, or undefined: a read or search reaching a read-denied folder
 *  (inside it, or a search from a folder that holds one), a write into a write-denied one, each as it really is. */
export function fileToolRefusal(input: { tool_name?: unknown; tool_input?: unknown }, fence: { denyRead: readonly string[]; denyWrite: readonly string[] }, root: string): string | undefined {
  const name = typeof input.tool_name === "string" ? input.tool_name : "";
  const args = (input.tool_input ?? {}) as Record<string, unknown>;
  if (!READ_TOOLS.has(name) && !WRITE_TOOLS.has(name)) return undefined;
  const paths: { path: string; search: boolean }[] = [];
  for (const key of ["file_path", "notebook_path", "path"]) {
    if (typeof args[key] === "string" && args[key] !== "") paths.push({ path: args[key] as string, search: name === "Glob" || name === "Grep" });
  }
  if ((name === "Glob" || name === "Grep") && paths.length === 0) paths.push({ path: root, search: true });
  // Glob's pattern, and Grep's `glob`, may be absolute: their fixed folder is searched (Grep's `pattern` is a regex).
  const globs = [name === "Glob" ? args["pattern"] : undefined, name === "Grep" ? args["glob"] : undefined];
  for (const g of globs) {
    const at = typeof g === "string" ? globRoot(g) : undefined;
    if (at !== undefined) paths.push({ path: at, search: true });
  }
  const denied = WRITE_TOOLS.has(name) ? fence.denyWrite : fence.denyRead;
  for (const { path, search } of paths) {
    for (const folder of denied) {
      if (folder.includes("*")) continue; // a pattern item: its whole folder is denied by name too
      const reach = homeReach(folder, path, root);
      if (reach === "inside" || (search && reach === "holds")) return `${name} was not run: ${path} reaches a folder agents may not touch.`;
    }
  }
  return undefined;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
const PAUSE_POLL_MS = 1_000;

/** Waits while the gate says no; false when the call should not go on (the turn was cancelled or the agent stopped). */
async function holdWhilePaused(gate: AgentPauseGate | undefined, signal: AbortSignal): Promise<boolean> {
  if (gate === undefined || gate.mayAct()) return true;
  await new Promise<void>((resolve) => {
    let off: (() => void) | undefined;
    const done = () => {
      clearInterval(timer);
      off?.();
      signal.removeEventListener("abort", done);
      resolve();
    };
    const check = () => {
      if (gate.mayAct()) done();
    };
    signal.addEventListener("abort", done, { once: true });
    off = gate.watch?.(check);
    const timer = setInterval(check, PAUSE_POLL_MS);
    check();
  });
  return !signal.aborted && gate.mayAct();
}

export class CloverCodeBackend implements AgentBackend {
  readonly id = CLOVER_CODE_ID;
  readonly pluginId = "clover/agent-clover-code";
  readonly name = "Clover's coding agent";
  readonly quirks = CLOVER_CODE_QUIRKS;
  /** Tells the manager to hand this backend the session's in-process bridge (`inProcessBridge`). */
  readonly inProcess = true;
  readonly #deps: CloverCodeDeps;
  readonly #selections: UserSelections;

  constructor(deps: CloverCodeDeps) {
    this.#deps = deps;
    this.#selections = deps.selections ?? new UserSelections();
  }

  async detect(): Promise<AgentDetection> {
    // Part of the daemon, at the SDK's version; its sandbox is the embedded runtime's, which every in-process session
    // runs in, and which only macOS has for now.
    if (!(this.#deps.sandboxReady ?? inProcessSandboxReady)()) return notAvailableHere(CLOVER_CODE_ID, SDK_VERSION);
    return { installed: true, version: SDK_VERSION, identityOk: true, versionOk: true, sandboxed: true };
  }

  async start(spec: AcpStartSpec): Promise<AcpAgentSession> {
    const deps = this.#deps;
    const bridge = spec.inProcessBridge;
    if (!bridge) throw new ContractError("refused", "Clover's coding agent needs its in-process bridge");
    // The root is a folder that exists: the manager resolved it; one that went away isn't made again here.
    if (!isDirectory(spec.root)) throw new ContractError("not_found", `the agent's root folder ${spec.root} isn't there`);
    const model = spec.model ?? deps.defaultModel();
    const abort = new AbortController();
    // Never a bot's own memory (`ownMemory`): an agent's policy denies all of `<home>/bots`.
    const fence = agentPolicyOf(spec.fence);
    // The session's own pause (the manager's, with another computer's forwarded switch for an agent run for it).
    // With no gate at all it fails closed, as lane A's backend does (`CLOSED_GATE`): the core always hands one.
    const gate = spec.pause ?? deps.pause ?? CLOSED_GATE;
    const pauseHook: HookCallbackMatcher[] = [{
        failClosed: true,
        timeout: 86_400,
        hooks: [async (_input, _id, { signal }) => (await holdWhilePaused(gate, AbortSignal.any([signal, abort.signal])))
          ? {}
          : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: PAUSED } }],
    }];
    const base = deps.baseOptions({ model, ...(spec.effort === undefined ? {} : { effort: spec.effort }), cwd: spec.root });
    // The runtime's TaskStop and SendMessage would reach the host's other sessions through host messaging; an agent
    // reaches its bot through the bridge alone.
    if ((base as { hostMessaging?: unknown }).hostMessaging !== undefined) throw new ContractError("refused", "Clover's coding agent wasn't started: its options carry host messaging");
    // Each file tool's path as it really is: the deny rules match a path as written, so a link from the root into a
    // denied folder (the Clover home) would pass them.
    const fenceHook: HookCallbackMatcher[] = [{
      failClosed: true,
      hooks: [async (input) => {
        const why = fileToolRefusal(input as { tool_name?: unknown; tool_input?: unknown }, fence, spec.root);
        return why === undefined ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } };
      }],
    }];
    // Every model turn holds at its start while paused (the runtime's own turns too); this event doesn't fail closed,
    // so the hold outlasts any timer (about 24.8 days), and a hold that ends without the resume blocks the turn.
    const turnHook: HookCallbackMatcher[] = [{
      timeout: Math.floor(2_147_483_647 / 1000),
      hooks: [async (_input, _id, { signal }) => (await holdWhilePaused(gate, AbortSignal.any([signal, abort.signal])))
        ? {}
        : { decision: "block" as const, reason: PAUSED }],
    }];
    // The base's hooks stay, never allowing; the pause and the fence's check go first, and again last (hooks from
    // sources the runtime ranks higher run before these lists).
    // After a call (done or failed), the model's next request waits while the pause holds: the call itself is never cut
    // off, and its result reaches no model until the user resumes (lane A's `#afterCall`).
    const afterCall: HookCallbackMatcher[] = [{
      timeout: 86_400,
      hooks: [async (_input, _id, { signal }) => {
        await holdWhilePaused(gate, AbortSignal.any([signal, abort.signal]));
        return {};
      }],
    }];
    const ownCalls = [...pauseHook, ...fenceHook];
    const hooks = mergedHooks(base.hooks, { PreToolUse: ownCalls, UserPromptSubmit: turnHook, PostToolUse: afterCall, PostToolUseFailure: afterCall }, { last: { PreToolUse: ownCalls } });
    const denials = [...(base.permissions?.deny ?? []), ...fileToolDenials(fence.denyRead, fence.denyWrite)];
    const options: Options = {
      ...base,
      tools: [...CLOVER_CODE_TOOLS],
      abortController: abort,
      hooks,
      // An empty allow list is the runtime's "anywhere": the fence always names at least the root.
      sandbox: {
        enabled: true,
        filesystem: { allowWrite: fence.allowWrite.length > 0 ? [...fence.allowWrite] : [spec.root], denyWrite: [...fence.denyWrite], denyRead: [...fence.denyRead] },
      },
      // The sandbox holds Bash; the file tools get the same denials as deny rules (the fenced set and bots' memory).
      ...(denials.length === 0 && base.permissions === undefined ? {} : { permissions: { ...(base.permissions ?? {}), deny: denials } }),
    };
    await fillProvider(deps.fillProvider ? { provider: (m, o) => deps.fillProvider!(m, o) } : {}, options);
    const run = deps.query ?? sdkQuery;
    // The ACP agent's query, with the session's in-process bridge in place of the stdio entry it was handed, and an
    // allow that came while the pause came on waiting for the resume.
    const query: AcpQueryFn = (args) => {
      const o = args.options as unknown as Options & { canUseTool: CanUseTool; mcpServers?: Record<string, unknown> };
      const servers = { ...(o.mcpServers ?? {}), [bridge.name]: bridge as McpSdkServerConfigWithInstance };
      const ask = o.canUseTool;
      const canUseTool: CanUseTool = async (name, input, opts) => {
        const answer = await ask(name, input, opts);
        if (answer?.behavior === "allow" && !(await holdWhilePaused(gate, AbortSignal.any([opts.signal, abort.signal])))) return { behavior: "deny", message: PAUSED };
        return answer;
      };
      const q = run({ prompt: args.prompt, options: { ...o, mcpServers: servers as Options["mcpServers"], canUseTool } }) as unknown as AcpQuery;
      return stoppingTasksWhilePaused(q, gate, abort.signal, deps.log);
    };
    const wire = deps.wire?.(spec.sessionId) ?? {};
    const proc = inMemoryAgent((write) => serveAcpAgent({
      query,
      options: options as unknown as Record<string, unknown>,
      agentInfo: { name: CLOVER_CODE_ID, title: "Clover's coding agent", version: SDK_VERSION },
      write,
      newId: () => randomUUID(),
      ...(deps.log ? { log: deps.log } : {}),
    }));
    void proc.exited.then(() => abort.abort());
    const readOnly = spec.readOnly === true;
    return AcpAgentSession.open({
      quirks: this.quirks,
      clock: deps.clock,
      process: proc,
      cwd: spec.root,
      // No stdio bridge on the wire: the agent's query serves the in-process one under the session's bridge name.
      mcpServers: [],
      ...(spec.instructions === undefined ? {} : { instructions: spec.instructions }),
      ...(spec.reattach === undefined ? {} : { reattach: spec.reattach }),
      ...(spec.model === undefined ? {} : { model: spec.model }),
      ...(spec.effort === undefined ? {} : { effort: spec.effort }),
      ...(wire.tap ? { tap: wire.tap } : {}),
      selections: { keeper: this.#selections, backend: this.id },
      readOnlyMode: CLOVER_CODE_READ_ONLY_MODE,
      ...(readOnly ? { readOnly: true } : {}),
    });
  }
}

/** The query, with the agent's background tasks stopped while the pause holds (lane A's rule, #238): through the
 *  runtime's `stopTask`, as the host, tried again while tasks remain and the pause holds; a task the runtime no longer
 *  has is done with (`isUnknownTask`). A task whose start doesn't say it runs in the foreground counts. */
function stoppingTasksWhilePaused(q: AcpQuery, gate: AgentPauseGate | undefined, done: AbortSignal, log?: (line: string) => void): AcpQuery {
  if (!gate) return q;
  const stopTask = (q as { stopTask?: (id: string, o?: { by?: "host" }) => Promise<unknown> }).stopTask;
  const tasks = new Set<string>();
  const stopping = new Set<string>();
  let off: (() => void) | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let saidAt = -Infinity;
  const unwatch = () => {
    off?.();
    off = undefined;
    if (poll !== undefined) clearInterval(poll);
    poll = undefined;
  };
  const look = () => {
    if (tasks.size === 0 || done.aborted) return unwatch();
    if (gate.mayAct()) return;
    if (typeof stopTask !== "function") {
      // Said again while it lasts (throttled), and still watched: the tasks may end on their own, or the pause lift.
      const now = Date.now();
      if (now - saidAt >= NO_STOP_LOG_MS) {
        saidAt = now;
        log?.(`clover-code: paused with ${tasks.size} background task(s), and this runtime can't stop a task`);
      }
      return;
    }
    for (const id of [...tasks]) {
      if (stopping.has(id)) continue;
      stopping.add(id);
      void stopTask.call(q, id, { by: "host" }).then(
        () => tasks.delete(id),
        (err: unknown) => {
          if (isUnknownTask(err)) tasks.delete(id);
          else log?.(`clover-code: stopping background task ${id} failed (tried again while paused): ${err instanceof Error ? err.message : String(err)}`);
        },
      ).finally(() => stopping.delete(id));
    }
  };
  const watch = () => {
    if (off !== undefined || poll !== undefined) return;
    off = gate.watch?.(look);
    poll = setInterval(look, 1_000);
    (poll as { unref?: () => void }).unref?.();
    look();
  };
  const observe = (raw: unknown) => {
    const msg = raw as { type?: unknown; subtype?: unknown; task_id?: unknown; is_backgrounded?: unknown; patch?: { is_backgrounded?: unknown } };
    if (msg?.type !== "system" || typeof msg.task_id !== "string") return;
    const patch = msg.subtype === "task_updated" ? msg.patch : undefined;
    if ((msg.subtype === "task_started" && msg.is_backgrounded !== false) || patch?.is_backgrounded === true) {
      tasks.add(msg.task_id);
      watch();
    } else if (msg.subtype === "task_notification") tasks.delete(msg.task_id);
  };
  return new Proxy(q, {
    get(target, prop, recv) {
      if (prop === Symbol.asyncIterator) {
        return () => (async function* () {
          try {
            for await (const m of target) {
              observe(m);
              yield m;
            }
          } finally {
            unwatch();
          }
        })();
      }
      const v = Reflect.get(target, prop, recv) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
