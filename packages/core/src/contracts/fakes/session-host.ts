// FakeSessionHost and FakeSessionDriver: the host's routing rules in memory, and a driver whose turns a test ends by
// hand. Pair the host with a FakeApprovalBroker (or anything with `withdrawSession` and `cancelSession`) to see cards
// withdrawn on an interrupt and cancelled on a stop.
import { randomBytes } from "node:crypto";
import { clampSentAt, type SessionStatus, type SessionView, type TurnOrigin } from "@waifucave/clover-protocol";
import type { ApprovalBroker } from "../approval-broker";
import { compareStamps, type Clock } from "../clock";
import { ContractError, Listeners, type Unsubscribe } from "../common";
import {
  originOf,
  type AgentStopReason, type DeliveredInput, type Disposition, type SessionDriver, type SessionHost, type SessionRecord,
  type SessionRecordBody, type SessionSpec, type TurnControl, type TurnEnd, type TurnInput, type UserInput,
} from "../session-host";

interface Running {
  origin: TurnOrigin;
  abort: AbortController;
  folds: Listeners<TurnInput>;
}

interface Hosted {
  view: SessionView;
  driver: SessionDriver;
  log: SessionRecord[];
  subscribers: Listeners<SessionRecord>;
  queue: TurnInput[];
  running?: Running;
  asleep: boolean;
}

export class FakeSessionHost implements SessionHost {
  readonly #clock: Clock;
  readonly #approvals: Pick<ApprovalBroker, "withdrawSession" | "cancelSession"> | undefined;
  readonly #epoch: (() => number) | undefined;
  readonly #sessions = new Map<string, Hosted>();
  readonly #watchers = new Listeners<SessionView>();

  constructor(opts: { clock: Clock; approvals?: Pick<ApprovalBroker, "withdrawSession" | "cancelSession">; epoch?: () => number }) {
    this.#clock = opts.clock;
    this.#approvals = opts.approvals;
    this.#epoch = opts.epoch;
  }

  open(spec: SessionSpec, driver: SessionDriver): SessionView {
    const id = spec.id ?? `s_${randomBytes(6).toString("hex")}`;
    if (this.#sessions.has(id)) throw new ContractError("conflict", `session ${id} is already open`);
    const now = this.#clock.now();
    const view: SessionView = {
      id, kind: spec.kind, computer: spec.computer, status: "ready", startedAt: now, updatedAt: now,
      ...(spec.bot === undefined ? {} : { bot: spec.bot }),
      ...(spec.parent === undefined ? {} : { parent: spec.parent }),
      ...(spec.title === undefined ? {} : { title: spec.title }),
      ...(spec.backend === undefined ? {} : { backend: spec.backend }),
      ...(spec.model === undefined ? {} : { model: spec.model }),
      ...(spec.effort === undefined ? {} : { effort: spec.effort }),
      ...(spec.root === undefined ? {} : { root: spec.root }),
      ...(spec.routine === undefined ? {} : { routine: spec.routine }),
    };
    const s: Hosted = { view, driver, log: [], subscribers: new Listeners(), queue: [], asleep: false };
    this.#sessions.set(id, s);
    this.#record(s, { type: "status", status: "ready" });
    this.#watchers.emit({ ...view });
    return { ...view };
  }

  list(filter: { bot?: string; kind?: SessionView["kind"]; parent?: string } = {}): SessionView[] {
    return [...this.#sessions.values()]
      .map((s) => s.view)
      .filter((v) => (filter.bot === undefined || v.bot === filter.bot) && (filter.kind === undefined || v.kind === filter.kind) && (filter.parent === undefined || v.parent === filter.parent))
      .map((v) => ({ ...v }));
  }

  get(id: string): SessionView | undefined {
    const s = this.#sessions.get(id);
    return s ? { ...s.view } : undefined;
  }

  async sendUser(id: string, input: Omit<UserInput, "from">): Promise<{ disposition: Disposition }> {
    const s = this.#live(id);
    if (s.asleep) throw new ContractError("bot_asleep", "can't reach the computer running this bot; the draft is kept");
    if (s.view.kind === "side-thread") throw new ContractError("refused", "a side thread takes no messages from the user");
    const full: UserInput = { from: "user", ...input, sentAt: clampSentAt(input.sentAt, this.#clock.now()) };
    if (s.running && s.view.kind === "bot") {
      this.#record(s, { type: "input", input: full, disposition: "interrupted" });
      // Ahead of anything else waiting; among the user's own waiting messages, in send order.
      this.#enqueueUser(s, full, true);
      await this.#interruptStep(s);
      this.#pump(s);
      return { disposition: "interrupted" };
    }
    return this.#accept(s, full);
  }

  /** The user's waiting messages keep send order on the shared clock, ties by device (§6.4), whatever order they
   *  arrived in: a message sent earlier from a slower device goes before one sent later. */
  #enqueueUser(s: Hosted, input: UserInput, aheadOfOthers: boolean): void {
    const stamp = (u: UserInput) => ({ t: u.sentAt, device: u.device });
    const at = s.queue.findIndex((q) => (q.from === "user" ? compareStamps(stamp(input), stamp(q)) < 0 : aheadOfOthers));
    s.queue.splice(at < 0 ? s.queue.length : at, 0, input);
  }

  async deliver(id: string, input: DeliveredInput): Promise<{ disposition: Disposition }> {
    const s = this.#live(id);
    if (input.from === "note") {
      this.#record(s, { type: "input", input, disposition: "note" });
      return { disposition: "note" };
    }
    return this.#accept(s, input);
  }

  async interrupt(id: string): Promise<void> {
    const s = this.#live(id);
    if (s.running) await this.#interruptStep(s);
  }

  async stop(id: string, reason = "stopped"): Promise<void> {
    const s = this.#sessions.get(id);
    if (!s || s.view.status === "stopped" || s.view.status === "failed") return;
    s.queue = [];
    s.running?.abort.abort(reason);
    this.#approvals?.cancelSession(id);
    await s.driver.stop();
    this.#setStatus(s, "stopped");
    if (s.view.kind === "agent") this.#notifyParent(s, "stopped", { reason: "stopped" });
  }

  history(id: string, opts: { afterSeq?: number; limit?: number } = {}): SessionRecord[] {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    const after = s.log.filter((r) => opts.afterSeq === undefined || r.seq > opts.afterSeq);
    return structuredClone(opts.limit === undefined ? after : after.slice(0, opts.limit));
  }

  subscribe(id: string, fn: (record: SessionRecord) => void): Unsubscribe {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    return s.subscribers.add(fn);
  }

  watch(fn: (view: SessionView) => void): Unsubscribe {
    return this.#watchers.add(fn);
  }

  /** The device lost (or regained) its connection to the computer running this session (§6.4). */
  setAsleep(id: string, asleep: boolean): void {
    const s = this.#sessions.get(id);
    if (s) s.asleep = asleep;
  }

  #live(id: string): Hosted {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    if (s.view.status === "stopped" || s.view.status === "failed") throw new ContractError("closed", `session ${id} has ended`);
    return s;
  }

  #accept(s: Hosted, input: TurnInput): { disposition: Disposition } {
    if (!s.running) {
      this.#record(s, { type: "input", input, disposition: "turn" });
      s.queue.push(input);
      this.#pump(s);
      return { disposition: "turn" };
    }
    if (input.from !== "user" && s.driver.canFold) {
      this.#record(s, { type: "input", input, disposition: "folded" });
      s.running.folds.emit(structuredClone(input));
      return { disposition: "folded" };
    }
    this.#record(s, { type: "input", input, disposition: "queued" });
    if (input.from === "user") this.#enqueueUser(s, input, false);
    else s.queue.push(input);
    return { disposition: "queued" };
  }

  async #interruptStep(s: Hosted): Promise<void> {
    if (!s.running) return;
    this.#setStatus(s, "cancelling");
    s.running.abort.abort("interrupted");
    this.#approvals?.withdrawSession(s.view.id);
    await s.driver.interrupt();
  }

  /** Starts the next queued turn if none runs. */
  #pump(s: Hosted): void {
    if (s.running || s.queue.length === 0) return;
    if (s.view.status === "stopped" || s.view.status === "failed") return;
    const input = s.queue.shift()!;
    const origin = originOf(input);
    const running: Running = { origin, abort: new AbortController(), folds: new Listeners() };
    s.running = running;
    this.#record(s, { type: "turn_started", origin });
    this.#setStatus(s, "prompting");
    const ctl: TurnControl = {
      origin,
      signal: running.abort.signal,
      onFold: (fn) => running.folds.add(fn),
      record: (event) => this.#record(s, { type: "driver", event: structuredClone(event) }),
    };
    void Promise.resolve()
      .then(() => s.driver.turn(structuredClone(input), ctl))
      .then(
        (end) => this.#ended(s, running, end),
        (err: unknown) => this.#ended(s, running, { reason: "failed", failure: "error", text: err instanceof Error ? err.message : String(err) }),
      );
  }

  #ended(s: Hosted, running: Running, end: TurnEnd): void {
    if (s.running !== running) return;
    delete s.running;
    this.#record(s, { type: "turn_ended", end });
    if (s.view.status === "stopped") return;
    if (end.reason === "failed") {
      s.queue = [];
      this.#setStatus(s, "failed", end.failure ?? "error");
      if (s.view.kind === "agent") this.#notifyParent(s, stopReasonOf(end), end);
      return;
    }
    this.#setStatus(s, "idle");
    if (s.queue.length > 0) {
      this.#pump(s);
      return;
    }
    if (s.view.kind === "agent" && end.reason !== "interrupted") this.#notifyParent(s, stopReasonOf(end), end);
  }

  #notifyParent(s: Hosted, stopReason: AgentStopReason, end: Partial<TurnEnd>): void {
    const parent = s.view.parent ? this.#sessions.get(s.view.parent) : undefined;
    if (!parent || parent.view.status === "stopped" || parent.view.status === "failed") return;
    const bot = s.view.bot ?? parent.view.bot ?? "bot";
    this.deliver(parent.view.id, {
      from: "task-notification",
      agent: s.view.id,
      backend: s.view.backend ?? "unknown",
      stopReason,
      text: end.text ?? "",
      transcript: `bots/${bot.replace("/", "--")}/agents/${s.view.id}/acp.ndjson`,
      ...(end.usage === undefined ? {} : { usage: end.usage }),
    }).catch(() => {
      // The parent ended meanwhile; the transcript keeps the result.
    });
  }

  #setStatus(s: Hosted, status: SessionStatus, failure?: SessionView["failure"]): void {
    if (s.view.status === status && failure === undefined) return;
    s.view = { ...s.view, status, updatedAt: this.#clock.now(), ...(failure === undefined ? {} : { failure }) };
    this.#record(s, { type: "status", status, ...(failure === undefined ? {} : { failure }) });
    this.#watchers.emit({ ...s.view });
  }

  #record(s: Hosted, body: SessionRecordBody): void {
    const epoch = this.#epoch?.();
    const record = { ...structuredClone(body), seq: s.log.length, sessionId: s.view.id, ts: this.#clock.now(), ...(epoch === undefined ? {} : { epoch }) } as SessionRecord;
    s.log.push(record);
    s.subscribers.emit(structuredClone(record));
  }
}

function stopReasonOf(end: Partial<TurnEnd>): AgentStopReason {
  if (end.reason === "failed") return end.failure === "sign-in" ? "sign-in" : end.failure === "crashed" ? "crashed" : end.failure === "stalled" ? "stalled" : "error";
  if (end.reason === "refusal" || end.reason === "cancelled" || end.reason === "stopped") return end.reason;
  return "end_turn";
}

/** A driver a test steers: each turn waits until `end()`, an interrupt or a stop. */
export class FakeSessionDriver implements SessionDriver {
  readonly canFold: boolean;
  /** Every turn it ran: what started it, its origin, and what folded into it. */
  readonly turns: { input: TurnInput; origin: TurnOrigin; folded: TurnInput[] }[] = [];
  interrupts = 0;
  stopped = false;
  #current?: { resolve: (end: TurnEnd) => void; ctl: TurnControl };

  constructor(opts: { canFold?: boolean } = {}) {
    this.canFold = opts.canFold ?? true;
  }

  get running(): boolean {
    return this.#current !== undefined;
  }

  turn(input: TurnInput, ctl: TurnControl): Promise<TurnEnd> {
    const entry = { input, origin: ctl.origin, folded: [] as TurnInput[] };
    this.turns.push(entry);
    ctl.onFold((i) => entry.folded.push(i));
    return new Promise<TurnEnd>((resolve) => {
      this.#current = { resolve, ctl };
    });
  }

  /** Records an event as the runtime would (a tool call, text). */
  emit(event: { type: string; [key: string]: unknown }): void {
    this.#current?.ctl.record(event);
  }

  /** Ends the running turn. */
  end(end: Partial<TurnEnd> = {}): void {
    const cur = this.#current;
    if (!cur) throw new Error("no turn is running");
    this.#current = undefined;
    cur.resolve({ reason: "end_turn", ...end });
  }

  async interrupt(): Promise<void> {
    this.interrupts++;
    const cur = this.#current;
    this.#current = undefined;
    cur?.resolve({ reason: "interrupted" });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const cur = this.#current;
    this.#current = undefined;
    cur?.resolve({ reason: "stopped" });
  }
}
