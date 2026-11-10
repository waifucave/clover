// One ACP agent session: Clover's client side of one delegation (spec §9.3, spike S5 §7 "Connection", "Handlers",
// "AgentSession"). It implements the spine's `AgentSession` (packages/core/src/contracts/agent-backend.ts) over a
// JSON-RPC peer, reading the backend's quirks instead of its name.
//
// What it does that the protocol alone doesn't:
// * **Replays are dropped** (S5 edit 8): updates that arrive between a `session/load` or `session/resume` request and
//   its response are counted in `droppedReplay`, marked `replay` on the wire tap (the transcript skips them) and never
//   become events.
// * **Permissions** go to the host's handler (the ApprovalBroker). The answer is `allow_once`, `reject_once` or
//   `cancelled`, never an "always" (S5 edit 5): a handler that picks one is held to the matching "once" option. An
//   MCP call's server and tool are read from the tool call's structured input where the quirks say (Cursor's
//   `rawInput.providerIdentifier` and `toolName`, which arrive in an update before the request), never the title.
//   Pending requests are answered `cancelled` on a cancel, as ACP requires of a client.
// * **Clover's own record of each tool call**: a refused call is recorded refused whatever the agent reports
//   (Cursor says `completed`), and calls a cancel leaves open are closed by Clover (`closedByClover`).
// * **How a turn ends**: a refusal that ends the turn with no reply (Antigravity reports `end_turn`) is `refusal`; the
//   final text is the agent's text after its last tool call, unchanged; usage is passed on where the agent reports it.
// * **Model and effort** through `session/set_config_option`. Where a choice persists into the user's own settings
//   (Cursor, S5 edit 11), the backend's one record of the user's own selection (`UserSelections`) is set back when the
//   last delegation that changed it ends, after a crash or a restart too (review 10).
// * **Read-only** (spec §9.3 [P], item 78): an agent that acts without asking starts in its read-only mode (Cursor's
//   `ask` or `plan`), or not at all; `setReadOnly` switches it at a later turn when its computer's level changes, and
//   back to the mode it had.
// * **Progress** for the stall watchdog: any message from the agent, stamped on the session's clock. While a
//   permission request waits on the user, the session is waiting on them, not stalled (review 3).
// * **A hostile agent's limits** (review 12): at most `MAX_OPEN_ASKS` permission requests at once (more are refused
//   without a card), a `rawInput` over `MAX_RAW_INPUT_CHARS` is cut to a preview, and requests during a replay are
//   cancelled.
//
// The client advertises neither `fs` nor `terminal`: agents use their own tools, inside their own sandbox (§9.3).
// Reaching the folder tree and Bash under the fence through those doors comes with Gemini CLI, which uses them (M2).
import type { Level } from "@waifucave/clover-protocol";
import type {
  AgentEvent, AgentPermissionAnswer, AgentPermissionAsk, AgentQuirks, AgentSession, AgentSessionState, AgentTurnEnd,
} from "../../contracts/agent-backend";
import { AGENT_CANCEL_WAIT_MS } from "../../contracts/agent-backend";
import type { AgentPermissionOption } from "../../contracts/approval-broker";
import type { Clock } from "../../contracts/clock";
import { ContractError, Listeners, type Unsubscribe } from "../../contracts/common";
import { RPC_METHOD_NOT_FOUND, RpcError, RpcPeer, type JsonRpcMessage } from "@waifucave/clover-agent-sdk/acp";
import { UserSelections } from "./selections";
import {
  ACP_PROTOCOL_VERSION, type AgentCaps, type ConfigOption, type StdioMcpServer, at, isAuthRequired, obj, pathsOf, readCaps,
  readConfigOptions, readPermissionOptions, readToolStatus, str, textOf, type Obj, type ToolStatus,
} from "@waifucave/clover-agent-sdk/acp";

/** Where the raw wire goes: the transcript, which skips what is marked `replay`. */
export type WireTap = (dir: "in" | "out", msg: JsonRpcMessage, replay: boolean) => void;

/** The process under the session, as the session uses it. */
export interface AgentProcess {
  readonly pid: number;
  readonly exited: Promise<unknown>;
  write(line: string): void;
  onData(fn: (chunk: Uint8Array) => void): void;
  stop(graceMs?: number): Promise<void>;
}

/** Clover's own record of one tool call. */
export interface ToolCallRecord {
  id: string;
  kind: string;
  title: string;
  status: ToolStatus;
  rawInput?: unknown;
  /** The update's other structured fields (`locations`, `content`), for paths. */
  fields: Obj;
  /** Wall-clock start, for the watchdog's process check (the process table is on wall time). */
  startedAtWall: number;
  decision?: "allowed" | "refused" | "cancelled";
  closedByClover?: boolean;
}

export interface OpenOptions {
  quirks: AgentQuirks;
  clock: Clock;
  process: AgentProcess;
  cwd: string;
  mcpServers: StdioMcpServer[];
  /** The bridge's essentials (S5 edit 3): the system prompt where the backend lets a client add to it, else the first
   *  prompt. */
  instructions?: string;
  /** More `_meta` for `session/new`, `load` and `resume`: a sandbox writer's (the Claude adapter's options). */
  meta?: Obj;
  reattach?: { agentSessionId: string };
  model?: string;
  effort?: string;
  tap?: WireTap;
  clientInfo?: { name: string; version: string };
  /** How long `initialize` and `session/new` may take. */
  startTimeoutMs?: number;
  /** The backend's record of the user's own selections, where a choice persists (`choicePersists`). */
  selections?: { keeper: UserSelections; backend: string };
  /** The agent's read-only mode: the config option, and its values in order of preference (its quirks file's `readOnlyMode`). */
  readOnlyMode?: { option: string; values: readonly string[] };
  /** Start in the read-only mode; the session fails `refused` when the agent offers none of its values. */
  readOnly?: boolean;
  /** Modes the session may not be in, by level (its sandbox writer's): one it starts in, from the user's own settings
   *  (Claude Code's `permissions.defaultMode`), is switched to the floor's `fallback`, or the session fails `refused`.
   *  Held again at every turn against the level then (`setLevel`). */
  modeFloor?: ModeFloorFor;
  /** The session's level at its start, for `modeFloor`. */
  level?: Level;
  /** How long a mode switch may take to be confirmed (`MODE_CONFIRM_MS`). */
  modeConfirmMs?: number;
}

/** A writer's mode floor at a level (absent: the strictest). */
export type ModeFloorFor = (level: Level | undefined) => ModeFloor;

/** Modes a session may not be in, and the one to switch to instead. */
export interface ModeFloor {
  /** Only these modes, where given: the ones the live gates showed keep the sandbox (a mode that is a sandbox preset of
   *  its own may replace the writer's profile). Empty: none yet, so no session holds the floor. With a list, a session
   *  that reports no mode isn't counted on either. */
  allowed?: readonly string[];
  /** Never these modes. */
  refused?: readonly string[];
  /** The mode a refused one is switched to; none: no switch is tried, and the session is refused or ended. */
  fallback?: string;
}

/** Whether a floor allows a mode. */
export function floorAllows(floor: ModeFloor, mode: string): boolean {
  return (floor.allowed === undefined || floor.allowed.includes(mode)) && !(floor.refused ?? []).includes(mode);
}

/** How long an agent has to confirm a mode the floor switched it to (its `current_mode_update`) before a running turn is
 *  cancelled, or a session between turns ended. */
export const MODE_CONFIRM_MS = 5_000;

/** The most permission requests one agent may have open at once; more are refused without a card. */
export const MAX_OPEN_ASKS = 8;
/** A tool call's `rawInput` longer than this, as JSON, is kept as a preview. */
export const MAX_RAW_INPUT_CHARS = 256 * 1024;

export const CLIENT_INFO = { name: "clover", title: "Clover", version: "0.0.0" };
const DEFAULT_START_TIMEOUT_MS = 120_000;
const CONFIG_TIMEOUT_MS = 30_000;

interface Turn {
  /** Text since the last tool call: the final text. */
  text: string;
  abort: AbortController;
  toolIds: Set<string>;
  /** The last permission answer was a refusal, and no text came after it. */
  endedOnRefusal: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

export class AcpAgentSession implements AgentSession {
  readonly #quirks: AgentQuirks;
  readonly #clock: Clock;
  readonly #proc: AgentProcess;
  readonly #peer: RpcPeer;
  readonly #events = new Listeners<AgentEvent>();
  readonly #calls = new Map<string, ToolCallRecord>();
  #agentSessionId = "";
  #state: AgentSessionState = "starting";
  #caps: AgentCaps | undefined;
  #config: ConfigOption[] = [];
  /** The backend's record of the user's own selections, and the options this session changed. */
  readonly #selections: { keeper: UserSelections; backend: string };
  readonly #held = new Set<string>();
  /** Permission requests waiting on their answer. */
  #asking = 0;
  readonly #readOnlyMode: { option: string; values: readonly string[] } | undefined;
  readonly #modeFloor: ModeFloorFor | undefined;
  #level: Level | undefined;
  readonly #modeConfirmMs: number;
  /** Waiting on the agent's `current_mode_update`. */
  readonly #modeWaiters = new Set<() => void>();
  #readOnly = false;
  /** The mode before the read-only one, to switch back to. */
  #modeBefore: string | undefined;
  /** ACP's session modes (`modes` at `session/new`, `current_mode_update`), for agents that offer no `mode` option. */
  #modes: { available: string[]; current?: string } | undefined;
  #permission: ((ask: AgentPermissionAsk) => Promise<AgentPermissionAnswer>) | undefined;
  #turn: Turn | undefined;
  #turnDone: Promise<unknown> | undefined;
  #replaying = false;
  #stopping = false;
  #exited = false;
  #lastProgress: number;
  #preamble: string | undefined;
  /** Updates a load or replaying resume sent, dropped (S5 edit 8). */
  droppedReplay = 0;
  reattachedWith: "resume" | "load" | undefined;

  private constructor(opts: OpenOptions) {
    this.#quirks = opts.quirks;
    this.#clock = opts.clock;
    this.#proc = opts.process;
    this.#lastProgress = opts.clock.now();
    this.#selections = opts.selections ?? { keeper: new UserSelections(), backend: "agent" };
    this.#readOnlyMode = opts.readOnlyMode;
    this.#modeFloor = opts.modeFloor;
    this.#level = opts.level;
    this.#modeConfirmMs = opts.modeConfirmMs ?? MODE_CONFIRM_MS;
    const tap = opts.tap;
    this.#peer = new RpcPeer({
      write: (line) => this.#proc.write(line),
      tap: (dir, msg) => {
        if (dir === "in") this.#lastProgress = this.#clock.now();
        tap?.(dir, msg, dir === "in" && this.#replaying && msg.method === "session/update");
      },
      onRequest: (method, params) => this.#onRequest(method, params),
      onNotification: (method, params) => {
        if (method === "session/update") this.#onUpdate(params);
      },
    });
    this.#proc.onData((chunk) => this.#peer.feed(chunk));
    void this.#proc.exited.then(() => {
      this.#exited = true;
      // No live session to set the user's selection back through: the record stays for the next delegation.
      if (!this.#stopping) this.#release(false);
      this.#peer.close(new ContractError("closed", "the agent's process exited"));
      if (!this.#stopping && this.#state !== "stopped") this.#state = "failed";
    });
  }

  /** Starts the ACP session on a launched process: `initialize`, then `session/new` or a reattach, then model and
   *  effort. A signed-out agent fails `sign_in`; the user signs in to it themselves, never through Clover. */
  static async open(opts: OpenOptions): Promise<AcpAgentSession> {
    const s = new AcpAgentSession(opts);
    try {
      await s.#start(opts);
      return s;
    } catch (err) {
      s.#stopping = true;
      s.#state = "failed";
      s.#peer.close();
      await opts.process.stop().catch(() => {});
      throw err;
    }
  }

  get agentSessionId(): string {
    return this.#agentSessionId;
  }

  get pid(): number {
    return this.#proc.pid;
  }

  get caps(): AgentCaps | undefined {
    return this.#caps;
  }

  /** The tool calls still running, for the stall watchdog. */
  openCalls(): ToolCallRecord[] {
    return [...this.#calls.values()].filter((c) => c.status === "pending" || c.status === "in_progress");
  }

  toolCall(id: string): ToolCallRecord | undefined {
    return this.#calls.get(id);
  }

  configOptions(): readonly ConfigOption[] {
    return this.#config;
  }

  state(): AgentSessionState {
    return this.#state;
  }

  lastProgressAt(): number {
    return this.#lastProgress;
  }

  /** A permission request is waiting on its answer (a card, for the user): the watchdog doesn't count the wait. */
  waitingOnUser(): boolean {
    return this.#asking > 0;
  }

  onPermission(fn: (ask: AgentPermissionAsk) => Promise<AgentPermissionAnswer>): void {
    this.#permission = fn;
  }

  onEvent(fn: (event: AgentEvent) => void): Unsubscribe {
    return this.#events.add(fn);
  }

  async #start(opts: OpenOptions): Promise<void> {
    const timeoutMs = opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const init = await this.#call("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: opts.clientInfo ? { ...CLIENT_INFO, ...opts.clientInfo } : CLIENT_INFO,
    }, timeoutMs);
    const caps = readCaps(init);
    this.#caps = caps;
    if (caps.protocolVersion !== undefined && caps.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new ContractError("refused", `the agent speaks ACP version ${caps.protocolVersion}; Clover speaks ${ACP_PROTOCOL_VERSION}`);
    }
    const promptMeta = this.#systemPromptMeta(opts.instructions);
    if (opts.instructions && !promptMeta) this.#preamble = opts.instructions;
    const meta = promptMeta || opts.meta ? mergeMeta(promptMeta ?? {}, opts.meta ?? {}) : undefined;
    const base = { cwd: opts.cwd, mcpServers: opts.mcpServers, ...(meta ? { _meta: meta } : {}) };
    let result: unknown;
    if (opts.reattach) {
      const q = this.#quirks.sessions;
      const honestResume = q.resume.supported && !q.resume.replays && caps.resume;
      const load = q.load.supported && caps.loadSession;
      if (!honestResume && !load) throw new ContractError("refused", "this agent can't reattach to a session");
      this.#agentSessionId = opts.reattach.agentSessionId;
      this.reattachedWith = honestResume ? "resume" : "load";
      this.#replaying = true;
      try {
        result = await this.#call(honestResume ? "session/resume" : "session/load", { sessionId: this.#agentSessionId, ...base }, timeoutMs);
      } finally {
        this.#replaying = false;
      }
      // A later prompt is the agent's next turn; the bridge's essentials are already in its history.
      this.#preamble = undefined;
    } else {
      result = await this.#call("session/new", base, timeoutMs);
      const id = str(obj(result)?.["sessionId"]);
      if (!id) throw new ContractError("failed", "the agent answered session/new without a session id");
      this.#agentSessionId = id;
    }
    this.#config = readConfigOptions(obj(result)?.["configOptions"]) ?? this.#config;
    const modes = obj(obj(result)?.["modes"]);
    if (modes) {
      const available = (Array.isArray(modes["availableModes"]) ? modes["availableModes"] : []).map((m) => str(obj(m)?.["id"])).filter((x): x is string => !!x);
      const current = str(modes["currentModeId"]);
      this.#modes = { available, ...(current ? { current } : {}) };
    }
    await this.#setBackLeftovers();
    if (this.#modeFloor) await this.#holdModeFloor(this.#modeFloor(this.#level));
    if (opts.readOnly) await this.setReadOnly(true);
    if (opts.model !== undefined) await this.setConfig("model", opts.model);
    if (opts.effort !== undefined && !this.#quirks.config.effortInModel) await this.setConfig("effort", opts.effort);
    this.#state = "ready";
  }

  #systemPromptMeta(instructions: string | undefined): Obj | undefined {
    if (!instructions) return undefined;
    switch (this.#quirks.mcp.systemPromptChannel) {
      case "_meta.antigravity.systemPrompt.append":
        return this.#caps?.systemPromptAppend ? { antigravity: { systemPrompt: { append: instructions } } } : undefined;
      case "_meta.systemPrompt":
        return { systemPrompt: { append: instructions } };
      default:
        // `acp.systemPrompt` is a draft field no agent S5 ran offers; the first prompt carries the essentials.
        return undefined;
    }
  }

  /** A request whose error answer becomes a contract error: `sign_in` when the agent needs its own login. */
  async #call(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    try {
      return await this.#peer.request(method, params, timeoutMs === undefined ? {} : { timeoutMs });
    } catch (err) {
      if (err instanceof RpcError) {
        if (isAuthRequired(err, this.#quirks.auth.requiredError)) {
          throw new ContractError("sign_in", "this agent needs its own sign-in: sign in to it yourself, then try again", { method });
        }
        throw new ContractError("failed", `the agent refused ${method}: ${err.message}`, { method, code: err.code });
      }
      if (err instanceof ContractError) throw err;
      throw new ContractError(this.#exited ? "closed" : "failed", err instanceof Error ? err.message : String(err), { method });
    }
  }

  async prompt(input: { text: string; images?: { mimeType: string; data: string }[] }): Promise<AgentTurnEnd> {
    if (this.#state === "stopped" || this.#state === "failed") throw new ContractError("closed", "the agent's session has ended");
    if (this.#state === "prompting" || this.#state === "cancelling") throw new ContractError("conflict", "a turn is running; the host queues the next prompt");
    if (this.#state === "starting") throw new ContractError("conflict", "the agent is still starting");
    // A mode the agent switched itself into since (a `current_mode_update`) is held to the floor before each turn.
    if (this.#modeFloor) await this.#holdFloorOrStop();
    const turn: Turn = { text: "", abort: new AbortController(), toolIds: new Set(), endedOnRefusal: false };
    this.#turn = turn;
    this.#state = "prompting";
    const text = this.#preamble ? `${this.#preamble}\n\n---\n\n${input.text}` : input.text;
    this.#preamble = undefined;
    const blocks: Obj[] = [{ type: "text", text }];
    if (this.#caps?.image) for (const img of input.images ?? []) blocks.push({ type: "image", mimeType: img.mimeType, data: img.data });
    const run = (async (): Promise<AgentTurnEnd> => {
      let stopReason: AgentTurnEnd["stopReason"];
      let errorText: string | undefined;
      try {
        const result = obj(await this.#peer.request("session/prompt", { sessionId: this.#agentSessionId, prompt: blocks }));
        stopReason = mapStopReason(str(result?.["stopReason"]));
        const usage = obj(result?.["usage"]);
        const inTok = usage ? Number(usage["inputTokens"]) : NaN;
        const outTok = usage ? Number(usage["outputTokens"]) : NaN;
        if (this.#quirks.turns.reportsUsage && Number.isFinite(inTok) && Number.isFinite(outTok)) {
          turn.usage = { inputTokens: inTok, outputTokens: outTok };
          this.#emit({ type: "usage", inputTokens: inTok, outputTokens: outTok });
        }
      } catch (err) {
        if (this.#stopping || turn.abort.signal.aborted) stopReason = "cancelled";
        else if (err instanceof RpcError && isAuthRequired(err, this.#quirks.auth.requiredError)) {
          throw new ContractError("sign_in", "this agent needs its own sign-in: sign in to it yourself, then try again");
        } else if (this.#exited || (err instanceof ContractError && err.code === "closed")) {
          throw new ContractError("closed", "the agent's process exited during the turn", { crashed: true });
        } else {
          stopReason = "error";
          errorText = err instanceof Error ? err.message : String(err);
        }
      }
      if (stopReason === "end_turn" && this.#quirks.turns.refusal === "ends-turn" && turn.endedOnRefusal) stopReason = "refusal";
      if (stopReason === "cancelled") this.#closeOpenCalls(turn);
      return { stopReason, text: turn.text || (errorText ?? ""), ...(turn.usage ? { usage: turn.usage } : {}) };
    })();
    this.#turnDone = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      turn.abort.abort();
      if (this.#turn === turn) this.#turn = undefined;
      if (this.#state === "prompting" || this.#state === "cancelling") this.#state = this.#exited ? "failed" : "idle";
    }
  }

  async cancel(): Promise<void> {
    const turn = this.#turn;
    if (this.#state !== "prompting" || !turn) return;
    this.#state = "cancelling";
    this.#peer.notify("session/cancel", { sessionId: this.#agentSessionId });
    // Pending permission requests are answered `cancelled` (ACP requires it of a client).
    turn.abort.abort();
    const done = this.#turnDone;
    if (!done) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([done, new Promise((r) => (timer = setTimeout(r, AGENT_CANCEL_WAIT_MS)))]);
    clearTimeout(timer);
  }

  async setConfig(option: "model" | "effort", value: string): Promise<void> {
    if (this.#state === "stopped" || this.#state === "failed") throw new ContractError("closed", "the agent's session has ended");
    const q = this.#quirks.config;
    const id = option === "model" ? q.modelOption : q.effortOption;
    if (id === null) {
      throw new ContractError("refused", `this agent takes no ${option} option${option === "effort" && q.effortInModel ? "; its effort is part of the model" : ""}`);
    }
    await this.#setOption(id, value);
  }

  /** A choice an earlier delegation left in the user's own settings (its process crashed before it could set it
   *  back): set back now, before anything else (check 2's minor 4). */
  async #setBackLeftovers(): Promise<void> {
    if (!this.#quirks.config.choicePersists) return;
    const { keeper, backend } = this.#selections;
    for (const c of [...this.#config]) {
      const user = keeper.leftover(backend, c.id, c.currentValue);
      if (user === undefined || user === c.currentValue) {
        if (user !== undefined) keeper.restored(backend, c.id);
        continue;
      }
      const result = await this.#call("session/set_config_option", { sessionId: this.#agentSessionId, configId: c.id, value: user }, CONFIG_TIMEOUT_MS).catch(() => undefined);
      if (result === undefined) continue;
      keeper.restored(backend, c.id);
      this.#config = readConfigOptions(result) ?? this.#config;
    }
  }

  /** The level as it is now (the manager's, at every turn): the mode floor follows it, so a mode the level allowed
   *  when the session started (`acceptEdits` at accept-edits) is switched to the floor's fallback when it drops. */
  async setLevel(level: Level): Promise<void> {
    this.#level = level;
    if (!this.#modeFloor) return;
    if (this.#state === "ready" || this.#state === "idle") return this.#holdFloorOrStop();
    // A running turn (the manager pushes a level change straight away): the mode is switched under it, since an agent
    // in a mode the level no longer allows (Claude Code's acceptEdits) would edit without asking until the turn ends.
    // Not confirmed in time, the turn is cancelled; the next turn's floor then ends a session that still hasn't left it.
    if (this.#state === "prompting") {
      const held = await this.#holdModeFloor(this.#modeFloor(level)).then(() => true, () => false);
      if (!held && this.#state === "prompting") await this.cancel();
    }
  }

  /** The floor at the current level on a running session: an agent that doesn't leave a refused mode is stopped. */
  async #holdFloorOrStop(): Promise<void> {
    try {
      await this.#holdModeFloor(this.#modeFloor!(this.#level));
    } catch (err) {
      await this.stop().catch(() => {});
      this.#state = "failed";
      throw err;
    }
  }

  /** The modes the agent says it is in: its `mode` config option and ACP's session modes. */
  #currentModes(): string[] {
    return [this.#config.find((c) => c.id === "mode")?.currentValue, this.#modes?.current].filter((m): m is string => m !== undefined);
  }

  /** Waits for the agent's `current_mode_update` to report a mode `ok` accepts, up to the confirm time. */
  #confirmMode(ok: (mode: string) => boolean): Promise<boolean> {
    if (this.#modes?.current !== undefined && ok(this.#modes.current)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v: boolean) => {
        clearTimeout(timer);
        this.#modeWaiters.delete(check);
        resolve(v);
      };
      const check = () => {
        if (this.#modes?.current !== undefined && ok(this.#modes.current)) done(true);
      };
      const timer = setTimeout(() => done(false), this.#modeConfirmMs);
      this.#modeWaiters.add(check);
    });
  }

  /** Holds the floor: a mode it doesn't allow is switched to its fallback (the `mode` config option, whose answer
   *  carries the new value, or ACP's `session/set_mode`, confirmed only by the agent's own `current_mode_update`), and
   *  this throws `refused` unless the agent then reports only modes the floor allows. With an allow-list, a session
   *  that reports no mode at all is refused too. */
  async #holdModeFloor(floor: ModeFloor): Promise<void> {
    const bad = () => this.#currentModes().filter((m) => !floorAllows(floor, m));
    const refuse = (why: string): never => {
      throw new ContractError("refused", `the agent ${why}, which this level doesn't allow, so its session was ended`);
    };
    if (floor.allowed !== undefined && this.#currentModes().length === 0) refuse("reports no mode Clover has checked");
    if (bad().length === 0) return;
    const was = bad()[0]!;
    const to = floor.fallback;
    if (to === undefined || !floorAllows(floor, to)) refuse(`is in its ${was} mode and Clover has no mode to switch it to`);
    const o = this.#config.find((c) => c.id === "mode");
    if (o && !floorAllows(floor, o.currentValue ?? "") && o.values.includes(to!)) await this.#setOption(o.id, to!);
    if (this.#modes?.current !== undefined && !floorAllows(floor, this.#modes.current) && this.#modes.available.includes(to!)) {
      const confirmed = this.#confirmMode((m) => floorAllows(floor, m));
      await this.#call("session/set_mode", { sessionId: this.#agentSessionId, modeId: to }, CONFIG_TIMEOUT_MS);
      await confirmed;
    }
    if (bad().length > 0) refuse(`is in its ${was} mode and didn't confirm leaving it`);
  }

  /** Switches the agent into its read-only mode, or back to the mode it had: its `mode` config option, else ACP's
   *  `session/set_mode`. Refused when it offers no read-only mode, or its answer doesn't show the mode set (check 1's
   *  minor 11: Clover counts on the agent's own word only once it says so). */
  async setReadOnly(on: boolean): Promise<void> {
    if (on === this.#readOnly) return;
    const mode = this.#readOnlyMode;
    const option = mode ? this.#config.find((c) => c.id === mode.option) : undefined;
    const refuse = (why: string): never => {
      throw new ContractError("refused", `this agent acts without asking and ${why}, so it can't run at read-only`);
    };
    // An unconfirmed switch on a running session ends it, as the mode floor does: Clover never counts on a read-only
    // mode the agent hasn't reported itself (its config option's answer, or its own `current_mode_update`).
    const unconfirmed = async (): Promise<never> => {
      if (this.#state === "ready" || this.#state === "idle") {
        await this.stop().catch(() => {});
        this.#state = "failed";
      }
      return refuse("didn't confirm its read-only mode");
    };
    // A read-only value the sandbox writer's floor doesn't allow (Codex's own read-only preset, which may replace the
    // writer's profile) is never picked.
    const allowed = (v: string) => !this.#modeFloor || floorAllows(this.#modeFloor(this.#level), v);
    if (on) {
      if (option) {
        const value = mode!.values.find((v) => option.values.includes(v) && allowed(v));
        if (value === undefined) refuse("offers no read-only mode");
        this.#modeBefore = option.currentValue;
        if (option.currentValue !== value) await this.#setOption(option.id, value!);
        if (this.#config.find((c) => c.id === option.id)?.currentValue !== value) await unconfirmed();
      } else {
        const value = mode?.values.find((v) => this.#modes?.available.includes(v) && allowed(v));
        if (value === undefined) refuse("offers no read-only mode");
        this.#modeBefore = this.#modes!.current;
        if (this.#modes!.current !== value) {
          const confirmed = this.#confirmMode((m) => m === value);
          await this.#call("session/set_mode", { sessionId: this.#agentSessionId, modeId: value }, CONFIG_TIMEOUT_MS);
          if (!(await confirmed)) await unconfirmed();
        }
      }
      this.#readOnly = true;
      return;
    }
    if (this.#modeBefore !== undefined) {
      if (option && option.currentValue !== this.#modeBefore) await this.#setOption(option.id, this.#modeBefore);
      else if (!option && this.#modes && this.#modes.current !== this.#modeBefore) {
        // Back to the mode it had: its own `current_mode_update` moves `#modes.current`; unconfirmed, it stays read-only,
        // which costs nothing.
        const back = this.#modeBefore;
        const confirmed = this.#confirmMode((m) => m === back);
        await this.#call("session/set_mode", { sessionId: this.#agentSessionId, modeId: back }, CONFIG_TIMEOUT_MS);
        await confirmed;
      }
    }
    this.#readOnly = false;
  }

  async #setOption(id: string, value: string): Promise<void> {
    const persists = this.#quirks.config.choicePersists;
    const { keeper, backend } = this.#selections;
    if (persists && !this.#held.has(id)) {
      keeper.begin(backend, id, this, this.#config.find((c) => c.id === id)?.currentValue);
      this.#held.add(id);
    }
    const result = await this.#call("session/set_config_option", { sessionId: this.#agentSessionId, configId: id, value }, CONFIG_TIMEOUT_MS);
    if (persists) keeper.set(backend, id, value);
    this.#config = readConfigOptions(result) ?? this.#config;
  }

  /** Lets go of the options this session changed; the last holder sets the user's own value back when it can. */
  #release(canRestore: boolean): Promise<void>[] {
    const { keeper, backend } = this.#selections;
    const sets: Promise<void>[] = [];
    for (const id of this.#held) {
      const user = keeper.end(backend, id, this, canRestore);
      if (user === undefined || !canRestore) continue;
      sets.push(this.#peer.request("session/set_config_option", { sessionId: this.#agentSessionId, configId: id, value: user }, { timeoutMs: 5_000 })
        .then(() => keeper.restored(backend, id), () => {}));
    }
    this.#held.clear();
    return sets;
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#stopping = true;
    if (this.#state === "prompting") await this.cancel();
    // A delegation's choice became the user's own selection: the last one to end sets it back (S5 edit 11).
    await Promise.all(this.#release(!this.#exited));
    this.#peer.close(new ContractError("closed", "the agent's session was stopped"));
    await this.#proc.stop();
    this.#state = "stopped";
  }

  async #onRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "session/request_permission":
        return { outcome: await this.#onPermission(obj(params)) };
      case "elicitation/create":
      case "session/elicitation":
        // A URL-mode sign-in would open a browser; form elicitations come with M2's cards. Declined for now.
        return { action: "decline" };
      default:
        throw new RpcError(RPC_METHOD_NOT_FOUND, `Clover's client doesn't offer ${method}`);
    }
  }

  async #onPermission(params: Obj | undefined): Promise<AgentPermissionAnswer> {
    const toolCall = obj(params?.["toolCall"]);
    const id = str(toolCall?.["toolCallId"]) ?? "";
    const record = this.#merge(id, toolCall, false);
    const options = readPermissionOptions(params?.["options"]);
    const turn = this.#turn;
    const names = this.#quirks.permissions.mcpNames;
    const server = names ? str(at(record, names.server)) : undefined;
    const tool = names ? str(at(record, names.tool)) : undefined;
    const ask: AgentPermissionAsk = {
      toolCallId: id,
      toolKind: record.kind,
      title: record.title,
      ...(record.rawInput === undefined ? {} : { rawInput: record.rawInput }),
      ...(server && tool ? { mcp: { server, tool } } : {}),
      options,
      paths: pathsOf(record.fields, record.rawInput),
    };
    let answer: AgentPermissionAnswer = { outcome: "cancelled" };
    if (this.#asking >= MAX_OPEN_ASKS) {
      // A flood: refused without a card (review 12).
      const reject = options.find((o) => o.kind === "reject_once");
      answer = reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
    } else if (this.#permission && turn && !turn.abort.signal.aborted && !this.#replaying) {
      const cancelled = new Promise<AgentPermissionAnswer>((resolve) => {
        turn.abort.signal.addEventListener("abort", () => resolve({ outcome: "cancelled" }), { once: true });
      });
      this.#asking++;
      try {
        answer = await Promise.race([this.#permission(ask).catch((): AgentPermissionAnswer => ({ outcome: "cancelled" })), cancelled]);
      } finally {
        this.#asking--;
        // The stall window starts again from the answer: the wait was the user's, not the agent's.
        this.#lastProgress = this.#clock.now();
      }
      if (turn.abort.signal.aborted) answer = { outcome: "cancelled" };
    }
    answer = onceOnly(answer, options);
    const kind = answer.outcome === "selected" ? options.find((o) => o.optionId === answer.optionId)?.kind : undefined;
    record.decision = answer.outcome === "cancelled" ? "cancelled" : kind === "allow_once" ? "allowed" : "refused";
    // An allowed command starts now, for the watchdog's command limit.
    if (record.decision === "allowed") record.startedAtWall = Date.now();
    if (turn) turn.endedOnRefusal = record.decision !== "allowed";
    return answer;
  }

  #onUpdate(params: unknown): void {
    if (this.#replaying) {
      this.droppedReplay++;
      return;
    }
    const update = obj(obj(params)?.["update"]);
    const turn = this.#turn;
    switch (str(update?.["sessionUpdate"])) {
      case "agent_message_chunk": {
        const text = textOf(update?.["content"]);
        if (!text) return;
        if (turn) {
          turn.text += text;
          turn.endedOnRefusal = false;
        }
        this.#emit({ type: "text", text });
        return;
      }
      case "agent_thought_chunk": {
        const text = textOf(update?.["content"]);
        if (text) this.#emit({ type: "thought", text });
        return;
      }
      case "tool_call": {
        const id = str(update?.["toolCallId"]);
        if (!id) return;
        const r = this.#merge(id, update, true);
        if (turn) {
          turn.text = "";
          turn.toolIds.add(id);
        }
        this.#emit({ type: "tool_call", id, kind: r.kind, title: r.title, status: r.status, ...(r.rawInput === undefined ? {} : { rawInput: r.rawInput }) });
        return;
      }
      case "tool_call_update": {
        const id = str(update?.["toolCallId"]);
        if (!id) return;
        const before = this.#calls.get(id)?.status;
        const r = this.#merge(id, update, false);
        if (turn) turn.toolIds.add(id);
        const status = readToolStatus(update?.["status"]);
        if (status && status !== before) {
          const refused = r.decision === "refused" && (status === "completed" || status === "failed");
          this.#emit({ type: "tool_call_update", id, status, ...(refused ? { refused: true } : {}) });
        }
        return;
      }
      default:
        // Plans, commands, modes, titles, config and usage updates: progress, recorded on the wire.
        if (str(update?.["sessionUpdate"]) === "config_option_update") this.#config = readConfigOptions(update?.["configOptions"]) ?? this.#config;
        if (str(update?.["sessionUpdate"]) === "current_mode_update" && this.#modes) {
          const id = str(update?.["currentModeId"]) ?? str(update?.["modeId"]);
          if (id) {
            this.#modes.current = id;
            for (const w of [...this.#modeWaiters]) w();
            // The agent left its read-only mode on its own: Clover no longer counts on it.
            if (this.#readOnly && !this.#readOnlyMode?.values.includes(id)) this.#readOnly = false;
          }
        }
        return;
    }
  }

  /** Merges a `tool_call`, a `tool_call_update` or a permission request's `toolCall` into Clover's record. */
  #merge(id: string, src: Obj | undefined, created: boolean): ToolCallRecord {
    let r = this.#calls.get(id);
    if (!r) {
      r = { id, kind: "other", title: "", status: "pending", fields: {}, startedAtWall: Date.now() };
      this.#calls.set(id, r);
    } else if (created) {
      r.startedAtWall = Date.now();
    }
    if (!src) return r;
    const kind = str(src["kind"]);
    if (kind) r.kind = kind;
    const title = str(src["title"]);
    if (title) r.title = title;
    const status = readToolStatus(src["status"]);
    if (status) r.status = status;
    if (src["rawInput"] !== undefined && !(isEmptyObject(src["rawInput"]) && r.rawInput !== undefined)) r.rawInput = capRawInput(src["rawInput"]);
    for (const key of ["locations", "content"]) if (src[key] !== undefined) r.fields[key] = src[key];
    return r;
  }

  #closeOpenCalls(turn: Turn): void {
    for (const id of turn.toolIds) {
      const r = this.#calls.get(id);
      if (!r || (r.status !== "pending" && r.status !== "in_progress")) continue;
      r.status = "failed";
      r.closedByClover = true;
      this.#emit({ type: "tool_call_update", id, status: "failed", closedByClover: true });
    }
  }

  #emit(event: AgentEvent): void {
    this.#events.emit(event);
  }
}

/** A deep merge of two `_meta` objects; the second wins on a clash of plain values. */
function mergeMeta(a: Obj, b: Obj): Obj {
  const out: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = obj(v) && obj(out[k]) ? mergeMeta(out[k] as Obj, v as Obj) : v;
  return out;
}

/** A `rawInput` too long to keep whole becomes a preview of its JSON (review 12); with no `command` left, a card for
 *  it offers no "always". */
export function capRawInput(v: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(v) ?? "";
  } catch {
    return { clover_unreadable: true };
  }
  return json.length <= MAX_RAW_INPUT_CHARS ? v : { clover_truncated: json.slice(0, 4096), length: json.length };
}

function isEmptyObject(v: unknown): boolean {
  const o = obj(v);
  return o !== undefined && Object.keys(o).length === 0;
}

function mapStopReason(s: string | undefined): AgentTurnEnd["stopReason"] {
  switch (s) {
    case "end_turn":
    case "refusal":
    case "cancelled":
    case "max_tokens":
      return s;
    case "max_turn_requests":
      return "max_tokens";
    default:
      return "end_turn";
  }
}

/** Holds an answer to a "once" option (S5 edit 5): an "always" becomes the matching "once", a refusal with no
 *  `reject_once` becomes `cancelled`, and an option the agent didn't offer becomes `cancelled`. */
export function onceOnly(answer: AgentPermissionAnswer, options: readonly AgentPermissionOption[]): AgentPermissionAnswer {
  if (answer.outcome !== "selected") return answer;
  const picked = options.find((o) => o.optionId === answer.optionId);
  if (!picked) return { outcome: "cancelled" };
  if (picked.kind === "allow_once" || picked.kind === "reject_once") return answer;
  const want = picked.kind === "allow_always" ? "allow_once" : "reject_once";
  const once = options.find((o) => o.kind === want);
  if (once) return { outcome: "selected", optionId: once.optionId };
  const reject = options.find((o) => o.kind === "reject_once");
  return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
}
