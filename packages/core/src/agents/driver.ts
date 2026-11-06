// The session driver for an ACP agent (spine `SessionDriver`, contracts/session-host.ts): the session host keeps the
// agent's state, log, queue and task notifications; this runs its turns on the agent.
//
// * It can't fold (`canFold: false`): ACP has no standard mid-turn input, so the host queues a message that arrives
//   during a turn and sends it as the next prompt (S5 §8).
// * The agent starts lazily, in the first turn, so `Agent` returns at once (§9.3 "starts a background agent and
//   returns at once"). A sign-in the agent needs, a crash, or a stall ends the turn `failed` with that reason, and the
//   agent's process is ended with it, since the host gives a failed session no further turns.
// * The agent's events are recorded in the session's log as the driver's own (`ctl.record`): text and thinking
//   coalesced into runs of at most a quarter second, tool calls and their updates as they come. That log is the live
//   transcript a client follows (`session.attach`); `acp.ndjson` is the raw wire.
// * The user's interrupt is ACP's `session/cancel`; `stop` cancels, then ends the agent's process group.
// * Everything recorded and the turn's final text pass `redact` first (review 9): the bridge's token must not reach the
//   session's log through the agent's own words or a tool call's input.
import type { AgentEvent, AgentSession } from "../contracts/agent-backend";
import { isContractError } from "../contracts/common";
import type { SessionDriver, TurnControl, TurnEnd, TurnInput } from "../contracts/session-host";
import type { TurnOrigin } from "@waifucave/clover-protocol";

export interface AgentDriverOptions {
  /** Starts the agent (or reattaches to it); called once, by the first turn. */
  start(): Promise<AgentSession>;
  /** The prompt a turn's input becomes. */
  promptOf(input: TurnInput): Promise<{ text: string; images?: { mimeType: string; data: string }[] }>;
  /** Called once the agent's process is gone for good: revoke the token, stop watching. */
  ended?(): void;
  /** How long text may wait before it is recorded. */
  coalesceMs?: number;
  /** Applied to every record and to each turn's text before they leave the driver. */
  redact?: <T>(value: T) => T;
}

/** What the driver records in the session's log. */
export type AgentLogEvent =
  | { type: "agent_text"; text: string }
  | { type: "agent_thought"; text: string }
  | { type: "agent_tool_call"; id: string; kind: string; title: string; status: string; rawInput?: unknown }
  | { type: "agent_tool_call_update"; id: string; status: string; refused?: boolean; closedByClover?: boolean }
  | { type: "agent_usage"; inputTokens: number; outputTokens: number }
  | { type: "agent_started"; agentSessionId: string };

export class AgentDriver implements SessionDriver {
  readonly canFold = false;
  readonly #opts: AgentDriverOptions;
  #session: AgentSession | undefined;
  #starting: Promise<AgentSession> | undefined;
  #origin: TurnOrigin | undefined;
  #signal: AbortSignal | undefined;
  #stopping = false;
  #stalled = false;
  #ended = false;
  #pendingModel: { model: string; effort?: string } | undefined;

  constructor(opts: AgentDriverOptions) {
    this.#opts = opts;
  }

  get session(): AgentSession | undefined {
    return this.#session;
  }

  /** The running turn's origin, for the approval request: only the user's own turn makes a card wait (§5.5). */
  currentOrigin(): TurnOrigin | undefined {
    return this.#origin;
  }

  /** The running turn's signal: a request the turn made is withdrawn with it. */
  currentSignal(): AbortSignal | undefined {
    return this.#signal;
  }

  busy(): boolean {
    return this.#origin !== undefined;
  }

  async #ensure(): Promise<AgentSession> {
    if (this.#session) return this.#session;
    this.#starting ??= this.#opts.start().then(async (s) => {
      this.#session = s;
      if (this.#pendingModel) {
        const m = this.#pendingModel;
        this.#pendingModel = undefined;
        await s.setConfig("model", m.model);
        if (m.effort !== undefined) await s.setConfig("effort", m.effort).catch(() => {});
      }
      return s;
    });
    return this.#starting;
  }

  async turn(input: TurnInput, ctl: TurnControl): Promise<TurnEnd> {
    const end = await this.#turn(input, ctl);
    return this.#opts.redact && end.text !== undefined ? { ...end, text: this.#opts.redact(end.text) } : end;
  }

  #record(ctl: TurnControl, e: AgentLogEvent): void {
    ctl.record(this.#opts.redact ? this.#opts.redact(e) : e);
  }

  async #turn(input: TurnInput, ctl: TurnControl): Promise<TurnEnd> {
    if (this.#stopping) return { reason: "stopped" };
    this.#origin = ctl.origin;
    this.#signal = ctl.signal;
    let session: AgentSession;
    try {
      const fresh = !this.#session;
      session = await this.#ensure();
      if (fresh) this.#record(ctl, { type: "agent_started", agentSessionId: session.agentSessionId });
    } catch (err) {
      this.#origin = undefined;
      this.#signal = undefined;
      return this.#fail(err);
    }
    const flusher = new TextRuns((e) => this.#record(ctl, e), this.#opts.coalesceMs ?? 250);
    const off = session.onEvent((e) => flusher.push(e));
    const onAbort = () => {
      if (!this.#stopping) void session.cancel();
    };
    ctl.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const prompt = await this.#opts.promptOf(input);
      const end = await session.prompt(prompt);
      flusher.flush();
      if (this.#stalled) return await this.#failStalled();
      if (this.#stopping) return { reason: "stopped", text: end.text };
      switch (end.stopReason) {
        case "cancelled":
          return ctl.signal.aborted ? { reason: "interrupted", text: end.text } : { reason: "cancelled", text: end.text, ...(end.usage ? { usage: end.usage } : {}) };
        case "refusal":
          return { reason: "refusal", text: end.text, ...(end.usage ? { usage: end.usage } : {}) };
        case "error":
          await this.#shutdown();
          return { reason: "failed", failure: "error", text: end.text };
        default:
          return { reason: "end_turn", text: end.text, ...(end.usage ? { usage: end.usage } : {}) };
      }
    } catch (err) {
      flusher.flush();
      if (this.#stalled) return await this.#failStalled();
      if (this.#stopping) return { reason: "stopped" };
      return this.#fail(err);
    } finally {
      off();
      ctl.signal.removeEventListener("abort", onAbort);
      this.#origin = undefined;
      this.#signal = undefined;
    }
  }

  async #failStalled(): Promise<TurnEnd> {
    await this.#shutdown();
    return { reason: "failed", failure: "stalled", text: "The agent made no progress for 10 minutes, so Clover stopped it." };
  }

  async #fail(err: unknown): Promise<TurnEnd> {
    await this.#shutdown();
    const text = err instanceof Error ? err.message : String(err);
    if (isContractError(err, "sign_in")) return { reason: "failed", failure: "sign-in", text };
    if (isContractError(err, "closed")) return { reason: "failed", failure: "crashed", text: "The agent's process exited." };
    return { reason: "failed", failure: "error", text };
  }

  async interrupt(): Promise<void> {
    await this.#session?.cancel();
  }

  /** The watchdog found no progress for 10 minutes: the turn ends `failed`, `stalled`. */
  async stall(): Promise<void> {
    if (this.#stopping || this.#ended) return;
    this.#stalled = true;
    await this.#session?.stop();
  }

  async setModel(model: string, effort?: string): Promise<void> {
    if (!this.#session) {
      this.#pendingModel = { model, ...(effort === undefined ? {} : { effort }) };
      return;
    }
    await this.#session.setConfig("model", model);
    if (effort !== undefined) await this.#session.setConfig("effort", effort);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#shutdown();
  }

  /** The daemon is closing: the agent's process ends, and the session isn't ended (no `ended`), so a later daemon
   *  can reattach it. */
  async detach(): Promise<void> {
    this.#stopping = true;
    this.#ended = true;
    const s = this.#session ?? (await this.#starting?.catch(() => undefined));
    await s?.stop().catch(() => {});
  }

  async #shutdown(): Promise<void> {
    const s = this.#session ?? (await this.#starting?.catch(() => undefined));
    await s?.stop().catch(() => {});
    if (!this.#ended) {
      this.#ended = true;
      this.#opts.ended?.();
    }
  }
}

/** Coalesces text and thinking chunks into runs, so the log isn't one record per word. */
class TextRuns {
  #kind: "agent_text" | "agent_thought" | undefined;
  #text = "";
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly record: (e: AgentLogEvent) => void,
    readonly ms: number,
  ) {}

  push(e: AgentEvent): void {
    if (e.type === "text" || e.type === "thought") {
      const kind = e.type === "text" ? "agent_text" : "agent_thought";
      if (this.#kind !== kind) this.flush();
      this.#kind = kind;
      this.#text += e.text;
      if (this.#text.length >= 4096) this.flush();
      else this.#timer ??= setTimeout(() => this.flush(), this.ms);
      return;
    }
    this.flush();
    switch (e.type) {
      case "tool_call":
        this.record({ type: "agent_tool_call", id: e.id, kind: e.kind, title: e.title, status: e.status, ...(e.rawInput === undefined ? {} : { rawInput: e.rawInput }) });
        return;
      case "tool_call_update":
        this.record({ type: "agent_tool_call_update", id: e.id, status: e.status, ...(e.refused ? { refused: true } : {}), ...(e.closedByClover ? { closedByClover: true } : {}) });
        return;
      case "usage":
        this.record({ type: "agent_usage", inputTokens: e.inputTokens, outputTokens: e.outputTokens });
        return;
      default:
        return;
    }
  }

  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#kind && this.#text) this.record({ type: this.#kind, text: this.#text });
    this.#kind = undefined;
    this.#text = "";
  }
}
