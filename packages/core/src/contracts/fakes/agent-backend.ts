// FakeAgentBackend: an ACP agent played from a script, bending the protocol the way its quirks say, so the host, the
// broker and the bridge can be tested against every row of S5 §8 without a real agent or a model call. The two presets
// carry what S5 measured for Cursor and Antigravity; lane K's quirks table is the source of truth once it lands.
import type { Clock } from "../clock";
import { ContractError, Listeners, type Unsubscribe } from "../common";
import type {
  AgentBackend, AgentDetection, AgentEvent, AgentPermissionAnswer, AgentPermissionAsk, AgentQuirks, AgentSession,
  AgentSessionState, AgentStartSpec, AgentTurnEnd,
} from "../agent-backend";
import type { AgentPermissionOption } from "../approval-broker";

/** One step of a scripted turn. */
export type AgentStep =
  | { say: string }
  | { think: string }
  | { tool: { id?: string; kind: string; title: string; rawInput?: unknown; mcp?: { server: string; tool: string }; paths?: string[]; ask?: boolean } }
  | { usage: { inputTokens: number; outputTokens: number } }
  /** Waits until `FakeAgentSession.proceed()` or a cancel, like a long command. */
  | { wait: true }
  | { end: AgentTurnEnd["stopReason"] };

/** An agent that keeps to the protocol: the baseline the presets differ from. */
export const WELL_BEHAVED_QUIRKS: AgentQuirks = {
  launch: { command: { macos: ["fake-agent", "acp"], linux: ["fake-agent", "acp"], windows: ["fake-agent.exe", "acp"] }, identity: { versionArgs: ["--version"], versionPattern: "^fake-agent \\d+" }, envAllow: ["PATH", "HOME"], envSet: {}, versions: ">=1.0.0" },
  capabilities: { snakeCaseDuplicates: false, httpMcpUnadvertised: false },
  mcp: { transports: ["stdio", "http"], storesPlainText: false, passesEnvironment: false, instructionsReachPrompt: true, systemPromptChannel: "acp.systemPrompt", tellsConversationId: false },
  sessions: { load: { supported: true, replays: true }, resume: { supported: true, replays: false }, replayKeepsToolCallIds: true, listFiltersHonestly: true, close: true },
  turns: { refusal: "reported-failed", cancelLeavesToolCallsOpen: false, reportsUsage: true, quotaErrorsAsText: false },
  permissions: { optionKinds: ["allow_once", "allow_always", "reject_once", "reject_always"], neverAsks: [], mcpNames: { server: "rawInput.server", tool: "rawInput.tool" } },
  config: { modelOption: "model", effortOption: "thought_level", effortInModel: false, choicePersists: false },
  auth: { methods: [{ id: "api-key", headless: true }], requiredError: { code: -32000 } },
  progress: { countsChildProcesses: true },
  placement: "local",
  marks: [],
};

/** Cursor's CLI as S5 found it (§1, §8, edits 6 and 11). */
export const S5_CURSOR_QUIRKS: AgentQuirks = {
  ...WELL_BEHAVED_QUIRKS,
  launch: { ...WELL_BEHAVED_QUIRKS.launch, command: { macos: ["cursor-agent", "acp"], linux: ["cursor-agent", "acp"], windows: ["cursor-agent.exe", "acp"] }, identity: { versionArgs: ["--version"], versionPattern: "^\\d{4}\\.\\d+" } },
  mcp: { transports: ["stdio", "http"], storesPlainText: false, passesEnvironment: false, instructionsReachPrompt: false, systemPromptChannel: null, tellsConversationId: false },
  sessions: { load: { supported: true, replays: true }, resume: { supported: false, replays: false }, replayKeepsToolCallIds: false, listFiltersHonestly: false, close: false },
  turns: { refusal: "reported-completed", cancelLeavesToolCallsOpen: true, reportsUsage: false, quotaErrorsAsText: true },
  permissions: { optionKinds: ["allow_once", "allow_always", "reject_once"], neverAsks: ["edit inside the root", "commands on the user's own allowlist", "delete inside the root (by its code, untested)"], mcpNames: { server: "rawInput.providerIdentifier", tool: "rawInput.toolName" } },
  config: { modelOption: "model", effortOption: null, effortInModel: true, choicePersists: true },
  auth: { methods: [{ id: "cursor-login", headless: false }], requiredError: { messagePattern: "login" } },
  marks: ["unasked-actions", "persists-model-choice"],
};

/** Antigravity CLI as S5 found it (§2, §8, edit 4). */
export const S5_ANTIGRAVITY_QUIRKS: AgentQuirks = {
  ...WELL_BEHAVED_QUIRKS,
  launch: { ...WELL_BEHAVED_QUIRKS.launch, command: { macos: ["agy", "acp"], linux: ["agy", "acp"], windows: ["agy.exe", "acp"] }, envSet: { AGY_CLI_DISABLE_AUTO_UPDATE: "1" }, identity: { versionArgs: ["--version"], versionPattern: "^\\d+\\.\\d+\\.\\d+" } },
  capabilities: { snakeCaseDuplicates: true, httpMcpUnadvertised: true },
  mcp: { transports: ["stdio", "http"], storesPlainText: true, passesEnvironment: true, instructionsReachPrompt: "unknown", systemPromptChannel: "_meta.antigravity.systemPrompt.append", tellsConversationId: true },
  sessions: { load: { supported: true, replays: true }, resume: { supported: true, replays: true }, replayKeepsToolCallIds: true, listFiltersHonestly: false, close: false },
  turns: { refusal: "ends-turn", cancelLeavesToolCallsOpen: true, reportsUsage: true, quotaErrorsAsText: false },
  permissions: { optionKinds: ["allow_once", "reject_once"], neverAsks: ["read-only MCP calls"], mcpNames: null },
  config: { modelOption: "model", effortOption: "thought_level", effortInModel: false, choicePersists: false },
  auth: { methods: [{ id: "google", headless: false }], requiredError: { code: -32000 } },
  marks: ["stores-plain-text", "passes-environment"],
};

export interface FakeAgentBackendOptions {
  id: string;
  pluginId?: string;
  clock: Clock;
  quirks?: AgentQuirks;
  detection?: Partial<AgentDetection>;
  signedIn?: boolean;
  /** One list of steps per prompt, in order; a prompt past the script ends at once with `end_turn`. */
  script?: AgentStep[][];
  /** What a `load` (or a replaying `resume`) replays: dropped by the session, counted in `droppedReplay`. */
  history?: AgentEvent[];
}

export class FakeAgentBackend implements AgentBackend {
  readonly id: string;
  readonly pluginId: string;
  readonly quirks: AgentQuirks;
  readonly sessions: FakeAgentSession[] = [];
  /** The user's own selection in the agent's settings, which a persisting choice overwrites (S5 edit 11). */
  readonly userSelection: { model?: string } = {};
  readonly #opts: FakeAgentBackendOptions;
  #seq = 0;

  constructor(opts: FakeAgentBackendOptions) {
    this.id = opts.id;
    this.pluginId = opts.pluginId ?? `agent-${opts.id}`;
    this.quirks = opts.quirks ?? WELL_BEHAVED_QUIRKS;
    this.#opts = opts;
  }

  async detect(): Promise<AgentDetection> {
    return { installed: true, path: `/opt/agents/${this.id}`, version: "1.0.0", identityOk: true, versionOk: true, sandboxed: true, ...this.#opts.detection };
  }

  async start(spec: AgentStartSpec): Promise<AgentSession> {
    const d = await this.detect();
    if (!d.installed) throw new ContractError("not_installed", `${this.id} isn't installed on this computer`);
    if (!d.identityOk) throw new ContractError("refused", `${d.path ?? this.id} isn't ${this.id}'s binary`);
    if (this.#opts.signedIn === false) throw new ContractError("sign_in", `sign in to ${this.id} yourself, then try again`);
    if (!this.quirks.mcp.transports.includes("stdio")) throw new ContractError("refused", `${this.id} takes no stdio MCP server, so the bridge can't reach it`);
    const reattach = spec.reattach;
    if (reattach && !this.quirks.sessions.load.supported && !this.quirks.sessions.resume.supported) {
      throw new ContractError("refused", `${this.id} can't reattach to a session`);
    }
    const id = reattach?.agentSessionId ?? `${this.id}-session-${++this.#seq}`;
    const session = new FakeAgentSession(id, this, spec, this.#opts.clock, [...(this.#opts.script ?? [])]);
    if (reattach) {
      // An honest resume replays nothing; a load, or a resume that replays, replays history, which the client drops.
      const replays = this.quirks.sessions.resume.supported && !this.quirks.sessions.resume.replays ? false : true;
      if (replays) session.droppedReplay = (this.#opts.history ?? []).length;
      session.reattachedWith = this.quirks.sessions.resume.supported && !this.quirks.sessions.resume.replays ? "resume" : "load";
    }
    this.sessions.push(session);
    session.ready();
    return session;
  }
}

export class FakeAgentSession implements AgentSession {
  readonly agentSessionId: string;
  readonly spec: AgentStartSpec;
  /** Every answer the host gave, by tool call. */
  readonly answers: { toolCallId: string; answer: AgentPermissionAnswer; kind?: AgentPermissionOption["kind"] }[] = [];
  /** The config each `setConfig` set. */
  readonly config: { model?: string; effort?: string } = {};
  droppedReplay = 0;
  reattachedWith?: "resume" | "load";
  readonly #backend: FakeAgentBackend;
  readonly #clock: Clock;
  readonly #script: AgentStep[][];
  readonly #events = new Listeners<AgentEvent>();
  #state: AgentSessionState = "starting";
  #permission?: (ask: AgentPermissionAsk) => Promise<AgentPermissionAnswer>;
  #lastProgress: number;
  #proceed: (() => void) | undefined;
  #cancel: (() => void) | undefined;
  #toolSeq = 0;

  constructor(id: string, backend: FakeAgentBackend, spec: AgentStartSpec, clock: Clock, script: AgentStep[][]) {
    this.agentSessionId = id;
    this.#backend = backend;
    this.spec = spec;
    this.#clock = clock;
    this.#script = script;
    this.#lastProgress = clock.now();
  }

  /** @internal */
  ready(): void {
    this.#state = "ready";
  }

  state(): AgentSessionState {
    return this.#state;
  }

  async prompt(_input: { text: string }): Promise<AgentTurnEnd> {
    if (this.#state === "stopped" || this.#state === "failed") throw new ContractError("closed", "the agent's session has ended");
    if (this.#state === "prompting" || this.#state === "cancelling") throw new ContractError("conflict", "a turn is running; the host queues the next prompt");
    this.#state = "prompting";
    const steps = this.#script.shift() ?? [];
    const q = this.#backend.quirks;
    let cancelled = false;
    const cancelledP = new Promise<void>((resolve) => {
      this.#cancel = () => {
        cancelled = true;
        resolve();
      };
    });
    const open = new Set<string>();
    let text = "";
    let usage: AgentTurnEnd["usage"];
    const finish = (stopReason: AgentTurnEnd["stopReason"]): AgentTurnEnd => {
      if (stopReason === "cancelled" && q.turns.cancelLeavesToolCallsOpen) {
        // The agent left them open; Clover closes them itself (S5 edit 5).
        for (const id of open) this.#emit({ type: "tool_call_update", id, status: "failed", closedByClover: true });
      }
      this.#cancel = undefined;
      this.#proceed = undefined;
      if (this.#state !== "stopped") this.#state = "idle";
      return { stopReason, text, ...(usage === undefined ? {} : { usage }) };
    };
    for (const step of steps) {
      if (cancelled) return finish("cancelled");
      if ("say" in step) {
        text += step.say;
        this.#emit({ type: "text", text: step.say });
      } else if ("think" in step) this.#emit({ type: "thought", text: step.think });
      else if ("usage" in step) {
        if (q.turns.reportsUsage) {
          usage = step.usage;
          this.#emit({ type: "usage", ...step.usage });
        }
      } else if ("wait" in step) {
        await Promise.race([new Promise<void>((resolve) => (this.#proceed = resolve)), cancelledP]);
        if (cancelled) return finish("cancelled");
      } else if ("end" in step) return finish(step.end);
      else {
        const t = step.tool;
        const id = t.id ?? `call-${++this.#toolSeq}`;
        open.add(id);
        this.#emit({ type: "tool_call", id, kind: t.kind, title: t.title, status: "pending", ...(t.rawInput === undefined ? {} : { rawInput: t.rawInput }) });
        if (t.ask !== false) {
          const options = q.permissions.optionKinds.map((kind): AgentPermissionOption => ({ optionId: kind, name: kind.replace("_", " "), kind }));
          const ask: AgentPermissionAsk = {
            toolCallId: id, toolKind: t.kind, title: t.title, options, paths: t.paths ?? [],
            ...(t.rawInput === undefined ? {} : { rawInput: t.rawInput }), ...(t.mcp === undefined ? {} : { mcp: t.mcp }),
          };
          const answer = await Promise.race([
            this.#permission ? this.#permission(ask) : Promise.resolve<AgentPermissionAnswer>({ outcome: "cancelled" }),
            cancelledP.then((): AgentPermissionAnswer => ({ outcome: "cancelled" })),
          ]);
          const kind = answer.outcome === "selected" ? options.find((o) => o.optionId === answer.optionId)?.kind : undefined;
          this.answers.push({ toolCallId: id, answer, ...(kind === undefined ? {} : { kind }) });
          if (cancelled) return finish("cancelled");
          const allowed = kind === "allow_once" || kind === "allow_always";
          if (!allowed) {
            open.delete(id);
            if (q.turns.refusal === "ends-turn") {
              this.#emit({ type: "tool_call_update", id, status: "failed", refused: true });
              return finish("refusal");
            }
            // The agent reports the refused call its own way; Clover's record says refused.
            this.#emit({ type: "tool_call_update", id, status: q.turns.refusal === "reported-completed" ? "completed" : "failed", refused: true });
            continue;
          }
        }
        this.#emit({ type: "tool_call_update", id, status: "in_progress" });
        open.delete(id);
        this.#emit({ type: "tool_call_update", id, status: "completed" });
      }
    }
    return finish(cancelled ? "cancelled" : "end_turn");
  }

  async cancel(): Promise<void> {
    if (this.#state !== "prompting") return;
    this.#state = "cancelling";
    this.#cancel?.();
  }

  async setConfig(option: "model" | "effort", value: string): Promise<void> {
    const q = this.#backend.quirks.config;
    const id = option === "model" ? q.modelOption : q.effortOption;
    if (id === null) throw new ContractError("refused", `${this.#backend.id} takes no ${option} option${option === "effort" && q.effortInModel ? "; its effort is part of the model" : ""}`);
    this.config[option] = value;
    if (option === "model" && q.choicePersists) this.#backend.userSelection.model = value;
  }

  async stop(): Promise<void> {
    await this.cancel();
    this.#state = "stopped";
  }

  onPermission(fn: (ask: AgentPermissionAsk) => Promise<AgentPermissionAnswer>): void {
    this.#permission = fn;
  }

  onEvent(fn: (event: AgentEvent) => void): Unsubscribe {
    return this.#events.add(fn);
  }

  lastProgressAt(): number {
    return this.#lastProgress;
  }

  /** Lets a `wait` step go on. */
  proceed(): void {
    this.#proceed?.();
  }

  #emit(event: AgentEvent): void {
    this.#lastProgress = this.#clock.now();
    this.#events.emit(event);
  }
}
