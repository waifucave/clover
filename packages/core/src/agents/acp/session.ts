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
//   (Cursor, S5 edit 11), `stop` sets the user's selection back.
// * **Progress** for the stall watchdog: any message from the agent, stamped on the session's clock.
//
// The client advertises neither `fs` nor `terminal`: agents use their own tools, inside their own sandbox (§9.3).
// Reaching the folder tree and Bash under the fence through those doors comes with Gemini CLI, which uses them (M2).
import type {
  AgentEvent, AgentPermissionAnswer, AgentPermissionAsk, AgentQuirks, AgentSession, AgentSessionState, AgentTurnEnd,
} from "../../contracts/agent-backend";
import { AGENT_CANCEL_WAIT_MS } from "../../contracts/agent-backend";
import type { AgentPermissionOption } from "../../contracts/approval-broker";
import type { Clock } from "../../contracts/clock";
import { ContractError, Listeners, type Unsubscribe } from "../../contracts/common";
import { RPC_METHOD_NOT_FOUND, RpcError, RpcPeer, type JsonRpcMessage } from "./jsonrpc";
import {
  ACP_PROTOCOL_VERSION, type AgentCaps, type ConfigOption, type StdioMcpServer, at, isAuthRequired, obj, pathsOf, readCaps,
  readConfigOptions, readPermissionOptions, readToolStatus, str, textOf, type Obj, type ToolStatus,
} from "./types";

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
  reattach?: { agentSessionId: string };
  model?: string;
  effort?: string;
  tap?: WireTap;
  clientInfo?: { name: string; version: string };
  /** How long `initialize` and `session/new` may take. */
  startTimeoutMs?: number;
}

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
  /** The user's own model selection, kept to set back on stop where a choice persists (S5 edit 11). */
  #userModel: string | undefined;
  #modelChanged = false;
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
    const meta = this.#systemPromptMeta(opts.instructions);
    if (opts.instructions && !meta) this.#preamble = opts.instructions;
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
    if (done) await Promise.race([done, new Promise((r) => setTimeout(r, AGENT_CANCEL_WAIT_MS))]);
  }

  async setConfig(option: "model" | "effort", value: string): Promise<void> {
    if (this.#state === "stopped" || this.#state === "failed") throw new ContractError("closed", "the agent's session has ended");
    const q = this.#quirks.config;
    const id = option === "model" ? q.modelOption : q.effortOption;
    if (id === null) {
      throw new ContractError("refused", `this agent takes no ${option} option${option === "effort" && q.effortInModel ? "; its effort is part of the model" : ""}`);
    }
    if (option === "model" && q.choicePersists && !this.#modelChanged) {
      this.#userModel = this.#config.find((c) => c.id === id)?.currentValue;
    }
    const result = await this.#call("session/set_config_option", { sessionId: this.#agentSessionId, configId: id, value }, CONFIG_TIMEOUT_MS);
    if (option === "model") this.#modelChanged = true;
    this.#config = readConfigOptions(result) ?? this.#config;
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#stopping = true;
    if (this.#state === "prompting") await this.cancel();
    // A delegation's choice became the user's own selection: set it back (S5 edit 11).
    const q = this.#quirks.config;
    if (q.choicePersists && this.#modelChanged && this.#userModel !== undefined && q.modelOption && !this.#exited) {
      await this.#peer.request("session/set_config_option", { sessionId: this.#agentSessionId, configId: q.modelOption, value: this.#userModel }, { timeoutMs: 5_000 }).catch(() => {});
    }
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
    if (this.#permission && turn && !turn.abort.signal.aborted && !this.#replaying) {
      const cancelled = new Promise<AgentPermissionAnswer>((resolve) => {
        turn.abort.signal.addEventListener("abort", () => resolve({ outcome: "cancelled" }), { once: true });
      });
      answer = await Promise.race([this.#permission(ask).catch((): AgentPermissionAnswer => ({ outcome: "cancelled" })), cancelled]);
      if (turn.abort.signal.aborted) answer = { outcome: "cancelled" };
    }
    answer = onceOnly(answer, options);
    const kind = answer.outcome === "selected" ? options.find((o) => o.optionId === answer.optionId)?.kind : undefined;
    record.decision = answer.outcome === "cancelled" ? "cancelled" : kind === "allow_once" ? "allowed" : "refused";
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
    if (src["rawInput"] !== undefined && !(isEmptyObject(src["rawInput"]) && r.rawInput !== undefined)) r.rawInput = src["rawInput"];
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
