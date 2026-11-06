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
// * **The pause:** while the gate says no, every tool call holds at a fail-closed `PreToolUse` (read-only ones too, which
//   never ask), and an allow given while it came on waits for the resume. Background commands started before a pause
//   keep running; only tool calls are held.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { query as sdkQuery, SDK_VERSION, type CanUseTool, type HookCallbackMatcher, type McpSdkServerConfigWithInstance, type Options } from "@waifucave/clover-agent-sdk";
import { serveAcpAgent, type AcpAgentServer, type AcpQuery, type AcpQueryFn } from "@waifucave/clover-agent-sdk/acp";
import type { AgentBackend, AgentDetection, AgentQuirks } from "../../contracts/agent-backend";
import type { Clock } from "../../contracts/clock";
import { ContractError } from "../../contracts/common";
import { UserSelections } from "../acp/selections";
import { AcpAgentSession, type AgentProcess } from "../acp/session";
import type { AcpStartSpec, AgentWire } from "../backend";
import type { AgentPauseGate } from "../manager";
import { agentPolicyOf, fileToolDenials } from "../memory";

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
    // runs in.
    return { installed: true, version: SDK_VERSION, identityOk: true, versionOk: true, sandboxed: true };
  }

  async start(spec: AcpStartSpec): Promise<AcpAgentSession> {
    const deps = this.#deps;
    const bridge = spec.inProcessBridge;
    if (!bridge) throw new ContractError("refused", "Clover's coding agent needs its in-process bridge");
    mkdirSync(spec.root, { recursive: true });
    const model = spec.model ?? deps.defaultModel();
    const abort = new AbortController();
    // Never a bot's own memory (`ownMemory`): an agent's policy denies all of `<home>/bots`.
    const fence = agentPolicyOf(spec.fence);
    const gate = deps.pause;
    const pauseHooks: Partial<Record<"PreToolUse", HookCallbackMatcher[]>> = {
      PreToolUse: [{
        failClosed: true,
        timeout: 86_400,
        hooks: [async (_input, _id, { signal }) => (await holdWhilePaused(gate, AbortSignal.any([signal, abort.signal])))
          ? {}
          : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: PAUSED } }],
      }],
    };
    const options: Options = {
      ...deps.baseOptions({ model, ...(spec.effort === undefined ? {} : { effort: spec.effort }), cwd: spec.root }),
      tools: [...CLOVER_CODE_TOOLS],
      abortController: abort,
      ...(gate ? { hooks: pauseHooks } : {}),
      // An empty allow list is the runtime's "anywhere": the fence always names at least the root.
      sandbox: {
        enabled: true,
        filesystem: { allowWrite: fence.allowWrite.length > 0 ? [...fence.allowWrite] : [spec.root], denyWrite: [...fence.denyWrite], denyRead: [...fence.denyRead] },
      },
      // The sandbox holds Bash; the file tools get the same denials as deny rules (the fenced set and bots' memory).
      ...(fence.denyRead.length + fence.denyWrite.length === 0 ? {} : { permissions: { deny: fileToolDenials(fence.denyRead, fence.denyWrite) } }),
    };
    await deps.fillProvider?.(model, options);
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
      return run({ prompt: args.prompt, options: { ...o, mcpServers: servers as Options["mcpServers"], canUseTool } }) as unknown as AcpQuery;
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
