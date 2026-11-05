// DurableSessionHost: the core's `SessionHost` (contracts/session-host.ts), with every session's log on disk so a
// bot's one conversation survives restarts (spec §6.3, §6.4, §7, §8.5). Owner: lane D, with lane A, whose embedded
// runtime is the driver that runs bots' and side threads' turns (lane K's ACP client runs agents').
//
// It keeps the contract's routing rules exactly as the fake does (an interrupt from the user, folds, queues, task
// notifications, cards withdrawn or cancelled, `bot_asleep`, send order), and adds what a real host needs:
//
// * **The log is the truth.** Each session is two files under `<home>/transcripts/<bot>/` (ids.ts): its meta (who it
//   is) and its event log (event-log.ts). On start the host reads every meta and replays the log of every session that
//   hasn't ended, rebuilding its status, its queue of inputs still waiting for a turn, its pending notes, its open
//   questions and the client ids it has seen; an ended session's log is read only when asked for (a year of routine
//   runs is tens of thousands of side threads). A session it restores is dormant: it has no driver until `open` is
//   called again with the same id, which reattaches it and starts what waits. A meta written by a newer Clover stops
//   the start rather than be skipped; a log whose meta was lost is picked up again by `open`, never written over.
// * **A record is written before the state it changes.** If the disk refuses a record, the session is as it was: an
//   input that couldn't be recorded is an error to its sender, and a turn that couldn't be recorded as started stays
//   queued and is tried again shortly. A record too large for the log has its long fields cut (`shrinkRecord`).
// * **A restart interrupts.** A turn that was running when the daemon stopped is recorded `interrupted` (§3.1 "A
//   daemon restart … records running calls as interrupted"); what was queued behind it runs once the session's driver
//   is back.
// * **A bot's conversation never fails.** The contract ends a session whose turn fails, which is right for an agent's
//   backend; a bot's one conversation (§6.3) records the failed turn, with why, and goes on to the next input.
// * **Notes reach the model.** A note never starts a turn (§5.4 `conversation.post`), but the bot should still see it:
//   one that arrives while a turn runs folds into that turn after its next tool call, and one that arrives while the
//   session is idle waits and is folded into the next turn as it starts, before the driver's first model call.
// * **A routine's result posts** (§7 "posts a short result into the bot's main conversation"). Delivered to a bot's
//   main conversation, it folds into a running turn like any message, but when the bot is idle it waits like a note
//   instead of starting a turn, so a routine every 15 minutes doesn't run the main conversation every 15 minutes
//   (§6.4 "Background work never runs in the main conversation"). In a side thread, the routine's input starts the run.
// * **A resend is not a second message.** The user's `clientMessageId` is remembered (`session.send`).
// * **Needs-you counts.** Each view carries its pending cards (from the approval broker) and its unanswered
//   `AskUserQuestion`s (from the driver's `question_asked` and `question_resolved` events).
// * **Folds wait for the driver.** What folds into a turn (and the notes waiting for it) is held until the driver first
//   subscribes with `onFold`, so a driver that builds its prompt before subscribing misses nothing; what it never took
//   by the turn's end waits for the next turn.
// * **A hung driver can't hold anyone up.** Each call into a driver to interrupt or stop it has `INTERRUPT_GRACE_MS`;
//   past that the host goes on without it. After the user's interrupt, a driver that says it stopped but never ends
//   its turn has the turn ended for it after the same grace.
// * **Streaming never reaches the log.** A runtime event of one of the inherited transient types (`assistant_delta`,
//   `thinking_delta` …, `TRANSIENT_EVENT_TYPES`) is handed to `onTransient` listeners and never recorded, as today.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  pluginIdToSegment, TRANSIENT_EVENT_TYPES,
  type SessionFailure, type SessionKind, type SessionStatus, type SessionView, type TurnOrigin,
} from "@waifucave/clover-protocol";
import type { ApprovalBroker } from "../contracts/approval-broker";
import type { Clock } from "../contracts/clock";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import {
  originOf,
  type AgentStopReason, type DeliveredInput, type Disposition, type SessionDriver, type SessionHost, type SessionRecord,
  type SessionRecordBody, type SessionSpec, type TurnControl, type TurnEnd, type TurnInput, type UserInput,
} from "../contracts/session-host";
import { readJson, writeJsonAtomic } from "./atomic-file";
import { RecordTooLargeError, SessionLogFile, shrinkRecord } from "./event-log";
import { mintSessionId, sessionLogPath, sessionMetaPath, transcriptsDir } from "./ids";

/** After the user's interrupt, how long a driver that said it stopped has to end its turn before the host ends it. */
export const INTERRUPT_GRACE_MS = 5_000;
/** How many of the user's client message ids a session remembers, newest kept: a resend comes within minutes. */
export const CLIENT_IDS_KEPT = 1_000;
/** After the disk refused a turn's start, when it is tried again. */
export const PUMP_RETRY_MS = 5_000;
/** The meta format this host writes; a newer one stops the start. */
export const SESSION_META_VERSION = 1;

/** Who a session is, kept beside its log. */
export interface SessionMeta {
  meta: 1;
  id: string;
  kind: SessionKind;
  bot?: string;
  parent?: string;
  computer: string;
  title?: string;
  backend?: string;
  model?: string;
  effort?: string;
  root?: string;
  routine?: string;
  startedAt: number;
  /** Set when the session ends, so a start needn't read its log. */
  ended?: { status: "stopped" | "failed"; at: number; failure?: SessionFailure };
}

/** The fields `update` and a reattaching `open` may change; who the session is (kind, bot, parent) never changes.
 *  `undefined` leaves a field as it is, and `null` clears it (the session's `computer` can't be cleared). */
export type SessionSpecPatch = { computer?: string } & {
  [K in "title" | "backend" | "model" | "effort" | "root" | "routine"]?: string | null;
};

export interface DurableSessionHostOptions {
  /** The Clover home: `~/.clover`, `~/.clover-dev`, or a test's temp home. */
  home: string;
  clock: Clock;
  /** Withdraws and cancels a session's cards; with `pending` and `watch`, also counts them for the needs-you marks. */
  approvals?: Pick<ApprovalBroker, "withdrawSession" | "cancelSession"> & Partial<Pick<ApprovalBroker, "pending" | "watch">>;
  /** The lease epoch every record carries once lane H's lease exists (§6.4). */
  epoch?: () => number | undefined;
  warn?: (message: string) => void;
}

/** What folds into a running turn, held until the driver first subscribes. */
class FoldChannel {
  readonly #listeners = new Listeners<TurnInput>();
  #held: TurnInput[] | undefined = [];

  subscribe(fn: (input: TurnInput) => void): Unsubscribe {
    const off = this.#listeners.add(fn);
    const held = this.#held;
    if (held !== undefined) {
      this.#held = undefined;
      for (const input of held) fn(structuredClone(input));
    }
    return off;
  }

  emit(input: TurnInput): void {
    if (this.#held !== undefined) this.#held.push(structuredClone(input));
    else this.#listeners.emit(structuredClone(input));
  }

  /** What no subscriber ever took. */
  unclaimed(): TurnInput[] {
    return this.#held ?? [];
  }
}

interface Running {
  origin: TurnOrigin;
  abort: AbortController;
  folds: FoldChannel;
}

interface Hosted {
  meta: SessionMeta;
  view: SessionView;
  /** Undefined for an ended session restored without reading its log: `#logOf` reads it when asked. */
  log: SessionLogFile | undefined;
  driver?: SessionDriver;
  subscribers: Listeners<SessionRecord>;
  transient: Listeners<{ type: string; [key: string]: unknown }>;
  /** Inputs waiting for a turn of their own, in the order they will run. */
  queue: TurnInput[];
  /** Notes and posted routine results that arrived while no turn ran: folded into the next turn as it starts. */
  pending: TurnInput[];
  running?: Running;
  /** `stop` has begun: nothing starts, and the turn it ends is recorded without anything else following. */
  stopping: boolean;
  /** `release` is detaching the driver: nothing starts. */
  releasing: boolean;
  asleep: boolean;
  clientIds: Map<string, { seq: number; disposition: Disposition }>;
  questions: Set<string>;
  cards: number;
  /** A turn's start the disk refused, to be tried again. */
  retry?: ReturnType<Clock["setTimeout"]>;
}

const isEnded = (status: SessionStatus) => status === "stopped" || status === "failed";

/** The user's message goes ahead of everything waiting except earlier user messages, so they keep send order. */
function insertUserInput(queue: TurnInput[], input: TurnInput): void {
  const at = queue.findIndex((q) => q.from !== "user");
  queue.splice(at < 0 ? queue.length : at, 0, input);
}

function rememberClientId(map: Hosted["clientIds"], id: string, entry: { seq: number; disposition: Disposition }): void {
  map.delete(id);
  map.set(id, entry);
  while (map.size > CLIENT_IDS_KEPT) map.delete(map.keys().next().value as string);
}

/** Tracks the open `AskUserQuestion`s a driver's events show; true when the set changed. */
function trackQuestion(questions: Set<string>, event: { type: string; [key: string]: unknown }): boolean {
  const callId = typeof event.callId === "string" ? event.callId : undefined;
  if (callId === undefined) return false;
  if (event.type === "question_asked") {
    if (questions.has(callId)) return false;
    questions.add(callId);
    return true;
  }
  if (event.type === "question_resolved") return questions.delete(callId);
  return false;
}

/** What replaying a log rebuilds. */
class Replay {
  running = false;
  queue: TurnInput[] = [];
  pending: TurnInput[] = [];
  status: SessionStatus = "ready";
  failure: SessionFailure | undefined;
  updatedAt: number | undefined;
  readonly clientIds: Hosted["clientIds"] = new Map();
  readonly questions = new Set<string>();

  apply(r: SessionRecord): void {
    switch (r.type) {
      case "input":
        if (r.input.from === "user") rememberClientId(this.clientIds, r.input.clientMessageId, { seq: r.seq, disposition: r.disposition });
        switch (r.disposition) {
          case "turn":
          case "queued":
            this.queue.push(r.input);
            break;
          case "interrupted":
            insertUserInput(this.queue, r.input);
            break;
          case "note":
            // While a turn ran, a note folded into it (or, for a driver that can't fold, was only recorded).
            if (!this.running) this.pending.push(r.input);
            break;
          case "folded":
            break;
        }
        break;
      case "turn_started":
        this.queue.shift();
        this.pending = [];
        this.running = true;
        break;
      case "turn_ended":
        this.running = false;
        break;
      case "status":
        this.status = r.status;
        if (r.failure !== undefined) this.failure = r.failure;
        this.updatedAt = r.ts;
        if (isEnded(r.status)) {
          this.queue = [];
          this.pending = [];
        }
        break;
      case "driver":
        trackQuestion(this.questions, r.event);
        break;
    }
  }
}

function readMeta(path: string): SessionMeta | undefined {
  const v = readJson(path) as Partial<SessionMeta> | undefined;
  if (v !== undefined && typeof v.meta === "number" && v.meta > SESSION_META_VERSION) {
    throw new ContractError("conflict", `${path} was written by a newer Clover (meta ${v.meta}); start that version, since this one would lose what it can't read`);
  }
  if (v === undefined || v.meta !== SESSION_META_VERSION || typeof v.id !== "string" || typeof v.kind !== "string" || typeof v.computer !== "string" || typeof v.startedAt !== "number") return undefined;
  return v as SessionMeta;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class DurableSessionHost implements SessionHost {
  readonly #home: string;
  readonly #clock: Clock;
  readonly #approvals: DurableSessionHostOptions["approvals"];
  readonly #epoch: (() => number | undefined) | undefined;
  readonly #warn: (message: string) => void;
  readonly #sessions = new Map<string, Hosted>();
  readonly #watchers = new Listeners<SessionView>();
  readonly #taps = new Listeners<{ record: SessionRecord; view: SessionView }>();
  readonly #offApprovals: Unsubscribe | undefined;

  constructor(opts: DurableSessionHostOptions) {
    this.#home = opts.home;
    this.#clock = opts.clock;
    this.#approvals = opts.approvals;
    this.#epoch = opts.epoch;
    this.#warn = opts.warn ?? (() => {});
    this.#restore();
    this.#offApprovals = opts.approvals?.watch?.(() => this.#recountCards());
    this.#recountCards();
  }

  // -----------------------------------------------------------------------------------------------
  // The contract
  // -----------------------------------------------------------------------------------------------

  /** Opens a new session, or reattaches a restored one (the same id, kind, bot and parent) with this driver. */
  open(spec: SessionSpec, driver: SessionDriver): SessionView {
    const id = spec.id ?? mintSessionId(spec.kind);
    let existing = this.#sessions.get(id);
    if (!existing && existsSync(sessionLogPath(this.#home, spec.bot, id))) {
      // A log whose meta was lost or unreadable: it is this session's, so it is picked up, never written over.
      this.#warn(`session ${id}: its log had no readable meta; it is picked up again with a new one`);
      const meta: SessionMeta = { meta: SESSION_META_VERSION, id, kind: spec.kind, startedAt: this.#clock.now(), ...specPatchOf(spec) };
      if (spec.bot !== undefined) meta.bot = spec.bot;
      if (spec.parent !== undefined) meta.parent = spec.parent;
      writeJsonAtomic(sessionMetaPath(this.#home, meta.bot, id), meta);
      this.#load(meta);
      existing = this.#sessions.get(id);
    }
    if (existing) {
      if (existing.driver) throw new ContractError("conflict", `session ${id} is already open`);
      if (isEnded(existing.view.status)) throw new ContractError("conflict", `session ${id} has ended`);
      if (existing.meta.kind !== spec.kind || existing.meta.bot !== spec.bot || existing.meta.parent !== spec.parent) {
        throw new ContractError("conflict", `session ${id} is another ${existing.meta.kind} session`);
      }
      existing.driver = driver;
      if (!driver.canFold) existing.pending = [];
      this.#patchMeta(existing, specPatchOf(spec));
      this.#emitView(existing);
      this.#pump(existing);
      return this.#viewOf(existing);
    }
    const now = this.#clock.now();
    const meta: SessionMeta = { meta: SESSION_META_VERSION, id, kind: spec.kind, startedAt: now, ...specPatchOf(spec) };
    if (spec.bot !== undefined) meta.bot = spec.bot;
    if (spec.parent !== undefined) meta.parent = spec.parent;
    writeJsonAtomic(sessionMetaPath(this.#home, meta.bot, id), meta);
    const log = new SessionLogFile(sessionLogPath(this.#home, meta.bot, id), id, this.#warn);
    log.load();
    const s = this.#hosted(meta, log);
    s.driver = driver;
    this.#sessions.set(id, s);
    this.#record(s, { type: "status", status: "ready" });
    this.#emitView(s);
    return this.#viewOf(s);
  }

  list(filter: { bot?: string; kind?: SessionKind; parent?: string } = {}): SessionView[] {
    return [...this.#sessions.values()]
      .filter((s) => (filter.bot === undefined || s.meta.bot === filter.bot) && (filter.kind === undefined || s.meta.kind === filter.kind) && (filter.parent === undefined || s.meta.parent === filter.parent))
      .map((s) => this.#viewOf(s));
  }

  get(id: string): SessionView | undefined {
    const s = this.#sessions.get(id);
    return s ? this.#viewOf(s) : undefined;
  }

  /** The user's message. Also returns the record's `seq` (`session.send`'s result); a resend with a `clientMessageId`
   *  already seen returns the first one's disposition and seq, and records nothing. */
  async sendUser(id: string, input: Omit<UserInput, "from">): Promise<{ disposition: Disposition; seq: number }> {
    const s = this.#live(id);
    if (s.asleep) throw new ContractError("bot_asleep", "can't reach the computer running this bot; the draft is kept");
    if (s.meta.kind === "side-thread") throw new ContractError("refused", "a side thread takes no messages from the user");
    const seen = s.clientIds.get(input.clientMessageId);
    if (seen) return { ...seen };
    const full: UserInput = { from: "user", ...structuredClone(input) };
    if (s.running && s.meta.kind === "bot") {
      const record = this.#record(s, { type: "input", input: full, disposition: "interrupted" });
      rememberClientId(s.clientIds, full.clientMessageId, { seq: record.seq, disposition: "interrupted" });
      insertUserInput(s.queue, full);
      await this.#interruptStep(s);
      this.#pump(s);
      return { disposition: "interrupted", seq: record.seq };
    }
    return this.#accept(s, full);
  }

  /** Another bot's, an agent's, a routine's or a plugin's message, a task notification, or a note. Also returns the
   *  record's `seq`. */
  async deliver(id: string, input: DeliveredInput): Promise<{ disposition: Disposition; seq: number }> {
    const s = this.#live(id);
    const copy = structuredClone(input);
    if (copy.from === "note" || (copy.from === "routine" && s.meta.kind === "bot")) return this.#post(s, copy);
    return this.#accept(s, copy);
  }

  async interrupt(id: string): Promise<void> {
    const s = this.#live(id);
    if (s.running) await this.#interruptStep(s);
  }

  async stop(id: string, reason = "stopped"): Promise<void> {
    const s = this.#sessions.get(id);
    if (!s || isEnded(s.view.status) || s.stopping) return;
    s.stopping = true;
    s.queue = [];
    s.pending = [];
    const running = s.running;
    running?.abort.abort(reason);
    this.#approvals?.cancelSession(id);
    if (s.driver) await this.#bounded(s, s.driver, (d) => d.stop(), "stop");
    if (running && s.running === running) {
      this.#tryRecord(s, { type: "turn_ended", end: { reason: "stopped" } });
      delete s.running;
    }
    delete s.driver;
    this.#setStatus(s, "stopped");
    if (s.meta.kind === "agent") this.#notifyParent(s, "stopped", { reason: "stopped" });
  }

  history(id: string, opts: { afterSeq?: number; limit?: number } = {}): SessionRecord[] {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    const log = this.#logOf(s);
    const from = opts.afterSeq === undefined ? 0 : opts.afterSeq + 1;
    const to = opts.limit === undefined ? log.length : Math.min(log.length, from + opts.limit);
    return log.read(from, to);
  }

  subscribe(id: string, fn: (record: SessionRecord) => void): Unsubscribe {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    return s.subscribers.add(fn);
  }

  watch(fn: (view: SessionView) => void): Unsubscribe {
    return this.#watchers.add(fn);
  }

  // -----------------------------------------------------------------------------------------------
  // Beyond the contract: what the bot service, the usage counter and the methods need
  // -----------------------------------------------------------------------------------------------

  /** Detaches a session's driver and leaves the session dormant (a removed bot's conversation, a shutdown): a running
   *  turn is recorded `interrupted`, what waits stays queued, and `open` with the same id picks it all up again. */
  async release(id: string): Promise<void> {
    const s = this.#sessions.get(id);
    if (!s?.driver || s.stopping) return;
    s.releasing = true;
    try {
      const running = s.running;
      if (running) {
        this.#setStatus(s, "cancelling");
        running.abort.abort("released");
        this.#approvals?.withdrawSession(id);
        await this.#bounded(s, s.driver, (d) => d.interrupt(), "interrupt");
        if (s.running === running) {
          this.#tryRecord(s, { type: "turn_ended", end: { reason: "interrupted" } });
          delete s.running;
        }
      }
      if (s.driver) await this.#bounded(s, s.driver, (d) => d.stop(), "stop");
    } catch (err) {
      this.#warn(`session ${id}: its driver failed to stop: ${errorText(err)}`);
    } finally {
      delete s.driver;
      s.releasing = false;
    }
    if (!isEnded(s.view.status) && s.view.status !== "ready") this.#setStatus(s, "idle");
  }

  /** Releases every attached session (a daemon shutdown) and stops counting cards. */
  async close(): Promise<void> {
    this.#offApprovals?.();
    for (const s of [...this.#sessions.values()]) if (s.driver) await this.release(s.meta.id);
  }

  /** Every record of every session as it is written, with the session's view: the usage counter and the wire. */
  tap(fn: (entry: { record: SessionRecord; view: SessionView }) => void): Unsubscribe {
    return this.#taps.add(fn);
  }

  /** A session's streaming events (deltas), which are never recorded: the wire sends them to attached clients. */
  onTransient(id: string, fn: (event: { type: string; [key: string]: unknown }) => void): Unsubscribe {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    return s.transient.add(fn);
  }

  /** Records an event the core itself makes in a session's log, in the runtime's vocabulary (a bot's greeting as its
   *  first `assistant_message`). */
  recordCore(id: string, event: { type: string; [key: string]: unknown }): SessionRecord {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    return this.#record(s, { type: "driver", event: structuredClone(event) });
  }

  /** Changes what a session's view says about it: its computer, title, model or effort (a bot's main conversation
   *  follows its bot's settings). */
  update(id: string, patch: SessionSpecPatch): SessionView {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    if (this.#patchMeta(s, patch)) this.#emitView(s);
    return this.#viewOf(s);
  }

  /** The device lost (or regained) its connection to the computer running this session (§6.4). */
  setAsleep(id: string, asleep: boolean): void {
    const s = this.#sessions.get(id);
    if (s) s.asleep = asleep;
  }

  isAsleep(id: string): boolean {
    return this.#sessions.get(id)?.asleep ?? false;
  }

  /** Whether a driver is attached (an open session) rather than dormant. */
  isAttached(id: string): boolean {
    return this.#sessions.get(id)?.driver !== undefined;
  }

  /** How many records the session's log holds. */
  length(id: string): number {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    return this.#logOf(s).length;
  }

  // -----------------------------------------------------------------------------------------------
  // Routing
  // -----------------------------------------------------------------------------------------------

  #live(id: string): Hosted {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    if (isEnded(s.view.status) || s.stopping) throw new ContractError("closed", `session ${id} has ended`);
    return s;
  }

  #accept(s: Hosted, input: TurnInput): { disposition: Disposition; seq: number } {
    if (!s.running) {
      const startsNow = s.driver !== undefined && !s.releasing && s.queue.length === 0;
      const disposition: Disposition = startsNow ? "turn" : "queued";
      const record = this.#record(s, { type: "input", input, disposition });
      if (input.from === "user") rememberClientId(s.clientIds, input.clientMessageId, { seq: record.seq, disposition });
      s.queue.push(input);
      this.#pump(s);
      return { disposition, seq: record.seq };
    }
    if (input.from !== "user" && s.driver?.canFold) {
      const record = this.#record(s, { type: "input", input, disposition: "folded" });
      s.running.folds.emit(input);
      return { disposition: "folded", seq: record.seq };
    }
    const record = this.#record(s, { type: "input", input, disposition: "queued" });
    if (input.from === "user") rememberClientId(s.clientIds, input.clientMessageId, { seq: record.seq, disposition: "queued" });
    s.queue.push(input);
    return { disposition: "queued", seq: record.seq };
  }

  /** A note, or a routine's result in a bot's main conversation: it never starts a turn. */
  #post(s: Hosted, input: DeliveredInput): { disposition: Disposition; seq: number } {
    const running = s.running;
    if (running && s.driver?.canFold) {
      const disposition: Disposition = input.from === "note" ? "note" : "folded";
      const record = this.#record(s, { type: "input", input, disposition });
      running.folds.emit(input);
      return { disposition, seq: record.seq };
    }
    const record = this.#record(s, { type: "input", input, disposition: "note" });
    if (!running) s.pending.push(input);
    return { disposition: "note", seq: record.seq };
  }

  async #interruptStep(s: Hosted): Promise<void> {
    const running = s.running;
    if (!running) return;
    this.#setStatus(s, "cancelling");
    running.abort.abort("interrupted");
    this.#approvals?.withdrawSession(s.meta.id);
    if (s.driver) await this.#bounded(s, s.driver, (d) => d.interrupt(), "interrupt");
    // A driver ends its turn when it stops; one that never does is cut loose, and its late end is ignored.
    if (s.running === running) {
      this.#clock.setTimeout(() => {
        if (s.running !== running) return;
        this.#warn(`session ${s.meta.id}: its driver didn't end the interrupted turn; ending it`);
        this.#ended(s, running, { reason: "interrupted" });
      }, INTERRUPT_GRACE_MS);
    }
  }

  /** Starts the next queued turn when none runs and a driver is attached. */
  #pump(s: Hosted): void {
    const driver = s.driver;
    if (s.running || !driver || s.releasing || s.stopping || s.queue.length === 0 || isEnded(s.view.status)) return;
    const input = s.queue[0]!;
    const origin = originOf(input);
    // The turn's start is recorded before anything changes: if the disk refuses it, the input stays first in line.
    if (!this.#tryRecord(s, { type: "turn_started", origin })) {
      if (s.retry === undefined && s.log?.broken === undefined) {
        s.retry = this.#clock.setTimeout(() => {
          delete s.retry;
          this.#pump(s);
        }, PUMP_RETRY_MS);
      }
      return;
    }
    s.queue.shift();
    const running: Running = { origin, abort: new AbortController(), folds: new FoldChannel() };
    s.running = running;
    const pending = driver.canFold ? s.pending : [];
    s.pending = [];
    for (const note of pending) running.folds.emit(note);
    this.#setStatus(s, "prompting");
    const ctl: TurnControl = {
      origin,
      signal: running.abort.signal,
      onFold: (fn) => running.folds.subscribe(fn),
      record: (event) => {
        if (TRANSIENT_EVENT_TYPES.has(event.type as never)) s.transient.emit(structuredClone(event));
        else this.#tryRecord(s, { type: "driver", event: structuredClone(event) });
      },
    };
    void Promise.resolve()
      .then(() => driver.turn(structuredClone(input), ctl))
      .then(
        (end) => this.#ended(s, running, end),
        (err: unknown) => this.#ended(s, running, { reason: "failed", failure: "error", text: errorText(err) }),
      )
      .catch((err: unknown) => this.#warn(`session ${s.meta.id}: ending a turn failed: ${errorText(err)}`));
  }

  #ended(s: Hosted, running: Running, end: TurnEnd): void {
    if (s.running !== running) return;
    // What the driver never subscribed to take: notes wait for the next turn, and messages get a turn of their own.
    const unclaimed = running.folds.unclaimed();
    // Recorded first; if the disk refuses it, the turn has still ended, and a restart records it interrupted.
    this.#tryRecord(s, { type: "turn_ended", end });
    delete s.running;
    s.pending.unshift(...unclaimed.filter((i) => i.from === "note" || (i.from === "routine" && s.meta.kind === "bot")));
    s.queue.push(...unclaimed.filter((i) => !(i.from === "note" || (i.from === "routine" && s.meta.kind === "bot"))));
    if (s.stopping || isEnded(s.view.status)) return;
    if (s.releasing) {
      this.#setStatus(s, "idle");
      return;
    }
    if (end.reason === "failed" && s.meta.kind === "bot") {
      // A bot's one conversation never ends (§6.3): the failed turn is recorded with why, and what waits runs next.
      this.#setStatus(s, "idle");
      this.#pump(s);
      return;
    }
    if (end.reason === "failed") {
      s.queue = [];
      s.pending = [];
      this.#setStatus(s, "failed", end.failure ?? "error");
      if (s.meta.kind === "agent") this.#notifyParent(s, stopReasonOf(end), end);
      return;
    }
    this.#setStatus(s, "idle");
    if (s.queue.length > 0) {
      this.#pump(s);
      return;
    }
    if (s.meta.kind === "agent" && end.reason !== "interrupted") this.#notifyParent(s, stopReasonOf(end), end);
  }

  /** A background agent's task notification to its bot's main conversation (§9.3, S5 §8). */
  #notifyParent(s: Hosted, stopReason: AgentStopReason, end: Partial<TurnEnd>): void {
    const parent = s.meta.parent ? this.#sessions.get(s.meta.parent) : undefined;
    if (!parent || isEnded(parent.view.status)) return;
    const bot = s.meta.bot ?? parent.meta.bot ?? "bot";
    this.deliver(parent.meta.id, {
      from: "task-notification",
      agent: s.meta.id,
      backend: s.meta.backend ?? "unknown",
      stopReason,
      text: end.text ?? "",
      transcript: `bots/${pluginIdToSegment(bot)}/agents/${s.meta.id}/acp.ndjson`,
      ...(end.usage === undefined ? {} : { usage: end.usage }),
    }).catch(() => {
      // The parent ended meanwhile; the agent's transcript keeps the result.
    });
  }

  // -----------------------------------------------------------------------------------------------
  // State, records and views
  // -----------------------------------------------------------------------------------------------

  #hosted(meta: SessionMeta, log: SessionLogFile | undefined): Hosted {
    return {
      meta,
      view: viewOfMeta(meta, "ready", meta.startedAt),
      log,
      subscribers: new Listeners(),
      transient: new Listeners(),
      queue: [],
      pending: [],
      stopping: false,
      releasing: false,
      asleep: false,
      clientIds: new Map(),
      questions: new Set(),
      cards: 0,
    };
  }

  #restore(): void {
    const root = transcriptsDir(this.#home);
    if (!existsSync(root)) return;
    for (const folder of readdirSync(root, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      for (const file of readdirSync(join(root, folder.name))) {
        if (!file.endsWith(".meta.json")) continue;
        const path = join(root, folder.name, file);
        const meta = readMeta(path);
        if (!meta) {
          this.#warn(`skipped ${path}: not a session's meta`);
          continue;
        }
        if (sessionMetaPath(this.#home, meta.bot, meta.id) !== path) {
          this.#warn(`skipped ${path}: it names session ${meta.id}, whose files live elsewhere`);
          continue;
        }
        if (this.#sessions.has(meta.id)) continue;
        if (meta.ended !== undefined) {
          // Its log is read when someone asks for it.
          const s = this.#hosted(meta, undefined);
          s.view = viewOfMeta(meta, meta.ended.status, meta.ended.at, meta.ended.failure);
          this.#sessions.set(meta.id, s);
        } else this.#load(meta);
      }
    }
  }

  /** The session's log, read now if it wasn't at the start (an ended session). */
  #logOf(s: Hosted): SessionLogFile {
    if (s.log === undefined) {
      const log = new SessionLogFile(sessionLogPath(this.#home, s.meta.bot, s.meta.id), s.meta.id, this.#warn);
      log.load();
      s.log = log;
    }
    return s.log;
  }

  #load(meta: SessionMeta): void {
    const log = new SessionLogFile(sessionLogPath(this.#home, meta.bot, meta.id), meta.id, this.#warn);
    const replay = new Replay();
    log.load((r) => replay.apply(r));
    const s = this.#hosted(meta, log);
    s.view = viewOfMeta(meta, replay.status, replay.updatedAt ?? meta.startedAt, replay.failure);
    s.queue = replay.queue;
    s.pending = replay.pending;
    for (const [k, v] of replay.clientIds) s.clientIds.set(k, v);
    for (const q of replay.questions) s.questions.add(q);
    this.#sessions.set(meta.id, s);
    // A turn the daemon was running when it stopped is recorded interrupted (§3.1).
    if (replay.running) this.#tryRecord(s, { type: "turn_ended", end: { reason: "interrupted" } });
    if (s.view.status === "prompting" || s.view.status === "cancelling" || s.view.status === "starting") this.#setStatus(s, "idle");
    // Ended before its meta said so (a crash between the two writes, or an older home): the next start skips its log.
    if (isEnded(s.view.status) && meta.ended === undefined) this.#markEnded(s);
  }

  #record(s: Hosted, body: SessionRecordBody): SessionRecord {
    const log = this.#logOf(s);
    const epoch = this.#epoch?.();
    let record = {
      ...structuredClone(body),
      seq: log.length,
      sessionId: s.meta.id,
      ts: this.#clock.now(),
      ...(epoch === undefined ? {} : { epoch }),
    } as SessionRecord;
    const durable = { durable: body.type !== "driver" };
    try {
      log.append(record, durable);
    } catch (err) {
      if (!(err instanceof RecordTooLargeError)) throw err;
      record = shrinkRecord(record, err.bytes) ?? record;
      this.#warn(`session ${s.meta.id}: a ${body.type} record of ${err.bytes} bytes had its long fields cut to fit the log`);
      log.append(record, durable);
    }
    s.subscribers.emit(structuredClone(record));
    if (body.type === "driver" && trackQuestion(s.questions, body.event)) this.#emitView(s);
    if (this.#taps.size > 0) this.#taps.emit({ record: structuredClone(record), view: this.#viewOf(s) });
    return record;
  }

  /** Writes a record, or says why it couldn't; true when it was written. */
  #tryRecord(s: Hosted, body: SessionRecordBody): boolean {
    try {
      this.#record(s, body);
      return true;
    } catch (err) {
      this.#warn(`session ${s.meta.id}: a ${body.type} record wasn't written: ${errorText(err)}`);
      return false;
    }
  }

  /** The status is recorded first; the view follows the session's real state even when the disk refused the record. */
  #setStatus(s: Hosted, status: SessionStatus, failure?: SessionFailure): void {
    if (s.view.status === status && failure === undefined) return;
    this.#tryRecord(s, { type: "status", status, ...(failure === undefined ? {} : { failure }) });
    s.view = { ...s.view, status, updatedAt: this.#clock.now(), ...(failure === undefined ? {} : { failure }) };
    if (isEnded(status)) this.#markEnded(s);
    this.#emitView(s);
  }

  /** Notes in the meta that the session ended, so a start needn't read its log. */
  #markEnded(s: Hosted): void {
    const status = s.view.status;
    if (status !== "stopped" && status !== "failed") return;
    const next: SessionMeta = { ...s.meta, ended: { status, at: s.view.updatedAt, ...(s.view.failure === undefined ? {} : { failure: s.view.failure }) } };
    try {
      writeJsonAtomic(sessionMetaPath(this.#home, next.bot, next.id), next);
      s.meta = next;
    } catch (err) {
      this.#warn(`session ${s.meta.id}: its meta wasn't marked ended: ${errorText(err)}`);
    }
  }

  /** A call into a driver to interrupt or stop it, given `INTERRUPT_GRACE_MS` before the host goes on without it. */
  async #bounded(s: Hosted, driver: SessionDriver, call: (d: SessionDriver) => Promise<void>, what: string): Promise<void> {
    let handle: ReturnType<Clock["setTimeout"]> | undefined;
    const late = new Promise<"late">((resolve) => {
      handle = this.#clock.setTimeout(() => resolve("late"), INTERRUPT_GRACE_MS);
    });
    try {
      const done = Promise.resolve().then(() => call(driver)).then(() => "done" as const);
      if ((await Promise.race([done, late])) === "late") {
        this.#warn(`session ${s.meta.id}: its driver didn't ${what} within ${INTERRUPT_GRACE_MS} ms; going on without it`);
      }
    } catch (err) {
      this.#warn(`session ${s.meta.id}: its driver failed to ${what}: ${errorText(err)}`);
    } finally {
      if (handle !== undefined) this.#clock.clearTimeout(handle);
    }
  }

  #patchMeta(s: Hosted, patch: SessionSpecPatch): boolean {
    let changed = false;
    const next: SessionMeta = { ...s.meta };
    for (const [k, v] of Object.entries(patch) as [keyof SessionSpecPatch, string | null | undefined][]) {
      if (v === undefined || next[k] === v) continue;
      if (v === null) {
        if (k === "computer" || next[k] === undefined) continue;
        delete next[k];
      } else next[k] = v;
      changed = true;
    }
    if (!changed) return false;
    writeJsonAtomic(sessionMetaPath(this.#home, next.bot, next.id), next);
    s.meta = next;
    s.view = { ...viewOfMeta(next, s.view.status, s.view.updatedAt, s.view.failure) };
    return true;
  }

  #recountCards(): void {
    const pending = this.#approvals?.pending?.();
    if (pending === undefined) return;
    const counts = new Map<string, number>();
    for (const card of pending) if (card.session !== undefined) counts.set(card.session, (counts.get(card.session) ?? 0) + 1);
    for (const s of this.#sessions.values()) {
      const n = counts.get(s.meta.id) ?? 0;
      if (n === s.cards) continue;
      s.cards = n;
      this.#emitView(s);
    }
  }

  #viewOf(s: Hosted): SessionView {
    return { ...structuredClone(s.view), needsYou: { cards: s.cards, questions: s.questions.size } };
  }

  #emitView(s: Hosted): void {
    this.#watchers.emit(this.#viewOf(s));
  }
}

function specPatchOf(spec: SessionSpec): Pick<SessionMeta, "computer"> & Partial<Pick<SessionMeta, "title" | "backend" | "model" | "effort" | "root" | "routine">> {
  const out: Pick<SessionMeta, "computer"> & Partial<Pick<SessionMeta, "title" | "backend" | "model" | "effort" | "root" | "routine">> = { computer: spec.computer };
  for (const k of ["title", "backend", "model", "effort", "root", "routine"] as const) if (spec[k] !== undefined) out[k] = spec[k];
  return out;
}

function viewOfMeta(meta: SessionMeta, status: SessionStatus, updatedAt: number, failure?: SessionFailure): SessionView {
  return {
    id: meta.id,
    kind: meta.kind,
    computer: meta.computer,
    status,
    startedAt: meta.startedAt,
    updatedAt,
    ...(failure === undefined ? {} : { failure }),
    ...(meta.bot === undefined ? {} : { bot: meta.bot }),
    ...(meta.parent === undefined ? {} : { parent: meta.parent }),
    ...(meta.title === undefined ? {} : { title: meta.title }),
    ...(meta.backend === undefined ? {} : { backend: meta.backend }),
    ...(meta.model === undefined ? {} : { model: meta.model }),
    ...(meta.effort === undefined ? {} : { effort: meta.effort }),
    ...(meta.root === undefined ? {} : { root: meta.root }),
    ...(meta.routine === undefined ? {} : { routine: meta.routine }),
  };
}

function stopReasonOf(end: Partial<TurnEnd>): AgentStopReason {
  if (end.reason === "failed") return end.failure === "sign-in" ? "sign-in" : end.failure === "crashed" ? "crashed" : end.failure === "stalled" ? "stalled" : "error";
  if (end.reason === "refusal" || end.reason === "cancelled" || end.reason === "stopped") return end.reason;
  return "end_turn";
}
